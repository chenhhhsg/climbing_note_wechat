/**
 * 好友动态页
 * 展示好友设置为 friends 可见的攀岩 Session
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');

Page({
  data: {
    sessions: [],
    loading: true,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    friendOpenid: '',
    friendName: ''
  },

  onLoad(options) {
    if (options.friendOpenid) {
      this.setData({ friendOpenid: options.friendOpenid });
      if (options.friendName) {
        this.setData({ friendName: decodeURIComponent(options.friendName) });
        wx.setNavigationBarTitle({ title: options.friendName + '的动态' });
      }
    }
    this.loadSessions(true);
  },

  async loadSessions(refresh = false) {
    if (refresh) {
      this.setData({ page: 1, sessions: [], hasMore: true });
    }

    if (!this.data.hasMore && !refresh) return;

    this.setData({ loading: true });

    const params = {
      page: this.data.page,
      pageSize: this.data.pageSize
    };
    if (this.data.friendOpenid) {
      params.friendOpenid = this.data.friendOpenid;
    }

    const res = await db.callCloud('getFriendSessions', params);

    if (res.success) {
      const { list, total } = res.data;
      const enriched = list.map(session => this.enrichSession(session));
      const sessions = refresh ? enriched : [...this.data.sessions, ...enriched];

      this.setData({
        sessions,
        total,
        hasMore: sessions.length < total,
        page: this.data.page + 1,
        loading: false
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: res.error || '加载失败', icon: 'none' });
    }
  },

  enrichSession(session) {
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
      completionRate,
      friendNickName: session.friendNickName || '未设置昵称',
      friendAvatarUrl: session.friendAvatarUrl || ''
    };
  },

  viewDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/friend-detail/friend-detail?id=${id}`
    });
  },

  onReachBottom() {
    if (this.data.hasMore) {
      this.loadSessions();
    }
  },

  onPullDownRefresh() {
    this.loadSessions(true);
    wx.stopPullDownRefresh();
  }
});
