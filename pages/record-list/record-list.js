/**
 * 记录列表页面
 * 支持搜索、筛选、分页加载
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    records: [],
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
    tempFilters: {},

    // 用于获取去重后的地点列表
    allLocations: []
  },

  onLoad() {
    const { climbTypes, climbTypeLabels, statusOptions, statusLabels } = app.globalData;
    this.setData({
      climbTypes,
      climbTypeLabels,
      statusOptions,
      statusLabels
    });
    this.loadRecords();
  },

  onShow() {
    this.refreshRecords();
  },

  onPullDownRefresh() {
    this.refreshRecords().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  async refreshRecords() {
    this.setData({ page: 1, records: [], hasMore: true });
    await this.loadRecords();
  },

  async loadRecords() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const { page, pageSize, keyword, filters } = this.data;

    const res = await db.getRecords({
      page,
      pageSize,
      filters,
      keyword
    });

    if (res.success) {
      const { climbTypeLabels, statusLabels } = app.globalData;

      const newRecords = res.data.list.map(record => ({
        ...record,
        dateText: dateUtil.formatDateChinese(record.date),
        climbTypeLabel: climbTypeLabels[record.climbType] || record.climbType,
        statusLabel: statusLabels[record.status] || record.status,
        isCompleted: record.status === 'flash' || record.status === 'completed'
      }));

      const allRecords = page === 1
        ? newRecords
        : [...this.data.records, ...newRecords];

      this.setData({
        records: allRecords,
        isEmpty: allRecords.length === 0,
        hasMore: allRecords.length < res.data.total,
        loading: false
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  async loadMore() {
    this.setData({ page: this.data.page + 1 });
    await this.loadRecords();
  },

  // 搜索相关
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.refreshRecords();
  },

  onClearSearch() {
    this.setData({ keyword: '' });
    this.refreshRecords();
  },

  // 筛选相关
  onToggleFilter() {
    this.setData({
      showFilter: !this.data.showFilter,
      tempFilters: { ...this.data.filters }
    });
    // 打开面板时更新难度选项
    if (this.data.showFilter && this.data.tempFilters.climbType) {
      this.updateFilterGradeOptions(this.data.tempFilters.climbType);
    }
  },

  onFilterTypeChange(e) {
    const climbType = this.data.climbTypes[e.detail.value];
    this.setData({
      'tempFilters.climbType': climbType,
      'tempFilters.grade': '' // 切换类型时清空难度选择
    });
    this.updateFilterGradeOptions(climbType);
  },

  /**
   * 更新筛选面板的难度选项
   */
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
    this.refreshRecords();
  },

  onResetFilter() {
    const resetFilters = { climbType: '', status: '', grade: '', location: '' };
    this.setData({
      filters: resetFilters,
      tempFilters: resetFilters,
      showFilter: false,
      filterGradeOptions: []
    });
    this.refreshRecords();
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
