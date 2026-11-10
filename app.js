/**
 * 攀笔 - 攀岩记录小程序
 * 应用入口文件
 *
 * T016：云启动与正式本机档案隔离。没有云能力、云环境仍是占位或初始化失败时，
 * 只记账并继续启动——正式页面的本机记录、场内记把与回看都不依赖云。旧云记录的
 * 读取失败在 utils/db.js 里以可判别错误返回，不在这里阻塞启动。
 * 不改 AppID、不猜云环境：env 仍是占位值，由后续任务在获得真实环境后替换。
 */
App({
  onLaunch() {
    // 云能力不可用时只记录，不影响本机档案与页面加载。
    if (typeof wx === 'undefined' || !wx.cloud) {
      console.warn('未检测到云开发能力（可能基础库低于 2.2.3）：旧云记录暂不可读，本机记录不受影响');
      this.globalData.cloudReady = false;
      return;
    }
    try {
      wx.cloud.init({
        // 占位环境：获得真实云环境后在配置任务中替换，这里不猜测。
        env: 'your-env-id',
        traceUser: true
      });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.error('云开发初始化失败：旧云记录暂不可读，本机记录不受影响', error);
      this.globalData.cloudReady = false;
    }
  },

  globalData: {
    // 全局数据
    userInfo: null,
    // 云能力是否可用；false 时旧云记录走可判别失败，本机档案照常。
    cloudReady: false,
    // 攀岩类型选项
    climbTypes: ['抱石', '先锋攀', '顶绳攀', '室内', '室外'],
    // 完成状态选项
    statusOptions: ['完成', '未完成', '挂片', '红点']
  }
});
