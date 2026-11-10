/**
 * 单线记录页（T036）
 *
 * 从本场线路列表整行进入，或加线成功后直达。页面只服务**一条长期线路在**一场训练里
 * 的记录：按入口带下来的 archiveId + sessionId + routeId 核对归属，然后把这一条线的
 * 结果按钮、本场把数、最近一把的撤回／恢复、待保存重试与按把「改为未完成」放在一页。
 *
 * 数据归属：
 * - 入口缺参、场次/线路不存在、线路不属于这一场，或档案已经换成另一份时，页面只显示
 *   可见原因与返回路径，不展示别场别线的把次，也不接受任何写入；
 * - 把次、撤回状态、待保存与完攀判定全部来自 utils/training-store.js；写入、重试与
 *   按把更正走 utils/training-record-actions.js 的共用事件处理，与逐把明细页、线路
 *   资料页是同一份实现；
 * - 照片、卡点、跨天历史与清单操作不在这里重复，页面只提供「线路资料」入口。
 *
 * 返回本场列表后行读数由列表页自己按最新档案重算；本页重开（onShow）也按最新档案
 * 刷新，因此撤回、恢复与待保存重试的结果在两边一致。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';
const ROUTE_URL = '/pages/training-route/training-route';
const ATTEMPTS_URL = '/pages/training-attempts/training-attempts';

Page({
  data: {
    ready: false,
    loadError: '',     // 本机档案损坏/版本不支持/读取失败的可见报错
    contextError: '',  // 入口缺参、串档或线路不属于这一场的可见原因（不写盘）
    storageError: '',  // 本次操作未落盘（不报已保存）
    notice: '',        // 说明性提示（守卫、快速双击等），不改数据

    archiveId: '',
    activeSession: null,
    selectedRoute: null,
    routeStateText: '',
    routeCompleted: false,
    routeClosed: false,
    routeRepeatable: true,
    routeCountText: '0 把',

    attempts: [],
    hasAttempts: false,
    pendingRows: [],
    hasPending: false,
    // 有未落盘的把次时锁定结果按钮：先在待保存行按同一操作重试，确认后才记下一把。
    resultLocked: false,
    resultLockHint: '',

    // 按把「改为未完成」：本场这条线每一把仍可更正的已确认完攀各占一行。
    correctionRows: [],
    correctionStatusText: '',

    // 最近一把的撤回与恢复：结果按钮下方的固定操作区。null 表示不显示。
    recentAttempt: null
  },

  onLoad(query) {
    // 本实例的临时状态，全部不落盘（与旧场内页同名，便于沿用事件语义）：
    // _failedOps 本实例发起但未落盘的把次（按线路分组），重试沿用同一 opId；
    // _lastTap 快速双击窗口；_correctedRows / _correctionFailures 按把更正的只读回读
    // 与失败重试标记；_attemptOps 本次没落盘的撤回/恢复意图；_recentStatus 刚落盘成功
    // 的那一次动作带来的状态（只用于本页确认文案）。
    this._failedOps = {};
    this._lastTap = {};
    this._correctedRows = {};
    this._correctionFailures = {};
    this._attemptOps = {};
    this._recentStatus = null;
    this._context = actions.parseRecordQuery(query);
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从明细或资料返回、或页面重新显示：按最新档案重算同一场同一线。
    this.loadPage();
  },

  /**
   * 按入口参数重新读档并核对归属。只读；缺参/串档/失效时不写盘。
   */
  loadPage() {
    const context = actions.loadRecordContext(this._context);
    if (!context.ok) {
      this.archive = context.archive || null;
      this._session = null;
      this._route = null;
      this.setData({
        ready: true,
        loadError: context.code === 'unreadable' ? context.error : '',
        contextError: context.code === 'unreadable' ? '' : context.error,
        storageError: '',
        notice: '',
        archiveId: '',
        activeSession: null,
        selectedRoute: null,
        routeStateText: '',
        routeCompleted: false,
        routeClosed: false,
        routeRepeatable: true,
        routeCountText: '0 把',
        attempts: [],
        hasAttempts: false,
        pendingRows: [],
        hasPending: false,
        resultLocked: false,
        resultLockHint: '',
        correctionRows: [],
        correctionStatusText: '',
        recentAttempt: null
      });
      return;
    }

    this.archive = context.archive;
    this._session = context.session;
    this._route = context.route;
    this.setData({
      ready: true,
      loadError: '',
      contextError: '',
      storageError: '',
      notice: ''
    });
    this.refreshView();
  },

  retryLoad() {
    this.loadPage();
  },

  /**
   * 由当前档案重新推导这条线在本场的展示；不改动任何已保存数据。
   */
  refreshView() {
    const archive = this.archive;
    const session = this._session;
    const route = this._route;
    if (!archive || !session || !route) return;

    const activeSession = {
      id: session.id,
      gymId: session.gymId,
      gymName: store.gymName(archive, session.gymId),
      dateText: session.date,
      label: store.sessionLabel(archive, session)
    };
    const completion = store.routeCompletion(archive, route.id);
    const selectedRoute = {
      id: route.id,
      name: route.name,
      // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写档案。
      climbType: climbTypeOf(route),
      grade: route.grade,
      colorName: route.colorName || '',
      colorHex: route.colorHex || '#dee2e6',
      isCompleted: Boolean(completion.completed),
      isClosed: Boolean(completion.closed),
      completionText: actions.completionText(completion)
    };

    const labels = actions.attemptLabelMap(archive, session.id, route.id);
    const attempts = store
      .attemptsFor(archive, { sessionId: session.id, routeId: route.id })
      .map(attempt => ({
        id: attempt.id,
        label: labels.get(attempt.id) || '',
        resultText: actions.attemptResultText(attempt.result),
        timeText: actions.timeText(attempt.createdAt),
        note: attempt.note || '',
        hasNote: Boolean(attempt.note)
      }));

    // 待保存行：档案里的「进行中」操作 + 本实例发起但完全没落盘的操作。
    const fromArchive = (archive.pendingSaves || [])
      .filter(op => op.sessionId === session.id && op.routeId === route.id)
      .sort((left, right) => (left.seq || 0) - (right.seq || 0))
      .map(op => ({
        opId: op.opId,
        label: labels.get(op.opId) || '',
        resultText: actions.attemptResultText(op.result),
        statusText: '未保存 · 点「重试保存」按同一把重试',
        canRetry: true
      }));
    const localOnly = Object.keys(this._failedOps)
      .map(key => this._failedOps[key])
      .filter(
        op =>
          op.sessionId === session.id &&
          op.routeId === route.id &&
          !fromArchive.some(row => row.opId === op.opId)
      )
      .map(op => ({
        opId: op.opId,
        label: '',
        resultText: actions.attemptResultText(op.result),
        statusText: '未保存 · 点「重试保存」按同一把重试',
        canRetry: true
      }));
    const pendingRows = fromArchive.concat(localOnly);

    // 按把「改为未完成」：只列本场这条线仍可更正的已确认完攀；跨天历史在资料页更正。
    const correctionRows = store
      .routeCorrectionTargets(archive, route.id)
      .filter(target => target.sessionId === session.id)
      .map(target => {
        const corrected = this._correctedRows[target.attemptId];
        const needsRetry = Boolean(
          this._correctionFailures[target.attemptId] ||
            (archive.pendingCorrections || []).some(item => item.attemptId === target.attemptId)
        );
        const state = corrected ? 'corrected' : needsRetry ? 'retry' : 'ready';
        return {
          attemptId: target.attemptId,
          routeId: target.routeId,
          sessionId: target.sessionId,
          archiveId: archive.archiveId,
          label: target.label,
          contextText: target.contextText,
          state,
          buttonText: state === 'retry' ? '重试改为未完成' : '改为未完成',
          statusText: corrected ? corrected.statusText : ''
        };
      });

    const resultLocked = pendingRows.length > 0;
    const routeCountText = pendingRows.length
      ? attempts.length + ' 把 · ' + pendingRows.length + ' 把待保存'
      : attempts.length + ' 把';
    const correctionStatusText = correctionRows.some(row => row.state === 'retry')
      ? '更正未保存 · 点「重试改为未完成」按同一把重试'
      : '';

    this.setData({
      archiveId: archive.archiveId,
      activeSession,
      selectedRoute,
      routeStateText: actions.completionText(completion),
      routeCompleted: Boolean(completion && completion.completed),
      routeClosed: Boolean(completion && completion.closed),
      routeRepeatable: !completion || completion.repeatable,
      routeCountText,
      attempts,
      hasAttempts: attempts.length > 0,
      pendingRows,
      hasPending: pendingRows.length > 0,
      resultLocked,
      resultLockHint: resultLocked
        ? '上一把还没保存：先在「待保存」行点「重试保存」，确认后再记下一把。'
        : '',
      correctionRows,
      correctionStatusText,
      recentAttempt: actions.recentAttemptView.call(
        this,
        archive,
        activeSession,
        selectedRoute,
        pendingRows
      )
    });
  },

  // ---------------------------------------------------------------- 页面入口

  /**
   * 逐把明细：只带这一场、这一条线的原 ID；明细页按同一组参数再核对一次归属。
   */
  openAttempts() {
    if (this.data.loadError || this.data.contextError) return;
    if (!this.archive || !this._session || !this._route) return;
    wx.navigateTo({
      url:
        ATTEMPTS_URL +
        '?' +
        actions.recordQueryString({
          archiveId: this.archive.archiveId,
          sessionId: this._session.id,
          routeId: this._route.id
        })
    });
  },

  /**
   * 线路资料：按原长期 routeId 进入照片、卡点、跨天历史与清单操作。
   */
  openRouteProfile() {
    if (this.data.loadError || this.data.contextError) return;
    const routeId = this._route && this._route.id;
    if (!routeId) return;
    wx.navigateTo({
      url: ROUTE_URL + '?routeId=' + encodeURIComponent(routeId)
    });
  },

  /**
   * 回到本场线路列表：正常路径就是系统返回；这里显式给缺参/失效时一个可点的出口。
   */
  backToList() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: SESSION_URL });
  },

  // ---------------------------------------------------------------- 共用事件

  recordAttempt: actions.recordAttempt,
  retryPendingAttempt: actions.retryPendingAttempt,
  undoLatestAttempt: actions.undoLatestAttempt,
  restoreLatestAttempt: actions.restoreLatestAttempt,
  changeRecentAttempt: actions.changeRecentAttempt,
  correctSend: actions.correctSend,

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
