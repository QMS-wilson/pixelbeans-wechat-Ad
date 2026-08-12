const cloud = require("wx-server-sdk");
const {
  readStore,
  writeStore,
  getBinding,
  findCardByCode,
  getFreeTrialStatus,
  consumeFreeTrial,
  normalizeImageHash,
  assertCardAction,
  bindCardImage,
  consumeCardAction,
  buildAccessPayload,
  appendLog,
  submitImageTask,
  pollImageTask,
  uploadImageResult,
  assembleUpload,
} = require("./lib/card-lib.js");

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
async function recordTask({ taskId, OPENID, cardCode = "", imageHash = "", freeTrialUsed = false, deviceId = "" }) {
  await ensureCollection(AI_TASKS_COLLECTION);
  const record = {
    openid: OPENID,
    cardCode: String(cardCode || ""),
    imageHash: String(imageHash || ""),
    freeTrialUsed: !!freeTrialUsed,
    deviceId: String(deviceId || ""),
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

// 提交 AI 优化任务：校验资格 -> 组装图片 -> 提交火山引擎 -> 记录任务并立即返回 taskId
async function submitTask(OPENID, event) {
  const { imageBase64, imageFileID: inputFileID, imageUploadId, prompt, imageHash, freeTrial, deviceId } = event || {};
  console.log("[ai-optimize] submit start", {
    OPENID,
    promptLength: prompt ? String(prompt).length : 0,
    imageHash,
    freeTrial: !!freeTrial,
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

  const store = await readStore();
  const binding = getBinding(store, OPENID);
  const card = binding ? findCardByCode(store, binding.cardCode) : null;
  const isTrial = !card && freeTrial === true;

  if (isTrial) {
    const deviceTrial = getFreeTrialStatus(store, deviceId);
    const openidTrial = getFreeTrialStatus(store, `openid:${OPENID}`);
    if (!deviceTrial || deviceTrial.used || (openidTrial && openidTrial.used)) {
      return { error: "AI optimization denied", message: "免费 AI 体验次数已用完，请兑换卡密后继续使用。" };
    }
    const normalizedHash = normalizeImageHash(imageHash);
    if (!normalizedHash) {
      return { error: "AI optimization denied", message: "未识别到当前图片，请重新上传后重试。" };
    }
    console.log("[ai-optimize] trial submit start", { deviceId });
    const taskId = await submitImageTask(resolvedImageBase64, prompt);
    await recordTask({ taskId, OPENID, imageHash: normalizedHash, freeTrialUsed: true, deviceId });
    console.log("[ai-optimize] trial submitted", { taskId });
    return { success: true, taskId, submitted: true };
  }

  if (!card) {
    return { error: "AI optimization denied", message: "请先兑换卡密后再操作。" };
  }
  const allowed = assertCardAction(card, imageHash, "ai");
  if (!allowed.ok) {
    await writeStore(store);
    return { error: "AI optimization denied", message: allowed.message };
  }
  const bindResult = bindCardImage(card, allowed.imageHash);
  if (!bindResult.ok) {
    await writeStore(store);
    return { error: "AI optimization denied", message: bindResult.message };
  }
  // 提交前先持久化图片绑定，避免并发重复提交
  await writeStore(store);

  console.log("[ai-optimize] paid submit start");
  const taskId = await submitImageTask(resolvedImageBase64, prompt);
  await recordTask({ taskId, OPENID, cardCode: card.code, imageHash: allowed.imageHash, freeTrialUsed: false });
  console.log("[ai-optimize] paid submitted", { taskId });
  return { success: true, taskId, submitted: true, ...buildAccessPayload(card) };
}

// 查询 AI 任务结果（客户端轮询）：成功后上传结果图并幂等扣减次数
async function getAccessPayload(OPENID) {
  try {
    const store = await readStore();
    const binding = getBinding(store, OPENID);
    const card = binding ? findCardByCode(store, binding.cardCode) : null;
    return card ? buildAccessPayload(card) : {};
  } catch (error) {
    return {};
  }
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
      ...(await getAccessPayload(OPENID)),
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
  // 幂等守卫：只有 processing -> done 的更新成功才扣减次数，避免并发轮询重复扣费
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
        ...(await getAccessPayload(OPENID)),
      };
    } catch (error) {
      return { success: true, imageFileID, taskId, done: true, ...(await getAccessPayload(OPENID)) };
    }
  }

  const store = await readStore();
  const binding = getBinding(store, OPENID);
  const card = binding ? findCardByCode(store, binding.cardCode) : null;
  // 扣减提交时锁定的卡密，避免轮询期间用户更换卡密导致扣错
  const taskCard = task.cardCode ? findCardByCode(store, task.cardCode) : null;
  if (task.freeTrialUsed) {
    consumeFreeTrial(store, task.deviceId || OPENID, task.imageHash || "");
    consumeFreeTrial(store, `openid:${OPENID}`, task.imageHash || "");
    appendLog(store, OPENID, { type: "ai_free_trial", imageHash: task.imageHash || "", detail: "free trial ai optimize" });
  } else if (taskCard) {
    consumeCardAction(taskCard, "ai");
    appendLog(store, OPENID, {
      type: "ai_optimize",
      cardCode: taskCard.code,
      imageHash: taskCard.imageHash || task.imageHash || "",
      detail: "ai optimize success",
    });
  }
  await writeStore(store);
  return { success: true, imageFileID, taskId, ...(card ? buildAccessPayload(card) : {}) };
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
