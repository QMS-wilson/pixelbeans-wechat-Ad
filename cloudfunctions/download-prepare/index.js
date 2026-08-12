const cloud = require("wx-server-sdk");
const {
  readUnlockState,
  consumeDownloadCredit,
  buildUnlockPayload,
  prepareDownloadFile,
  assembleUpload,
} = require("./lib/cloud-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 下载预处理：校验广告解锁额度、扣次，生成文件上传到云存储，返回 fileID
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const { filename = "export", dataUrl, dataFileID, dataUploadId, dataExt, text } = event || {};
    const safeFilename = String(filename).replace(/[/\\\r\n\0]/g, "_").replace(/\.[^/.]+$/, "");
    console.log("[download-prepare] start", {
      OPENID,
      safeFilename,
      hasDataUrl: !!dataUrl,
      hasDataFileID: !!dataFileID,
      hasDataUploadId: !!dataUploadId,
      textLength: text ? String(text).length : 0,
    });

    const state = await readUnlockState(OPENID);
    if (Number(state.downloadRemaining) <= 0) {
      return { error: "Download denied", message: "下载额度已用完，看完广告后可继续下载。" };
    }

    // 图片大文件走云存储：前端传 dataFileID，函数下载后转 dataUrl
    let resolvedDataUrl = dataUrl;
    if (!resolvedDataUrl && dataFileID) {
      const downloaded = await cloud.downloadFile({ fileID: dataFileID });
      const mime = /\.png/i.test(dataFileID) ? "image/png" : "image/jpeg";
      resolvedDataUrl = `data:${mime};base64,${downloaded.fileContent.toString("base64")}`;
    }
    if (!resolvedDataUrl && dataUploadId) {
      const assembled = await assembleUpload(dataUploadId);
      const mime = dataExt === "png" ? "image/png" : dataExt === "webp" ? "image/webp" : "image/jpeg";
      resolvedDataUrl = `data:${mime};base64,${assembled.toString("base64")}`;
    }
    console.log("[download-prepare] data ready", {
      resolvedDataUrlLength: resolvedDataUrl ? resolvedDataUrl.length : 0,
    });
    const prepared = await prepareDownloadFile({
      dataUrl: resolvedDataUrl,
      text,
      filename: safeFilename,
      ext: dataExt,
    });
    // 文件生成成功后扣减一次下载额度
    const consumed = await consumeDownloadCredit(OPENID);

    console.log("[download-prepare] prepared", { fileID: prepared.fileID, filename: prepared.filename, mime: prepared.mime });
    return {
      success: true,
      fileID: prepared.fileID,
      filename: prepared.filename,
      mime: prepared.mime,
      consumed,
      ...buildUnlockPayload(await readUnlockState(OPENID)),
    };
  } catch (error) {
    console.error("[download-prepare] failed", error);
    return { error: "Download prepare failed", message: error.message || "下载准备失败" };
  }
};
