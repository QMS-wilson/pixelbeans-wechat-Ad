const ADMIN_KEY_STORAGE = "pixelbeansAdminKey";

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function callAdmin(data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: "card-admin",
      data,
      success: (res) => resolve(res.result || {}),
      fail: (err) => reject(new Error((err && err.errMsg) || "云函数调用失败")),
    });
  });
}

Page({
  data: {
    adminKey: "",
    cards: [],
    logs: [],
    summary: { unused: 0, active: 0, exhausted: 0 },
    loaded: false,
    loading: false,
    genCount: "10",
    genPrefix: "PB",
    genNote: "",
    message: "",
    messageType: "",
    statusText: "",
    statusType: "",
  },

  onLoad() {
    const adminKey = wx.getStorageSync(ADMIN_KEY_STORAGE) || "";
    this.setData({ adminKey });
    if (adminKey) {
      this.setStatus("密钥已读取，正在加载卡密…", "info");
      this.loadCards();
    } else {
      this.setStatus("未设置管理密钥：请返回主页在「意见反馈」栏输入管理密码进入，或在本页输入密钥后点「加载数据」。", "warn");
    }
  },

  setStatus(text, type = "info") {
    this.setData({ statusText: text, statusType: type });
  },

  onAdminKeyInput(e) {
    this.setData({ adminKey: e.detail.value });
  },
  onGenCount(e) {
    this.setData({ genCount: e.detail.value });
  },
  onGenPrefix(e) {
    this.setData({ genPrefix: e.detail.value });
  },
  onGenNote(e) {
    this.setData({ genNote: e.detail.value });
  },

  setMessage(message, type = "") {
    this.setData({ message, messageType: type });
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => this.setData({ message: "" }), 3000);
  },

  async loadCards() {
    if (!this.data.adminKey) {
      this.setMessage("请先输入管理员密钥", "error");
      this.setStatus("缺少管理密钥，无法加载。", "warn");
      return;
    }
    this.setData({ loading: true });
    this.setStatus("正在加载卡密…", "info");
    try {
      const result = await callAdmin({ action: "list", adminKey: this.data.adminKey });
      if (result.error) {
        this.setMessage(result.message || "密钥无效", "error");
        this.setStatus(result.message || "加载失败", "error");
        return;
      }
      const cards = (result.cards || []).map((card) => ({
        ...card,
        statusText: card.status === "active" ? "已激活" : card.status === "exhausted" ? "已失效" : "未使用",
        createdAtText: formatDate(card.createdAt),
      }));
      const logs = (result.logs || []).map((log) => ({ ...log, createdAtText: formatDate(log.createdAt) }));
      const summary = {
        unused: cards.filter((c) => c.status === "unused").length,
        active: cards.filter((c) => c.status === "active").length,
        exhausted: cards.filter((c) => c.status === "exhausted").length,
      };
      this.setData({ cards, logs, summary, loaded: true });
      this.setStatus(`已加载 ${cards.length} 张卡密，日志 ${logs.length} 条。`, "success");
    } catch (error) {
      this.setMessage(error.message || "加载失败", "error");
      this.setStatus(error.message || "加载失败（请确认 card-admin 云函数已部署）", "error");
    } finally {
      this.setData({ loading: false });
    }
  },

  async generateCards() {
    this.setData({ loading: true });
    try {
      const count = Math.min(200, Math.max(1, Number(this.data.genCount) || 10));
      const result = await callAdmin({
        action: "generate",
        adminKey: this.data.adminKey,
        count,
        prefix: this.data.genPrefix,
        note: this.data.genNote,
      });
      if (result.error) {
        this.setMessage(result.message || "生成失败", "error");
        return;
      }
      this.setMessage(`已生成 ${result.cards.length} 张卡密`);
      await this.loadCards();
    } catch (error) {
      this.setMessage(error.message || "生成失败", "error");
    } finally {
      this.setData({ loading: false });
    }
  },

  async resetCard(e) {
    const cardCode = e.currentTarget.dataset.code;
    this.setData({ loading: true });
    try {
      const result = await callAdmin({ action: "reset", adminKey: this.data.adminKey, cardCode });
      if (result.error) {
        this.setMessage(result.message || "重置失败", "error");
        return;
      }
      this.setMessage(`已重置 ${cardCode}`);
      await this.loadCards();
    } catch (error) {
      this.setMessage(error.message || "重置失败", "error");
    } finally {
      this.setData({ loading: false });
    }
  },

  copyCardCode(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => this.setMessage(`已复制：${code}`),
    });
  },

  clearKey() {
    wx.removeStorageSync(ADMIN_KEY_STORAGE);
    this.setData({ adminKey: "", cards: [], logs: [], loaded: false });
    this.setStatus("已清除密钥。", "warn");
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/index/index" }) });
  },
});
