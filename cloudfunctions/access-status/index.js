const cloud = require("wx-server-sdk");
const {
  readStore,
  getBinding,
  findCardByCode,
  buildAccessPayload,
} = require("./lib/card-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 查询当前 openid 的卡密授权状态
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const store = await readStore();
  const binding = getBinding(store, OPENID);
  const card = binding ? findCardByCode(store, binding.cardCode) : null;
  const payload = buildAccessPayload(card);
  payload.openid = OPENID;
  return payload;
};
