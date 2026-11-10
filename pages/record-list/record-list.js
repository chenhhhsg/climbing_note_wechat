/**
 * 记录列表页面（Tab）
 *
 * 上半部分是 T018 的本机训练历史：只读 T016 的正式本机档案，按长期线路列出有逐把
 * 记录的线路（最近训练的在前），点一条进 pages/training-route 按本地日期与场次回看。
 * 打开本页只读档案，不建场次、不改写、不把旧云汇总并进本机统计。
 *
 * 下半部分是既有的「旧记录」：仍是原 climbing_records 云列表，保留 T002 的第一页/
 * 翻页/下拉刷新与请求竞争处理，保留本人有权限的访问边界；读取失败按「云环境不可用 /
 * 没有权限 / 读取失败」显示有区别的状态，且不触发任何回写、清空或覆盖本机档案。
 * 两条入口的 ID 不混用：本机线路走 routeId（training-route），旧记录走原 _id
 * （record-detail），即使字符串相同也各自进入自己的详情。
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const store = require('../../utils/training-store');
const { climbTypeOf } = require('../../utils/training-rules');

Page({
  data: {
    // 本机训练历史（T018）
    localRoutes: [],          // 有逐把记录的长期线路
    hasLocalHistory: false,
    archiveError: '',         // 本机档案损坏/版本不支持/读取失败

    // 旧记录（云汇总，只读回看）
    records: [],              // 记录列表
    loading: true,            // 第一页加载中
    isEmpty: false,           // 是否无数据
    loadError: false,         // 首屏加载失败（没有可展示的旧数据）
    refreshError: false,      // 已有数据时刷新第一页失败
    loadMoreError: false,     // 翻页失败
    loadingMore: false,       // 翻页请求进行中
    cloudKind: 'idle',        // idle | ok | empty | unavailable | denied | failed
    cloudErrorTitle: '',      // 旧记录读取失败的种类标题
    cloudErrorHint: '',       // 失败说明（含「本机训练不受影响」）
    page: 1,                  // 已成功加载的页码
    hasMore: true,            // 是否有更多数据
    pageSize: 20              // 每页数量
  },

  onLoad() {
    this._generation = 0;
    this._loadingMore = false;
    this._pullDownSequence = 0;
  },

  // 每次显示页面时刷新本机历史与旧记录第一页。首次进入也由这里发起，
  // 配合空的 onLoad 保证 onLoad → onShow 只查询一次旧记录。
  onShow() {
    this.refreshLocalHistory();
    return this.loadFirstPage();
  },

  // 下拉刷新：本机历史与旧记录一起刷新；只有最新一次下拉负责结束动画，
  // 过时的下拉回调不能提前停止当前下拉动画
  async onPullDownRefresh() {
    const sequence = (this._pullDownSequence || 0) + 1;
    this._pullDownSequence = sequence;

    try {
      this.refreshLocalHistory();
      await this.refreshRecords();
    } finally {
      if (sequence === this._pullDownSequence) {
        wx.stopPullDownRefresh();
      }
    }
  },

  // 上拉加载更多
  onReachBottom() {
    return this.loadMore();
  },

  /**
   * 刷新本机训练历史：只读档案，损坏时显示可见错误但不动旧记录区。
   */
  refreshLocalHistory() {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({ archiveError: loaded.error, localRoutes: [], hasLocalHistory: false });
      return;
    }

    const localRoutes = store.routesWithHistory(loaded.archive).map(route => ({
      id: route.id,
      name: route.name,
      // 旧 V 级线路没有 climbType，按抱石只读展示，不回写档案。
      climbType: climbTypeOf(route),
      grade: route.grade,
      colorName: route.colorName,
      colorHex: route.colorHex || '#dee2e6',
      gymName: route.gymName,
      lastDateText: route.lastDate + ' ' + route.lastSessionLabel,
      countText:
        route.dayCount + ' 天 · ' + route.sessionCount + ' 场 · ' + route.attemptCount + ' 把',
      sendText: route.sendCount > 0 ? route.sendCount + ' 次完攀' : '还没有完攀'
    }));

    this.setData({
      archiveError: '',
      localRoutes,
      hasLocalHistory: localRoutes.length > 0
    });
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
        loadMoreError: false,
        cloudKind: records.length === 0 ? 'empty' : 'ok',
        cloudErrorTitle: '',
        cloudErrorHint: ''
      });
    } catch (err) {
      if (generation !== this._generation) return;

      console.error('加载旧记录失败：', err);
      const hasRecords = this.data.records.length > 0;
      // 旧云不可用、没有权限与一般读取失败分开显示；都不影响本机训练历史。
      const described = db.describeCloudError(err);

      this.setData({
        loading: false,
        isEmpty: false,
        loadError: !hasRecords,
        refreshError: hasRecords,
        cloudKind: described.kind,
        cloudErrorTitle: described.title,
        cloudErrorHint: described.hint + '（本机训练历史照常可用）'
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

      console.error('加载旧记录下一页失败：', err);
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
    this.refreshLocalHistory();
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
   * 打开本机长期线路历史（按长期线路 ID 路由，与旧记录 ID 分开）
   */
  goToRouteDetail(e) {
    const routeId = e.currentTarget.dataset.routeId;
    if (!routeId) return;
    wx.navigateTo({
      url: `/pages/training-route/training-route?routeId=${routeId}`
    });
  },

  /**
   * 跳转到旧记录详情（按原 _id 读取原字段与图片，只读回看）
   */
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/record-detail/record-detail?id=${id}`
    });
  },

  /**
   * 跳转到添加记录页面（旧表单入口保持可达）
   */
  goToAddRecord() {
    wx.navigateTo({
      url: '/pages/add-record/add-record'
    });
  }
});
