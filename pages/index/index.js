/**
 * 首页 - 显示基础统计和最近攀岩场次
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    recentSessions: [],
    loading: true,
    isEmpty: false,

    // 基础统计
    stats: {
      monthSessions: 0,
      monthRoutes: 0,
      maxGrade: '-',
      completionRate: 0
    },
    statsLoading: true
  },

  onLoad() {
    this.loadData();
  },

  onShow() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true, statsLoading: true });

    const [sessionsRes, statsRes] = await Promise.all([
      db.getRecentSessions(3),
      db.getSessionStats()
    ]);

    // 处理攀岩场次
    if (sessionsRes.success) {
      const sessions = sessionsRes.data.map(session => {
        const routes = session.routes || [];
        const completedCount = routes.filter(r =>
          r.status === 'flash' || r.status === 'completed'
        ).length;
        const grades = routes.map(r => r.grade).filter(Boolean);
        const maxGrade = grades.length > 0 ? gradeUtil.getMaxGrade(grades) : '-';
        const completionRate = routes.length > 0
          ? Math.round(completedCount / routes.length * 100)
          : 0;

        return {
          ...session,
          dateText: dateUtil.getRelativeTime(session.date),
          routeCount: routes.length,
          completedCount,
          maxGrade,
          completionRate
        };
      });

      this.setData({
        recentSessions: sessions,
        isEmpty: sessions.length === 0,
        loading: false
      });
    } else {
      this.setData({ loading: false });
    }

    // 处理统计
    if (statsRes.success) {
      this.setData({
        stats: {
          monthSessions: statsRes.data.monthSessions || 0,
          monthRoutes: statsRes.data.monthRoutes || 0,
          maxGrade: statsRes.data.maxGrade || '-',
          completionRate: statsRes.data.completionRate || 0
        },
        statsLoading: false
      });
    } else {
      this.setData({ statsLoading: false });
    }
  },

  goToAddRecord() {
    wx.navigateTo({ url: '/pages/add-record/add-record' });
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/record-detail/record-detail?id=${id}` });
  },

  goToList() {
    wx.switchTab({ url: '/pages/record-list/record-list' });
  },

  goToStats() {
    wx.switchTab({ url: '/pages/stats/stats' });
  }
});
