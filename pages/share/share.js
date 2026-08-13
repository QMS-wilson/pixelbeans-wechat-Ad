const { callFunction } = require("../../utils/api");

Page({
  data: {
    loading: true,
    error: "",
    share: null,
    name: "",
    metaText: "",
    paid: true,
    hasOriginal: false,
    hasPreview: false,
  },

  onLoad(options) {
    this.shareId = String((options && options.shareId) || "").trim();
    this.cells = [];
    this.cols = 0;
    this.rows = 0;
    this.originalImage = null;
    this.previewImage = null;
    this.share = null;
  },

  onReady() {
    // 画布位于 wx:else 条件块内，需等待分享数据加载完成后再初始化
    this.loadShare();
  },

  initCanvases() {
    return Promise.all([
      this.initCanvas("shareCanvas"),
      this.initCanvas("shareOriginalCanvas"),
      this.initCanvas("shareProcessedCanvas"),
    ]).then(([preview, original, processed]) => {
      this.preview = preview;
      this.originalThumb = original;
      this.processedThumb = processed;
    });
  },

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

  renderPlaceholder() {
    if (!this.preview) return;
    const { ctx, width, height } = this.preview;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("正在加载分享…", width / 2, height / 2);
  },

  async loadShare() {
    if (!this.shareId) {
      this.setData({ loading: false, error: "分享链接无效" });
      return;
    }
    try {
      const res = await callFunction("share-pattern", { action: "get", shareId: this.shareId });
      if (!res || !res.success || !res.share) {
        throw new Error((res && res.message) || "分享不存在或已失效。");
      }
      const share = res.share;
      this.share = share;
      await new Promise((resolve) => {
        this.setData(
          {
            loading: false,
            share,
            name: share.name || "拼豆图纸",
            metaText: `${share.cols || 0} x ${share.rows || 0}`,
            paid: !!share.paid,
            hasOriginal: !!share.originalFileID,
            hasPreview: !!share.previewFileID,
          },
          resolve,
        );
      });
      // 画布此时才渲染到页面上，初始化后再下载图片/图纸并绘制
      await this.initCanvases();
      const [cells, original, preview] = await Promise.all([
        this.downloadCells(share.fileID),
        this.downloadImage(share.originalFileID),
        this.downloadImage(share.previewFileID),
      ]);
      if (!Array.isArray(cells) || !cells.length) {
        throw new Error("图纸数据不完整，无法查看。");
      }
      this.cells = cells;
      this.cols = share.cols || (cells[0] || []).length;
      this.rows = share.rows || cells.length;
      this.originalImage = original || null;
      this.previewImage = preview || null;
      this.renderAll();
    } catch (error) {
      console.error("[share] load failed", error);
      const message = (error && error.message) || "加载分享失败";
      const classified = /FUNCTION_NOT_FOUND|FunctionName parameter could not be found/.test(message)
        ? "分享服务未部署：请先在微信开发者工具中部署 share-pattern 云函数。"
        : message;
      this.setData({ loading: false, error: classified });
    }
  },

  downloadCells(fileID) {
    return new Promise((resolve, reject) => {
      if (!fileID) {
        reject(new Error("图纸文件缺失"));
        return;
      }
      wx.cloud.downloadFile({
        fileID,
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
            fail: () => reject(new Error("读取图纸失败")),
          });
        },
        fail: () => reject(new Error("下载图纸失败")),
      });
    });
  },

  downloadImage(fileID) {
    return new Promise((resolve) => {
      if (!fileID) return resolve(null);
      wx.cloud.downloadFile({
        fileID,
        success: (dl) => {
          const createImage = () =>
            this.preview && this.preview.canvas ? this.preview.canvas.createImage() : wx.createImage();
          const image = createImage();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = dl.tempFilePath;
        },
        fail: () => resolve(null),
      });
    });
  },

  // 未付款创作者的分享统一叠加「未付款预览」水印，避免绕过付费预览
  applyWatermark(context, width, height) {
    if (!context || !width || !height) return;
    const diagonal = Math.sqrt(width * width + height * height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(-Math.PI / 5);
    context.fillStyle = "rgba(17, 24, 39, 0.22)";
    context.font = `800 ${Math.max(14, Math.floor(width * 0.05))}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const stepX = Math.max(150, Math.floor(width * 0.3));
    const stepY = Math.max(80, Math.floor(height * 0.16));
    for (let y = -diagonal; y <= diagonal; y += stepY) {
      for (let x = -diagonal; x <= diagonal; x += stepX) {
        context.fillText("未付款预览", x, y);
      }
    }
    context.restore();
  },

  drawThumb(context, source, width, height) {
    if (!context || !width || !height) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    if (!source) {
      context.fillStyle = "#94a3b8";
      context.font = "600 14px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("无预览图", width / 2, height / 2);
    } else {
      const scale = Math.min(width / source.width, height / source.height);
      const drawWidth = Math.max(1, Math.round(source.width * scale));
      const drawHeight = Math.max(1, Math.round(source.height * scale));
      const offsetX = Math.round((width - drawWidth) / 2);
      const offsetY = Math.round((height - drawHeight) / 2);
      context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
    }
    if (!this.data.paid) this.applyWatermark(context, width, height);
  },

  renderAll() {
    this.renderPattern();
    this.drawThumb(
      this.originalThumb && this.originalThumb.ctx,
      this.originalImage,
      this.originalThumb && this.originalThumb.width,
      this.originalThumb && this.originalThumb.height,
    );
    this.drawThumb(
      this.processedThumb && this.processedThumb.ctx,
      this.previewImage || this.originalImage,
      this.processedThumb && this.processedThumb.width,
      this.processedThumb && this.processedThumb.height,
    );
  },

  renderPattern() {
    if (!this.preview) return;
    const { ctx, width, height } = this.preview;
    const cells = this.cells;
    const rows = cells.length;
    const cols = cells[0] ? cells[0].length : 0;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    if (!rows || !cols) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("图纸为空", width / 2, height / 2);
      return;
    }
    const padding = Math.max(4, Math.floor(width * 0.01));
    const cellSize = Math.max(1, Math.min((width - padding * 2) / cols, (height - padding * 2) / rows));
    const chartWidth = cellSize * cols;
    const chartHeight = cellSize * rows;
    const offsetX = Math.round((width - chartWidth) / 2);
    const offsetY = Math.round((height - chartHeight) / 2);
    cells.forEach((line, row) => {
      line.forEach((cell, col) => {
        if (!cell || !cell.hex) return;
        const x0 = Math.round(offsetX + col * cellSize);
        const y0 = Math.round(offsetY + row * cellSize);
        const x1 = Math.round(offsetX + (col + 1) * cellSize);
        const y1 = Math.round(offsetY + (row + 1) * cellSize);
        ctx.fillStyle = cell.hex;
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      });
    });
    if (cellSize >= 3) {
      ctx.strokeStyle = "rgba(17, 24, 39, 0.18)";
      ctx.lineWidth = 1;
      for (let col = 0; col <= cols; col += 1) {
        ctx.beginPath();
        ctx.moveTo(offsetX + col * cellSize + 0.5, offsetY);
        ctx.lineTo(offsetX + col * cellSize + 0.5, offsetY + chartHeight);
        ctx.stroke();
      }
      for (let row = 0; row <= rows; row += 1) {
        ctx.beginPath();
        ctx.moveTo(offsetX, offsetY + row * cellSize + 0.5);
        ctx.lineTo(offsetX + chartWidth, offsetY + row * cellSize + 0.5);
        ctx.stroke();
      }
    }
    if (!this.data.paid) this.applyWatermark(ctx, width, height);
  },

  importToCanvas() {
    if (!this.share || !this.shareId) return;
    wx.navigateTo({ url: `/pages/index/index?import=${this.shareId}` });
  },

  goHome() {
    wx.reLaunch({ url: "/pages/index/index" });
  },
});
