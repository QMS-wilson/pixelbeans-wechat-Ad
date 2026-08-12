const cloud = require("wx-server-sdk");
const {
  readUnlockState,
  buildUnlockPayload,
} = require("./lib/cloud-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 查询当前 openid 的广告解锁额度状态
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const state = await readUnlockState(OPENID);
  return { success: true, openid: OPENID, ...buildUnlockPayload(state) };
};
