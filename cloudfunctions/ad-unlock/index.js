const cloud = require("wx-server-sdk");
const {
  readUnlockState,
  grantAdReward,
  buildUnlockPayload,
} = require("./lib/cloud-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 广告解锁：grant（看完完整激励视频后发放额度）/ status（查询当前额度）
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const action = (event && event.action) || "status";
    if (action === "grant") {
      const state = await grantAdReward(OPENID);
      return { success: true, ...buildUnlockPayload(state) };
    }
    const state = await readUnlockState(OPENID);
    return { success: true, ...buildUnlockPayload(state) };
  } catch (error) {
    console.error("[ad-unlock] failed", error);
    return { error: "Ad unlock failed", message: error.message || "广告解锁失败" };
  }
};
