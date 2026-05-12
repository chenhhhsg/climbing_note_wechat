/**
 * 记录详情页面 - 攀岩 Session 详情
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    session: null,
    loading: true,
    sessionId: ''
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ sessionId: options.id });
      this.loadSession(options.id);
    }
  },

  onShow() {
    if (this.data.sessionId) {
      this.loadSession(this.data.sessionId);
    }
  },

  async loadSession(id) {
    this.setData({ loading: true });

    const res = await db.getSessionById(id);

    if (res.success) {
      const { climbTypeLabels, statusLabels } = app.globalData;
      const session = res.data;
      const routes = session.routes || [];

      const completedCount = routes.filter(r =>
        r.status === 'flash' || r.status === 'completed'
      ).length;
      const projectCount = routes.filter(r => r.status === 'project').length;
      const grades = routes.map(r => r.grade).filter(Boolean);
      const maxGrade = grades.length > 0 ? gradeUtil.getMaxGrade(grades) : '-';
      const completionRate = routes.length > 0
        ? Math.round(completedCount / routes.length * 100)
        : 0;

      const enrichedRoutes = routes.map(route => ({
        ...route,
        climbTypeLabel: climbTypeLabels[route.climbType] || route.climbType,
        statusLabel: statusLabels[route.status] || route.status,
        isCompleted: route.status === 'flash' || route.status === 'completed'
      }));

      this.setData({
        session: {
          ...session,
          dateText: dateUtil.formatDateChinese(session.date),
          routeCount: routes.length,
          completedCount,
          projectCount,
          maxGrade,
          completionRate,
          routes: enrichedRoutes
        },
        loading: false
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  previewRouteImage(e) {
    const { url, routeIndex } = e.currentTarget.dataset;
    const images = this.data.session.routes[routeIndex].images || [];
    wx.previewImage({ current: url, urls: images });
  },

  editSession() {
    wx.navigateTo({
      url: `/pages/add-record/add-record?id=${this.data.sessionId}`
    });
  },

  deleteSession() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除本次攀岩记录吗？所有线路和图片将一并删除，且无法恢复。',
      confirmText: '删除',
      confirmColor: '#f44336',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...' });

        const delRes = await db.deleteSession(this.data.sessionId);

        wx.hideLoading();

        if (delRes.success) {
          wx.showToast({ title: '删除成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1500);
        } else {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  }
});
