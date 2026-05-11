/**
 * 攀笔 - 攀岩记录小程序
 * 应用入口文件
 */
App({
  onLaunch() {
    // 初始化云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        // 替换为你的云开发环境ID
        env: 'your-env-id',
        traceUser: true
      });
    }
  },

  globalData: {
    // 全局数据
    userInfo: null,
    // 攀岩类型选项
    climbTypes: ['抱石', '先锋攀', '顶绳攀', '室内', '室外'],
    // 完成状态选项
    statusOptions: ['完成', '未完成', '挂片', '红点']
  }
});
