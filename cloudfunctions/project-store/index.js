const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PROJECTS_COLLECTION = "projects";

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

// 项目库云存储：
// 图纸 JSON 由客户端直接上传到云存储（projects/<id>.json，避开云函数入参大小限制）；
// 本函数负责元数据（projects 集合，按 openid 隔离）的查询 / 保存 / 删除。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event || {};
  console.log("[project-store] start", { action, OPENID });
  try {
    await ensureCollection(PROJECTS_COLLECTION);
    const coll = db.collection(PROJECTS_COLLECTION);

    if (action === "list") {
      const res = await coll.where({ openid: OPENID }).orderBy("savedAt", "desc").limit(100).get();
      // 文档主键是项目 id（_id），这里统一补上 id 字段，方便前端合并本地/云端列表
      const projects = (res.data || []).map((doc) => ({ ...doc, id: doc._id }));
      console.log("[project-store] list done", { count: projects.length });
      return { success: true, projects };
    }

    if (action === "saveMeta") {
      const { id, name, savedAt, cols, rows, paletteIndex, gridSize, mergeLevel, gridLineOn, sourceFingerprint, sourceType, selectedColorCode, fileID, originalFileID, previewFileID } = event || {};
      if (!id || !fileID) {
        return { error: "Missing id or fileID", message: "缺少项目 ID 或文件 ID。" };
      }
      // 归属校验：已存在的文档属于其他 openid 时禁止覆盖
      let existing = null;
      try {
        const res = await coll.doc(id).get();
        existing = res.data || null;
      } catch (error) {
        existing = null;
      }
      if (existing && existing.openid && existing.openid !== OPENID) {
        return { error: "Forbidden", message: "无权覆盖他人项目。" };
      }
      const record = {
        id,
        openid: OPENID,
        name: String(name || "").slice(0, 60),
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
        fileID,
        originalFileID: String(originalFileID || ""),
        previewFileID: String(previewFileID || ""),
        updatedAt: new Date().toISOString(),
      };
      await coll.doc(id).set({ data: record });
      console.log("[project-store] saveMeta done", { id, name: record.name });
      return { success: true, id };
    }

    if (action === "delete") {
      const { id } = event || {};
      if (!id) {
        return { error: "Missing id", message: "缺少项目 ID。" };
      }
      const found = await coll.where({ _id: id, openid: OPENID }).get();
      const doc = found.data && found.data[0];
      if (!doc) {
        return { error: "Project not found", message: "项目不存在或无权删除。" };
      }
      const fileList = [doc.fileID, doc.originalFileID, doc.previewFileID].filter(Boolean);
      if (fileList.length) {
        try {
          await cloud.deleteFile({ fileList });
        } catch (error) {
          console.error("[project-store] deleteFile failed", { id, error: error && error.message });
        }
      }
      await coll.doc(id).remove();
      console.log("[project-store] delete done", { id });
      return { success: true };
    }

    if (action === "clearUserData") {
      // 清空当前 openid 关联的数据：项目（记录 + 云存储文件）、意见反馈
      await ensureCollection(PROJECTS_COLLECTION);
      const listRes = await coll.where({ openid: OPENID }).limit(1000).get();
      const rows = listRes.data || [];
      const fileIDs = [];
      rows.forEach((doc) => {
        if (!doc) return;
        [doc.fileID, doc.originalFileID, doc.previewFileID].forEach((fid) => {
          if (fid) fileIDs.push(fid);
        });
      });
      // deleteFile 单次最多 50 个，分批删除
      for (let i = 0; i < fileIDs.length; i += 50) {
        try {
          await cloud.deleteFile({ fileList: fileIDs.slice(i, i + 50) });
        } catch (error) {
          console.error("[project-store] clearUserData deleteFile failed", { error: error && error.message });
        }
      }
      let deletedProjects = 0;
      if (rows.length) {
        const removed = await coll.where({ openid: OPENID }).remove();
        deletedProjects = (removed && removed.stats && removed.stats.removed) || rows.length;
      }
      let deletedFeedback = 0;
      try {
        await ensureCollection("feedback");
        const fb = await db.collection("feedback").where({ openid: OPENID }).remove();
        deletedFeedback = (fb && fb.stats && fb.stats.removed) || 0;
      } catch (error) {
        console.error("[project-store] clearUserData feedback remove failed", { error: error && error.message });
      }
      console.log("[project-store] clearUserData done", { OPENID, deletedProjects, deletedFiles: fileIDs.length, deletedFeedback });
      return { success: true, deletedProjects, deletedFiles: fileIDs.length, deletedFeedback };
    }

    return { error: "Unknown action", message: "未知操作。" };
  } catch (error) {
    console.error("[project-store] failed", { action, error: error && error.message });
    return { error: "Project store failed", message: (error && error.message) || "项目库操作失败" };
  }
};
