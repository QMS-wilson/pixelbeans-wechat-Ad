const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CHUNKS_COLLECTION = "chunks";

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

// Chunked upload: the client splits large base64 data into small pieces and
// calls this function once per piece. Each piece is written to cloud storage
// (chunks/<uploadId>/<index>.b64) and its fileID is recorded in a dedicated
// chunk doc (chunks collection, doc id = <uploadId>__<index>). doc.set()
// creates the doc when missing and is safe for retries and concurrency.
exports.main = async (event) => {
  try {
    const { uploadId, index, total, data } = event || {};
    if (!uploadId || typeof index !== "number" || !total || typeof data !== "string" || !data) {
      return { error: "Invalid chunk", message: "分块参数不完整。" };
    }
    if (data.length > 600 * 1024) {
      return { error: "Chunk too large", message: "单块过大（超过600KB）。" };
    }

    console.log("[upload-chunk] start", { uploadId, index, total, dataLength: data.length });

    // Make sure the chunks collection exists before any write.
    await ensureCollection(CHUNKS_COLLECTION);

    const uploaded = await cloud.uploadFile({
      cloudPath: `chunks/${uploadId}/${index}.b64`,
      fileContent: data,
    });
    console.log("[upload-chunk] uploaded", { uploadId, index, fileID: uploaded.fileID });

    const coll = db.collection(CHUNKS_COLLECTION);
    const chunkId = `${uploadId}__${index}`;
    const record = {
      uploadId,
      index,
      total,
      fileID: uploaded.fileID,
      createdAt: new Date().toISOString(),
    };
    try {
      await coll.doc(chunkId).set({ data: record });
    } catch (error) {
      if (isCollectionNotExist(error)) {
        await ensureCollection(CHUNKS_COLLECTION);
        await coll.doc(chunkId).set({ data: record });
      } else {
        throw error;
      }
    }

    console.log("[upload-chunk] recorded", { uploadId, index });
    return { success: true, index };
  } catch (error) {
    console.error("[upload-chunk] failed", { uploadId, index }, error);
    return {
      error: "Chunk upload failed",
      message: (error && error.message) || "分块上传失败",
    };
  }
};