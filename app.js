const config = require("./config.js");

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error("当前基础库版本过低，请使用 2.2.3 及以上版本以使用云能力");
      return;
    }
    wx.cloud.init({
      env: config.cloudEnv || undefined,
      traceUser: true,
    });
  },
  globalData: {
    // 云函数版不再使用 HTTP 接口地址
    apiBase: "",
  },
});
