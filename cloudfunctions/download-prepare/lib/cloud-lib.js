// 拼豆云函数共享库（广告解锁版）
// 唯一源：shared/cloud-lib.js；修改后复制到各云函数目录下的 lib/cloud-lib.js。
// 注意：shared 不是云函数，不要上传；cloudfunctions/ 下每个子目录才是一个云函数。
// 数据：广告解锁额度按 openid 存储在云数据库 unlocks 集合（doc id = openid）。
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const UNLOCKS_COLLECTION = "unlocks";

// ---------------- 广告解锁额度 ----------------

function defaultUnlockState(openid) {
  return {
    openid: String(openid || ""),
    aiRemaining: 0,
    downloadRemaining: 0,
    aiUsed: 0,
    downloadUsed: 0,
    updatedAt: "",
  };
}

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

async function readUnlockState(openid) {
  const key = String(openid || "").trim();
  if (!key) return defaultUnlockState("");
  const coll = db.collection(UNLOCKS_COLLECTION);
  try {
    const res = await coll.doc(key).get();
    const doc = res.data || {};
    return {
      openid: key,
      aiRemaining: Math.max(0, Number(doc.aiRemaining) || 0),
      downloadRemaining: Math.max(0, Number(doc.downloadRemaining) || 0),
      aiUsed: Math.max(0, Number(doc.aiUsed) || 0),
      downloadUsed: Math.max(0, Number(doc.downloadUsed) || 0),
      updatedAt: String(doc.updatedAt || ""),
    };
  } catch (error) {
    // doc 不存在或集合未创建：回退查询一次，避免旧数据 / 并发首写问题
    try {
      const res = await coll.where({ openid: key }).limit(1).get();
      const doc = (res.data && res.data[0]) || null;
      if (doc) {
        return {
          openid: key,
          aiRemaining: Math.max(0, Number(doc.aiRemaining) || 0),
          downloadRemaining: Math.max(0, Number(doc.downloadRemaining) || 0),
          aiUsed: Math.max(0, Number(doc.aiUsed) || 0),
          downloadUsed: Math.max(0, Number(doc.downloadUsed) || 0),
          updatedAt: String(doc.updatedAt || ""),
        };
      }
    } catch (error2) {
      // Collection not exist yet; fall through to default.
    }
    return defaultUnlockState(key);
  }
}

async function writeUnlockState(state) {
  const key = String(state && state.openid).trim();
  if (!key) return;
  const data = { ...state, updatedAt: new Date().toISOString() };
  const coll = db.collection(UNLOCKS_COLLECTION);
  try {
    await coll.doc(key).set({ data });
  } catch (error) {
    await ensureCollection(UNLOCKS_COLLECTION);
    try {
      await coll.doc(key).set({ data });
    } catch (error2) {
      try {
        await coll.add({ _id: key, ...data });
      } catch (error3) {
        // 并发首写冲突时再试一次 set
        await coll.doc(key).set({ data });
      }
    }
  }
}

// 看完一次完整激励视频：AI 优化 +1 次、下载 +1 次（不设每日上限）
async function grantAdReward(openid) {
  const state = await readUnlockState(openid);
  state.aiRemaining = (Number(state.aiRemaining) || 0) + 1;
  state.downloadRemaining = (Number(state.downloadRemaining) || 0) + 1;
  await writeUnlockState(state);
  return state;
}

// 扣减一次 AI 优化额度；成功返回 true，额度不足返回 false
async function consumeAiCredit(openid) {
  const state = await readUnlockState(openid);
  if (Number(state.aiRemaining) <= 0) return false;
  state.aiRemaining = Number(state.aiRemaining) - 1;
  state.aiUsed = (Number(state.aiUsed) || 0) + 1;
  await writeUnlockState(state);
  return true;
}

// 扣减一次下载额度；成功返回 true，额度不足返回 false
async function consumeDownloadCredit(openid) {
  const state = await readUnlockState(openid);
  if (Number(state.downloadRemaining) <= 0) return false;
  state.downloadRemaining = Number(state.downloadRemaining) - 1;
  state.downloadUsed = (Number(state.downloadUsed) || 0) + 1;
  await writeUnlockState(state);
  return true;
}

function buildUnlockPayload(state) {
  return {
    unlocked: (Number(state.aiRemaining) || 0) > 0 || (Number(state.downloadRemaining) || 0) > 0,
    aiRemaining: Number(state.aiRemaining) || 0,
    downloadRemaining: Number(state.downloadRemaining) || 0,
  };
}

// ---------------- 火山引擎签名 + 调用（https 版） ----------------

const VOLC_API_HOST = "visual.volcengineapi.com";
const VOLC_API_REGION = "cn-north-1";
const VOLC_API_SERVICE = "cv";
const DEFAULT_PROMPT =
  "将图片优化为适合拼豆图纸的形象：保留主体特征，透明背景，chibi 可爱画风，pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality";

function getDateTimeNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function uriEscape(value) {
  return encodeURIComponent(value)
    .replace(/[^A-Za-z0-9_.~\-%]+/g, (char) => char)
    .replace(/[*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function queryParamsToString(params) {
  return Object.keys(params).sort().map((key) => `${uriEscape(key)}=${uriEscape(params[key])}`).join("&");
}

function sha256(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function getSignHeaders(headers) {
  const keys = Object.keys(headers)
    .filter((key) => !["authorization", "content-length", "content-type", "user-agent"].includes(key.toLowerCase()))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const signedHeaders = keys.map((key) => key.toLowerCase()).join(";");
  const canonicalHeaders = keys
    .map((key) => `${key.toLowerCase()}:${String(headers[key]).trim().replace(/\s+/g, " ")}`)
    .join("\n");
  return { signedHeaders, canonicalHeaders };
}

function generateSignature({ method, pathName, query, headers, bodySha, accessKeyId, secretAccessKey }) {
  const datetime = headers["X-Date"] || headers["x-date"];
  const date = datetime.substring(0, 8);
  const { signedHeaders, canonicalHeaders } = getSignHeaders(headers);
  const canonicalRequest = [
    method.toUpperCase(),
    pathName,
    queryParamsToString(query),
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodySha || sha256(""),
  ].join("\n");
  const credentialScope = [date, VOLC_API_REGION, VOLC_API_SERVICE, "request"].join("/");
  const stringToSign = ["HMAC-SHA256", datetime, credentialScope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, VOLC_API_REGION);
  const kService = hmac(kRegion, VOLC_API_SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return [
    "HMAC-SHA256",
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(" ");
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, text: buffer.toString("utf8"), buffer });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("AI 优化接口请求超时，请稍后重试。")));
    if (body) req.write(body);
    req.end();
  });
}

function normalizeProviderError(status, text, data) {
  const rawMessage = String((data && (data.message || data.error)) || "");
  const raw = `${rawMessage} ${text}`;
  if (/余额不足|欠费|arrears|insufficient.*balance|balance.*insufficient|payment required|\b402\b/i.test(raw)) {
    return `AI 接口余额不足或账户欠费，请联系管理员充值后重试（接口返回：${(rawMessage || text).slice(0, 300)}）`;
  }
  if (text.includes("50430") || /concurrent limit/i.test(raw)) {
    return "当前已有 AI 优化任务在处理中，请等待一个任务完成后再试。";
  }
  if (text.includes("50400") || /access denied|鉴权失败|invalid access/i.test(raw)) {
    return `AI 接口鉴权失败，请确认 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY 配置正确，并已开通 jimeng_t2i_v40 权限（接口返回：${(rawMessage || text).slice(0, 300)}）`;
  }
  if (text.includes("50411") || /risk|内容安全|违规/i.test(raw)) {
    return "图片未通过内容安全检测，请更换一张图片后再试。";
  }
  if (status === 429 || /throttl|限流|too many request/i.test(raw)) {
    return "AI 接口请求过于频繁，请稍后再试。";
  }
  return `AI 优化接口失败（HTTP ${status}）：${(rawMessage || text).slice(0, 500)}`;
}

async function callVolc(action, requestBody) {
  const accessKeyId = process.env.VOLC_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VOLC_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("缺少鉴权密钥，请配置 VOLC_ACCESS_KEY_ID 和 VOLC_SECRET_ACCESS_KEY。");
  }
  const body = JSON.stringify(requestBody);
  const query = { Action: action, Version: "2022-08-31" };
  const xDate = getDateTimeNow();
  const headers = { host: VOLC_API_HOST, "X-Date": xDate, "content-type": "application/json" };
  const authorization = generateSignature({
    method: "POST", pathName: "/", query, headers, bodySha: sha256(body), accessKeyId, secretAccessKey,
  });
  const response = await httpsRequest(
    {
      hostname: VOLC_API_HOST,
      path: `/?${queryParamsToString(query)}`,
      method: "POST",
      headers: {
        ...headers,
        Authorization: authorization,
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body,
  );
  console.log("[callVolc] response", {
    action,
    httpStatus: response.status,
    bodyLength: response.text.length,
    bodyHead: response.text.slice(0, 2000),
  });
  if (response.status !== 200) {
    throw new Error(normalizeProviderError(response.status, response.text));
  }
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    throw new Error(`AI 优化接口返回异常：${response.text.slice(0, 500)}`);
  }
  // 火山引擎业务码在 code 字段（个别版本为 status），code != 10000 即业务失败
  const bizCode = data.code !== undefined ? data.code : data.status;
  if (bizCode !== undefined && String(bizCode) !== "10000") {
    console.error("[callVolc] business error", {
      action,
      bizCode,
      message: (data && data.message) || response.text.slice(0, 500),
    });
    throw new Error(normalizeProviderError(response.status, response.text, data));
  }
  return data;
}

async function imageUrlToDataUrl(imageUrl) {
  if (imageUrl.startsWith("data:")) return imageUrl;
  const response = await httpsRequest(
    {
      hostname: new URL(imageUrl).hostname,
      path: new URL(imageUrl).pathname + new URL(imageUrl).search,
      method: "GET",
      headers: { "User-Agent": "pixelbeans-cloud" },
    },
    null,
  );
  if (response.status !== 200) {
    throw new Error(`AI 优化结果拉取失败：${response.status}`);
  }
  const b64 = response.buffer ? response.buffer.toString("base64") : Buffer.from(response.text, "utf8").toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

// 提交 AI 优化任务（火山引擎异步任务），立即返回 taskId，不做轮询。
// 客户端随后通过 pollImageTask 轮询结果，避免云函数单次 60s 超时限制。
async function submitImageTask(imageBase64, prompt = DEFAULT_PROMPT) {
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  const submitResult = await callVolc("CVSync2AsyncSubmitTask", {
    req_key: "jimeng_t2i_v40",
    binary_data_base64: [base64Data],
    prompt,
    scale: 0.5,
    force_single: true,
  });
  const taskId = submitResult.data?.task_id || submitResult.task_id;
  console.log("[submitImageTask] submitted", { taskId, promptLength: String(prompt || "").length });
  if (!taskId) {
    console.error("[submitImageTask] missing task_id", JSON.stringify(submitResult).slice(0, 1000));
    throw new Error(`AI 优化任务提交失败：未返回 task_id（接口响应：${JSON.stringify(submitResult).slice(0, 500)}）`);
  }
  return taskId;
}

// 查询一次 AI 优化任务结果，返回 { status: "processing" | "success" | "failed", imageDataUrl?, message? }
async function pollImageTask(taskId) {
  const result = await callVolc("CVSync2AsyncGetResult", {
    req_key: "jimeng_t2i_v40",
    task_id: taskId,
    req_json: JSON.stringify({ return_url: true }),
  });
  const taskStatus = result.data?.task_status || result.data?.status;
  console.log("[pollImageTask] result", {
    taskId,
    taskStatus,
    hasImageUrl: !!(result.data?.images?.[0]?.url || result.data?.image_urls?.[0]),
    hasBase64: !!result.data?.binary_data_base64?.[0],
    message: (result && result.message) || "",
  });
  if (taskStatus === "success" || taskStatus === "done") {
    const imageUrl = result.data?.images?.[0]?.url || result.data?.image_urls?.[0];
    const imageBase64Result = result.data?.binary_data_base64?.[0];
    let imageDataUrl = "";
    if (imageBase64Result) {
      imageDataUrl = `data:image/jpeg;base64,${imageBase64Result}`;
    } else if (imageUrl) {
      imageDataUrl = await imageUrlToDataUrl(imageUrl);
    }
    if (!imageDataUrl) throw new Error("AI 优化完成，但没有返回图片。");
    return { status: "success", imageDataUrl };
  }
  if (taskStatus === "failed") {
    return { status: "failed", message: result.message || "AI 优化任务失败。" };
  }
  return { status: "processing" };
}

// ---------------- 下载 ----------------

function normalizeFileExt(ext, fallback = ".bin") {
  const value = String(ext || "").trim().toLowerCase().replace(/^\.+/, "");
  return value ? `.${value}` : fallback;
}

async function prepareDownloadFile({ dataUrl, text, filename, ext }) {
  let buffer = null;
  let mime = "";
  let cloudPath = "";
  const fileId = crypto.randomUUID();
  if (dataUrl) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid dataUrl");
    buffer = Buffer.from(match[2], "base64");
    mime = match[1] || "image/png";
    const fallbackExt = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
    ext = normalizeFileExt(ext, fallbackExt);
    cloudPath = `downloads/${fileId}${ext}`;
  } else if (text !== null && text !== undefined) {
    buffer = Buffer.from(text, "utf8");
    ext = normalizeFileExt(ext, ".csv");
    mime = "text/csv; charset=utf-8";
    cloudPath = `downloads/${fileId}${ext}`;
  } else {
    throw new Error("Missing dataUrl or text");
  }
  console.log("[prepareDownloadFile] buffer ready", { cloudPath, byteLength: buffer.length, mime });
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer });
  console.log("[prepareDownloadFile] uploaded", { fileID: uploaded.fileID, filename: `${filename}${ext}` });
  return { fileID: uploaded.fileID, filename: `${filename}${ext}`, mime, ext };
}

// 把 AI 结果图（data URL）上传到云存储，返回 fileID。
// 云函数响应有 1MB 上限，base64 大图不能直接放返回值里。
async function uploadImageResult(dataUrl, taskId) {
  console.log("[uploadImageResult] start", { taskId, dataUrlLength: String(dataUrl || "").length });
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("AI 优化结果图片格式无效。");
  const buffer = Buffer.from(match[2], "base64");
  const mime = match[1] || "image/jpeg";
  const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
  const cloudPath = `ai-results/${taskId || crypto.randomUUID()}${ext}`;
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer });
  console.log("[uploadImageResult] uploaded", { fileID: uploaded.fileID });
  return uploaded.fileID;
}

// 按 uploadId 合并分块上传的大文件（chunks 集合里记录的各块 fileID）
// 每块是 chunks 集合里的一个文档（doc id = <uploadId>__<index>），
// 记录 uploadId/index/total/fileID；按 index 排序后下载并合并 base64 部分。
async function cleanupChunks(uploadId) {
  try {
    const coll = db.collection("chunks");
    let rows = [];
    let skip = 0;
    const pageSize = 1000;
    for (;;) {
      const res = await coll.where({ uploadId }).skip(skip).limit(pageSize).get();
      const page = res.data || [];
      rows = rows.concat(page);
      if (page.length < pageSize) break;
      skip += pageSize;
      if (rows.length >= 5000) break;
    }
    const fileIDs = rows.map((row) => row && row.fileID).filter(Boolean);
    for (let i = 0; i < fileIDs.length; i += 50) {
      await cloud.deleteFile({ fileList: fileIDs.slice(i, i + 50) });
    }
    await coll.where({ uploadId }).remove();
    console.log("[cleanupChunks] done", { uploadId, files: fileIDs.length, records: rows.length });
  } catch (error) {
    console.error("[cleanupChunks] failed", { uploadId, error: error && error.message });
  }
}

async function assembleUpload(uploadId) {
  console.log("[assembleUpload] start", { uploadId });
  const coll = db.collection("chunks");
  const pageSize = 1000;
  let rows = [];
  let skip = 0;
  for (;;) {
    const res = await coll.where({ uploadId }).skip(skip).limit(pageSize).get();
    const page = res.data || [];
    rows = rows.concat(page);
    if (page.length < pageSize) break;
    skip += pageSize;
    if (rows.length > 10000) break;
  }
  if (!rows.length) {
    console.error("[assembleUpload] no chunk records", { uploadId });
    throw new Error("分块上传记录不存在，请重新导出。");
  }
  rows.sort((a, b) => Number(a.index) - Number(b.index));
  const total = Number((rows[0] && rows[0].total) || 0) || rows.length;
  if (rows.length !== total || rows.some((p) => !p || !p.fileID)) {
    console.error("[assembleUpload] incomplete", { uploadId, count: rows.length, total });
    throw new Error("分块上传不完整，请重试。");
  }

  // Download all chunk files with limited concurrency, then merge in order.
  const parts = new Array(rows.length);
  const CONCURRENCY = 8;
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, rows.length); w += 1) {
    workers.push(
      (async () => {
        while (cursor < rows.length) {
          const i = cursor;
          cursor += 1;
          const downloaded = await cloud.downloadFile({ fileID: rows[i].fileID });
          parts[i] = downloaded.fileContent.toString("utf8");
        }
      })(),
    );
  }
  await Promise.all(workers);

  const merged = parts.join("");
  console.log("[assembleUpload] merged", { uploadId, chunkCount: rows.length, base64Length: merged.length });
  const buffer = Buffer.from(merged, "base64");
  // 组装完成后立即清理该 uploadId 的分块文件与记录，避免云存储持续增长
  await cleanupChunks(uploadId);
  return buffer;
}

module.exports = {
  cloud,
  db,
  readUnlockState,
  writeUnlockState,
  grantAdReward,
  consumeAiCredit,
  consumeDownloadCredit,
  buildUnlockPayload,
  submitImageTask,
  pollImageTask,
  prepareDownloadFile,
  uploadImageResult,
  assembleUpload,
};
