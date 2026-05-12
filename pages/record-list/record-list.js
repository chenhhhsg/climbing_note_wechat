/**
 * 记录列表页面 - 攀岩场次列表
 * 支持搜索、筛选、分页加载
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    sessions: [],
    loading: false,
    isEmpty: false,
    page: 1,
    hasMore: true,
    pageSize: 20,

    // 搜索和筛选
    keyword: '',
    filters: {
      climbType: '',
      status: '',
      grade: '',
      location: ''
    },

    // 筛选选项
    climbTypes: [],
    climbTypeLabels: {},
    statusOptions: [],
    statusLabels: {},

    // 难度筛选选项（根据攀岩类型动态变化）
    filterGradeOptions: [],

    // 筛选面板
    showFilter: false,
    tempFilters: {}
  },

  onLoad() {
    const { climbTypes, climbTypeLabels, statusOptions, statusLabels } = app.globalData;
    this.setData({
      climbTypes,
      climbTypeLabels,
      statusOptions,
      statusLabels
    });
    this.loadSessions();
  },

  onShow() {
    this.refreshSessions();
  },

  onPullDownRefresh() {
    this.refreshSessions().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  async refreshSessions() {
    this.setData({ page: 1, sessions: [], hasMore: true });
    await this.loadSessions();
  },

  async loadSessions() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const { page, pageSize, keyword, filters } = this.data;

    const res = await db.getSessions({
      page,
      pageSize,
      filters,
      keyword
    });

    if (res.success) {
      const newSessions = res.data.list.map(session => {
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

        return {
          ...session,
          dateText: dateUtil.formatDateChinese(session.date),
          routeCount: routes.length,
          completedCount,
          projectCount,
          maxGrade,
          completionRate
        };
      });

      const allSessions = page === 1
        ? newSessions
        : [...this.data.sessions, ...newSessions];

      this.setData({
        sessions: allSessions,
        isEmpty: allSessions.length === 0,
        hasMore: allSessions.length < res.data.total,
        loading: false
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  async loadMore() {
    this.setData({ page: this.data.page + 1 });
    await this.loadSessions();
  },

  // 搜索相关
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.refreshSessions();
  },

  onClearSearch() {
    this.setData({ keyword: '' });
    this.refreshSessions();
  },

  // 筛选相关
  onToggleFilter() {
    this.setData({
      showFilter: !this.data.showFilter,
      tempFilters: { ...this.data.filters }
    });
    if (this.data.showFilter && this.data.tempFilters.climbType) {
      this.updateFilterGradeOptions(this.data.tempFilters.climbType);
    }
  },

  onFilterTypeChange(e) {
    const climbType = this.data.climbTypes[e.detail.value];
    this.setData({
      'tempFilters.climbType': climbType,
      'tempFilters.grade': ''
    });
    this.updateFilterGradeOptions(climbType);
  },

  updateFilterGradeOptions(climbType) {
    if (!climbType) {
      this.setData({ filterGradeOptions: [] });
      return;
    }
    const grades = gradeUtil.getGradeOptions(climbType);
    this.setData({
      filterGradeOptions: grades.map(g => g.value)
    });
  },

  onFilterGradeChange(e) {
    this.setData({ 'tempFilters.grade': this.data.filterGradeOptions[e.detail.value] });
  },

  onFilterStatusChange(e) {
    this.setData({ 'tempFilters.status': this.data.statusOptions[e.detail.value] });
  },

  onFilterLocationInput(e) {
    this.setData({ 'tempFilters.location': e.detail.value });
  },

  onApplyFilter() {
    this.setData({
      filters: { ...this.data.tempFilters },
      showFilter: false
    });
    this.refreshSessions();
  },

  onResetFilter() {
    const resetFilters = { climbType: '', status: '', grade: '', location: '' };
    this.setData({
      filters: resetFilters,
      tempFilters: resetFilters,
      showFilter: false,
      filterGradeOptions: []
    });
    this.refreshSessions();
  },

  onFilterMaskTap() {
    this.setData({ showFilter: false });
  },

  // 跳转
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/record-detail/record-detail?id=${id}` });
  },

  goToAddRecord() {
    wx.navigateTo({ url: '/pages/add-record/add-record' });
  }
});
