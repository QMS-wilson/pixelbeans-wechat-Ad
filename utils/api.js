// 云函数版接口封装：把原有 /api/* 路径映射到云函数，页面代码无需改动。
const PATH_TO_FUNCTION = {
  "/api/access-status": "access-status",
  "/api/redeem-card": "redeem-card",
  "/api/logout-access": "logout-access",
  "/api/ai-optimize": "ai-optimize",
  "/api/download-prepare": "download-prepare",
};

function callFunction(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        const result = res && res.result;
        if (result && result.error) {
          const error = new Error(result.message || result.error);
          error.status = result.status || 400;
          reject(error);
          return;
        }
        resolve(result || {});
      },
      fail: (err) => {
        const message = err && err.errMsg ? `云函数调用失败：${err.errMsg}` : "云函数调用失败，请检查云开发环境。";
        reject(new Error(message));
      },
    });
  });
}

// 兼容旧调用：requestJson("/api/xxx", { method, data })
function requestJson(path, options = {}) {
  const cleanPath = String(path || "").split("?")[0];
  const name = PATH_TO_FUNCTION[cleanPath];
  if (!name) {
    return Promise.reject(new Error(`未找到云函数映射：${cleanPath}`));
  }
  return callFunction(name, (options && options.data) || {});
}

// 大图分块上传：把 base64 切成小块，逐块调用 upload-chunk 云函数（云函数内部写入云存储并记录分块）。
// 背景：云函数入参有大小限制（约 100KB），且客户端直传大文件容易连接重置，所以必须走分块。
// 参数：dataUrl 为 base64 数据；prefix 用于区分用途（ai-input/download）；onProgress 逐块上报 (done, total) 进度。
function uploadDataChunks(dataUrl, prefix = "upload", onProgress) {
  return new Promise((resolve, reject) => {
    const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      reject(new Error("图片数据格式无效"));
      return;
    }
    const mime = match[1] || "image/jpeg";
    const b64 = match[2];
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    // 本次上传的唯一批次 ID：分块云存储目录与 chunks 集合记录都以它为标识
    const uploadId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 云函数文本请求体上限 100KB，这里用 64KB 分块留足余量
    const CHUNK_SIZE = 64 * 1024;
    const chunks = [];
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      chunks.push(b64.slice(i, i + CHUNK_SIZE));
    }
    const total = chunks.length;
    console.log("[uploadDataChunks] start", { prefix, total, b64Length: b64.length });
    // 单块上传：调用 upload-chunk 云函数写入该块，失败自动重试一次（网络抖动兜底）
    const uploadChunk = (index) =>
      callFunction("upload-chunk", { uploadId, index, total, data: chunks[index] }).catch((error) => {
        console.warn("[uploadDataChunks] chunk failed, retrying", { uploadId, index, error: error && error.message });
        return callFunction("upload-chunk", { uploadId, index, total, data: chunks[index] });
      });
    (async () => {
      try {
        // 3 路并发上传，加快速度（fileID 按 index 记录，乱序无影响）
        let cursor = 0;
        let done = 0;
        // 每传完一块回调一次进度（done/total），供导出页进度条实时更新
        const reportProgress = () => {
          if (typeof onProgress === "function") onProgress(done, total);
        };
        const workers = [];
        for (let w = 0; w < Math.min(3, total); w += 1) {
          workers.push(
            (async () => {
              while (cursor < total) {
                const index = cursor;
                cursor += 1;
                await uploadChunk(index);
                done += 1;
                reportProgress();
              }
            })(),
          );
        }
        // 等待所有并发上传任务结束
        await Promise.all(workers);
        reportProgress();
        // 全部上传完成：返回批次 ID / 扩展名 / 总块数，供服务端组装文件
        console.log("[uploadDataChunks] done", { uploadId, total });
        resolve({ uploadId, ext, total });
      } catch (error) {
        console.error("[uploadDataChunks] failed", { uploadId, error: error && error.message });
        reject(new Error(`图片分块上传失败：${(error && error.message) || ""}`));
      }
    })();
  });
}

module.exports = {
  API_BASE: "",
  requestJson,
  callFunction,
  uploadDataChunks,
};
