/**
 * 正式长期线路详情页（T018 回看 / T019 主照片）
 *
 * 从正式记录 tab 的「本机训练历史」按长期线路 ID 进入，回看这条线跨日、跨场次的
 * 逐把结果与备注：按本地日期和场次分组，场次新的在前，同一天多场各自保留原归属。
 *
 * T019 在本页加上线路主照片：展示、预览确认、更换与移除都由 utils/training-photo-
 * controller.js 驱动，照片文件落在本机档案目录、索引落在正式照片索引键；照片操作
 * 不写旧云记录，也不改场次、把次与备注。
 *
 * T027 在本页加上「下次想爬」：加入、撤下与拆线归档都只改清单这一份独立记录
 * （utils/training-wishlist.js），不动线路、照片、把次与备注；清单状态由档案推导，
 * 关注的抱石完攀后显示已完成，把那一把改为未完成后自动回到想爬。
 *
 * 本页只读本机档案（utils/training-store.js），与旧云记录完全分开：
 * - 打开历史本身不建场次、不改当前选择、不写任何数据；损坏或版本不支持时可见报错
 *   并保留原数据；
 * - 「当天再记」是唯一的档案写入口，且必须由用户明确点按：当日该岩馆恰好一场就直接
 *   复用，还没有场次才新建一场，同日多场先让用户显式选一场（原归属不动）；抱石已
 *   完攀时不新增把次，只提示按把更正；
 * - 「改为未完成」按渲染那一行带下来的原把次 ID 与归属逐个更正：只翻那一把的
 *   result，把数、ID、序号、场次、时间与备注都不变；改好的那一把留在原位置变成
 *   只读回读，同一坐标不会自动接上另一把。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const SESSION_URL = '/pages/training-session/training-session';
const PROFILE_URL = '/pages/profile/profile';

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * 完攀状态文案：与首页、场内页共用档案层 routeCompletion 的同一份判定。
 */
function completionText(completion) {
  if (!completion || !completion.known) return '';
  if (completion.completed) return '已完攀';
  if (completion.closed) return '完攀待确认';
  return '';
}

Page({
  data: {
    ready: false,
    loadError: '',      // 档案损坏 / 版本不支持 / 读取失败
    storageError: '',   // 本次操作未落盘（不报已成功）
    notice: '',         // 说明性提示，不改数据

    route: null,
    notFound: false,

    // 线路主照片（T019）：展示状态由控制器推导，页面只渲染
    routePhoto: null,
    photoNotice: '',

    // 下次想爬（T027）：加入/撤下/拆线归档都只改清单，状态由档案推导
    wishlistState: null,

    groups: [],
    hasAttempts: false,
    attemptCount: 0,
    attemptCountText: '0 把',
    sendCount: 0,
    summaryText: '0 天 · 0 场 · 0 把',

    // 完攀状态：抱石已完攀时不显示「当天再记」，改为按把更正
    routeCompleted: false,
    routeClosed: false,
    canRecordAgain: false,
    routeStateText: '',

    // 按把「改为未完成」：每一把各占一行、各带自己的控件
    correctionRows: [],
    correctionStatusText: '',
    routeCorrectable: false,

    // 同日多场：先让用户明确选一场
    sessionPicker: null
  },

  onLoad(query) {
    this._routeId = (query && (query.routeId || query.routeid)) || '';
    // 本实例临时状态，不落盘：
    // _correctedRows 刚改好的那一把（原位只读回读）；_correctionFailures 失败可重试标记。
    this._correctedRows = {};
    this._correctionFailures = {};
    this._photoUi = null;
    this.loadPage();
    this.loadRoutePhoto();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从场内页返回或另一页面实例刚改了同一档案时重新读取，保持回看与本机一致。
    // 打开历史只读，不写盘、不建场次。
    this.loadPage({ keepPicker: true });
    this.loadRoutePhoto();
  },

  /**
   * 照片控制器只在本页创建一次；档案 ID 由控制器从本机档案读取。
   * 打开详情本身不写照片，只有用户点按拍照/相册/确认/移除才动文件与索引。
   * 这里只做初始化，不读取照片，避免和 loadRoutePhoto 相互递归。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createTrainingPhotoController(this, {
        onChange: () => this.applyPhotoView(),
        onNotice: text => this.setData({ photoNotice: text })
      });
    }
    return Promise.resolve(this._photoUi.init());
  },

  loadRoutePhoto() {
    if (!this._routeId) {
      this.setData({ routePhoto: null });
      return Promise.resolve();
    }
    // 先过一遍 initPhotoUi：档案 ID 变化（重置本机档案）后照片服务要跟上。
    return Promise.resolve(this.initPhotoUi()).then(() => {
      if (!this._photoUi) return;
      return this._photoUi
        .load([this._routeId])
        .then(() => this.applyPhotoView());
    });
  },

  /**
   * 只更新当前线路的照片展示；线路或档案变化时按最新档案重算。
   */
  applyPhotoView() {
    if (!this._photoUi || !this.data.route) return;
    this.setData({ routePhoto: this._photoUi.view(this.data.route.id) });
  },

  photoRouteId(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    return dataset.routeId || this._routeId || '';
  },

  dismissPhotoNotice() {
    this.setData({ photoNotice: '' });
  },

  chooseRoutePhoto(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = dataset.source;
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    return this._photoUi.choose(routeId, source);
  },

  confirmRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.confirm(routeId);
  },

  cancelRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.cancelPreview(routeId);
    // 取消预览后留下的只是临时路径，不进入索引；旧照片（若有）继续显示。
    this.applyPhotoView();
  },

  retryRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.retry(routeId);
  },

  dismissRoutePhotoFailure(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.dismiss(routeId);
    this.applyPhotoView();
  },

  removeRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.remove(routeId);
  },

  previewRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.preview(routeId);
  },

  reloadRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.load([routeId]);
  },

  /**
   * 缩略图是可重建缓存：清缓存或被系统清理后，用持久主图重建一次。
   * 只补缓存，主图、关联与档案数据都不变。
   */
  rebuildRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve(null);
    return this._photoUi.rebuildThumbs();
  },

  /**
   * 空间不足时页面上给出的出口：可重建缓存的清理入口在「我的」。
   */
  goToClearCache() {
    wx.switchTab({ url: PROFILE_URL });
  },

  /**
   * 读取本机档案并按最新数据重算展示；只读，不写盘。
   */
  loadPage(options) {
    const keepPicker = Boolean(options && options.keepPicker);
    const loaded = store.loadState();
    this.archive = loaded.archive;

    this.setData({
      ready: true,
      loadError: loaded.error || '',
      storageError: '',
      notice: '',
      route: null,
      notFound: false,
      routePhoto: null,
      photoNotice: '',
      wishlistState: null,
      groups: [],
      hasAttempts: false,
      attemptCount: 0,
      attemptCountText: '0 把',
      sendCount: 0,
      summaryText: '0 天 · 0 场 · 0 把',
      routeCompleted: false,
      routeClosed: false,
      canRecordAgain: false,
      routeStateText: '',
      correctionRows: [],
      correctionStatusText: '',
      routeCorrectable: false,
      sessionPicker: keepPicker ? this.data.sessionPicker : null
    });

    this.refreshView();
  },

  retryLoad() {
    this.loadPage({ keepPicker: true });
  },

  /**
   * 由当前档案重新推导展示内容；不改动任何已保存数据。
   */
  refreshView() {
    if (this.data.loadError) return;

    if (!this._routeId) {
      this.setData({ notFound: true, route: null, canRecordAgain: false, routePhoto: null, wishlistState: null });
      return;
    }

    const history = store.routeHistory(this.archive, this._routeId);
    if (!history.known) {
      this.setData({
        notFound: true,
        route: null,
        routePhoto: null,
        wishlistState: null,
        groups: [],
        hasAttempts: false,
        attemptCount: 0,
        attemptCountText: '0 把',
        sendCount: 0,
        summaryText: '0 天 · 0 场 · 0 把',
        routeCompleted: false,
        routeClosed: false,
        canRecordAgain: false,
        routeStateText: '',
        correctionRows: [],
        correctionStatusText: '',
        routeCorrectable: false
      });
      return;
    }

    const route = history.route;
    const completion = history.completion;

    // 逐把更正行：这条抱石线的每一把仍可更正的完攀各占一行；本实例刚改好的那一把
    // 留在原位置变成只读回读行，行与行之间不塌陷，同一坐标不会被另一把接手。
    const correctionRows = store
      .routeCorrectionRows(this.archive, route.id, Object.keys(this._correctedRows))
      .map(row => {
        if (row.state === 'corrected') {
          const readback = this._correctedRows[row.attemptId];
          return {
            attemptId: row.attemptId,
            routeId: row.routeId,
            sessionId: row.sessionId,
            label: row.label,
            contextText: row.contextText,
            state: 'corrected',
            buttonText: '',
            statusText: (readback && readback.statusText) || '已改为未完成 · 本把次保留原时间、场次与备注'
          };
        }
        const needsRetry = Boolean(
          this._correctionFailures[row.attemptId] ||
            (this.archive.pendingCorrections || []).some(item => item.attemptId === row.attemptId)
        );
        return {
          attemptId: row.attemptId,
          routeId: row.routeId,
          sessionId: row.sessionId,
          label: row.label,
          contextText: row.contextText,
          state: needsRetry ? 'retry' : 'ready',
          buttonText: needsRetry ? '重试改为未完成' : '改为未完成',
          statusText: ''
        };
      });

    this.setData({
      route: {
        id: route.id,
        gymId: route.gymId,
        name: route.name,
        // 旧 V 级线路没有 climbType，按抱石只读展示，不回写档案。
        climbType: climbTypeOf(route),
        colorName: route.colorName || '',
        colorHex: route.colorHex || '#dee2e6',
        grade: route.grade,
        gymName: store.gymName(this.archive, route.gymId)
      },
      notFound: false,
      // 照片展示与逐把回看各自独立：照片由控制器按 routeId 推导，不改逐把数据。
      routePhoto: this._photoUi
        ? this._photoUi.view(route.id)
        : this.data.routePhoto,
      wishlistState: this.wishlistView(route.id),
      groups: history.groups.map(group => ({
        sessionId: group.sessionId,
        dateText: group.date,
        sessionLabel: group.sessionLabel,
        gymName: group.gymName,
        countText: group.countText,
        attempts: group.attempts.map(attempt => ({
          id: attempt.id,
          label: attempt.label,
          resultText: attempt.resultText,
          isSend: attempt.result === 'send',
          timeText: timeText(attempt.createdAt),
          note: attempt.note,
          hasNote: Boolean(attempt.note)
        }))
      })),
      hasAttempts: history.attemptCount > 0,
      attemptCount: history.attemptCount,
      attemptCountText: history.attemptCount + ' 把',
      sendCount: history.sendCount,
      summaryText:
        history.dayCount + ' 天 · ' + history.sessionCount + ' 场 · ' + history.attemptCount + ' 把',
      routeCompleted: Boolean(completion && completion.completed),
      routeClosed: Boolean(completion && completion.closed),
      canRecordAgain: Boolean(completion && completion.canRecord),
      routeStateText: completionText(completion),
      correctionRows,
      correctionStatusText: correctionRows.some(row => row.state === 'retry')
        ? '更正未保存 · 点「重试改为未完成」按同一把重试'
        : '',
      routeCorrectable: correctionRows.some(row => row.state !== 'corrected')
    });
  },

  // ---------------------------------------------------------------- 下次想爬

  /**
   * 这条线在「下次想爬」清单里的状态（只读，不写盘）。
   *
   * 状态由档案推导：清单里的活跃条目是「想爬」，关注的抱石出现完攀后变「已完成」，
   * 把那一把改为未完成后又会回到「想爬」，都不需要另存一份状态。
   * 清单损坏、版本不支持或读取失败时只显示可见错误并收回写入口，保留原清单。
   */
  wishlistView(routeId) {
    const listed = wishlist.wishlistEntry(this.archive, routeId);
    if (!listed.ok) {
      return Object.assign(wishlist.wishlistActionView(null), {
        error: listed.error,
        canAdd: false,
        stateText: ''
      });
    }
    return Object.assign({ error: '' }, wishlist.wishlistActionView(listed.entry));
  },

  /**
   * 加入下次想爬。只写清单这一份独立记录：线路、照片、把次与备注都不动。
   * 重复点击幂等（已在清单里不写盘）；落盘失败不报已保存，可再点一次重试。
   */
  addToWishlist() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.addWishlist(routeId);
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '收藏未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.code === 'duplicate'
        ? '这条线路已经在下次想爬清单里。'
        : outcome.code === 'reactivated'
          ? '已重新加入下次想爬。'
          : '已加入下次想爬。'
    });
    this.refreshView();
  },

  /**
   * 撤下收藏：只从清单里移除这一条，线路、照片、把次、备注与历史都保留。
   */
  removeFromWishlist() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.removeWishlist(routeId);
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '撤下未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.removed ? '已从下次想爬撤下；线路、照片与把次都不变。' : '这条线路本来就不在清单里。'
    });
    this.refreshView();
  },

  /**
   * 拆线归档：岩馆把这条线拆了，把它从活跃清单移到已归档。
   * 只改清单里的这一条，照片文件、照片索引、把次、备注与跨日历史都不动。
   */
  archiveWishlistItem() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.archiveWishlist(routeId);
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '归档未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.code === 'already-archived'
        ? '这条线路已经归档。'
        : '已归档；照片、把次与历史都保留，仍可按原线路 ID 回看。'
    });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 当天再记
  /**
   * 「当天再记」：把当前场次与线路指到这条线所在岩馆的本地当日场次。
   *
   * 只有用户点这一下才可能新建场次（当日该岩馆还没有场次时）；同日多场先返回选场，
   * 不静默改归属；抱石已完攀或落盘失败都不离开本页、不改任何数据。
   */
  recordAgain() {
    if (this.data.loadError || this.data.notFound) return;

    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = store.resumeRouteToday(routeId);
    if (outcome.archive && !outcome.ok) this.archive = outcome.archive;

    if (outcome.code === 'choose-session') {
      this.setData({
        storageError: '',
        notice: '',
        sessionPicker: {
          routeId: routeId,
          routeName: this.data.route.name,
          dateText: outcome.date,
          gymName: this.data.route.gymName,
          sessions: outcome.sessions.map(session => ({
            id: session.id,
            label: store.sessionLabel(this.archive, session),
            isCurrent: session.id === this.archive.activeSessionId
          }))
        }
      });
      return;
    }

    if (!outcome.ok) {
      this.setData({
        notice: outcome.code === 'closed' ? outcome.error : '',
        storageError: outcome.code === 'closed' ? '' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    this.setData({ storageError: '', notice: '', sessionPicker: null });
    this.refreshView();
    this.goToSession();
  },

  /**
   * 同日多场时用户明确选一场：只改当前场次与线路，不动任何把次与备注。
   * 选中的场次必须属于该岩馆当日；落盘失败时保留选择界面与原场次，可重试。
   */
  chooseSessionForAgain(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const sessionId = dataset.sessionId;
    const picker = this.data.sessionPicker;
    if (!sessionId || !picker) return;
    if (!picker.sessions.some(item => item.id === sessionId)) return;

    const outcome = store.chooseRouteSession(picker.routeId, sessionId, { date: picker.dateText });
    if (outcome.archive && !outcome.ok) this.archive = outcome.archive;

    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    this.setData({ storageError: '', notice: '', sessionPicker: null });
    this.refreshView();
    this.goToSession();
  },

  /**
   * 取消选场：不写盘、不改归属，留在详情页继续看原数据。
   */
  cancelSessionPicker() {
    this.setData({ sessionPicker: null });
  },

  goToSession() {
    wx.navigateTo({ url: SESSION_URL });
  },

  // ---------------------------------------------------------------- 按把更正

  /**
   * 「改为未完成」：只改正渲染这一行对应的那一把已确认完攀。
   *
   * 目标来自该行按钮带下来的原把次 ID 与归属，连点/双击原坐标只会重复更正同一把
   * （第二次幂等返回 resolved），不会改到另一把；只翻这一把的 result，把数、ID、
   * 序号、场次、时间与备注都不变，之后可以正常再记并再次完攀。
   */
  correctSend(event) {
    if (this.data.loadError || this.data.notFound) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId;
    if (!attemptId) return;

    const outcome = store.correctAttempt(attemptId, {
      routeId: dataset.routeId,
      sessionId: dataset.sessionId
    });
    if (outcome.archive) this.archive = outcome.archive;

    if (outcome.ok) {
      delete this._correctionFailures[attemptId];
      // 改好的那一把留在原位置变成只读回读：下面的行不上移，同一坐标不会被
      // 另一把的控件接管（改另一把必须点它自己那一行）。
      this._correctedRows[attemptId] = {
        statusText: '已改为未完成 · 本把次保留原时间、场次与备注'
      };
      this.setData({
        storageError: '',
        notice: outcome.code === 'resolved' ? '这一把已经是未完成。' : ''
      });
      this.refreshView();
      return;
    }

    if (outcome.code === 'missing') {
      delete this._correctedRows[attemptId];
      this.setData({ storageError: '', notice: outcome.error });
      this.refreshView();
      return;
    }

    // 写盘失败与归属冲突：保留可重试的控件，明确提示，不改任何数据。
    this._correctionFailures[attemptId] = outcome.code;
    this.setData({
      storageError: outcome.code === 'write-failed' ? outcome.error : '',
      notice: outcome.code === 'write-failed' ? '更正未保存，可再点一次重试。' : outcome.error
    });
    this.refreshView();
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
