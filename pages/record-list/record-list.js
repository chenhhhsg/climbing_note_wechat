/**
 * 记录列表页面
 * 显示所有攀岩记录
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');

Page({
  data: {
    records: [],        // 记录列表
    loading: true,      // 加载状态
    isEmpty: false,     // 是否无数据
    page: 1,            // 当前页码
    hasMore: true,      // 是否有更多数据
    pageSize: 20        // 每页数量
  },

  onLoad() {
    this.loadRecords();
  },

  // 每次显示页面时刷新数据
  onShow() {
    this.refreshRecords();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.refreshRecords().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 上拉加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  /**
   * 刷新记录列表
   */
  async refreshRecords() {
    this.setData({
      page: 1,
      records: [],
      hasMore: true
    });
    await this.loadRecords();
  },

  /**
   * 加载记录列表
   */
  async loadRecords() {
    if (this.data.loading) return;

    this.setData({ loading: true });

    try {
      const res = await db.getRecords(this.data.page, this.data.pageSize);
      const newRecords = res.data.map(record => ({
        ...record,
        // 格式化日期显示
        dateText: dateUtil.formatDateChinese(record.date),
        // 格式化创建时间
        createTimeText: dateUtil.getRelativeTime(record.createTime)
      }));

      const allRecords = this.data.page === 1
        ? newRecords
        : [...this.data.records, ...newRecords];

      this.setData({
        records: allRecords,
        isEmpty: allRecords.length === 0,
        hasMore: newRecords.length >= this.data.pageSize,
        loading: false
      });
    } catch (err) {
      console.error('加载记录失败：', err);
      this.setData({ loading: false });
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  /**
   * 加载更多
   */
  async loadMore() {
    this.setData({ page: this.data.page + 1 });
    await this.loadRecords();
  },

  /**
   * 跳转到记录详情
   */
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/record-detail/record-detail?id=${id}`
    });
  },

  /**
   * 跳转到添加记录页面
   */
  goToAddRecord() {
    wx.navigateTo({
      url: '/pages/add-record/add-record'
    });
  }
});
