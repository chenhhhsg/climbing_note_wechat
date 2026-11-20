/**
 * 首页 - 训练入口（开始/继续本场）与最近记录
 *
 * T017：首页的主要操作改为「开始训练」或「继续本场」，进入正式场内记录页
 * （pages/training-session）。入口只读 T016 的本机档案（utils/training-store.js），
 * 与旧云记录列表完全分开：
 * - 本机档案读取是同步的，先于云请求完成，因此旧云请求失败、延迟或迟到返回都
 *   不会遮住训练入口，也不会改动入口上的场次与线路；
 * - 旧云读取用请求序号（token）判别迟到返回：旧请求的回执只丢弃，不覆盖更新的状态；
 * - 旧「添加记录」表单与记录列表入口保持可达，不向旧表单或 climbing_records 双写。
 *
 * T027：首页加上「下次想爬」概况（只读）。清单按岩馆分组，带累计把数与最近一条非空
 * 备注；点开某一条回到它的长期线路详情按原线路 ID 继续记。首页本身不写清单、不建场次。
 *
 * T032：「继续本场」那一行的把数只数**有效把次**（已撤回的那一把不计），与场内、统计、
 * 小结、清单共用档案层的同一份有效集合；首页仍然只读，不参与撤回/恢复本身。
 *
 * T035：「下次想爬」在首页收成一行入口（标题 + 数量），整份按馆分组的清单搬到独立页
 * pages/training-wishlist；首页只算 listWishlist 返回的本档可展示条目数，0 条时入口照常在。
 * 首页不再铺清单条目，也不再把线路 ID 交给别处的点击；打开独立页时带上渲染这一刻的
 * archiveId，供清单页核对归属。首页本身仍只读。
 *
 * T058：旧记录区统一为互斥的 loading / error / ok+空 / ok+有数据 四态；失败只显示
 * 原原因与重试，绝不再落到「还没有旧记录」。首次进入只由 onLoad 发起一次读取（紧随
 * 其后的首次 onShow 不重复请求），之后返回首页或下拉刷新才重新读取；迟到失败与迟到
 * 成功都按请求序号丢弃，不覆盖更新状态。本机训练入口仍只读本机档案，与云请求无关。
 * 应用启动时若已明确云能力不可用（getApp().globalData.cloudReady === false），首次
 * 进入直接给出可重试的不可用状态；重试始终实际发起请求，仍由 utils/db.js 的既有
 * 错误分类区分不可用、拒绝、网络失败等原因。
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const store = require('../../utils/training-store');
const wishlist = require('../../utils/training-wishlist');

const WISHLIST_URL = '/pages/training-wishlist/training-wishlist';

Page({
  data: {
    recentRecords: [],  // 最近的旧云记录
    loading: true,      // 旧云记录加载状态
    isEmpty: false,     // 旧云记录是否为空
    cloudState: 'loading', // loading | ok | error：旧云读取的可判别状态
    cloudError: '',     // 旧云读取失败提示（不影响本机训练入口）
    cloudErrorKind: '', // unavailable | denied | not-found | failed：db 既有分类

    // 本机训练入口：与本机档案一致，不由云请求决定
    trainingReady: false,   // 本机档案可读（首次进入为 true，空档案也算可读）
    archiveError: '',       // 档案损坏/版本不支持/读取失败时的可见报错
    hasActiveSession: false,
    activeSession: null,     // { id, gymName, dateText, label, routeName, attemptCountText }

    // 下次想爬（T035）：单行入口 + 本档可展示条目数，只读；整份清单在独立页
    wishlistCountText: '',
    wishlistItemCount: 0,
    hasWishlist: false,
    wishlistError: ''
  },

  onLoad() {
    // 每次重新进入页面都换新的请求序号：旧请求的回执一律丢弃。
    this._cloudToken = 0;
    // 首次进入由 onLoad 发起读取；紧随其后的第一次 onShow 不再重复请求。
    this._skipFirstShow = true;
    this.refreshTrainingEntry();
    this.refreshWishlist();
    this.loadRecentRecords({ honorCloudState: true });
  },

  // 从别的页面返回或重新显示时刷新；首次 onShow 紧跟在 onLoad 之后，不重复请求。
  onShow() {
    if (this._skipFirstShow) {
      this._skipFirstShow = false;
      return;
    }
    this.refreshTrainingEntry();
    this.refreshWishlist();
    this.loadRecentRecords();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.refreshTrainingEntry();
    this.refreshWishlist();
    this.loadRecentRecords().then(() => {
      if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh();
    });
  },

  /**
   * 读取本机档案，得到「开始训练」或「继续本场」所需的当前场次与线路。
   * 只读：不改写档案，也不因为读失败而隐藏入口（失败时显示可见报错）。
   */
  refreshTrainingEntry() {
    const loaded = store.loadState();
    const archive = loaded.archive;

    if (!loaded.ok) {
      this.setData({
        trainingReady: false,
        archiveError: loaded.error,
        hasActiveSession: false,
        activeSession: null
      });
      return;
    }

    const session = archive.sessions.find(item => item.id === archive.activeSessionId) || null;
    if (!session) {
      this.setData({
        trainingReady: true,
        archiveError: '',
        hasActiveSession: false,
        activeSession: null
      });
      return;
    }

    const route = archive.routes.find(item => item.id === archive.activeRouteId) || null;
    // 只数有效把次：已撤回的那一把不贡献把数（与场内、统计、小结同一口径，T032）。
    const attempts = store.effectiveAttempts(
      (archive.attempts || []).filter(item => item.sessionId === session.id)
    );

    this.setData({
      trainingReady: true,
      archiveError: '',
      hasActiveSession: true,
      activeSession: {
        id: session.id,
        gymName: store.gymName(archive, session.gymId),
        dateText: session.date,
        label: store.sessionLabel(archive, session),
        routeName: route ? route.name : '',
        attemptCountText: attempts.length + ' 把'
      }
    });
  },

  /**
   * 应用启动时登记的云能力状态（T058）：明确为 false 时才作为首次读取的提示，
   * 其余（缺失、true、异常）都交给 utils/db.js 的真实请求结果判别。
   * 重试与返回刷新不读这个提示，避免一次过时的 false 永远挡住恢复。
   */
  readCloudReady() {
    try {
      if (typeof getApp !== 'function') return null;
      const app = getApp();
      if (!app || !app.globalData) return null;
      return typeof app.globalData.cloudReady === 'boolean'
        ? app.globalData.cloudReady
        : null;
    } catch (error) {
      return null;
    }
  },

  /**
   * 失败文案只用 utils/db.js 既有分类（T018）：title 说明原原因，hint 说明本机不受影响。
   * 分类的 hint 常以「旧记录暂不可读；」开头，这里去重后并入一条可见提示。
   */
  cloudErrorText(view) {
    const prefix = '旧记录暂不可读；';
    const hint = view.hint.indexOf(prefix) === 0 ? view.hint.slice(prefix.length) : view.hint;
    return '旧记录暂不可读（' + view.title + '）；' + hint;
  },

  /**
   * 统一的失败落盘：旧记录区进入 error，清空空态标记，本机训练入口不动。
   */
  applyCloudFailure(error) {
    const view = db.describeCloudError(error);
    this.setData({
      recentRecords: [],
      isEmpty: false,
      loading: false,
      cloudState: 'error',
      cloudError: this.cloudErrorText(view),
      cloudErrorKind: view.kind
    });
  },

  /**
   * 加载最近的旧云记录。
   * 用请求序号判别迟到返回：只有最后一次请求的回执才允许落到页面上，
   * 旧请求的失败或迟到成功都不会改动本机训练入口，也不覆盖更新状态。
   *
   * options.honorCloudState 只在首次进入时为 true：应用已明确云不可用时直接给出
   * 可重试的失败，不再发请求；重试与返回刷新始终实际请求，由 db 判别原因。
   */
  loadRecentRecords(options) {
    const opts = options || {};
    this._cloudToken = (this._cloudToken || 0) + 1;
    const token = this._cloudToken;

    if (opts.honorCloudState && this.readCloudReady() === false) {
      this.applyCloudFailure(db.cloudUnavailable('云开发不可用：应用启动时未检测到云能力'));
      return Promise.resolve();
    }

    this.setData({
      loading: true,
      cloudState: 'loading',
      cloudError: '',
      cloudErrorKind: ''
    });

    return db.getRecentRecords(5).then(res => {
      if (token !== this._cloudToken) return;
      const records = (res && Array.isArray(res.data) ? res.data : []).map(record => ({
        ...record,
        // 格式化日期显示
        dateText: dateUtil.getRelativeTime(record.date),
        // 格式化创建时间
        createTimeText: dateUtil.formatDateChinese(record.createTime)
      }));

      this.setData({
        recentRecords: records,
        isEmpty: records.length === 0,
        loading: false,
        cloudState: 'ok',
        cloudError: '',
        cloudErrorKind: ''
      });
    }).catch(err => {
      if (token !== this._cloudToken) return;
      console.error('加载旧记录失败：', err);
      // 旧云不可用（无云环境、无权限或占位环境）只影响旧记录区，训练入口照常可用。
      this.applyCloudFailure(err);
    });
  },

  /**
   * 失败后的重试入口：始终实际发起请求，失败可再次重试；本机训练入口保持可操作。
   */
  retryRecentRecords() {
    return this.loadRecentRecords();
  },

  /**
   * 「下次想爬」的单行入口（T035，只读）：整份按馆分组的清单已搬到独立页
   * pages/training-wishlist，首页只算这一行要显示的数量。
   *
   * 数量就是 listWishlist 返回的**本档可展示条目数**：已归档（岩馆拆线）也照常计入，
   * 属于别的本机档案、或没注明档案 ID 的旧条目本来就不上屏，因此不计入。0 条时入口
   * 照常在（点开是空态）。清单损坏、版本不受支持或档案读不出来时给出可见提示，入口仍
   * 可点——清单页里有失败原因与重试；首页本身不写清单、不重建、不覆盖原数据。
   */
  refreshWishlist() {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({
        wishlistCountText: '',
        wishlistItemCount: 0,
        hasWishlist: false,
        wishlistError: loaded.error
      });
      return;
    }

    const listed = wishlist.listWishlist(loaded.archive);
    if (!listed.ok) {
      this.setData({
        wishlistCountText: '',
        wishlistItemCount: 0,
        hasWishlist: false,
        wishlistError: listed.error
      });
      return;
    }

    const count = listed.items.length;
    this.setData({
      wishlistItemCount: count,
      wishlistCountText: count + ' 条',
      hasWishlist: count > 0,
      wishlistError: ''
    });
  },

  /**
   * 打开独立清单（T035）：把渲染这一行时用的本机档案 ID 一起带过去，清单页据此核对
   * 还是同一份档案（换档之后不拿同名线路顶替）。档案还没落盘时谈不上归属，不带参数。
   * 首页本身不改任何本机数据。
   */
  openWishlist() {
    const loaded = store.loadState();
    const archiveId =
      loaded.ok && loaded.present && loaded.archive && loaded.archive.archiveId
        ? loaded.archive.archiveId
        : '';
    wx.navigateTo({
      url: WISHLIST_URL + (archiveId ? '?archiveId=' + encodeURIComponent(archiveId) : '')
    });
  },

  /**
   * 开始训练：进入场内记录页并直接展开场次表单（同日主动另开也走这里）。
   */
  startTraining() {
    wx.navigateTo({
      url: '/pages/training-session/training-session?start=1'
    });
  },

  /**
   * 继续本场：进入场内记录页，恢复当前场次与原线选择。
   */
  continueTraining() {
    wx.navigateTo({
      url: '/pages/training-session/training-session'
    });
  },

  /**
   * 跳转到添加记录页面（旧表单入口保持可达）
   */
  goToAddRecord() {
    wx.navigateTo({
      url: '/pages/add-record/add-record'
    });
  },

  /**
   * 跳转到记录详情（旧云记录）
   */
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/record-detail/record-detail?id=${id}`
    });
  },

  /**
   * 跳转到记录列表
   */
  goToList() {
    wx.switchTab({
      url: '/pages/record-list/record-list'
    });
  }
});
