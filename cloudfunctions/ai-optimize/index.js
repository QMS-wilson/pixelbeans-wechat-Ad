const cloud = require("wx-server-sdk");
const {
  readUnlockState,
  consumeAiCredit,
  buildUnlockPayload,
  submitImageTask,
  pollImageTask,
  uploadImageResult,
  assembleUpload,
} = require("./lib/cloud-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const AI_TASKS_COLLECTION = "ai_tasks";

async function ensureCollection(name) {
  try {
    if (typeof db.createCollectionIfNotExists === "function") {
      await db.createCollectionIfNotExists(name);
      return true;
    }
    if (typeof db.createCollection === "function") {
      await db.createCollection(name);
      return true;
    }
  } catch (error) {
    // Collection already exists or concurrent creation race; ignore.
  }
  return false;
}

function isCollectionNotExist(error) {
  return (
    error &&
    (String(error.errCode) === "-502005" ||
      String(error.errCode) === "DATABASE_COLLECTION_NOT_EXIST" ||
      /collection not exist/i.test(String(error.errMsg || error.message || "")))
  );
}

// 记录 AI 任务到 ai_tasks 集合，供客户端轮询
async function recordTask({ taskId, OPENID, imageHash = "" }) {
  await ensureCollection(AI_TASKS_COLLECTION);
  const record = {
    openid: OPENID,
    imageHash: String(imageHash || ""),
    status: "processing",
    submitAt: new Date().toISOString(),
  };
  try {
    await db.collection(AI_TASKS_COLLECTION).doc(taskId).set({ data: record });
  } catch (error) {
    if (isCollectionNotExist(error)) {
      await ensureCollection(AI_TASKS_COLLECTION);
      await db.collection(AI_TASKS_COLLECTION).doc(taskId).set({ data: record });
    } else {
      throw error;
    }
  }
}

async function getUnlockPayload(OPENID) {
  return buildUnlockPayload(await readUnlockState(OPENID));
}

// 提交 AI 优化任务：校验广告解锁额度 -> 组装图片 -> 提交火山引擎 -> 扣减额度并记录任务
async function submitTask(OPENID, event) {
  const { imageBase64, imageFileID: inputFileID, imageUploadId, prompt, imageHash } = event || {};
  console.log("[ai-optimize] submit start", {
    OPENID,
    promptLength: prompt ? String(prompt).length : 0,
    imageHash,
    hasBase64: !!imageBase64,
    hasFileID: !!inputFileID,
    hasUploadId: !!imageUploadId,
  });

  let resolvedImageBase64 = imageBase64;
  if (!resolvedImageBase64 && inputFileID) {
    const downloaded = await cloud.downloadFile({ fileID: inputFileID });
    resolvedImageBase64 = downloaded.fileContent.toString("base64");
  }
  if (!resolvedImageBase64 && imageUploadId) {
    const assembled = await assembleUpload(imageUploadId);
    resolvedImageBase64 = assembled.toString("base64");
  }
  console.log("[ai-optimize] image ready", { base64Length: resolvedImageBase64 ? resolvedImageBase64.length : 0 });
  if (!resolvedImageBase64) {
    return { error: "Missing imageBase64 parameter" };
  }

  const state = await readUnlockState(OPENID);
  if (Number(state.aiRemaining) <= 0) {
    return { error: "AI optimization denied", message: "AI 优化额度已用完，看完广告后可继续使用。" };
  }

  console.log("[ai-optimize] submit task");
  const taskId = await submitImageTask(resolvedImageBase64, prompt);
  // 提交成功后扣减一次 AI 额度（任务失败 / 取消不退回，与旧版提示一致）
  const consumed = await consumeAiCredit(OPENID);
  await recordTask({ taskId, OPENID, imageHash });
  console.log("[ai-optimize] submitted", { taskId, consumed });
  return { success: true, taskId, submitted: true, ...(await getUnlockPayload(OPENID)) };
}

async function checkTask(OPENID, event) {
  const taskId = String((event && event.taskId) || "").trim();
  if (!taskId) {
    return { error: "Missing task id", message: "缺少任务 ID。" };
  }
  const coll = db.collection(AI_TASKS_COLLECTION);
  let task = null;
  try {
    const res = await coll.doc(taskId).get();
    task = res.data;
  } catch (error) {
    return { error: "Task not found", message: "AI 任务不存在，请重新提交。" };
  }
  if (!task || task.openid !== OPENID) {
    return { error: "Forbidden", message: "无权查询该任务。" };
  }
  if (task.status === "done") {
    return {
      success: true,
      imageFileID: task.imageFileID,
      taskId,
      done: true,
      ...(await getUnlockPayload(OPENID)),
    };
  }
  if (task.status === "failed") {
    return { success: false, failed: true, message: task.message || "AI 优化任务失败，请重试。" };
  }

  let poll;
  try {
    poll = await pollImageTask(taskId);
  } catch (error) {
    // 网络抖动等瞬时错误：让客户端稍后继续轮询
    console.error("[ai-optimize] poll error", { taskId, error: error && error.message });
    return { success: false, pending: true };
  }
  if (poll.status === "processing") {
    return { success: false, pending: true };
  }
  if (poll.status === "failed") {
    try {
      await coll.doc(taskId).update({
        data: { status: "failed", message: poll.message || "AI 优化任务失败。", checkedAt: new Date().toISOString() },
      });
    } catch (error) {
      console.error("[ai-optimize] mark failed error", error);
    }
    return { success: false, failed: true, message: poll.message || "AI 优化任务失败，请重试。" };
  }

  const imageFileID = await uploadImageResult(poll.imageDataUrl, taskId);
  // 幂等守卫：只有 processing -> done 的更新成功才视为完成，避免并发轮询重复处理
  let updated = 0;
  try {
    const upd = await coll.where({ _id: taskId, status: "processing" }).update({
      data: { status: "done", imageFileID, doneAt: new Date().toISOString() },
    });
    updated = (upd && upd.stats && upd.stats.updated) || 0;
  } catch (error) {
    console.error("[ai-optimize] mark done error", error);
  }
  if (!updated) {
    try {
      const again = await coll.doc(taskId).get();
      return {
        success: true,
        imageFileID: (again.data && again.data.imageFileID) || imageFileID,
        taskId,
        done: true,
        ...(await getUnlockPayload(OPENID)),
      };
    } catch (error) {
      return { success: true, imageFileID, taskId, done: true, ...(await getUnlockPayload(OPENID)) };
    }
  }

  return { success: true, imageFileID, taskId, ...(await getUnlockPayload(OPENID)) };
}

// AI 优化：action=submit 提交任务并立即返回 taskId；action=check 轮询结果（幂等扣减）
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const action = (event && event.action) || "submit";
    console.log("[ai-optimize] main", { action, OPENID });
    if (action === "check") {
      return await checkTask(OPENID, event);
    }
    return await submitTask(OPENID, event);
  } catch (error) {
    console.error("[ai-optimize] failed", error);
    return { error: "AI optimization failed", message: error.message || "未知错误" };
  }
};
