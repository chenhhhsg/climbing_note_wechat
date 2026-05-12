/**
 * 好友记录详情页（只读）
 * 展示好友的攀岩 Session 详情，不能编辑和删除
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

  async loadSession(id) {
    this.setData({ loading: true });

    const res = await db.callCloud('getFriendSessionDetail', { sessionId: id });

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

      wx.setNavigationBarTitle({
        title: (session.friendNickName || '好友') + '的攀岩'
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: res.error || '加载失败', icon: 'none' });
    }
  },

  previewRouteImage(e) {
    const { url, routeIndex } = e.currentTarget.dataset;
    const images = this.data.session.routes[routeIndex].images || [];
    wx.previewImage({ current: url, urls: images });
  }
});
