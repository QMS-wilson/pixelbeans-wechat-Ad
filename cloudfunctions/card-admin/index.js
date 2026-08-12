const cloud = require("wx-server-sdk");
const {
  db,
  readStore,
  writeStore,
  sanitizeCardCode,
  makeCardCode,
  appendLog,
  requireAdmin,
} = require("./lib/card-lib.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 卡密管理：list / generate / reset / import（需 adminKey）
exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const { action, adminKey } = event || {};
    // 校验管理密钥（供反馈页判断是否进入管理页，不返回密钥本身）
    if (action === "verify") {
      return { ok: requireAdmin(adminKey) };
    }
    if (action === "debug") {
      if (!requireAdmin(adminKey)) {
        return { error: "Forbidden", message: "管理员密钥无效。" };
      }
      try {
        const res = await db.collection("meta").doc("store").get();
        const doc = res.data || {};
        const top = Object.keys(doc);
        const inner = doc.data && typeof doc.data === "object" ? Object.keys(doc.data) : [];
        const innerType = doc.data === undefined ? "none" : typeof doc.data;
        return {
          docExists: true,
          docKeys: top,
          dataType: innerType,
          dataKeys: inner,
          hasCards: Array.isArray((doc.data && doc.data.cards) || doc.cards),
        };
      } catch (error) {
        return { docExists: false, error: error.message || "meta/store 不存在" };
      }
    }
    if (!requireAdmin(adminKey)) {
      return { error: "Forbidden", message: "管理员密钥无效。" };
    }
    const store = await readStore();

    if (action === "list") {
      return { cards: store.cards, logs: (store.logs || []).slice().reverse().slice(0, 200) };
    }

    if (action === "generate") {
      const count = Math.min(200, Math.max(1, Number(event.count) || 10));
      const prefix = sanitizeCardCode(event.prefix || "PB").replace(/-/g, "") || "PB";
      const note = String(event.note || "").trim();
      const codes = new Set(store.cards.map((item) => item.code));
      const created = [];
      while (created.length < count) {
        const code = makeCardCode(prefix.slice(0, 6), 12);
        if (codes.has(code)) continue;
        const card = {
          code,
          status: "unused",
          note,
          createdAt: new Date().toISOString(),
          usedAt: "",
          redeemedAt: "",
          exhaustedAt: "",
          imageHash: "",
          aiOptimizeCount: 0,
          downloadCount: 0,
        };
        store.cards.push(card);
        appendLog(store, OPENID, { type: "generate", cardCode: card.code, detail: note || "card generated" });
        created.push(card);
        codes.add(code);
      }
      await writeStore(store);
      return { success: true, cards: created };
    }

    if (action === "reset") {
      const code = sanitizeCardCode(event.cardCode);
      const card = store.cards.find((item) => item.code === code);
      if (!card) return { error: "Card not found" };
      card.status = "unused";
      card.usedAt = "";
      card.redeemedAt = "";
      card.exhaustedAt = "";
      card.imageHash = "";
      card.boundImages = [];
      card.aiOptimizeCount = 0;
      card.downloadCount = 0;
      appendLog(store, OPENID, { type: "reset", cardCode: card.code, detail: "card reset" });
      await writeStore(store);
      return { success: true, card };
    }

    if (action === "import") {
      if (!event.cards || !Array.isArray(event.cards)) {
        return { error: "Invalid payload", message: "缺少 cards 数组。" };
      }
      const store = await readStore();
      store.cards = event.cards;
      if (Array.isArray(event.logs)) store.logs = event.logs;
      if (event.freeTrials && typeof event.freeTrials === "object") store.freeTrials = event.freeTrials;
      if (event.bindings && typeof event.bindings === "object") store.bindings = event.bindings;
      appendLog(store, OPENID, { type: "import", detail: `imported ${store.cards.length} cards` });
      await writeStore(store);
      return { success: true, cards: store.cards.length, logs: store.logs.length };
    }

    return { error: "Unknown admin action" };
  } catch (error) {
    return { error: "Card admin failed", message: error.message || "后台操作失败" };
  }
};
