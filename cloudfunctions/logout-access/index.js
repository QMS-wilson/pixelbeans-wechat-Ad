const cloud = require("wx-server-sdk");
const {
  readStore,
  writeStore,
  unbindOpenid,
} = require("./lib/card-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 解绑当前 openid 与卡密
exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext();
    const store = await readStore();
    unbindOpenid(store, OPENID);
    await writeStore(store);
    return { success: true, paid: false };
  } catch (error) {
    return { error: "Logout failed", message: error.message || "退出失败" };
  }
};
