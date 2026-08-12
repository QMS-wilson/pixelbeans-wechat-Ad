const cloud = require("wx-server-sdk");
const {
  readStore,
  writeStore,
  sanitizeCardCode,
  findCardByCode,
  buildAccessPayload,
  appendLog,
  bindOpenid,
} = require("./lib/card-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 兑换卡密并绑定到当前 openid
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const cardCode = sanitizeCardCode(event && event.cardCode);
    if (!cardCode) {
      return { error: "Missing card code", message: "请输入有效卡密。" };
    }

    const store = await readStore();
    const card = findCardByCode(store, cardCode);
    if (!card) {
      return { error: "Card not found", message: "卡密不存在，请检查后重试。" };
    }
    // 同一 openid 退出授权后可重新兑换同一张卡（次数保留，不重复初始化）
    const sameOpenidReRedeem =
      Boolean(store.bindings && store.bindings[OPENID] && store.bindings[OPENID].cardCode === card.code);
    if (card.status === "active" && !sameOpenidReRedeem) {
      return { error: "Card used", message: "该卡密已被使用。" };
    }
    if (card.status === "exhausted") {
      return { error: "Card exhausted", message: "该卡密已失效，请使用新卡密。" };
    }

    if (!sameOpenidReRedeem) {
      card.status = "active";
      card.usedAt = new Date().toISOString();
      card.redeemedAt = card.usedAt;
      card.exhaustedAt = "";
      card.imageHash = "";
      card.boundImages = [];
      card.aiOptimizeCount = 0;
      card.downloadCount = 0;
    }

    appendLog(store, OPENID, { type: "redeem", cardCode: card.code, detail: "card redeemed" });
    bindOpenid(store, OPENID, card);
    await writeStore(store);

    return {
      success: true,
      ...buildAccessPayload(card),
      message: sameOpenidReRedeem ? "已重新绑定当前卡密，剩余次数保留。" : "卡密兑换成功，可开始使用。",
    };
  } catch (error) {
    return { error: "Redeem failed", message: error.message || "兑换失败" };
  }
};
