/**
 * 统计页面
 * 显示攀岩统计数据
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');

Page({
  data: {
    loading: true,
    totalClimbs: 0,       // 总攀岩次数
    monthClimbs: 0,       // 本月攀岩次数
    maxGrade: '-',        // 最高难度
    completedCount: 0,    // 完成次数
    failedCount: 0,       // 未完成次数
    completionRate: 0,    // 完成率
    topLocations: [],     // 常去地点
    typeDistribution: []  // 类型分布
  },

  onLoad() {
    this.loadStats();
  },

  onShow() {
    this.loadStats();
  },

  onPullDownRefresh() {
    this.loadStats().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 加载统计数据
   */
  async loadStats() {
    this.setData({ loading: true });

    try {
      const res = await db.getAllRecords();
      const records = res.data;

      // 总攀岩次数
      const totalClimbs = records.length;

      // 本月攀岩次数
      const monthClimbs = records.filter(r => dateUtil.isThisMonth(r.date)).length;

      // 最高难度
      const allGrades = records.map(r => r.grade).filter(Boolean);
      const maxGrade = gradeUtil.getMaxGrade(allGrades);

      // 完成状态统计
      const completedCount = records.filter(r => r.status === '完成').length;
      const failedCount = records.filter(r => r.status === '未完成').length;
      const completionRate = totalClimbs > 0
        ? Math.round((completedCount / totalClimbs) * 100)
        : 0;

      // 常去地点统计
      const locationMap = {};
      records.forEach(r => {
        if (r.location) {
          locationMap[r.location] = (locationMap[r.location] || 0) + 1;
        }
      });
      const topLocations = Object.entries(locationMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));

      // 攀岩类型分布
      const typeMap = {};
      records.forEach(r => {
        if (r.climbType) {
          typeMap[r.climbType] = (typeMap[r.climbType] || 0) + 1;
        }
      });
      const typeDistribution = Object.entries(typeMap)
        .map(([name, count]) => ({
          name,
          count,
          percentage: Math.round((count / totalClimbs) * 100)
        }))
        .sort((a, b) => b.count - a.count);

      this.setData({
        loading: false,
        totalClimbs,
        monthClimbs,
        maxGrade,
        completedCount,
        failedCount,
        completionRate,
        topLocations,
        typeDistribution
      });

    } catch (err) {
      console.error('加载统计数据失败：', err);
      this.setData({ loading: false });
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  }
});
