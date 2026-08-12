const { BEAD_PALETTES } = require("../../utils/palettes");
const { API_BASE, requestJson, callFunction, uploadDataChunks } = require("../../utils/api");
const { sha256Bytes } = require("../../utils/sha256");
const { base64ToBytes, arrayBufferToUtf8 } = require("../../utils/image");

const DEFAULT_AI_PROMPT =
  "将图片优化为适合拼豆图纸的形象：保留主体特征，白色干净背景，chibi 可爱画风，pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality";
const MAX_IMPORT_FILE_SIZE = 12 * 1024 * 1024;
const MAX_CANVAS_DIMENSION = 30000;
const MAX_CANVAS_PIXELS = 200000000;
const PATTERN_STORAGE_KEY = "pixelWorkshopPattern";
const PROJECTS_STORAGE_KEY = "pixelWorkshopProjects";
const ACCESS_TOKEN_KEY = "pixelWorkshopAccessToken";
const FREE_TRIAL_KEY = "pixelWorkshopFreeTrialUsed";
const DEVICE_ID_KEY = "pixelWorkshopDeviceId";

// AI 提示词快捷风格模板
const AI_PROMPT_PRESETS = [
  { label: "Q版可爱（默认）", value: "将图片优化为适合拼豆图纸的形象：保留主体特征，白色干净背景，chibi 可爱画风，pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality" },
  { label: "复古像素游戏", value: "将图片转化为复古像素游戏风格：16-bit pixel art, retro game aesthetic, crisp edges, limited palette, clean background, high contrast, masterpiece" },
  { label: "透明背景贴纸", value: "将图片处理为透明背景的贴纸形象：clean sticker style, white outline, vivid colors, no background, crisp edges, pixel art" },
  { label: "水墨国风", value: "将图片转换为水墨国风插画：ink wash painting, elegant, minimal color, soft edges, chinese style, pixel art" },
  { label: "扁平卡通", value: "将图片优化为卡通扁平风格：flat cartoon illustration, bold colors, simple shapes, clean background, friendly, pixel art" },
];
const PALETTE_FILTERS = ["全部", "红", "橙", "黄", "绿", "青", "蓝", "紫", "粉", "棕", "灰", "白", "黑"];

const PALETTE_KEYS = Object.keys(BEAD_PALETTES);
const PALETTE_OPTIONS = PALETTE_KEYS.map((key) => ({ key, label: BEAD_PALETTES[key].label }));
const DEFAULT_PALETTE_INDEX = Math.max(0, PALETTE_KEYS.indexOf("nabbi"));

Page({
  data: {
    statusText: "等待图片",
    statusState: "",
    canvasHint: "上传后会生成带网格线的拼豆预览图，可用于确认布局和配色。",
    controlNote: "上传图片后会自动生成色号，你也能继续手动微调。",
    uploadTitle: "上传图片开始生成",
    uploadHint: "支持 JPG / PNG / WebP，可点击选择图片",
    sourceType: "none",
    accessStatusText: "点击下载时会弹出兑换窗口",
    accessStatusBadge: "当前未解锁下载权限",
    accessStatusBadgeModal: "当前未解锁下载权限",
    paymentUsageSummary: "AI 剩余 0/3 次 · 下载剩余 0/3 次",
    paidAccess: false,
    gridSize: 64,
    mergeLevel: 24,
    gridLineOn: true,
    paletteIndex: DEFAULT_PALETTE_INDEX,
    paletteLabel: BEAD_PALETTES.nabbi.label,
    paletteOptions: PALETTE_OPTIONS,
    paletteFilter: "全部",
    paletteFilters: PALETTE_FILTERS,
    aiPromptPresets: AI_PROMPT_PRESETS,
    aiPromptPresetIndex: 0,
    aiOptimizeOn: false,
    feedbackInput: "",
    aiPrompt: DEFAULT_AI_PROMPT,
    editorTool: "brush",
    editorModeText: "画笔模式",
    activeColorHex: "#ffffff",
    activeColorText: "选择一个颜色开始绘制",
    paletteSwatches: [],
    historyEmpty: true,
    redoEmpty: true,
    cellsEmpty: true,
    exportBusy: false,    // ---- 导出进度浮层 ----
    // exportProgressVisible：是否显示浮层
    // exportStageText：当前阶段文案（生成/上传/服务端处理/下载/保存）
    // exportProgressPercent：0~100 百分比
    // exportProgressIndeterminate：true 时显示加载动画（服务端处理中，进度未知）
    exportProgressVisible: false,
    exportStageText: "",
    exportProgressPercent: 0,
    exportProgressIndeterminate: false,
    totalBeads: "0 颗",
    paletteList: [],
    processedPreviewLabel: "预处理后",
    compareExpanded: true,
    compareExpanding: false,
    compareCollapsing: false,
    aiOverlayVisible: false,
    aiWaitText: "",
    preprocessVisible: false,
    cardModalVisible: false,
    errorVisible: false,
    csvPreviewVisible: false,
    projectModalVisible: false,
    projects: [],
    projectName: "",
    errorMessage: "",
    cardRedeemMessage: "兑换成功后，本次浏览会自动解锁下载权限。",
    redeemMessageType: "",
    cardCodeInput: "",
    redeemDisabled: false,
    overlayOpen: false,
    showAiHint: false,
    showClearHint: false,
    aiOptimizeRemaining: 0,
    downloadRemaining: 0,
  },

  onLoad() {
    // 大体积状态放到非响应式实例属性，避免 setData 性能问题
    this.cells = [];
    this.cols = 64;
    this.rows = 64;
    this.counts = {};
    this.history = [];
    this.redoHistory = [];
    this.image = null;
    this.originalImage = null;
    this.sourceName = "";
    this.sourceType = "none";
    this.sourceFingerprint = "";
    this.paidAccess = false;
    this.cardCode = "";
    this.cardStatus = "none";
    this.accessToken = wx.getStorageSync(ACCESS_TOKEN_KEY) || "";
    this.aiOptimizeRemaining = 0;
    this.downloadRemaining = 0;
    this.error = "";
    this.renderMetrics = null;
    this.processToken = 0;
    this.isDrawing = false;
    this.selectedColorCode = "";
    this._cachedOriginalRef = null;
    this._migrationFailedIds = null;
    this._cachedPreviewRef = null;
    this.confirmedAiPrompt = DEFAULT_AI_PROMPT;
    this.aiOptimizeCacheKey = "";
    this.aiOptimizeCacheImage = null;
    this.aiOptimizeInFlightKey = "";
    this.aiOptimizeInFlightPromise = null;
    this.pendingProtectedAction = null;
    this.pendingCardError = "";
    this._saveTimer = null;
    this.freeTrialUsed = wx.getStorageSync(FREE_TRIAL_KEY) === true;
    this.aiWaitTimer = null;

    this.setData({ aiPrompt: this.confirmedAiPrompt });
    this.renderEditorPalette();
    this.syncAccessUi();
  },

  onReady() {
    this.initAllCanvases().then(() => {
      this.renderCanvas();
      this.restorePatternFromStorage();
      this.loadAccessStatus();
    });
  },

  // ---------- 画布初始化 ----------
  initCanvas(id) {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select(`#${id}`)
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            resolve(null);
            return;
          }
          const canvas = res[0].node;
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
          const dpr = info.pixelRatio || 1;
          canvas.width = res[0].width * dpr;
          canvas.height = res[0].height * dpr;
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          resolve({ canvas, ctx, width: res[0].width, height: res[0].height });
        });
    });
  },

  async initAllCanvases() {
    this.preview = await this.initCanvas("previewCanvas");
    this.sourceThumb = await this.initCanvas("sourcePreviewCanvas");
    this.processedThumb = await this.initCanvas("processedPreviewCanvas");
  },

  createOffscreen(width, height) {
    return wx.createOffscreenCanvas({
      type: "2d",
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
    });
  },

  // ---------- 基础工具 ----------
  setStatus(message, state = "") {
    this.setData({ statusText: message, statusState: state });
  },

  // AI 优化等待计时：每秒更新已等待时长。
  startAiWaitTimer() {
    this.clearAiWaitTimer();
    const startAt = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - startAt) / 1000);
      this.setData({ aiWaitText: `已等待 ${seconds} 秒，通常需要 30 秒 ~ 2 分钟` });
    };
    tick();
    this.aiWaitTimer = setInterval(tick, 1000);
  },

  clearAiWaitTimer() {
    if (this.aiWaitTimer) {
      clearInterval(this.aiWaitTimer);
      this.aiWaitTimer = null;
    }
    this.setData({ aiWaitText: "" });
  },

  // 取消 AI 优化：使当前流程失效并关闭遮罩（后端任务可能已扣次，无法退回）。
  cancelAiOptimization() {
    this.processToken += 1;
    this.clearAiWaitTimer();
    this.setData({
      aiOverlayVisible: false,
      statusText: "已取消 AI 优化",
      statusState: "idle",
      canvasHint: "已取消 AI 优化。若任务已提交，AI 次数可能已扣减且无法退回。",
    });
    this.syncOverlayState();
  },

  setError(message) {
    this.error = message;
    this.setData({
      statusText: "处理失败",
      statusState: "error",
      canvasHint: message,
      controlNote: "请重新选择图片，或压缩图片后再试。",
    });
  },

  clearError() {
    this.error = "";
  },

  setRedeemMessage(message, type = "info") {
    this.setData({ cardRedeemMessage: message, redeemMessageType: type });
  },

  openErrorOverlay(message) {
    this.setData({ errorVisible: true, errorMessage: message || "出现未知错误，请稍后重试。" });
    this.syncOverlayState();
  },

  closeErrorOverlay() {
    this.setData({ errorVisible: false });
    this.syncOverlayState();
  },

  // 任一弹窗打开时隐藏画布（原生层 canvas 会盖住普通视图），关闭后重绘
  syncOverlayState() {
    const open =
      this.data.exportProgressVisible ||
      this.data.aiOverlayVisible ||
      this.data.preprocessVisible ||
      this.data.cardModalVisible ||
      this.data.errorVisible ||
      this.data.csvPreviewVisible;
    const changed = open !== this.data.overlayOpen;
    this.setData({ overlayOpen: open });
    if (changed && !open) {
      this.renderCanvas();
      this.updateComparePreview();
    }
  },

  // 显示导出进度浮层，并设置初始阶段（文案/百分比/动画模式）
  showExportProgress(stageText, percent, indeterminate) {
    this.setData({
      exportProgressVisible: true,
      exportStageText: stageText,
      exportProgressPercent: percent,
      exportProgressIndeterminate: !!indeterminate,
    });
  },

  // 更新进度浮层内容（阶段文案/百分比/动画模式），浮层保持显示
  updateExportProgress(stageText, percent, indeterminate) {
    this.setData({
      exportStageText: stageText,
      exportProgressPercent: percent,
      exportProgressIndeterminate: !!indeterminate,
    });
  },

  // 关闭导出进度浮层（导出成功或失败后都会调用）
  hideExportProgress() {
    this.setData({ exportProgressVisible: false });
  },

  toast(title, icon = "none") {
    wx.showToast({ title, icon });
  },

  noop() {},

  // ---------- 色板 ----------
  getActivePalette() {
    return BEAD_PALETTES[PALETTE_KEYS[this.data.paletteIndex]].colors;
  },

  getPaletteColorByCode(code) {
    return this.getActivePalette().find((color) => color.code === code) || this.getActivePalette()[0];
  },

  getBlankColor() {
    return this.nearestPaletteColor([255, 255, 255]);
  },

  hexToRgb(hex) {
    const value = hex.replace("#", "");
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
  },

  quantize(value, level) {
    if (level <= 0) return value;
    const step = Math.max(1, Math.round(level / 8));
    return Math.round(value / step) * step;
  },

  colorDistance(a, b) {
    const redMean = (a[0] + b[0]) / 2;
    const red = a[0] - b[0];
    const green = a[1] - b[1];
    const blue = a[2] - b[2];
    return Math.sqrt(
      (2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue,
    );
  },

  // 色系分类：基于 HSL 把 RGB 颜色归入实用色系，用于色带筛选。
  classifyColorFamily(rgb) {
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max / 255;
    const s = max === 0 ? 0 : (max - min) / max;
    if (v > 0.92 && s < 0.12) return "白";
    if (v < 0.16) return "黑";
    if (s < 0.12) return "灰";
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
    }
    h = Math.round((h * 60 + 360) % 360);
    if (v < 0.5 && ((h >= 15 && h < 70) || h >= 340)) return "棕";
    if (h < 15 || h >= 345) return "红";
    if (h < 45) return "橙";
    if (h < 70) return "黄";
    if (h < 160) return "绿";
    if (h < 200) return "青";
    if (h < 260) return "蓝";
    if (h < 300) return "紫";
    if (h < 345) return "粉";
    return "红";
  },

  nearestPaletteColor(rgb) {
    const palette = this.getActivePalette();
    return palette.reduce(
      (best, color) => {
        const distance = this.colorDistance(rgb, color.rgb);
        return distance < best.distance ? { ...color, distance } : best;
      },
      { distance: Infinity },
    );
  },

  // 切换色板时，把当前网格中的所有格子重映射到新色板的最接近颜色，
  // 保证手绘内容不会丢失且画布立即按新色板重绘。
  remapCellsToActivePalette() {
    if (!this.cells.length) return false;
    const palette = this.getActivePalette();
    const nearestCache = {};
    this.cells.forEach((line) => {
      line.forEach((cell) => {
        if (!cell) return;
        const key = `${cell.hex}`;
        if (!nearestCache[key]) {
          const rgb = cell.rgb || this.hexToRgb(cell.hex);
          nearestCache[key] = palette.reduce(
            (best, color) => {
              const distance = this.colorDistance(rgb, color.rgb);
              return distance < best.distance ? { ...color, distance } : best;
            },
            { distance: Infinity },
          );
        }
      });
    });
    this.cells.forEach((line, row) => {
      line.forEach((cell, col) => {
        if (!cell) return;
        const matched = nearestCache[`${cell.hex}`];
        if (matched) line[col] = matched;
      });
    });
    this.recomputeCounts();
    this.renderCanvas();
    this.syncUiSummary();
    this.schedulePatternSave();
    return true;
  },

  renderEditorPalette() {
    let colors = this.getActivePalette();
    if (this.data.paletteFilter && this.data.paletteFilter !== "全部") {
      colors = colors.filter((color) => this.classifyColorFamily(color.rgb) === this.data.paletteFilter);
    }
    // 当前图纸用到的颜色置顶（按用量排序），方便手绘时快速取色。
    const usedMap = {};
    Object.values(this.counts).forEach((row) => {
      usedMap[row.code] = row.count;
    });
    colors = colors
      .map((color) => ({ color, used: usedMap[color.code] || 0 }))
      .sort((a, b) => b.used - a.used)
      .map((item) => item.color);
    if (!this.selectedColorCode || !colors.some((color) => color.code === this.selectedColorCode)) {
      this.selectedColorCode = (colors[0] || this.getActivePalette()[0]).code;
    }
    const swatches = colors.map((color) => ({
      code: color.code,
      hex: color.hex,
      active: color.code === this.selectedColorCode,
    }));
    const active = this.getPaletteColorByCode(this.selectedColorCode);
    this.setData({
      paletteSwatches: swatches,
      activeColorHex: active.hex,
      activeColorText: `${active.code}${active.label ? ` ${active.label}` : ""} · ${active.hex.toUpperCase()}`,
    });
  },

  onPaletteFilterTap(e) {
    const family = e.currentTarget.dataset.family;
    this.setData({ paletteFilter: family });
    this.renderEditorPalette();
  },

  // ---------- 授权状态 ----------
  hasPaidAccess() {
    return Boolean(this.paidAccess);
  },

  syncAccessUi() {
    const paid = this.hasPaidAccess();
    const statusValue = paid
      ? `已解锁${this.cardCode ? ` · ${this.cardCode}` : ""} · AI ${this.aiOptimizeRemaining}/3 · 下载 ${this.downloadRemaining}/3`
      : this.cardStatus === "exhausted"
        ? "当前卡密已失效，请更换新卡密"
        : "当前尚未解锁下载权限";
    const summaryValue = paid
      ? `AI 剩余 ${this.aiOptimizeRemaining}/3 次 · 下载剩余 ${this.downloadRemaining}/3 次${
          this.aiOptimizeRemaining === 1 || this.downloadRemaining === 1 ? " · 注意：次数即将用完" : ""
        }`
      : this.cardStatus === "exhausted"
        ? "当前卡密已作废，请更换新卡密"
        : "AI 剩余 0/3 次 · 下载剩余 0/3 次";
    this.setData({
      accessStatusText: statusValue,
      accessStatusBadge: statusValue,
      accessStatusBadgeModal: statusValue,
      paymentUsageSummary: summaryValue,
      redeemDisabled: paid,
      aiOptimizeRemaining: this.aiOptimizeRemaining,
      downloadRemaining: this.downloadRemaining,
    });
  },

  syncAccessState(result = null) {
    const wasPaid = this.paidAccess;
    this.paidAccess = Boolean(result && result.paid);
    this.cardCode = (result && result.cardCode) || "";
    this.cardStatus = (result && result.cardStatus) || (this.paidAccess ? "active" : "none");
    this.aiOptimizeRemaining = Number(result && result.aiOptimizeRemaining) || 0;
    this.downloadRemaining = Number(result && result.downloadRemaining) || 0;
    const token = (result && result.accessToken) || this.accessToken || "";
    if (result && result.paid === false) {
      this.accessToken = "";
      wx.removeStorageSync(ACCESS_TOKEN_KEY);
    } else if (token) {
      this.accessToken = token;
      wx.setStorageSync(ACCESS_TOKEN_KEY, token);
    }
    this.setData({ paidAccess: this.paidAccess });
    this.syncAccessUi();
    if (this.paidAccess !== wasPaid) {
      this.renderCanvas();
      this.updateComparePreview();
    }
  },

  async loadAccessStatus() {
    try {
      const path = this.accessToken
        ? `/api/access-status?accessToken=${encodeURIComponent(this.accessToken)}`
        : "/api/access-status";
      const result = await requestJson(path, { method: "GET" });
      this.syncAccessState(result);
      if (this.hasPaidAccess()) {
        this.setRedeemMessage(
          `当前卡密可继续使用：AI 剩余 ${this.aiOptimizeRemaining} 次，下载剩余 ${this.downloadRemaining} 次。`,
          "success",
        );
      }
    } catch {
      this.syncAccessUi();
    }
  },

  queueProtectedAction(action) {
    this.pendingProtectedAction = action;
    this.openCardModal();
  },

  async runPendingProtectedAction() {
    const action = this.pendingProtectedAction;
    this.pendingProtectedAction = null;
    if (typeof action === "function") {
      await action();
    }
  },

  openCardModal() {
    this.syncAccessUi();
    if (this.pendingCardError) {
      this.setRedeemMessage(this.pendingCardError, "error");
    }
    this.setData({ cardModalVisible: true });
    this.syncOverlayState();
  },

  closeCardModal() {
    this.setData({ cardModalVisible: false });
    this.syncOverlayState();
  },

  onCardCodeInput(e) {
    this.setData({ cardCodeInput: e.detail.value });
  },

  async redeemCard() {
    const cardCode = (this.data.cardCodeInput || "").trim();
    if (!cardCode) {
      this.setRedeemMessage("请输入有效卡密后再解锁下载。", "error");
      return;
    }
    this.setData({ redeemDisabled: true });
    this.setRedeemMessage("正在验证卡密，请稍候…", "info");
    try {
      const result = await requestJson("/api/redeem-card", {
        method: "POST",
        data: { cardCode },
      });
      if (!result || !result.success) {
        throw new Error((result && result.message) || "卡密兑换失败，请稍后重试。");
      }
      this.syncAccessState(result);
      this.setRedeemMessage(
        result.message ||
          `卡密已激活：AI 剩余 ${this.aiOptimizeRemaining} 次，下载剩余 ${this.downloadRemaining} 次。`,
        "success",
      );
      this.setData({ cardModalVisible: false, cardCodeInput: "" });
      this.syncOverlayState();
      await this.runPendingProtectedAction();
    } catch (error) {
      this.setData({ redeemDisabled: false });
      this.setRedeemMessage(error.message || "卡密验证失败。", "error");
    }
  },

  async logoutAccess() {
    try {
      await requestJson("/api/logout-access", { method: "POST" });
    } catch {
      // ignore
    }
    this.accessToken = "";
    wx.removeStorageSync(ACCESS_TOKEN_KEY);
    this.pendingProtectedAction = null;
    this.pendingCardError = "";
    this.syncAccessState(null);
    this.setData({ cardCodeInput: "" });
    this.setRedeemMessage("已退出当前授权，可重新输入卡密解锁下载。", "info");
  },

  handleCardDenied(message) {
    this.paidAccess = false;
    this.cardStatus = "exhausted";
    this.cardCode = "";
    this.accessToken = "";
    wx.removeStorageSync(ACCESS_TOKEN_KEY);
    this.pendingCardError = message || "当前卡密已失效，请使用新卡密。";
    this.error = this.pendingCardError;
    this.setRedeemMessage(this.pendingCardError, "error");
    this.setData({ paidAccess: false });
    this.syncAccessUi();
    this.setData({
      statusText: "下载权限已失效",
      statusState: "error",
      canvasHint: this.pendingCardError,
    });
    requestJson("/api/logout-access", { method: "POST" }).catch(() => {});
  },

  isCardDeniedError(error) {
    return error && (error.status === 403 || error.status === 409);
  },

  // ---------- 图片载入 ----------
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["original"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_FILE_SIZE) {
          this.setError("图片体积超过 12MB，建议压缩后再导入。");
          return;
        }
        this.loadFile(file.tempFilePath);
      },
    });
  },

  computeFileFingerprint(filePath) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => {
          try {
            resolve(sha256Bytes(base64ToBytes(res.data)));
          } catch {
            resolve(`file:${filePath}:${Date.now()}`);
          }
        },
        fail: () => resolve(`file:${filePath}:${Date.now()}`),
      });
    });
  },

  loadFile(filePath) {
    this.setData({ statusText: "正在读取图片", sourceType: "image" });
    const createImage = this.preview && this.preview.canvas && this.preview.canvas.createImage
      ? () => this.preview.canvas.createImage()
      : () => wx.createImage();
    const image = createImage();
    image.onload = async () => {
      this.originalImage = image;
      this.image = image;
      this.sourceName = filePath.split("/").pop() || "image";
      this.sourceType = "image";
      this.sourceFingerprint = await this.computeFileFingerprint(filePath);
      this.aiOptimizeCacheKey = "";
      this.aiOptimizeCacheImage = null;
      this.aiOptimizeInFlightKey = "";
      this.aiOptimizeInFlightPromise = null;
      this.setData({
        sourceType: "image",
        uploadTitle: "图片已载入",
        uploadHint: `${image.width} x ${image.height}`,
        showAiHint: true,
        showClearHint: false,
      });
      this.processCurrentImage();
    };
    image.onerror = () => this.setError("图片解析失败，请确认文件未损坏。");
    image.src = filePath;
  },

  createBlankBoardFingerprint(cols, rows) {
    return `blank:${cols}x${rows}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  },

  createBlankBoard(options = {}) {
    const { preserveSourceFingerprint = false } = options;
    this.clearError();
    this.history = [];
    this.redoHistory = [];
    const cols = Number(this.data.gridSize);
    const rows = cols;
    const blank = this.getBlankColor();
    this.image = null;
    this.originalImage = null;
    this.sourceName = "blank-board";
    this.sourceType = "blank";
    if (!preserveSourceFingerprint || !this.sourceFingerprint) {
      this.sourceFingerprint = this.createBlankBoardFingerprint(cols, rows);
    }
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => blank));
    this.cols = cols;
    this.rows = rows;
    this.counts = {};
    this.setData({
      sourceType: "blank",
      showClearHint: false,
      uploadTitle: "已创建空白图纸",
      uploadHint: `${cols} x ${rows}，适合作为后续手工绘制基础`,
      canvasHint: "空白图纸已创建，现在可以直接选择颜色并在网格上手绘。",
      statusText: "空白图纸",
      statusState: "ready",
    });
    this.syncUiSummary();
    this.schedulePatternSave();
    this.updateComparePreview();
    this.renderCanvas();
  },

  // 载入内置示例图纸：让新用户无需上传图片即可体验完整流程。
  loadDemoPattern() {
    const size = 16;
    const demoRows = [
      "................",
      ".XXXX......XXXX.",
      ".XXXXXX..XXXXXX.",
      ".XXXXXXXXXXXXXX.",
      ".XXXXXXXXXXXXXX.",
      ".XXXXXXXXXXXXXX.",
      "..XXXXXXXXXXXX..",
      "..XXXXXXXXXXXX..",
      "...XXXXXXXXXX...",
      "....XXXXXXXX....",
      ".....XXXXXX.....",
      "......XXXX......",
      ".......XX.......",
      "................",
      "................",
      "................",
    ];
    const blank = this.getBlankColor();
    const palette = this.getActivePalette();
    const red =
      palette.find((c) => c.rgb[0] > 180 && c.rgb[1] < 110 && c.rgb[2] < 110) ||
      palette.find((c) => c.rgb[0] > 150 && c.rgb[1] < c.rgb[0] - 60 && c.rgb[2] < c.rgb[0] - 60) ||
      palette[1] ||
      palette[0];
    this.cells = demoRows.map((line) =>
      line.split("").map((ch) => (ch === "X" ? { ...red } : { ...blank })),
    );
    this.cols = size;
    this.rows = size;
    this.history = [];
    this.redoHistory = [];
    this.image = null;
    this.originalImage = null;
    this.sourceType = "blank";
    this.sourceName = "demo-pattern";
    this.sourceFingerprint = this.createBlankBoardFingerprint(size, size);
    this.recomputeCounts();
    this.renderCanvas();
    this.setData({
      sourceType: "blank",
      showClearHint: false,
      uploadTitle: "示例图纸已载入",
      uploadHint: `${size} x ${size}，可直接开始手绘或导出`,
      canvasHint: `已载入示例图纸（${size} x ${size}），可以直接开始手绘或导出。`,
      statusText: "示例图纸",
      statusState: "ready",
    });
    this.syncUiSummary();
    this.schedulePatternSave();
    this.updateComparePreview();
  },

  // ---------- 图片处理 ----------
  normalizeSourceImage(image, maxSide = 1600) {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvasElement = this.createOffscreen(width, height);
    const context = canvasElement.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvasElement;
  },

  canvasToTemp(canvas, fileType = "png", quality = 1) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        fileType,
        quality,
        success: (res) => resolve(res.tempFilePath),
        fail: reject,
      });
    });
  },

  readFileBase64(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve(res.data),
        fail: reject,
      });
    });
  },

  fileSizeKB(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().stat({
        path: filePath,
        success: (res) => resolve(Math.round(res.stats.size / 1024)),
        fail: reject,
      });
    });
  },

  async canvasToDataUrl(canvas, maxSizeKB = 4096) {
    let tempPath = await this.canvasToTemp(canvas, "png", 1);
    let sizeKB = await this.fileSizeKB(tempPath);
    if (sizeKB > maxSizeKB) {
      tempPath = await this.canvasToTemp(canvas, "jpg", 0.8);
      sizeKB = await this.fileSizeKB(tempPath);
    }
    const base64 = await this.readFileBase64(tempPath);
    const mime = tempPath.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${base64}`;
  },

  loadImageSource(src) {
    return new Promise((resolve, reject) => {
      const image = this.preview.canvas.createImage();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("AI 优化结果图片解析失败。"));
      image.src = src;
    });
  },

  async buildAiSourceInfo(image) {
    const sourceCanvas = this.normalizeSourceImage(image, 2048);
    const imageBase64 = await this.canvasToDataUrl(sourceCanvas);
    const prompt = this.confirmedAiPrompt || DEFAULT_AI_PROMPT;
    const cacheKey = `${this.sourceName}:${image.width}x${image.height}:${imageBase64.length}:${prompt}`;
    return { imageBase64, prompt, cacheKey };
  },

  async optimizeImageWithAI(image, aiInfo = null) {
    if (!this.sourceFingerprint) {
      throw new Error("未识别到当前图片，请重新上传后再试。");
    }
    const info = aiInfo || (await this.buildAiSourceInfo(image));
    const { imageBase64, prompt, cacheKey } = info;

    if (this.aiOptimizeCacheKey === cacheKey && this.aiOptimizeCacheImage) {
      return this.aiOptimizeCacheImage;
    }
    if (this.aiOptimizeInFlightKey === cacheKey && this.aiOptimizeInFlightPromise) {
      return this.aiOptimizeInFlightPromise;
    }

    // 只有真正发起新的 AI 优化（缓存未命中）时才校验卡密/免费体验
    const trialAvailable = !this.hasPaidAccess() && !this.freeTrialUsed;
    if (!this.hasPaidAccess() && !trialAvailable) {
      this.queueProtectedAction(() => this.processCurrentImage());
      throw new Error("请先兑换卡密后再使用 AI 优化。");
    }
    const isTrial = trialAvailable;
    const myToken = this.processToken;
    if (this.hasPaidAccess() && this.aiOptimizeRemaining <= 0) {
      this.queueProtectedAction(() => this.processCurrentImage());
      throw new Error("当前卡密 AI 优化次数已用完，请兑换新卡密。");
    }

    this.aiOptimizeInFlightKey = cacheKey;
    this.aiOptimizeInFlightPromise = (async () => {
      // 大图分块上传到云存储，避免 callFunction 入参超限 / 直传断流
      const { uploadId: imageUploadId, ext: imageExt } = await uploadDataChunks(imageBase64, "ai-input");
      const submitResult = await requestJson("/api/ai-optimize", {
        method: "POST",
        data: {
          imageUploadId,
          imageExt,
          prompt,
          imageHash: this.sourceFingerprint,
          accessToken: this.accessToken || undefined,
          ...(isTrial ? { freeTrial: true, deviceId: this.getDeviceId() } : {}),
        },
      });
      const taskId = submitResult && submitResult.taskId;
      if (!submitResult || !submitResult.success || !taskId) {
        const error = new Error((submitResult && (submitResult.message || submitResult.error)) || "AI 优化提交失败");
        error.status = submitResult && submitResult.statusCode;
        throw error;
      }
      this.syncAccessState(submitResult);
      // 云函数版：提交后返回 taskId，由前端轮询 action=check，避免云函数 60s 超时限制
      const pollStartedAt = Date.now();
      for (;;) {
        if (myToken !== this.processToken) throw new Error("AI 优化已取消");
        if (Date.now() - pollStartedAt > 180000) throw new Error("AI 优化超时，请稍后重试。");
        let check = null;
        try {
          check = await requestJson("/api/ai-optimize", {
            method: "POST",
            data: { action: "check", taskId },
          });
        } catch (error) {
          console.warn("[optimizeImageWithAI] poll error, retrying", error);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        if (check && check.success && check.imageFileID) {
          if (isTrial) {
            this.freeTrialUsed = true;
            wx.setStorageSync(FREE_TRIAL_KEY, true);
            this.toast("免费 AI 体验已完成，后续使用需兑换卡密");
          }
          this.syncAccessState(check);
          const downloadResult = await new Promise((resolve, reject) => {
            wx.cloud.downloadFile({
              fileID: check.imageFileID,
              success: resolve,
              fail: () => reject(new Error("AI 优化结果下载失败，请重试。")),
            });
          });
          const optimizedImage = await this.loadImageSource(downloadResult.tempFilePath);
          this.aiOptimizeCacheKey = cacheKey;
          this.aiOptimizeCacheImage = optimizedImage;
          return optimizedImage;
        }
        if (check && check.failed) {
          throw new Error((check && check.message) || "AI 优化任务失败，请重试。");
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();

    try {
      return await this.aiOptimizeInFlightPromise;
    } finally {
      if (this.aiOptimizeInFlightKey === cacheKey) {
        this.aiOptimizeInFlightKey = "";
        this.aiOptimizeInFlightPromise = null;
      }
    }
  },

  getDeviceId() {
    let deviceId = wx.getStorageSync(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      wx.setStorageSync(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  },

  async buildProcessedSource(image, aiInfo = null) {
    if (!this.data.aiOptimizeOn) return image;
    return this.optimizeImageWithAI(image, aiInfo);
  },

  buildSampleBackgroundMask(imageData, cols, rows) {
    const total = cols * rows;
    const visited = new Uint8Array(total);
    const queue = new Uint32Array(total);
    let head = 0;
    let tail = 0;
    const cornerIndexes = [
      0,
      Math.max(0, cols - 1),
      Math.max(0, (rows - 1) * cols),
      Math.max(0, rows * cols - 1),
    ];

    let avgRed = 0;
    let avgGreen = 0;
    let avgBlue = 0;
    cornerIndexes.forEach((pixelIndex) => {
      const offset = pixelIndex * 4;
      avgRed += imageData[offset];
      avgGreen += imageData[offset + 1];
      avgBlue += imageData[offset + 2];
    });
    avgRed /= cornerIndexes.length;
    avgGreen /= cornerIndexes.length;
    avgBlue /= cornerIndexes.length;
    const avgBrightness = (avgRed + avgGreen + avgBlue) / 3;

    const isBackground = (pixelIndex) => {
      const offset = pixelIndex * 4;
      const alpha = imageData[offset + 3];
      if (alpha < 12) return true;
      const red = imageData[offset];
      const green = imageData[offset + 1];
      const blue = imageData[offset + 2];
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
      const brightness = (red + green + blue) / 3;
      const distance = Math.abs(red - avgRed) + Math.abs(green - avgGreen) + Math.abs(blue - avgBlue);
      const brightnessGap = Math.abs(brightness - avgBrightness);
      return brightness >= 238 && saturation <= 22 && distance <= 52 && brightnessGap <= 18;
    };

    const enqueue = (pixelIndex) => {
      if (!visited[pixelIndex] && isBackground(pixelIndex)) {
        visited[pixelIndex] = 1;
        queue[tail] = pixelIndex;
        tail += 1;
      }
    };

    for (let x = 0; x < cols; x += 1) {
      enqueue(x);
      enqueue((rows - 1) * cols + x);
    }
    for (let y = 0; y < rows; y += 1) {
      enqueue(y * cols);
      enqueue(y * cols + (cols - 1));
    }
    while (head < tail) {
      const pixelIndex = queue[head];
      head += 1;
      const x = pixelIndex % cols;
      const y = Math.floor(pixelIndex / cols);
      if (x > 0) enqueue(pixelIndex - 1);
      if (x < cols - 1) enqueue(pixelIndex + 1);
      if (y > 0) enqueue(pixelIndex - cols);
      if (y < rows - 1) enqueue(pixelIndex + cols);
    }
    return visited;
  },

  fitImage(image, targetCols) {
    const ratio = image.height / image.width;
    return Math.max(1, Math.round(targetCols * ratio));
  },

  // 用当前格子重建一张像素画布（每格 1x1），作为“恢复图纸/无原图”时的采样源
  rebuildSourceFromCells() {
    const cols = Math.max(1, this.cols);
    const rows = Math.max(1, this.rows);
    const canvas = this.createOffscreen(cols, rows);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cols, rows);
    this.cells.forEach((line, row) => {
      line.forEach((cell, col) => {
        if (!cell || !cell.hex) return;
        ctx.fillStyle = cell.hex;
        ctx.fillRect(col, row, 1, 1);
      });
    });
    return canvas;
  },
  sampleImage(image, cols) {
    const rows = this.fitImage(image, cols);
    const sourceCanvas = this.createOffscreen(cols, rows);
    const sourceContext = sourceCanvas.getContext("2d");
    sourceContext.fillStyle = "#ffffff";
    sourceContext.fillRect(0, 0, cols, rows);
    sourceContext.imageSmoothingEnabled = true;
    sourceContext.imageSmoothingQuality = "high";
    sourceContext.drawImage(image, 0, 0, cols, rows);

    const imageData = sourceContext.getImageData(0, 0, cols, rows).data;
    const backgroundMask = this.buildSampleBackgroundMask(imageData, cols, rows);
    const cells = [];
    const counts = {};
    const merge = Number(this.data.mergeLevel);
    const blankColor = this.getBlankColor();

    for (let row = 0; row < rows; row += 1) {
      const line = [];
      for (let col = 0; col < cols; col += 1) {
        const index = (row * cols + col) * 4;
        const alpha = imageData[index + 3] / 255;
        const raw = [
          Math.round(imageData[index] * alpha + 255 * (1 - alpha)),
          Math.round(imageData[index + 1] * alpha + 255 * (1 - alpha)),
          Math.round(imageData[index + 2] * alpha + 255 * (1 - alpha)),
        ].map((value) => Math.max(0, Math.min(255, this.quantize(value, merge))));
        const color = backgroundMask[row * cols + col] ? blankColor : this.nearestPaletteColor(raw);
        line.push(color);
        if (color.code !== blankColor.code) {
          counts[color.code] = {
            code: color.code,
            label: color.label || "",
            hex: color.hex,
            count: ((counts[color.code] && counts[color.code].count) || 0) + 1,
          };
        }
      }
      cells.push(line);
    }

    this.cells = cells;
    this.cols = cols;
    this.rows = rows;
    this.counts = counts;
  },

  recomputeCounts() {
    const counts = {};
    const blankColor = this.getBlankColor();
    this.cells.forEach((line) => {
      line.forEach((color) => {
        if (color.code === blankColor.code) return;
        counts[color.code] = {
          code: color.code,
          label: color.label || "",
          hex: color.hex,
          count: ((counts[color.code] && counts[color.code].count) || 0) + 1,
        };
      });
    });
    this.counts = counts;
  },

  // ---------- 主流程 ----------
  async processCurrentImage() {
    const token = (this.processToken += 1);
    const usesAi = Boolean(this.data.aiOptimizeOn) && this.sourceType !== "saved";
    this.clearError();
    this.history = [];
    this.redoHistory = [];
    this.syncUiSummary();

    if (this.sourceType === "blank") {
      this.createBlankBoard({ preserveSourceFingerprint: true });
      return;
    }
    // 采样源优先级：
    // 1) AI 关闭时，已加载/恢复的预处理图（如 AI 结果）优先作为采样源，
    //    避免“预处理图变成原图”、越调越模糊；
    // 2) 有原图则以原图重新生成；
    // 3) 都没有原图时用当前格子重建画布（旧项目降级方案）。
    const useRestoredPreview = !usesAi && this.image && this.image !== this.originalImage;
    let sourceForSampling = useRestoredPreview ? this.image : this.originalImage;
    if (!sourceForSampling) {
      if (!this.cells.length) {
        this.renderCanvas();
        return;
      }
      sourceForSampling = this.rebuildSourceFromCells();
    }

    let aiInfo = null;
    try {
      if (usesAi && this.originalImage) {
        aiInfo = await this.buildAiSourceInfo(this.originalImage);
        const cacheHit =
          (this.aiOptimizeCacheKey === aiInfo.cacheKey && this.aiOptimizeCacheImage) ||
          (this.aiOptimizeInFlightKey === aiInfo.cacheKey && this.aiOptimizeInFlightPromise);
        if (cacheHit) {
          // 复用已有 AI 结果，不需要再次请求，也不展示优化中的遮罩
          this.setData({ statusText: "正在生成图纸", statusState: "working" });
        } else {
          this.setData({
            statusText: "正在 AI 优化图片，请稍等",
            statusState: "working",
            canvasHint: "系统正在根据提示词优化图片，通常需要几十秒到 1-2 分钟，请不要频繁切换参数。",
            controlNote: "AI 优化处理中：完成后会自动生成拼豆图纸。",
            aiOverlayVisible: true,
          });
          this.syncOverlayState();
          this.startAiWaitTimer();
        }
      } else {
        this.setData({ statusText: "正在生成图纸", statusState: "working" });
      }

      const finalSource = useRestoredPreview
        ? sourceForSampling
        : this.originalImage
          ? await this.buildProcessedSource(this.originalImage, aiInfo)
          : sourceForSampling;
      if (token !== this.processToken) return;

      this.image = finalSource;
      this.sampleImage(finalSource, Number(this.data.gridSize));
      this.renderCanvas();
      this.updateComparePreview(this.originalImage, finalSource);
      if (usesAi) {
        this.setData({ preprocessVisible: false });
      }
      const preprocessText = usesAi ? " · 预处理：AI 优化" : "";
      this.setData({
        canvasHint: `当前 ${this.cols} x ${this.rows}，共 ${this.cols * this.rows} 颗${preprocessText}。`,
        statusText: "图纸已生成",
        statusState: "ready",
      });
      this.syncUiSummary();
      this.schedulePatternSave();
    } catch (error) {
      if (token !== this.processToken) return;
      if (this.isCardDeniedError(error)) {
        this.handleCardDenied(error.message);
        this.openErrorOverlay(`AI 优化未完成：${error.message || "当前卡密已失效，请使用新卡密。"}`);
        return;
      }
      this.setError(error.message || "生成失败，请稍后重试。");
      this.updateComparePreview(this.originalImage, this.image || this.originalImage);
    } finally {
      this.clearAiWaitTimer();
      if (token === this.processToken && usesAi) {
        this.setData({ aiOverlayVisible: false });
        this.syncOverlayState();
      }
    }
  },

  // ---------- 渲染 ----------
  applyPreviewProtection(context, width, height) {
    if (this.hasPaidAccess()) return;
    if (!width || !height) return;
    const diagonal = Math.sqrt(width * width + height * height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(-Math.PI / 5);
    context.fillStyle = "rgba(17, 24, 39, 0.18)";
    context.font = `800 ${Math.max(16, Math.floor(width * 0.04))}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const stepX = Math.max(180, Math.floor(width * 0.28));
    const stepY = Math.max(96, Math.floor(height * 0.16));
    for (let y = -diagonal; y <= diagonal; y += stepY) {
      for (let x = -diagonal; x <= diagonal; x += stepX) {
        context.fillText("未付款预览", x, y);
      }
    }
    context.restore();
  },

  drawEmptyPreview() {
    if (!this.preview) return;
    const { ctx, width, height } = this.preview;
    const grid = 16;
    const cell = width / grid;
    for (let row = 0; row < grid; row += 1) {
      for (let col = 0; col < grid; col += 1) {
        ctx.fillStyle = (row + col) % 2 === 0 ? "#f1f5f9" : "#ffffff";
        ctx.fillRect(col * cell, row * cell, cell, cell);
      }
    }
    ctx.fillStyle = "#3157d5";
    ctx.font = `700 ${Math.max(22, Math.floor(width * 0.045))}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillText("上传图片生成图纸", width / 2, height / 2);
    this.updateComparePreview();
  },

  renderCanvas() {
    if (!this.preview) return;
    const { ctx, width, height } = this.preview;
    const cells = this.cells;
    const rows = cells.length;
    const cols = cells[0] ? cells[0].length : 0;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    if (!rows || !cols) {
      this.drawEmptyPreview();
      this.updateStats();
      this.updateExportState();
      return;
    }

    const padding = Math.max(6, Math.floor(width * 0.012));
    // 用浮点格宽精确均分可用区域，避免格数大时向下取整导致图案缩小
    const cellSize = Math.max(1, Math.min((width - padding * 2) / cols, (height - padding * 2) / rows));
    const chartWidth = cellSize * cols;
    const chartHeight = cellSize * rows;
    const offsetX = Math.round((width - chartWidth) / 2);
    const offsetY = Math.round((height - chartHeight) / 2);
    this.renderMetrics = { padding, cellSize, chartWidth, chartHeight, offsetX, offsetY, cols, rows };

    cells.forEach((line, row) => {
      const y0 = Math.round(offsetY + row * cellSize);
      const y1 = Math.round(offsetY + (row + 1) * cellSize);
      line.forEach((cell, col) => {
        const x0 = Math.round(offsetX + col * cellSize);
        const x1 = Math.round(offsetX + (col + 1) * cellSize);
        ctx.fillStyle = cell.hex;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      });
    });

    if (this.data.gridLineOn && cellSize >= 3) {
      ctx.strokeStyle = "rgba(17, 24, 39, 0.2)";
      ctx.lineWidth = 1;
      for (let col = 0; col <= cols; col += 1) {
        const x = offsetX + col * cellSize + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, offsetY);
        ctx.lineTo(x, offsetY + chartHeight);
        ctx.stroke();
      }
      for (let row = 0; row <= rows; row += 1) {
        const y = offsetY + row * cellSize + 0.5;
        ctx.beginPath();
        ctx.moveTo(offsetX, y);
        ctx.lineTo(offsetX + chartWidth, y);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "rgba(17, 24, 39, 0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(offsetX, offsetY, chartWidth, chartHeight);
    this.applyPreviewProtection(ctx, width, height);

    this.updateStats();
    this.updateExportState();
  },

  drawPreviewThumbnail(context, source, width, height) {
    if (!context || !width || !height) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    if (!source) {
      context.fillStyle = "#94a3b8";
      context.font = "600 16px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("等待图片", width / 2, height / 2);
      return;
    }
    const scale = Math.min(width / source.width, height / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const offsetX = Math.round((width - drawWidth) / 2);
    const offsetY = Math.round((height - drawHeight) / 2);
    context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
    this.applyPreviewProtection(context, width, height);
  },

  // 展开/折叠“原图与预处理图”对比区（默认展开；折叠用 class 隐藏，避免销毁 canvas）
  // 展开/收起时播放 0.2s 上下滑动+淡入淡出动画
  toggleComparePanel() {
    clearTimeout(this._compareToggleTimer);
    if (this.data.compareExpanded) {
      this.setData({ compareExpanding: false, compareCollapsing: true });
      this._compareToggleTimer = setTimeout(() => {
        this.setData({ compareExpanded: false, compareCollapsing: false });
      }, 200);
    } else {
      this.setData({ compareExpanded: true, compareCollapsing: false, compareExpanding: true });
      this._compareToggleTimer = setTimeout(() => {
        this.setData({ compareExpanding: false });
      }, 240);
    }
  },
  updateComparePreview(originalSource = null, processedSource = null) {
    if (!this.sourceThumb || !this.processedThumb) return;
    this.drawPreviewThumbnail(
      this.sourceThumb.ctx,
      originalSource || this.originalImage,
      this.sourceThumb.width,
      this.sourceThumb.height,
    );
    this.drawPreviewThumbnail(
      this.processedThumb.ctx,
      processedSource || this.image || this.originalImage,
      this.processedThumb.width,
      this.processedThumb.height,
    );
    const label = this.data.aiOptimizeOn ? "预处理后" : "预处理图";
    this.setData({ processedPreviewLabel: label });
  },

  syncUiSummary() {
    const preprocessText = this.data.aiOptimizeOn ? " · 预处理：AI 优化" : "";
    if (!this.cells.length) {
      this.setData({
        controlNote: this.hasPaidAccess()
          ? "上传图片后会自动生成图纸，也可选 AI 优化预处理。"
          : "当前预览版未解锁下载权限，请先兑换卡密后再下载图纸。",
      });
      return;
    }
    const protectionText = this.hasPaidAccess() ? " · 下载权限已解锁" : " · 下载权限未解锁";
    this.setData({
      controlNote: `当前使用 ${BEAD_PALETTES[PALETTE_KEYS[this.data.paletteIndex]].label} 色板，共 ${
        Object.keys(this.counts).length
      } 种颜色${preprocessText}${protectionText}`,
    });
  },

  updateStats() {
    const rows = Object.values(this.counts).sort((a, b) => b.count - a.count);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    this.setData({
      totalBeads: `${total} 颗`,
      paletteList: rows,
    });
  },

  // 复制色号清单文本到剪贴板，方便发到微信群/笔记。
  copyPaletteList() {
    const rows = Object.values(this.counts).sort((a, b) => b.count - a.count);
    if (!rows.length) return;
    const lines = [
      `拼豆图纸 · ${this.cols} x ${this.rows} · 共 ${rows.reduce((sum, row) => sum + row.count, 0)} 颗`,
      `色板：${BEAD_PALETTES[PALETTE_KEYS[this.data.paletteIndex]].label}`,
      "",
      "色号 | 颜色 | 数量",
      ...rows.map((row) => `${row.code} | ${row.label || row.hex.toUpperCase()} | ${row.count}`),
    ];
    wx.setClipboardData({
      data: lines.join("\n"),
      success: () => this.toast("色号清单已复制"),
    });
  },

  updateExportState() {
    this.setData({ cellsEmpty: !this.cells.length });
    this.updateEditorActions();
  },

  updateEditorActions() {
    this.setData({
      historyEmpty: !this.history.length,
      redoEmpty: !this.redoHistory.length,
      cellsEmpty: !this.cells.length,
    });
  },

  // ---------- 手绘编辑 ----------
  pushHistorySnapshot() {
    if (!this.cells.length) return;
    this.history.push(this.cells.map((line) => line.slice()));
    if (this.history.length > 40) this.history.shift();
    this.redoHistory = [];
  },

  getCellFromTouch(touch) {
    if (!this.renderMetrics || !this.cells.length) return null;
    const { offsetX, offsetY, cellSize, cols, rows } = this.renderMetrics;
    const col = Math.floor((touch.x - offsetX) / cellSize);
    const row = Math.floor((touch.y - offsetY) / cellSize);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return { row, col };
  },

  applyCellPaint(row, col) {
    const line = this.cells[row];
    if (!line) return false;
    const nextColor =
      this.data.editorTool === "eraser" ? this.getBlankColor() : this.getPaletteColorByCode(this.selectedColorCode);
    const currentColor = line[col];
    if (!currentColor || currentColor.code === nextColor.code) return false;
    line[col] = nextColor;
    return true;
  },

  commitEdit() {
    this.recomputeCounts();
    this.renderCanvas();
    this.syncUiSummary();
    this.schedulePatternSave();
    this.setData({
      canvasHint: `手绘编辑已更新，当前图纸为 ${this.cols} x ${this.rows}。`,
      statusText: "编辑中",
      statusState: "ready",
    });
  },

  onPaintStart(e) {
    if (!this.cells.length) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const hit = this.getCellFromTouch(touch);
    if (!hit) return;
    this.pushHistorySnapshot();
    this.isDrawing = true;
    if (!this.applyCellPaint(hit.row, hit.col)) {
      this.history.pop();
      this.updateEditorActions();
      return;
    }
    this.commitEdit();
  },

  onPaintMove(e) {
    if (!this.isDrawing) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const hit = this.getCellFromTouch(touch);
    if (hit && this.applyCellPaint(hit.row, hit.col)) {
      this.commitEdit();
    }
  },

  onPaintEnd() {
    this.isDrawing = false;
  },

  setBrush() {
    this.setData({ editorTool: "brush", editorModeText: "画笔模式" });
  },

  setEraser() {
    this.setData({ editorTool: "eraser", editorModeText: "橡皮模式" });
  },

  onSelectColor(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    this.selectedColorCode = code;
    this.setData({ editorTool: "brush", editorModeText: "画笔模式" });
    this.renderEditorPalette();
  },

  undoEdit() {
    const previous = this.history.pop();
    if (!previous) return;
    this.redoHistory.push(this.cells.map((line) => line.slice()));
    if (this.redoHistory.length > 40) this.redoHistory.shift();
    this.cells = previous.map((line) => line.slice());
    this.rows = this.cells.length;
    this.cols = this.cells[0] ? this.cells[0].length : this.cols;
    this.recomputeCounts();
    this.renderCanvas();
    this.syncUiSummary();
    this.schedulePatternSave();
    this.setData({
      canvasHint: "已撤销上一步编辑。",
      statusText: "编辑中",
      statusState: "ready",
    });
  },

  redoEdit() {
    const next = this.redoHistory.pop();
    if (!next) return;
    this.history.push(this.cells.map((line) => line.slice()));
    if (this.history.length > 40) this.history.shift();
    this.cells = next.map((line) => line.slice());
    this.rows = this.cells.length;
    this.cols = this.cells[0] ? this.cells[0].length : this.cols;
    this.recomputeCounts();
    this.renderCanvas();
    this.syncUiSummary();
    this.schedulePatternSave();
    this.setData({
      canvasHint: "已重做下一步编辑。",
      statusText: "编辑中",
      statusState: "ready",
    });
  },

  clearBoard() {
    if (!this.cells.length) return;
    this.pushHistorySnapshot();
    const blank = this.getBlankColor();
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => blank));
    this.commitEdit();
    this.setData({ canvasHint: "图纸已清空，现在可以从空白网格继续绘制。" });
  },

  // ---------- 控件事件 ----------
  onGridChanging(e) {
    this.setData({ gridSize: e.detail.value });
  },

  onGridChange(e) {
    this.setData({ gridSize: e.detail.value });
    this.processCurrentImage();
  },

  onMergeChange(e) {
    this.setData({ mergeLevel: e.detail.value });
    this.processCurrentImage();
  },

  onGridLineChange(e) {
    this.setData({ gridLineOn: e.detail.value });
    this.renderCanvas();
  },

  onPaletteChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      paletteIndex: index,
      paletteLabel: PALETTE_OPTIONS[index] ? PALETTE_OPTIONS[index].label : this.data.paletteLabel,
    });
    this.renderEditorPalette();
    // 有原始图片时按新色板重新采样（背景空白判定更准）；
    // 空白/手绘/存档图纸则把现有格子重映射到新色板，保留手工内容并立即重绘。
    if (this.sourceType === "image" && this.originalImage) {
      this.processCurrentImage();
    } else if (this.cells.length) {
      this.remapCellsToActivePalette();
    }
  },

  togglePreprocessPanel() {
    this.setData({ preprocessVisible: !this.data.preprocessVisible, showAiHint: false });
    this.syncOverlayState();
  },

  onAiOptimizeChange(e) {
    this.setData({ aiOptimizeOn: e.detail.value, showAiHint: false });
    this.processCurrentImage();
  },

  onAiHintTap() {
    this.setData({ showAiHint: false });
    this.togglePreprocessPanel();
  },

  onPromptInput(e) {
    this.setData({ aiPrompt: e.detail.value });
  },

  // AI 提示词快捷模板：选中即填充输入框（不自动提交，避免误触消耗次数）。
  onAiPromptPresetChange(e) {
    const index = Number(e.detail.value);
    const preset = AI_PROMPT_PRESETS[index];
    if (!preset) return;
    this.setData({
      aiPrompt: preset.value,
      aiPromptPresetIndex: 0,
    });
  },

  confirmAiPrompt() {
    this.confirmedAiPrompt = (this.data.aiPrompt || "").trim() || DEFAULT_AI_PROMPT;
    this.aiOptimizeCacheKey = "";
    this.aiOptimizeCacheImage = null;
    this.processCurrentImage();
  },

  // ---------- 导出 ----------
  renderExportCanvas(showCodes) {
    const rows = this.cells.length;
    const cols = this.cells[0] ? this.cells[0].length : 0;
    if (!rows || !cols) return null;

    const preferredCellSize = showCodes ? 48 : 30;
    const minCellSize = showCodes ? 24 : 12;
    const cellSize = Math.max(
      minCellSize,
      Math.min(
        preferredCellSize,
        Math.floor(MAX_CANVAS_DIMENSION / Math.max(cols, rows)),
        Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cols * rows))),
      ),
    );
    const titleHeight = 96;
    const legendWidth = 340;
    const padding = 36;
    const chartWidth = cols * cellSize;
    const chartHeight = rows * cellSize;
    const exportWidth = padding * 2 + chartWidth + legendWidth;
    const exportHeight = padding * 2 + titleHeight + chartHeight;
    if (
      exportWidth > MAX_CANVAS_DIMENSION ||
      exportHeight > MAX_CANVAS_DIMENSION ||
      exportWidth * exportHeight > MAX_CANVAS_PIXELS
    ) {
      throw new Error("图纸尺寸过大，浏览器无法生成导出画布，请降低横向格数后重试。");
    }

    const exportCanvas = this.createOffscreen(exportWidth, exportHeight);
    const context = exportCanvas.getContext("2d");
    const legendRows = Object.values(this.counts).sort((a, b) => b.count - a.count);

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, exportWidth, exportHeight);
    context.fillStyle = "#111827";
    context.font = "900 30px system-ui, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillText(`拼豆图纸 ${cols}x${rows}`, padding, 46);
    context.fillStyle = "#687385";
    context.font = "500 16px system-ui, sans-serif";
    context.fillText(showCodes ? "带 Code 图纸，便于按编号定位制作。" : "纯色图纸，适合打印或快速查看整体效果。", padding, 74);

    const chartX = padding;
    const chartY = padding + titleHeight;
    this.cells.forEach((line, row) => {
      line.forEach((cell, col) => {
        const x = chartX + col * cellSize;
        const y = chartY + row * cellSize;
        context.fillStyle = cell.hex;
        context.fillRect(x, y, cellSize, cellSize);
        if (showCodes) {
          this.drawWrappedCode(context, cell.code, x, y, cellSize, this.getTextColor(cell.hex));
        }
      });
    });

    context.strokeStyle = "rgba(17, 24, 39, 0.28)";
    context.lineWidth = 1;
    for (let col = 0; col <= cols; col += 1) {
      const x = chartX + col * cellSize + 0.5;
      context.beginPath();
      context.moveTo(x, chartY);
      context.lineTo(x, chartY + chartHeight);
      context.stroke();
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = chartY + row * cellSize + 0.5;
      context.beginPath();
      context.moveTo(chartX, y);
      context.lineTo(chartX + chartWidth, y);
      context.stroke();
    }
    context.strokeStyle = "#111827";
    context.lineWidth = 2;
    context.strokeRect(chartX, chartY, chartWidth, chartHeight);

    const legendX = chartX + chartWidth + 28;
    context.fillStyle = "#111827";
    context.font = "900 22px system-ui, sans-serif";
    context.fillText("颜色清单", legendX, chartY + 4);
    context.font = "600 14px system-ui, sans-serif";
    context.fillStyle = "#687385";
    context.fillText(`总计 ${cols * rows} 颗 · ${legendRows.length} 色`, legendX, chartY + 30);
    legendRows.slice(0, Math.floor((chartHeight - 58) / 28)).forEach((item, index) => {
      const y = chartY + 62 + index * 28;
      context.fillStyle = item.hex;
      context.fillRect(legendX, y - 16, 18, 18);
      context.strokeStyle = "rgba(17, 24, 39, 0.22)";
      context.strokeRect(legendX, y - 16, 18, 18);
      context.fillStyle = "#111827";
      context.font = "800 14px system-ui, sans-serif";
      context.fillText(item.code, legendX + 28, y);
      context.fillStyle = "#687385";
      context.font = "600 13px system-ui, sans-serif";
      context.fillText(`${item.hex.toUpperCase()} · ${item.count} 颗`, legendX + 78, y);
    });
    if (legendRows.length > Math.floor((chartHeight - 58) / 28)) {
      context.fillStyle = "#687385";
      context.font = "600 13px system-ui, sans-serif";
      context.fillText("更多颜色请查看 CSV 清单", legendX, chartY + chartHeight - 8);
    }
    return exportCanvas;
  },

  getTextColor(hex) {
    const [red, green, blue] = this.hexToRgb(hex);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    return luminance > 0.62 ? "#111827" : "#ffffff";
  },

  drawWrappedCode(context, code, x, y, cellSize, color) {
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (cellSize >= 36) {
      context.font = `800 ${Math.max(10, Math.floor(cellSize * 0.28))}px system-ui, sans-serif`;
      context.fillText(code, x + cellSize / 2, y + cellSize / 2, cellSize - 6);
      return;
    }
    if (cellSize >= 24) {
      context.font = `800 ${Math.max(8, Math.floor(cellSize * 0.32))}px system-ui, sans-serif`;
      context.fillText(code.replace(/[A-Z]+/, ""), x + cellSize / 2, y + cellSize / 2, cellSize - 4);
    }
  },

  buildLegendRows() {
    return Object.values(this.counts).sort((a, b) => b.count - a.count);
  },

  // CSV 字段安全转义：防止公式注入（= + - @ 开头）与逗号/引号破坏列结构。
  sanitizeCsvField(value) {
    let text = String(value == null ? "" : value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  },

  // 导出下载主流程：分块上传 → 服务端生成文件 → 下载结果 → 返回 ArrayBuffer
  // onProgress(label, percent, indeterminate)：把各阶段进度实时同步给进度浮层
  async submitDownload({ filename, dataUrl = null, text = null, onProgress = null }) {
    // 阶段进度上报工具：统一把文案/百分比/动画模式传给进度浮层
    const stage = (label, percent, indeterminate) => {
      if (typeof onProgress === "function") onProgress(label, percent, indeterminate);
    };
    // 组装下载请求参数：文件名（去扩展名）+ 当前图片指纹，用于服务端校验下载权限
    const payload = {
      filename: filename.replace(/\.[^/.]+$/, ""),
      imageHash: this.sourceFingerprint,
    };
    // 大图走分块上传：按块数实时上报进度，百分比映射到 12%~67%
    if (dataUrl) {
      console.log("[submitDownload] chunk upload start", { dataUrlLength: dataUrl.length });
      const { uploadId, ext } = await uploadDataChunks(dataUrl, "download", (done, total) => {
        const percent = 12 + Math.round((done / total) * 55);
        stage(`正在上传图纸数据（${done}/${total}）`, percent, false);
      });
      payload.dataUploadId = uploadId;
      payload.dataExt = ext;
      console.log("[submitDownload] chunk upload done", { uploadId });
    }
    if (text !== null && text !== undefined) payload.text = text;
    // 服务端合并分块并生成文件：内部进度不可知，显示 70% 加载动画
    console.log("[submitDownload] server prepare start");
    stage("服务端正在生成文件…", 70, true);
    const result = await requestJson("/api/download-prepare", { method: "POST", data: payload });
    console.log("[submitDownload] server prepare done", { fileID: result && result.fileID });
    const fileID = result && result.fileID;
    if (!fileID) {
      throw new Error("下载准备失败，请重试。");
    }
    // 云函数版：文件已上传到云存储，用 wx.cloud.downloadFile 拉取
    // 拉取云存储结果文件：onProgressUpdate 提供真实下载进度，映射到 70%~96%
    console.log("[submitDownload] download start", { fileID });
    const dl = await new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        onProgressUpdate: (res) => {
          const percent = Math.min(96, 70 + Math.round(((res.progress || 0) / 100) * 26));
          stage("正在下载文件…", percent, false);
        },
        success: resolve,
        fail: () => reject(new Error("下载文件失败，请重试。")),
      });
    });
    console.log("[submitDownload] download done", { tempFilePath: dl.tempFilePath });
    stage("正在读取文件…", 97, false);
    // 将下载的临时文件读取为 ArrayBuffer，返回给调用方保存
    const read = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: dl.tempFilePath,
        success: resolve,
        fail: () => reject(new Error("读取下载文件失败，请重试。")),
      });
    });
    console.log("[submitDownload] read done", { byteLength: read.data.byteLength });
    return { buffer: read.data, filename: (result && result.filename) || filename };
  },

  // 保存下载结果：CSV 直接预览并复制；PNG 写入临时目录后存入相册（失败则预览供长按保存）
  saveDownloadedFile(buffer, filename) {
    console.log("[saveDownloadedFile]", { filename, byteLength: buffer && buffer.byteLength });
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/${filename}`;
    try {
      fs.writeFileSync(filePath, buffer);
    } catch (error) {
      this.openErrorOverlay(`保存文件失败：${error.message || "请稍后重试"}`);
      return;
    }
    const isCsv = filename.toLowerCase().endsWith(".csv");
    if (isCsv) {
      const text = arrayBufferToUtf8(buffer);
      this.setData({ csvPreviewVisible: true, csvPreviewText: text });
      this.syncOverlayState();
      wx.setClipboardData({ data: text, success: () => {} });
      this.toast("CSV 已生成，可复制或查看");
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => this.toast("已保存到相册", "success"),
      fail: () => {
        wx.previewImage({
          urls: [filePath],
          fail: () => this.toast("请长按图片保存"),
        });
      },
    });
  },

  async exportPng(showCodes) {
    if (!this.cells.length) return;
    if (!this.hasPaidAccess()) {
      this.queueProtectedAction(() => this.exportPng(showCodes));
      this.setRedeemMessage("请先兑换卡密，解锁下载权限后再导出图纸。", "error");
      return;
    }
    if (this.downloadRemaining <= 0) {
      this.queueProtectedAction(() => this.exportPng(showCodes));
      this.setRedeemMessage("当前卡密下载次数已用完，请兑换新卡密。", "error");
      return;
    }
    if (!this.sourceFingerprint) {
      this.setRedeemMessage("未识别到当前图片，请重新上传后再试。", "error");
      return;
    }
    console.log("[exportPng] start", { showCodes, cols: this.cols, rows: this.rows });
    const suffix = showCodes ? "with-code" : "clean";
    this.setData({
      exportBusy: true,
      statusText: showCodes ? "正在生成带编号图纸" : "正在生成纯色图纸",
      statusState: "working",
    });
    this.showExportProgress("正在生成图纸…", 5, false);
    try {
      this.clearError();
      // 步骤1：生成本地导出画布（showCodes 决定是否绘制色号）
      const exportCanvas = this.renderExportCanvas(showCodes);
      this.updateExportProgress("正在生成图纸…", 10, false);
      const filename = `拼豆图纸-${suffix}-${this.cols}x${this.rows}.png`;
      // 步骤2：画布转 base64（10240 为最大边长限制）
      const dataUrl = await this.canvasToDataUrl(exportCanvas, 10240);
      // 步骤3：分块上传 → 服务端生成 → 下载结果，全程由 onProgress 更新进度条
      const output = await this.submitDownload({
        filename,
        dataUrl,
        onProgress: (label, percent, indeterminate) =>
          this.updateExportProgress(label, percent, indeterminate),
      });
      // 步骤4：保存下载结果（PNG 存相册 / CSV 预览），成功后关闭进度浮层
      this.updateExportProgress("正在保存…", 98, false);
      this.saveDownloadedFile(output.buffer, output.filename || filename);
      console.log("[exportPng] done", { filename });
      this.hideExportProgress();
      await this.loadAccessStatus();
      this.setData({ statusText: "导出开始，正在下载…", statusState: "working", canvasHint: "图纸导出请求已发送。" });
    } catch (error) {
      if (this.isCardDeniedError(error)) {
        this.handleCardDenied(error.message);
        this.openErrorOverlay(`下载未完成：${error.message || "当前卡密已失效，请使用新卡密。"}`);
      } else {
        console.error("[exportPng] failed", error);
        this.openErrorOverlay(`导出 PNG 失败：${error.message || "请稍后重试"}`);
      }
    } finally {
      this.setData({ exportBusy: false });
      this.hideExportProgress();
      if (!this.error && this.cells.length) {
        this.setData({ statusText: "图纸已生成", statusState: "ready" });
      }
    }
  },

  async exportCsv() {
    if (!this.cells.length) return;
    if (!this.hasPaidAccess()) {
      this.queueProtectedAction(() => this.exportCsv());
      this.setRedeemMessage("请先兑换卡密，解锁下载权限后再导出 CSV 清单。", "error");
      return;
    }
    if (this.downloadRemaining <= 0) {
      this.queueProtectedAction(() => this.exportCsv());
      this.setRedeemMessage("当前卡密下载次数已用完，请兑换新卡密。", "error");
      return;
    }
    if (!this.sourceFingerprint) {
      this.setRedeemMessage("未识别到当前图片，请重新上传后再试。", "error");
      return;
    }
    console.log("[exportCsv] start", { cols: this.cols, rows: this.rows });
    this.setData({ exportBusy: true, statusText: "正在生成 CSV 清单", statusState: "working" });
    this.showExportProgress("正在生成 CSV 清单…", 5, false);
    try {
      this.clearError();
      // 步骤1：构建 CSV 内容（色号统计 + 点阵坐标）
      const pointRows = this.cells.flatMap((line, rowIndex) =>
        line.map((cell, colIndex) => [rowIndex + 1, colIndex + 1, cell.code, cell.hex.toUpperCase()]),
      );
      const rows = [
        ["code", "hex", "count"],
        ...this.buildLegendRows().map((row) => [row.code, row.hex.toUpperCase(), row.count]),
        [],
        ["points"],
        ["row", "col", "code", "hex"],
        ...pointRows,
        [],
        ["grid", `${this.cols}x${this.rows}`],
        ["note", "下方网格与带 Code 图纸一一对应，可直接用于制作或二次排版。"],
        ...this.cells.map((line) => line.map((cell) => cell.code)),
      ];
      const csvText = rows.map((row) => row.map((cell) => this.sanitizeCsvField(cell)).join(",")).join("\n");
      const filename = `拼豆清单-${this.cols}x${this.rows}.csv`;
      // 步骤2：上传文本并下载生成的文件（同样走进度条）
      const output = await this.submitDownload({
        filename,
        text: `\uFEFF${csvText}`,
        onProgress: (label, percent, indeterminate) =>
          this.updateExportProgress(label, percent, indeterminate),
      });
      // 步骤4：保存下载结果（PNG 存相册 / CSV 预览），成功后关闭进度浮层
      this.updateExportProgress("正在保存…", 98, false);
      this.saveDownloadedFile(output.buffer, output.filename || filename);
      console.log("[exportCsv] done", { filename });
      this.hideExportProgress();
      await this.loadAccessStatus();
      this.setData({ statusText: "导出开始，正在下载…", statusState: "working" });
    } catch (error) {
      if (this.isCardDeniedError(error)) {
        this.handleCardDenied(error.message);
        this.openErrorOverlay(`导出未完成：${error.message || "当前卡密已失效，请使用新卡密。"}`);
      } else {
        console.error("[exportCsv] failed", error);
        this.openErrorOverlay(`导出 CSV 失败：${error.message || "请稍后重试"}`);
      }
    } finally {
      this.setData({ exportBusy: false });
      this.hideExportProgress();
      if (!this.error && this.cells.length) {
        this.setData({ statusText: "图纸已生成", statusState: "ready" });
      }
    }
  },

  exportCodePng() {
    this.exportPng(true).catch((error) => {
      this.openErrorOverlay(error.message || "导出失败，请稍后重试");
    });
  },

  exportCleanPng() {
    this.exportPng(false).catch((error) => {
      this.openErrorOverlay(error.message || "导出失败，请稍后重试");
    });
  },

  exportCsvTap() {
    this.exportCsv().catch((error) => {
      this.openErrorOverlay(error.message || "导出失败，请稍后重试");
    });
  },

  closeCsvPreview() {
    this.setData({ csvPreviewVisible: false });
    this.syncOverlayState();
  },

  // ---------- 本地存档 ----------
  // 把图片对象缩放后序列化为本地文件，返回文件路径（失败返回空串）
  cacheImageFile(prefix, image) {
    if (!image || !image.width || !image.height) return "";
    try {
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = this.createOffscreen(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, width, height);
      if (typeof canvas.toDataURL !== "function") return "";
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = String(dataUrl || "").split(",")[1];
      if (!base64) return "";
      const filePath = `${wx.env.USER_DATA_PATH}/${prefix}.png`;
      wx.getFileSystemManager().writeFileSync(filePath, base64, "base64");
      return filePath;
    } catch (error) {
      console.warn("[draft] cache image failed", { prefix, error: error && error.message });
      return "";
    }
  },
  savePatternToStorage() {
    if (!this.cells.length) return;
    try {
      const payload = {
        version: 2,
        savedAt: Date.now(),
        cells: this.cells,
        cols: this.cols,
        rows: this.rows,
        paletteIndex: this.data.paletteIndex,
        gridSize: this.data.gridSize,
        mergeLevel: this.data.mergeLevel,
        gridLineOn: this.data.gridLineOn,
        sourceFingerprint: this.sourceFingerprint || "",
        selectedColorCode: this.selectedColorCode || "",
      };
      // 缓存原图：恢复后调整横向格数/颜色合并仍以原图为基准，避免越调越模糊
      if (this.originalImage && this.originalImage !== this._cachedOriginalRef) {
        payload.originalImagePath = this.cacheImageFile("draft-original", this.originalImage);
        this._cachedOriginalRef = this.originalImage;
      }
      // 缓存预处理预览图（与原图不同才单独保存）
      if (this.image && this.image !== this.originalImage && this.image !== this._cachedPreviewRef) {
        payload.previewImagePath = this.cacheImageFile("draft-preview", this.image);
        this._cachedPreviewRef = this.image;
      }
      wx.setStorageSync(PATTERN_STORAGE_KEY, payload);
    } catch {
      // 存储空间不足时静默失败
    }
  },

  schedulePatternSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.savePatternToStorage(), 400);
  },

  restorePatternFromStorage() {
    let payload = null;
    try {
      payload = wx.getStorageSync(PATTERN_STORAGE_KEY);
    } catch {
      payload = null;
    }
    if (!payload || !Array.isArray(payload.cells) || !payload.cells.length) return false;
    if (!PALETTE_KEYS[payload.paletteIndex]) return false;

    this.cells = payload.cells;
    this.cols = payload.cols || (payload.cells[0] ? payload.cells[0].length : 0);
    this.rows = payload.rows || payload.cells.length;
    this.sourceType = "saved";
    this.sourceName = "saved-pattern";
    this.sourceFingerprint = payload.sourceFingerprint || `saved:${payload.savedAt}`;
    this.setData({
      paletteIndex: payload.paletteIndex,
      paletteLabel: PALETTE_OPTIONS[payload.paletteIndex] ? PALETTE_OPTIONS[payload.paletteIndex].label : this.data.paletteLabel,
      gridSize: payload.gridSize || this.data.gridSize,
      mergeLevel: payload.mergeLevel !== undefined ? payload.mergeLevel : this.data.mergeLevel,
      gridLineOn: payload.gridLineOn !== undefined ? payload.gridLineOn : this.data.gridLineOn,
      sourceType: "saved",
      canvasHint: "已恢复上次保存的图纸方案，可直接继续编辑或上传新图覆盖。",
      statusText: "已恢复存档",
      statusState: "ready",
      showClearHint: true,
    });
    // 恢复上次选中的画笔颜色，避免画笔颜色被重置后“点了没反应”
    if (payload.selectedColorCode && this.getActivePalette().some((color) => color.code === payload.selectedColorCode)) {
      this.selectedColorCode = payload.selectedColorCode;
    }
    this.isDrawing = false;
    this.renderMetrics = null;
    this.renderEditorPalette();
    this.recomputeCounts();
    this.renderCanvas();
    this.syncUiSummary();
    this.updateEditorActions();
    // 异步恢复原图/预览图，供继续无损调整格数
    this.restoreCachedImages(payload);
    this.toast("已恢复上次未完成的图纸");
    return true;
  },

  // 异步从本地文件恢复存档时缓存的原图/预览图
  restoreCachedImages(payload) {
    const createImage = () =>
      this.preview && this.preview.canvas && this.preview.canvas.createImage
        ? this.preview.canvas.createImage()
        : wx.createImage();
    const loadPath = (filePath) =>
      new Promise((resolve) => {
        if (!filePath) return resolve(null);
        const image = createImage();
        image.onload = () => resolve(image);
        image.onerror = () => {
          // 直接路径加载失败：回退为读取文件后用 dataURL 再试一次
          try {
            wx.getFileSystemManager().readFile({
              filePath,
              encoding: "base64",
              success: (res) => {
                try {
                  const retry = createImage();
                  retry.onload = () => resolve(retry);
                  retry.onerror = () => resolve(null);
                  retry.src = `data:image/png;base64,${res.data}`;
                } catch {
                  resolve(null);
                }
              },
              fail: () => resolve(null),
            });
          } catch {
            resolve(null);
          }
        };
        image.src = filePath;
      });
    Promise.all([loadPath(payload.originalImagePath), loadPath(payload.previewImagePath)]).then(([original, preview]) => {
      // 若用户已清除存档/重新上传，放弃本次异步恢复结果，避免覆盖新状态
      if (this.sourceType !== "saved" || !this.cells.length) return;
      if (original) {
        this.originalImage = original;
        this._cachedOriginalRef = original;
      }
      if (preview) {
        this.image = preview;
        this._cachedPreviewRef = preview;
      }
      if (original || preview) {
        this.updateComparePreview(this.originalImage, this.image || this.originalImage);
        console.log("[draft] cached images restored", { hasOriginal: !!original, hasPreview: !!preview });
      }
    });
  },
  clearSavedPattern() {
    wx.removeStorageSync(PATTERN_STORAGE_KEY);
    const fs = wx.getFileSystemManager();
    ["draft-original.png", "draft-preview.png"].forEach((name) => {
      try {
        fs.unlinkSync(`${wx.env.USER_DATA_PATH}/${name}`);
      } catch {
        // 文件不存在时忽略
      }
    });
    // 恢复到“未上传图片”初始状态：清空图纸、原图与预览图，重新显示上传框
    this.cells = [];
    this.cols = 64;
    this.rows = 64;
    this.counts = {};
    this.history = [];
    this.redoHistory = [];
    this.image = null;
    this.originalImage = null;
    this.sourceName = "";
    this.sourceType = "none";
    this.sourceFingerprint = "";
    this.renderMetrics = null;
    this.isDrawing = false;
    this.selectedColorCode = "";
    this.setData({
      sourceType: "none",
      cellsEmpty: true,
      statusText: "等待图片",
      statusState: "",
      canvasHint: "上传后会生成带网格线的拼豆预览图，可用于确认布局和配色。",
      controlNote: "上传图片后会自动生成色号，你也能继续手动微调。",
      uploadTitle: "上传图片开始生成",
      uploadHint: "支持 JPG / PNG / WebP，可点击选择图片",
      showClearHint: false,
    });
    this.renderEditorPalette();
    this.updateComparePreview();
    this.renderCanvas();
    this.syncUiSummary();
    this.updateEditorActions();
    this.toast("已清除存档，请重新上传图片");
  },

    // ---------- 项目库：多图纸存档（云端按 openid 绑定，清除缓存后仍可恢复） ----------
  readProjects() {
    try {
      const raw = wx.getStorageSync(PROJECTS_STORAGE_KEY);
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  },

  writeProjects(projects) {
    try {
      wx.setStorageSync(PROJECTS_STORAGE_KEY, projects);
    } catch {
      // 存储满时静默失败
    }
  },

  applyProjectList(projects) {
    const list = (projects || []).map((project) => ({
      ...project,
      savedAtText: project.savedAt ? new Date(project.savedAt).toLocaleString() : "",
    }));
    this.setData({ projects: list });
  },

  // 项目 -> 元数据（不含 cells，供云端 projects 集合保存）
  projectToMeta(project) {
    return {
      id: project.id,
      name: project.name,
      savedAt: project.savedAt,
      cols: project.cols,
      rows: project.rows,
      paletteIndex: project.paletteIndex,
      gridSize: project.gridSize,
      mergeLevel: project.mergeLevel,
      gridLineOn: project.gridLineOn,
      sourceFingerprint: project.sourceFingerprint || "",
      sourceType: project.sourceType || "blank",
      selectedColorCode: project.selectedColorCode || "",
    };
  },

  // 把项目 JSON 写入本地临时文件，返回文件路径（供 wx.cloud.uploadFile 使用）
  writeProjectTempFile(project) {
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/project-${project.id}.json`;
    fs.writeFileSync(filePath, JSON.stringify(project), "utf8");
    return filePath;
  },

  // 上传图纸 JSON 到云存储，并在 projects 集合写入元数据；返回 { ...meta, fileID }
  // 上传图纸 JSON 到云存储，并在 projects 集合写入元数据；返回 { ...meta, fileID, originalFileID, previewFileID }
  // withImages=true 时把原图/预览图一并上传，载入后调整格数/颜色合并仍以原图为基准，避免越调越模糊
  async uploadProjectToCloud(project, options = {}) {
    const { withImages = false } = options;
    const filePath = this.writeProjectTempFile(project);
    const upload = await new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: `projects/${project.id}.json`,
        filePath,
        success: resolve,
        fail: (err) => reject(new Error((err && err.errMsg) || "云存储上传失败")),
      });
    });
    let originalFileID = "";
    let previewFileID = "";
    if (withImages) {
      const originalPath = this.originalImage ? this.cacheImageFile(`project-original-${project.id}`, this.originalImage) : "";
      const previewPath =
        this.image && this.image !== this.originalImage ? this.cacheImageFile(`project-preview-${project.id}`, this.image) : "";
      const uploadImage = (localPath, cloudName) =>
        localPath
          ? new Promise((resolve, reject) => {
              wx.cloud.uploadFile({
                cloudPath: `projects/${cloudName}`,
                filePath: localPath,
                success: resolve,
                fail: (err) => reject(new Error((err && err.errMsg) || "云存储图片上传失败")),
              });
            })
          : Promise.resolve(null);
      const [origUpload, prevUpload] = await Promise.all([
        uploadImage(originalPath, `${project.id}-original.png`),
        uploadImage(previewPath, `${project.id}-preview.png`),
      ]);
      originalFileID = (origUpload && origUpload.fileID) || "";
      previewFileID = (prevUpload && prevUpload.fileID) || "";
    }
    const meta = this.projectToMeta(project);
    const res = await callFunction("project-store", {
      action: "saveMeta",
      ...meta,
      fileID: upload.fileID,
      originalFileID,
      previewFileID,
    });
    if (!res || !res.success) {
      throw new Error((res && res.message) || "项目元数据保存失败");
    }
    return { ...meta, fileID: upload.fileID, originalFileID, previewFileID };
  },

  // 从云端下载项目缓存的原图/预览图（失败返回 null，不影响图纸加载）
  downloadProjectImage(fileID) {
    return new Promise((resolve) => {
      if (!fileID) return resolve(null);
      wx.cloud.downloadFile({
        fileID,
        success: (dl) => {
          const createImage = () =>
            this.preview && this.preview.canvas && this.preview.canvas.createImage
              ? this.preview.canvas.createImage()
              : wx.createImage();
          const image = createImage();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = dl.tempFilePath;
        },
        fail: () => resolve(null),
      });
    });
  },
  // 从云端下载图纸 JSON 并解析出 cells
  downloadProjectCells(project) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID: project.fileID,
        success: (dl) => {
          wx.getFileSystemManager().readFile({
            filePath: dl.tempFilePath,
            encoding: "utf8",
            success: (res) => {
              try {
                const data = JSON.parse(res.data);
                if (!Array.isArray(data.cells) || !data.cells.length) {
                  reject(new Error("图纸数据格式异常"));
                  return;
                }
                resolve(data.cells);
              } catch {
                reject(new Error("图纸数据解析失败"));
              }
            },
            fail: () => reject(new Error("读取云端图纸失败")),
          });
        },
        fail: (err) => reject(new Error((err && err.errMsg) || "下载云端图纸失败")),
      });
    });
  },

  // 刷新项目列表：先展示本地缓存，再拉取云端列表合并；仅存在于本地的旧项目自动同步上云
  async refreshProjectList() {
    this.applyProjectList(this.readProjects());
    try {
      const res = await callFunction("project-store", { action: "list" });
      if (!res || !res.success) throw new Error((res && res.message) || "云端列表获取失败");
      // 兼容旧数据：云端文档可能只有 _id 没有 id 字段
      const cloudProjects = (res.projects || []).map((p) => ({ ...p, id: p.id || p._id }));
      const cloudIds = new Set(cloudProjects.map((p) => p && p.id));
      const localProjects = this.readProjects();
      const localOnly = localProjects.filter((p) => p && !cloudIds.has(p.id));
      this.writeProjects([...cloudProjects, ...localOnly]);
      this.applyProjectList([...cloudProjects, ...localOnly]);
      // 只自动同步一次：本次会话中已失败的本地项目标记后不再反复提示
      const pending = localOnly.filter((p) => !this._migrationFailedIds || !this._migrationFailedIds.has(p.id));
      if (pending.length) {
        this.toast(`正在同步 ${pending.length} 个本地项目到云端…`);
        for (const project of pending) {
          try {
            const uploaded = await this.uploadProjectToCloud(project);
            project.fileID = uploaded.fileID;
          } catch (error) {
            console.error("[project-store] migrate failed", { id: project.id, error: error && error.message });
            this._migrationFailedIds = this._migrationFailedIds || new Set();
            this._migrationFailedIds.add(project.id);
          }
        }
        this.writeProjects(localProjects);
        await this.refreshProjectList();
      }
    } catch (error) {
      console.error("[project-store] list failed, use local cache", error);
      this.applyProjectList(this.readProjects());
    }
  },

  openProjectLibrary() {
    this.setData({ projectModalVisible: true });
    this.syncOverlayState();
    this.refreshProjectList();
  },

  closeProjectLibrary() {
    this.setData({ projectModalVisible: false });
    this.syncOverlayState();
  },

  onProjectNameInput(e) {
    this.setData({ projectName: e.detail.value });
  },

  async saveProjectFromLibrary() {
    if (!this.cells.length) {
      this.openErrorOverlay("当前没有图纸可保存，请先生成图纸。");
      return;
    }
    const name = (this.data.projectName || "").trim() || `项目 ${new Date().toLocaleDateString()}`;
    const project = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      savedAt: Date.now(),
      cols: this.cols,
      rows: this.rows,
      paletteIndex: this.data.paletteIndex,
      gridSize: this.data.gridSize,
      mergeLevel: this.data.mergeLevel,
      gridLineOn: this.data.gridLineOn,
      sourceFingerprint: this.sourceFingerprint || "",
      sourceType: this.sourceType || "blank",
      selectedColorCode: this.selectedColorCode || "",
      cells: this.cells,
    };
    wx.showLoading({ title: "保存中", mask: true });
    try {
      const uploaded = await this.uploadProjectToCloud(project, { withImages: true });
      const projects = this.readProjects().filter((p) => p.id !== project.id);
      projects.push({
        ...project,
        fileID: uploaded.fileID,
        originalFileID: uploaded.originalFileID,
        previewFileID: uploaded.previewFileID,
      });
      this.writeProjects(projects);
      wx.hideLoading();
      this.setData({ projectName: "" });
      this.applyProjectList(projects);
      this.toast(`已保存项目「${name}」。`);
    } catch (error) {
      wx.hideLoading();
      this.openErrorOverlay(`保存失败：${error.message || "请稍后重试"}`);
    }
  },

  async loadProjectFromLibrary(e) {
    const index = Number(e.currentTarget.dataset.index);
    const projects = this.readProjects();
    const project = projects[index];
    if (!project) return;
    wx.showLoading({ title: "加载中", mask: true });
    try {
      // 并行下载图纸数据与原图/预览图：载入后调整格数/颜色合并仍以原图为基准，避免越调越模糊
      const cellsPromise =
        Array.isArray(project.cells) && project.cells.length
          ? Promise.resolve(project.cells)
          : this.downloadProjectCells(project);
      const [cells, originalImage, previewImage] = await Promise.all([
        cellsPromise,
        this.downloadProjectImage(project.originalFileID),
        this.downloadProjectImage(project.previewFileID),
      ]);
      if (!Array.isArray(cells) || !cells.length) {
        this.openErrorOverlay("该项目数据不完整，无法加载。");
        return;
      }
      // 仅把可序列化的 cells 与 fileID 写回本地缓存（Image 对象不入缓存）
      projects[index] = { ...project, cells };
      this.writeProjects(projects);
      const loaded = { ...project, cells, originalImage, previewImage };
      const paletteKey = PALETTE_KEYS[loaded.paletteIndex];
      if (!paletteKey) {
        this.openErrorOverlay("该项目使用的色板不存在，无法载入。");
        return;
      }
      this.setData({
        paletteIndex: loaded.paletteIndex,
        paletteLabel: PALETTE_OPTIONS[loaded.paletteIndex] ? PALETTE_OPTIONS[loaded.paletteIndex].label : this.data.paletteLabel,
        gridSize: loaded.gridSize || this.data.gridSize,
        mergeLevel: loaded.mergeLevel || this.data.mergeLevel,
        gridLineOn: loaded.gridLineOn !== undefined ? loaded.gridLineOn : this.data.gridLineOn,
      });
      // 恢复上次选中的画笔颜色，避免画笔颜色被重置后“点了没反应”
      if (loaded.selectedColorCode && this.getActivePalette().some((color) => color.code === loaded.selectedColorCode)) {
        this.selectedColorCode = loaded.selectedColorCode;
      }
      this.isDrawing = false;
      this.renderMetrics = null;
      this.cells = loaded.cells;
      this.cols = loaded.cols || (loaded.cells[0] || []).length;
      this.rows = loaded.rows || loaded.cells.length;
      this.sourceFingerprint = loaded.sourceFingerprint || "";
      this.sourceType = loaded.sourceType || "blank";
      // 恢复原图/预览图：调整格数/颜色合并时以原图为基准重采样
      this.originalImage = loaded.originalImage || null;
      this.image = loaded.previewImage || loaded.originalImage || null;
      this.history = [];
      this.redoHistory = [];
      this.renderEditorPalette();
      this.recomputeCounts();
      this.renderCanvas();
      this.updateComparePreview(this.originalImage, this.image || this.originalImage);
      this.syncUiSummary();
      this.updateEditorActions();
      this.schedulePatternSave();
      this.setData({
        sourceType: this.sourceType,
        showClearHint: false,
        canvasHint: `已载入项目「${loaded.name || "未命名项目"}」。`,
        statusText: "项目已载入",
        statusState: "ready",
        projectModalVisible: false,
      });
      this.syncOverlayState();
    } catch (error) {
      this.openErrorOverlay(`加载失败：${error.message || "请稍后重试"}`);
    } finally {
      wx.hideLoading();
    }
  },

  deleteProjectFromLibrary(e) {
    const index = Number(e.currentTarget.dataset.index);
    const projects = this.readProjects();
    const project = projects[index];
    if (!project) return;
    wx.showModal({
      title: "删除项目",
      content: `确定删除项目「${project.name || "未命名项目"}」吗？`,
      confirmColor: "#e11d48",
      success: async (res) => {
        if (!res.confirm) return;
        projects.splice(index, 1);
        this.writeProjects(projects);
        this.applyProjectList(projects);
        if (project.fileID) {
          try {
            await callFunction("project-store", { action: "delete", id: project.id });
          } catch (error) {
            console.error("[project-store] delete failed", error);
            this.toast("云端删除失败，请稍后重试");
          }
        }
      },
    });
  },
  // 清空当前账号（openid）的云端数据：项目（记录+文件）与意见反馈
  clearUserCloudData() {
    wx.showModal({
      title: "清空云端数据",
      content: "将删除当前账号云端保存的全部项目与意见反馈（含云存储文件），且无法恢复。确定继续吗？",
      confirmText: "清空",
      confirmColor: "#e11d48",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "清空中", mask: true });
        try {
          const result = await callFunction("project-store", { action: "clearUserData" });
          wx.hideLoading();
          // 同步清空本地项目缓存，避免下次打开时把已删除的项目重新同步回云端
          this.writeProjects([]);
          this.applyProjectList([]);
          this.toast(`已清空 ${(result && result.deletedProjects) || 0} 个项目`);
        } catch (error) {
          wx.hideLoading();
          this.openErrorOverlay(`清空失败：${error.message || "请稍后重试"}`);
        }
      },
    });
  },
  onFeedbackInput(e) {
    this.setData({ feedbackInput: e.detail.value });
  },

  async submitFeedback() {
    const content = (this.data.feedbackInput || "").trim();
    if (!content) {
      this.toast("请先输入内容");
      return;
    }
    wx.showLoading({ title: "提交中", mask: true });
    try {
      // 先校验是否为管理密码（密钥只存在于云函数环境变量，不暴露到客户端）
      const verify = await callFunction("card-admin", { action: "verify", adminKey: content });
      if (verify && verify.ok) {
        wx.setStorageSync("pixelbeansAdminKey", content);
        wx.hideLoading();
        wx.navigateTo({ url: "/pages/admin/admin" });
        return;
      }
      // 普通意见反馈
      const res = await callFunction("feedback", { content });
      wx.hideLoading();
      if (res && res.success) {
        this.setData({ feedbackInput: "" });
        wx.navigateTo({ url: "/pages/feedback-success/feedback-success" });
      } else {
        this.toast((res && res.message) || "提交失败，请重试");
      }
    } catch (error) {
      wx.hideLoading();
      this.toast((error && error.message) || "提交失败，请检查云函数是否已部署");
    }
  },
});
