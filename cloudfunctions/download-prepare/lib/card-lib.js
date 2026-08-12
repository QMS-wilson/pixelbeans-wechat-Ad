// 拼豆卡密 - 云函数共享库
// 本文件是唯一源（shared/card-lib.js）：修改后复制到每个云函数目录下的 lib/card-lib.js。
// 注意：shared 不是云函数，不要上传；cloudfunctions/ 下每个子目录才是一个云函数。
// 数据：cards.json 整体作为 JSON 文档存在云数据库 meta 集合（_id = "store"），保持原格式。
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const META_COLLECTION = "meta";
const META_DOC_ID = "store";

// ---------------- 存储 ----------------

async function readStore() {
  try {
    const res = await db.collection(META_COLLECTION).doc(META_DOC_ID).get();
    const doc = res.data;
    if (!doc) return { cards: [], logs: [], freeTrials: {}, bindings: {} };
    // 兼容导入结构：
    // 1) 文档形如 { _id:"store", data:{ cards, logs, freeTrials, bindings } }
    // 2) 字段直接平铺在文档上：{ _id:"store", cards, logs, freeTrials }
    // 3) data 字段是 JSON 字符串
    let store = doc.data;
    if (typeof store === "string") {
      try {
        store = JSON.parse(store);
      } catch {
        store = null;
      }
    }
    if (!store || typeof store !== "object" || !Array.isArray(store.cards)) {
      store = doc;
    }
    return upgradeStore(store);
  } catch (error) {
    return { cards: [], logs: [], freeTrials: {}, bindings: {} };
  }
}

async function writeStore(store) {
  const payload = { data: store };
  try {
    await db.collection(META_COLLECTION).doc(META_DOC_ID).set(payload);
  } catch (error) {
    try {
      await db.collection(META_COLLECTION).add({ _id: META_DOC_ID, data: store });
    } catch (error2) {
      // 并发首写冲突时再试一次 set
      await db.collection(META_COLLECTION).doc(META_DOC_ID).set(payload);
    }
  }
}

// ---------------- 纯逻辑（与原 card-service.js 一致） ----------------

function sanitizeCardCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function normalizeImageHash(value) {
  return String(value || "").trim();
}

function normalizeCardRecord(card) {
  if (!card || typeof card !== "object") return null;
  const normalizedStatus = card.status === "used" ? "active" : card.status;
  const rawImageHash = normalizeImageHash(card.imageHash);
  const boundImages = Array.isArray(card.boundImages)
    ? card.boundImages.map(normalizeImageHash).filter(Boolean).slice(0, 3)
    : rawImageHash ? [rawImageHash] : [];
  return {
    code: sanitizeCardCode(card.code),
    status: normalizedStatus === "exhausted" ? "exhausted" : normalizedStatus === "active" ? "active" : "unused",
    note: String(card.note || ""),
    createdAt: card.createdAt || "",
    usedAt: card.usedAt || card.redeemedAt || "",
    redeemedAt: card.redeemedAt || card.usedAt || "",
    exhaustedAt: card.exhaustedAt || "",
    imageHash: boundImages[boundImages.length - 1] || rawImageHash || "",
    boundImages,
    aiOptimizeCount: Number(card.aiOptimizeCount) || 0,
    downloadCount: Number(card.downloadCount) || 0,
  };
}

function normalizeLogRecord(log) {
  if (!log || typeof log !== "object") return null;
  return {
    id: String(log.id || crypto.randomUUID()),
    type: String(log.type || "unknown"),
    cardCode: sanitizeCardCode(log.cardCode || ""),
    imageHash: String(log.imageHash || ""),
    detail: String(log.detail || ""),
    createdAt: log.createdAt || new Date().toISOString(),
    openid: String(log.openid || ""),
  };
}

function normalizeFreeTrials(freeTrials) {
  const normalized = {};
  if (freeTrials && typeof freeTrials === "object") {
    Object.entries(freeTrials).forEach(([deviceId, trial]) => {
      if (deviceId === "byIp") return;
      normalized[String(deviceId)] = {
        count: Math.max(0, Number(trial?.count) || 0),
        lastUsedAt: String(trial?.lastUsedAt || ""),
        imageHash: String(trial?.imageHash || ""),
      };
    });
    if (freeTrials.byIp && typeof freeTrials.byIp === "object") {
      normalized.byIp = {};
      Object.entries(freeTrials.byIp).forEach(([ipKey, trial]) => {
        normalized.byIp[String(ipKey)] = {
          count: Math.max(0, Number(trial?.count) || 0),
          lastUsedAt: String(trial?.lastUsedAt || ""),
          imageHash: String(trial?.imageHash || ""),
        };
      });
    }
  }
  return normalized;
}

function normalizeBindings(bindings) {
  const normalized = {};
  if (bindings && typeof bindings === "object") {
    Object.entries(bindings).forEach(([openid, binding]) => {
      if (!openid || !binding || typeof binding !== "object") return;
      normalized[String(openid)] = {
        cardCode: sanitizeCardCode(binding.cardCode || ""),
        redeemedAt: String(binding.redeemedAt || ""),
      };
    });
  }
  return normalized;
}

function upgradeStore(store) {
  let changed = false;
  const cards = Array.isArray(store?.cards) ? store.cards : [];
  const logs = Array.isArray(store?.logs) ? store.logs : [];
  const freeTrials = normalizeFreeTrials(store?.freeTrials);
  const bindings = normalizeBindings(store?.bindings);
  const normalizedCards = cards.map((card) => {
    const normalized = normalizeCardRecord(card);
    if (JSON.stringify(normalized) !== JSON.stringify(card)) changed = true;
    return normalized;
  });
  const normalizedLogs = logs.map((log) => normalizeLogRecord(log)).filter(Boolean);
  if (!Array.isArray(store?.logs) || JSON.stringify(normalizedLogs) !== JSON.stringify(logs)) changed = true;
  if (!store?.freeTrials || typeof store.freeTrials !== "object" || JSON.stringify(freeTrials) !== JSON.stringify(store.freeTrials)) {
    changed = true;
  }
  if (!store?.bindings || typeof store.bindings !== "object" || JSON.stringify(bindings) !== JSON.stringify(store.bindings)) {
    changed = true;
  }
  return { cards: normalizedCards, logs: normalizedLogs, freeTrials, bindings };
}

function appendLog(store, openid, { type, cardCode = "", imageHash = "", detail = "" }) {
  if (!Array.isArray(store.logs)) store.logs = [];
  store.logs.push(
    normalizeLogRecord({
      type,
      cardCode,
      imageHash,
      detail,
      openid,
    }),
  );
  if (store.logs.length > 1000) store.logs = store.logs.slice(-1000);
}

function findCardByCode(store, code) {
  return store.cards.find((item) => item.code === sanitizeCardCode(code));
}

function getCardRemaining(card) {
  return {
    aiOptimizeCount: Number(card.aiOptimizeCount) || 0,
    downloadCount: Number(card.downloadCount) || 0,
    aiOptimizeRemaining: Math.max(0, 3 - (Number(card.aiOptimizeCount) || 0)),
    downloadRemaining: Math.max(0, 3 - (Number(card.downloadCount) || 0)),
  };
}

function buildAccessPayload(card) {
  if (!card) {
    return {
      paid: false, redeemed: false, cardCode: "", redeemedAt: "", cardStatus: "none",
      imageHash: "", aiOptimizeCount: 0, aiOptimizeRemaining: 0, downloadCount: 0, downloadRemaining: 0, exhausted: false,
    };
  }
  const counters = getCardRemaining(card);
  return {
    paid: card.status === "active",
    redeemed: Boolean(card.redeemedAt || card.usedAt),
    cardCode: card.code || "",
    redeemedAt: card.redeemedAt || card.usedAt || "",
    cardStatus: card.status,
    imageHash: card.imageHash || "",
    aiOptimizeCount: counters.aiOptimizeCount,
    aiOptimizeRemaining: counters.aiOptimizeRemaining,
    downloadCount: counters.downloadCount,
    downloadRemaining: counters.downloadRemaining,
    exhausted: card.status === "exhausted",
  };
}

function exhaustCard(card) {
  card.status = "exhausted";
  card.exhaustedAt = new Date().toISOString();
}

function consumeCardAction(card, actionType) {
  if (actionType === "ai") {
    card.aiOptimizeCount = (Number(card.aiOptimizeCount) || 0) + 1;
  } else if (actionType === "download") {
    card.downloadCount = (Number(card.downloadCount) || 0) + 1;
  }
}

function assertCardAction(card, imageHash, actionType) {
  if (!card) return { ok: false, status: 403, message: "请先兑换卡密后再操作。" };
  if (card.status === "exhausted") return { ok: false, status: 403, message: "当前卡密已失效，请使用新卡密。" };
  if (card.status !== "active") return { ok: false, status: 403, message: "当前卡密尚未激活，请重新兑换。" };
  const normalizedHash = normalizeImageHash(imageHash);
  if (!normalizedHash) return { ok: false, status: 400, message: "未识别到当前图片，请重新上传后重试。" };
  const boundImages = Array.isArray(card.boundImages) ? card.boundImages : [];
  if (boundImages.length >= 3 && !boundImages.includes(normalizedHash)) {
    return { ok: false, status: 409, message: "当前卡密已绑定多张图片（最多 3 张），请更换新卡密。" };
  }
  const currentCount = actionType === "ai" ? Number(card.aiOptimizeCount) || 0 : Number(card.downloadCount) || 0;
  if (currentCount >= 3) {
    exhaustCard(card);
    return { ok: false, status: 403, message: "当前卡密已超过使用上限，现已作废。" };
  }
  return { ok: true, imageHash: normalizedHash };
}

function bindCardImage(card, imageHash) {
  const normalizedHash = normalizeImageHash(imageHash);
  if (!card || !normalizedHash) return { ok: true };
  if (!Array.isArray(card.boundImages)) card.boundImages = [];
  if (!card.boundImages.includes(normalizedHash)) {
    if (card.boundImages.length >= 3) {
      return { ok: false, status: 409, message: "当前卡密已绑定多张图片（最多 3 张），请更换新卡密。" };
    }
    card.boundImages.push(normalizedHash);
  }
  card.imageHash = normalizedHash;
  return { ok: true };
}

function makeCardCode(prefix = "PB", length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let body = "";
  for (let index = 0; index < length; index += 1) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function getFreeTrialStatus(store, deviceId) {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) return null;
  const trial = store?.freeTrials?.[normalizedDeviceId];
  return { deviceId: normalizedDeviceId, used: Boolean(trial && Number(trial.count) >= 1), count: Number(trial?.count) || 0 };
}

function consumeFreeTrial(store, deviceId, imageHash) {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) return;
  if (!store.freeTrials) store.freeTrials = {};
  store.freeTrials[normalizedDeviceId] = {
    count: (Number(store.freeTrials[normalizedDeviceId]?.count) || 0) + 1,
    lastUsedAt: new Date().toISOString(),
    imageHash: String(imageHash || ""),
  };
}

// ---------------- openid 绑定 ----------------

function getBinding(store, openid) {
  if (!openid) return null;
  return store?.bindings?.[openid] || null;
}

function bindOpenid(store, openid, card) {
  if (!openid) return;
  if (!store.bindings) store.bindings = {};
  store.bindings[openid] = {
    cardCode: card.code,
    redeemedAt: card.redeemedAt || card.usedAt || new Date().toISOString(),
  };
}

function unbindOpenid(store, openid) {
  if (!openid || !store.bindings) return;
  delete store.bindings[openid];
}

// ---------------- 管理端 ----------------

function requireAdmin(adminKey) {
  const expected = process.env.CARD_ADMIN_KEY || "";
  return Boolean(expected && adminKey && adminKey === expected);
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

function normalizeProviderError(status, text) {
  if (text.includes("50430") || text.includes("Concurrent Limit")) {
    return "当前已有 AI 优化任务在处理中，请等待一个任务完成后再试。";
  }
  if (text.includes("50400") || text.includes("Access Denied")) {
    return "鉴权失败，请确认 AccessKey/SecretKey 配置正确，并已开通 jimeng_t2i_v40 权限。";
  }
  if (text.includes("50411") || text.includes("Risk")) {
    return "图片未通过内容安全检测，请更换一张图片后再试。";
  }
  return `AI 优化接口失败：${status} ${text}`;
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
  if (response.status !== 200) {
    throw new Error(normalizeProviderError(response.status, response.text));
  }
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    throw new Error(`AI 优化接口返回异常：${response.text}`);
  }
  if (data.status && data.status !== 10000) {
    throw new Error(normalizeProviderError(response.status, response.text));
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

async function optimizeImage(imageBase64, prompt = DEFAULT_PROMPT) {
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  const submitResult = await callVolc("CVSync2AsyncSubmitTask", {
    req_key: "jimeng_t2i_v40",
    binary_data_base64: [base64Data],
    prompt,
    scale: 0.5,
    force_single: true,
  });
  const taskId = submitResult.data?.task_id || submitResult.task_id;
  console.log("[optimizeImage] submitted", { taskId, promptLength: String(prompt || "").length });
  if (!taskId) throw new Error("AI 优化任务提交失败：未返回 task_id。");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await callVolc("CVSync2AsyncGetResult", {
      req_key: "jimeng_t2i_v40",
      task_id: taskId,
      req_json: JSON.stringify({ return_url: true }),
    });
    const taskStatus = result.data?.task_status || result.data?.status;
    if (attempt % 10 === 0) console.log("[optimizeImage] polling", { taskId, attempt, taskStatus });
    if (taskStatus === "success" || taskStatus === "done") {
      console.log("[optimizeImage] success", { taskId, attempt });
      const imageUrl = result.data?.images?.[0]?.url || result.data?.image_urls?.[0];
      const imageBase64Result = result.data?.binary_data_base64?.[0];
      if (imageBase64Result) return { imageUrl: `data:image/jpeg;base64,${imageBase64Result}`, taskId };
      if (imageUrl) return { imageUrl: await imageUrlToDataUrl(imageUrl), taskId };
      throw new Error("AI 优化完成，但没有返回图片。");
    }
    if (taskStatus === "failed") {
      console.error("[optimizeImage] task failed", { taskId, attempt, message: result.message || "AI 优化任务失败" });
      throw new Error(result.message || "AI 优化任务失败。");
    }
  }
  console.error("[optimizeImage] timeout", { taskId });
  throw new Error("AI 优化超时，请稍后重试。");
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
  if (!taskId) throw new Error("AI 优化任务提交失败：未返回 task_id。");
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
// Reassemble a chunked upload. Each chunk is a dedicated doc in the chunks
// collection (doc id = <uploadId>__<index>) with uploadId/index/total/fileID.
// Query by uploadId, sort by index, then download and merge the base64 parts.
// Reassemble a chunked upload. Each chunk is a dedicated doc in the chunks
// collection (doc id = <uploadId>__<index>) with uploadId/index/total/fileID.
// Query by uploadId, sort by index, then download and merge the base64 parts.
// Reassemble a chunked upload. Each chunk is a dedicated doc in the chunks
// collection (doc id = <uploadId>__<index>) with uploadId/index/total/fileID.
// Query by uploadId, sort by index, then download and merge the base64 parts.
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
  readStore,
  writeStore,
  upgradeStore,
  sanitizeCardCode,
  normalizeImageHash,
  findCardByCode,
  getCardRemaining,
  buildAccessPayload,
  exhaustCard,
  consumeCardAction,
  assertCardAction,
  bindCardImage,
  makeCardCode,
  appendLog,
  getFreeTrialStatus,
  consumeFreeTrial,
  getBinding,
  bindOpenid,
  unbindOpenid,
  requireAdmin,
  optimizeImage,
  submitImageTask,
  pollImageTask,
  prepareDownloadFile,
  uploadImageResult,
  assembleUpload,
};
