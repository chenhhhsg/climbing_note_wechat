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
        env: 'cloud1-d1gm2volcc162cb06',
        traceUser: true
      });
    }
  },

  globalData: {
    userInfo: null,

    // 攀岩类型（存储值 -> 中文显示）
    climbTypes: ['boulder', 'lead', 'speed', 'outdoor'],
    climbTypeLabels: {
      boulder: '抱石',
      lead: '先锋攀',
      speed: '竞速',
      outdoor: '野外'
    },

    // 完成状态（存储值 -> 中文显示）
    statusOptions: ['flash', 'completed', 'failed', 'project'],
    statusLabels: {
      flash: 'Flash',
      completed: '完成',
      failed: '未完成',
      project: 'Project'
    }
  }
});
