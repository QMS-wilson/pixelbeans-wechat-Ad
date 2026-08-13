const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SHARES_COLLECTION = "shares";
const SHARE_EXPIRE_DAYS = 30;

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

// 创建分享：把客户端暂存的文件复制到 shares/<shareId>/（云函数上传，确保接收方可读），
// 删除暂存文件，并在 shares 集合写入分享记录。
async function createShare(OPENID, event) {
  const {
    id,
    name,
    savedAt,
    cols,
    rows,
    paletteIndex,
    gridSize,
    mergeLevel,
    gridLineOn,
    sourceFingerprint,
    sourceType,
    selectedColorCode,
    jsonFileID,
    originalFileID,
    previewFileID,
    paid,
  } = event || {};
  if (!jsonFileID) {
    return { error: "Missing file", message: "缺少图纸文件。" };
  }

  const shareId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const copyFile = async (fileID, filename) => {
    if (!fileID) return "";
    try {
      const downloaded = await cloud.downloadFile({ fileID });
      const uploaded = await cloud.uploadFile({
        cloudPath: `shares/${shareId}/${filename}`,
        fileContent: downloaded.fileContent,
      });
      return uploaded.fileID;
    } catch (error) {
      console.error("[share-pattern] copy file failed", { filename, error: error && error.message });
      return "";
    }
  };

  const [jsonCopy, origCopy, prevCopy] = await Promise.all([
    copyFile(jsonFileID, "pattern.json"),
    copyFile(originalFileID, "original.png"),
    copyFile(previewFileID, "preview.png"),
  ]);
  if (!jsonCopy) {
    return { error: "Copy failed", message: "图纸复制失败，请重试。" };
  }

  // 清理客户端暂存文件
  try {
    await cloud.deleteFile({ fileList: [jsonFileID, originalFileID, previewFileID].filter(Boolean) });
  } catch (error) {
    console.error("[share-pattern] staging cleanup failed", { error: error && error.message });
  }

  const record = {
    shareId,
    creator: OPENID,
    name: String(name || "拼豆图纸").slice(0, 60),
    savedAt: Number(savedAt) || Date.now(),
    cols: Number(cols) || 0,
    rows: Number(rows) || 0,
    paletteIndex: paletteIndex === undefined ? null : Number(paletteIndex),
    gridSize: gridSize === undefined ? null : Number(gridSize),
    mergeLevel: mergeLevel === undefined ? null : Number(mergeLevel),
    gridLineOn: !!gridLineOn,
    sourceFingerprint: String(sourceFingerprint || ""),
    sourceType: String(sourceType || "blank"),
    selectedColorCode: String(selectedColorCode || ""),
    jsonFileID: jsonCopy,
    originalFileID: origCopy,
    previewFileID: prevCopy,
    paid: !!paid,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SHARE_EXPIRE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };

  try {
    await ensureCollection(SHARES_COLLECTION);
    await db.collection(SHARES_COLLECTION).doc(shareId).set({ data: record });
  } catch (error) {
    if (isCollectionNotExist(error)) {
      await ensureCollection(SHARES_COLLECTION);
      await db.collection(SHARES_COLLECTION).doc(shareId).set({ data: record });
    } else {
      throw error;
    }
  }

  console.log("[share-pattern] created", { shareId, OPENID, name: record.name });
  return { success: true, shareId, path: `/pages/share/share?shareId=${shareId}` };
}

// 读取分享：任何用户凭 shareId 可查看（30 天内有效）
async function getShare(event) {
  const shareId = String((event && event.shareId) || "").trim();
  if (!shareId) {
    return { error: "Missing share id", message: "分享链接无效。" };
  }
  let doc = null;
  try {
    const res = await db.collection(SHARES_COLLECTION).doc(shareId).get();
    doc = res.data || null;
  } catch (error) {
    return { error: "Share not found", message: "分享不存在或已失效。" };
  }
  if (!doc) {
    return { error: "Share not found", message: "分享不存在或已失效。" };
  }
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) {
    return { error: "Share expired", message: "分享已过期。" };
  }
  return {
    success: true,
    share: {
      id: doc.shareId || doc._id,
      name: doc.name || "拼豆图纸",
      savedAt: doc.savedAt || 0,
      cols: Number(doc.cols) || 0,
      rows: Number(doc.rows) || 0,
      paletteIndex: doc.paletteIndex,
      gridSize: doc.gridSize,
      mergeLevel: doc.mergeLevel,
      gridLineOn: !!doc.gridLineOn,
      sourceFingerprint: doc.sourceFingerprint || "",
      sourceType: doc.sourceType || "blank",
      selectedColorCode: doc.selectedColorCode || "",
      fileID: doc.jsonFileID,
      originalFileID: doc.originalFileID || "",
      previewFileID: doc.previewFileID || "",
      paid: !!doc.paid,
      createdAt: doc.createdAt || "",
    },
  };
}

// 分享：action=create 由分享者调用；action=get 由被分享者调用
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const action = (event && event.action) || "get";
    console.log("[share-pattern] main", { action, OPENID });
    if (action === "create") {
      return await createShare(OPENID, event);
    }
    return await getShare(event);
  } catch (error) {
    console.error("[share-pattern] failed", error);
    return { error: "Share failed", message: error.message || "分享服务异常" };
  }
};
