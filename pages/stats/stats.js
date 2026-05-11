/**
 * 统计页面
 * 显示攀岩统计数据
 */
const db = require('../../utils/db');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    loading: true,
    totalClimbs: 0,
    monthClimbs: 0,
    maxGrade: '-',
    completionRate: 0,
    flashCount: 0,
    projectCount: 0,
    projectActive: 0,
    projectCompleted: 0,
    projectAbandoned: 0,
    topLocations: [],
    typeDistribution: [],
    monthTrend: [],
    monthTrendMax: 1 // 用于计算趋势图高度
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

    const res = await db.getStats();

    if (res.success) {
      const { climbTypeLabels } = app.globalData;
      const stats = res.data;

      // 为类型分布添加中文标签
      const typeDistribution = stats.typeDistribution.map(item => ({
        ...item,
        label: climbTypeLabels[item.type] || item.type
      }));

      // 计算月度趋势最大值
      const monthTrendMax = Math.max(...stats.monthTrend.map(m => m.count), 1);

      this.setData({
        loading: false,
        totalClimbs: stats.total,
        monthClimbs: stats.monthClimbs,
        maxGrade: stats.maxGrade || '-',
        completionRate: stats.completionRate,
        flashCount: stats.flashCount,
        projectCount: stats.projectCount,
        projectActive: stats.projectActive,
        projectCompleted: stats.projectCompleted,
        projectAbandoned: stats.projectAbandoned,
        topLocations: stats.topLocations,
        typeDistribution,
        monthTrend: stats.monthTrend,
        monthTrendMax
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  }
});
