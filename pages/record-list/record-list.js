/**
 * 记录列表页面
 * 显示所有攀岩记录
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');

Page({
  data: {
    records: [],              // 记录列表
    loading: true,            // 第一页加载中
    isEmpty: false,           // 是否无数据
    loadError: false,         // 首屏加载失败（没有可展示的旧数据）
    refreshError: false,      // 已有数据时刷新第一页失败
    loadMoreError: false,     // 翻页失败
    loadingMore: false,       // 翻页请求进行中
    page: 1,                  // 已成功加载的页码
    hasMore: true,            // 是否有更多数据
    pageSize: 20              // 每页数量
  },

  onLoad() {
    this._generation = 0;
    this._loadingMore = false;
  },

  // 每次显示页面时刷新第一页。首次进入也由这里发起，
  // 配合空的 onLoad 保证 onLoad → onShow 只查询一次。
  onShow() {
    return this.loadFirstPage();
  },

  // 下拉刷新：无论成功或失败都结束下拉动画
  async onPullDownRefresh() {
    try {
      await this.refreshRecords();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  // 上拉加载更多
  onReachBottom() {
    return this.loadMore();
  },

  /**
   * 刷新记录列表：保留当前记录，等新第一页成功后再整体替换
   */
  refreshRecords() {
    return this.loadFirstPage();
  },

  /**
   * 加载第一页
   */
  async loadFirstPage() {
    const generation = this._nextGeneration();

    // 开始新的第一页请求后，尚未返回的翻页请求视为过时，
    // 不再占用翻页状态，也不能再覆盖新结果。
    this._loadingMore = false;
    this.setData({
      loading: true,
      loadError: false,
      refreshError: false,
      loadingMore: false,
      loadMoreError: false
    });

    try {
      const res = await db.getRecords(1, this.data.pageSize);
      if (generation !== this._generation) return;

      const records = this.formatRecords(res && res.data);

      this.setData({
        records,
        page: 1,
        isEmpty: records.length === 0,
        hasMore: records.length >= this.data.pageSize,
        loading: false,
        loadError: false,
        refreshError: false,
        loadMoreError: false
      });
    } catch (err) {
      if (generation !== this._generation) return;

      console.error('加载记录失败：', err);
      const hasRecords = this.data.records.length > 0;

      this.setData({
        loading: false,
        isEmpty: false,
        loadError: !hasRecords,
        refreshError: hasRecords
      });
    }
  },

  /**
   * 加载下一页
   */
  async loadMore() {
    if (this.data.loading || this._loadingMore || !this.data.hasMore ||
        this.data.records.length === 0) {
      return;
    }

    const generation = this._generation;
    const nextPage = this.data.page + 1;

    this._loadingMore = true;
    this.setData({
      loadingMore: true,
      loadMoreError: false
    });

    try {
      const res = await db.getRecords(nextPage, this.data.pageSize);
      if (generation !== this._generation) return;

      const newRecords = this.formatRecords(res && res.data);
      const existingIds = new Set(this.data.records.map(record => record._id));
      const appended = newRecords.filter(record => !existingIds.has(record._id));

      this.setData({
        records: [...this.data.records, ...appended],
        page: nextPage,
        hasMore: newRecords.length >= this.data.pageSize,
        loadingMore: false,
        loadMoreError: false
      });
    } catch (err) {
      if (generation !== this._generation) return;

      console.error('加载更多失败：', err);
      this.setData({
        loadingMore: false,
        loadMoreError: true
      });
    } finally {
      // 只有当前请求才能释放翻页锁，过时请求不能干扰新请求
      if (generation === this._generation) {
        this._loadingMore = false;
      }
    }
  },

  /**
   * 首屏或刷新失败后的重试：重新请求第一页
   */
  retryRefresh() {
    return this.loadFirstPage();
  },

  /**
   * 翻页失败后的重试：继续请求刚才失败的下一页
   */
  retryLoadMore() {
    return this.loadMore();
  },

  /**
   * 格式化记录字段，保留旧记录的全部原始字段
   */
  formatRecords(list) {
    return (list || []).map(record => ({
      ...record,
      // 格式化日期显示
      dateText: dateUtil.formatDateChinese(record.date),
      // 格式化创建时间
      createTimeText: dateUtil.getRelativeTime(record.createTime)
    }));
  },

  /**
   * 每次第一页请求使用新的代号，用于识别过时请求
   */
  _nextGeneration() {
    this._generation = (this._generation || 0) + 1;
    return this._generation;
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
