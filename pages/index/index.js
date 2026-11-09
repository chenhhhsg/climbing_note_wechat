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
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const store = require('../../utils/training-store');
const wishlist = require('../../utils/training-wishlist');

const ROUTE_URL = '/pages/training-route/training-route';

Page({
  data: {
    recentRecords: [],  // 最近的旧云记录
    loading: true,      // 旧云记录加载状态
    isEmpty: false,     // 旧云记录是否为空
    cloudState: 'loading', // loading | ok | error：旧云读取的可判别状态
    cloudError: '',     // 旧云读取失败提示（不影响本机训练入口）

    // 本机训练入口：与本机档案一致，不由云请求决定
    trainingReady: false,   // 本机档案可读（首次进入为 true，空档案也算可读）
    archiveError: '',       // 档案损坏/版本不支持/读取失败时的可见报错
    hasActiveSession: false,
    activeSession: null,     // { id, gymName, dateText, label, routeName, attemptCountText }

    // 下次想爬（T027）：按岩馆分组的清单概况，只读；点开回原线详情续记
    wishlistGroups: [],
    wishlistCountText: '',
    hasWishlist: false,
    wishlistError: ''
  },

  onLoad() {
    // 每次重新进入页面都换新的请求序号：旧请求的回执一律丢弃。
    this._cloudToken = 0;
    this.refreshTrainingEntry();
    this.refreshWishlist();
    this.loadRecentRecords();
  },

  // 每次显示页面时刷新本机入口、想爬清单与旧云记录
  onShow() {
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
    const attempts = (archive.attempts || []).filter(item => item.sessionId === session.id);

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
   * 加载最近的旧云记录。
   * 用请求序号判别迟到返回：只有最后一次请求的回执才允许落到页面上，
   * 旧请求的失败或迟到成功都不会改动本机训练入口。
   */
  loadRecentRecords() {
    this._cloudToken += 1;
    const token = this._cloudToken;
    this.setData({ loading: true, cloudState: 'loading' });

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
        cloudError: ''
      });
    }).catch(err => {
      if (token !== this._cloudToken) return;
      console.error('加载旧记录失败：', err);
      // 旧云不可用（无云环境、无权限或占位环境）只影响旧记录区，训练入口照常可用。
      const code = err && err.code === db.CLOUD_UNAVAILABLE ? '云环境不可用' : '读取失败';
      this.setData({
        recentRecords: [],
        isEmpty: true,
        loading: false,
        cloudState: 'error',
        cloudError: '旧记录暂不可读（' + code + '）；本机训练不受影响。'
      });
    });
  },

  /**
   * 本机「下次想爬」清单概况（只读）：按岩馆分组，带累计把数与最近一条非空备注。
   *
   * 只读清单与本机档案，不写盘、不建场次；清单损坏、版本不支持或档案读取失败时
   * 显示可见错误、不显示条目，原清单保持原样（清缓存也不会动它）。
   */
  refreshWishlist() {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({
        wishlistGroups: [],
        wishlistCountText: '',
        hasWishlist: false,
        wishlistError: loaded.error
      });
      return;
    }

    const listed = wishlist.listWishlist(loaded.archive);
    if (!listed.ok) {
      this.setData({
        wishlistGroups: [],
        wishlistCountText: '',
        hasWishlist: false,
        wishlistError: listed.error
      });
      return;
    }

    const groups = listed.groups.map(group => ({
      gymId: group.gymId,
      gymName: group.gymName,
      countText: group.countText,
      items: group.items.map(entry => ({
        routeId: entry.routeId,
        name: entry.name,
        climbType: entry.climbType,
        grade: entry.grade,
        colorName: entry.colorName,
        colorHex: entry.colorHex,
        status: entry.status,
        statusText: entry.statusText,
        attemptCountText: entry.attemptCountText,
        latestNote: entry.latestNote,
        hasNote: entry.hasNote
      }))
    }));

    this.setData({
      wishlistGroups: groups,
      hasWishlist: listed.items.length > 0,
      wishlistCountText: listed.items.length
        ? listed.items.length + ' 条 · ' + groups.length + ' 家岩馆'
        : '',
      wishlistError: ''
    });
  },

  /**
   * 点开清单里的一条线：回到它的长期线路详情（同一个原线路 ID）。
   * 那里可以看照片、把次与历史，并用「当天再记」回到原线续记；
   * 加入、撤下与拆线归档也在详情页里。首页本身不改任何本机数据。
   */
  openWishlistRoute(e) {
    const routeId = e && e.currentTarget && e.currentTarget.dataset.routeId;
    if (!routeId) return;
    wx.navigateTo({
      url: ROUTE_URL + '?routeId=' + routeId
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
