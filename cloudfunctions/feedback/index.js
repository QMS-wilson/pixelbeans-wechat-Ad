const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function ensureCollection(name) {
  if (typeof db.createCollection !== "function") return;
  try {
    await db.createCollection(name);
  } catch (error) {
    // 集合已存在或创建失败：让后续 add 决定
  }
}

function isCollectionNotExist(error) {
  return (
    error &&
    (String(error.errCode) === "-502005" ||
      String(error.errCode) === "DATABASE_COLLECTION_NOT_EXIST" ||
      /collection not exist/i.test(String(error.errMsg || error.message || "")))
  );
}

// 意见反馈：写入 feedback 集合
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const content = String((event && event.content) || "").trim();
    if (!content) {
      return { error: "Empty feedback", message: "反馈内容不能为空。" };
    }
    if (content.length > 1000) {
      return { error: "Too long", message: "反馈内容过长（最多 1000 字）。" };
    }
    const record = {
      content,
      openid: OPENID,
      createdAt: new Date().toISOString(),
      status: "new",
    };
    const addRecord = async () => {
      const res = await db.collection("feedback").add({ data: record });
      return { success: true, id: res._id };
    };
    try {
      return await addRecord();
    } catch (error) {
      if (isCollectionNotExist(error)) {
        await ensureCollection("feedback");
        return await addRecord();
      }
      throw error;
    }
  } catch (error) {
    return { error: "Feedback failed", message: error.message || "提交失败" };
  }
};
