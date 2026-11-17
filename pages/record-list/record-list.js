/**
 * 记录列表页面（Tab）
 *
 * 上半部分是本机训练历史（T018 起点，T043 改为原场次列表）：只读 T016 的正式本机
 * 档案，按训练场次的原本地日期倒序、同日按原岩馆 ID 分组列出每一场（一个原场次 ID
 * 一行），行里是现有场次标识与小结的线路数 / 有效把数；点一行用原档案 ID 与原场次
 * ID 打开现有小结页（pages/training-summary），从小结继续回看原线路与跨日历史。
 * 打开本页只读档案，不建场次、不改写、不选当前场次或线路，也不把旧云汇总并进本机统计。
 *
 * 下半部分是既有的「旧记录」：仍是原 climbing_records 云列表，保留 T002 的第一页/
 * 翻页/下拉刷新与请求竞争处理，保留本人有权限的访问边界；读取失败按「云环境不可用 /
 * 没有权限 / 读取失败」显示有区别的状态，且不触发任何回写、清空或覆盖本机档案。
 * 两条入口的 ID 不混用：本机场次走 sessionId（training-summary），旧记录走原 _id
 * （record-detail），即使字符串相同也各自进入自己的详情。
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const store = require('../../utils/training-store');
const { buildSessionList } = require('../../utils/training-session-summary');

Page({
  data: {
    // 本机训练历史（T043）：日期倒序 → 同日原岩馆 ID 分组 → 组内原场次倒序
    sessionDays: [],
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
   * 刷新本机训练历史（T043）：只读档案，按原日期与原岩馆 ID 列出原场次。
   * 每行的线路数与有效把数直接取现有小结的同一份只读计数；损坏时显示可见错误
   * 但不动旧记录区，也不覆盖原档案。
   */
  refreshLocalHistory() {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this._archiveId = '';
      this.setData({ archiveError: loaded.error, sessionDays: [], hasLocalHistory: false });
      return;
    }

    const listed = buildSessionList(loaded.archive);
    // 点行时按渲染这一份档案的原档案 ID 进小结；之后换档由小结页按既有错误路径处理。
    this._archiveId = (loaded.archive && loaded.archive.archiveId) || '';
    this.setData({
      archiveError: '',
      sessionDays: listed.days,
      hasLocalHistory: listed.sessionCount > 0
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
   * 打开这一行的原场小结（T043）：只用渲染这一行时写下的原档案 ID 与原场次 ID，
   * 经现有小结页读取；同字 ID 的旧记录仍走 goToDetail 的原 _id 路由，两边不混用。
   * 换档或场次不存在时由小结页按既有错误路径显示可见状态，本页不猜、不补场次。
   */
  goToSessionSummary(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const sessionId = dataset.sessionId;
    if (!sessionId) return;
    const archiveId = dataset.archiveId || this._archiveId || '';
    if (!archiveId) return;
    const params = [
      'sessionId=' + encodeURIComponent(sessionId),
      'archiveId=' + encodeURIComponent(archiveId)
    ];
    wx.navigateTo({
      url: '/pages/training-summary/training-summary?' + params.join('&')
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
