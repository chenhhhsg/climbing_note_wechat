/**
 * 统计页面 - 基于 climbing_sessions 的攀岩统计
 */
const db = require('../../utils/db');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    loading: true,
    isEmpty: false,

    // 核心数据
    totalSessions: 0,
    totalRoutes: 0,
    monthSessions: 0,
    monthRoutes: 0,
    maxGrade: '-',
    completionRate: 0,

    // 线路状态统计
    flashCount: 0,
    completedCount: 0,
    failedCount: 0,
    projectCount: 0,

    // 攀岩类型分布
    typeDistribution: [],

    // 常去岩馆
    topLocations: [],

    // 月度趋势
    monthTrend: [],
    monthTrendSessionsMax: 1,
    monthTrendRoutesMax: 1,

    // 趋势切换
    trendMode: 'sessions' // 'sessions' | 'routes'
  },

  onLoad() {
    this.loadStats();
  },

  onShow() {
    this.loadStats();
  },

  onPullDownRefresh() {
    this.loadStats().then(() => wx.stopPullDownRefresh());
  },

  async loadStats() {
    this.setData({ loading: true });

    const res = await db.getSessionStats();

    if (res.success) {
      const { climbTypeLabels } = app.globalData;
      const stats = res.data;

      const isEmpty = stats.totalSessions === 0;

      // 类型分布添加中文标签
      const typeDistribution = (stats.typeDistribution || []).map(item => ({
        ...item,
        label: climbTypeLabels[item.type] || item.type
      }));

      // 月度趋势最大值
      const monthTrend = stats.monthTrend || [];
      const monthTrendSessionsMax = Math.max(...monthTrend.map(m => m.sessions), 1);
      const monthTrendRoutesMax = Math.max(...monthTrend.map(m => m.routes), 1);

      this.setData({
        loading: false,
        isEmpty,
        totalSessions: stats.totalSessions || 0,
        totalRoutes: stats.totalRoutes || 0,
        monthSessions: stats.monthSessions || 0,
        monthRoutes: stats.monthRoutes || 0,
        maxGrade: stats.maxGrade || '-',
        completionRate: stats.completionRate || 0,
        flashCount: stats.flashCount || 0,
        completedCount: stats.completedCount || 0,
        failedCount: stats.failedCount || 0,
        projectCount: stats.projectCount || 0,
        typeDistribution,
        topLocations: stats.topLocations || [],
        monthTrend,
        monthTrendSessionsMax,
        monthTrendRoutesMax
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onTrendModeChange(e) {
    this.setData({ trendMode: e.currentTarget.dataset.mode });
  }
});
