/**
 * 正式长期线路详情页（T018）
 *
 * 从正式记录 tab 的「本机训练历史」按长期线路 ID 进入，回看这条线跨日、跨场次的
 * 逐把结果与备注：按本地日期和场次分组，场次新的在前，同一天多场各自保留原归属。
 *
 * 本页只读本机档案（utils/training-store.js），与旧云记录完全分开：
 * - 打开历史本身不建场次、不改当前选择、不写任何数据；损坏或版本不支持时可见报错
 *   并保留原数据；
 * - 「当天再记」是唯一写入口，且必须由用户明确点按：当日该岩馆恰好一场就直接复用，
 *   还没有场次才新建一场，同日多场先让用户显式选一场（原归属不动）；抱石已完攀时
 *   不新增把次，只提示按把更正；
 * - 「改为未完成」按渲染那一行带下来的原把次 ID 与归属逐个更正：只翻那一把的
 *   result，把数、ID、序号、场次、时间与备注都不变；改好的那一把留在原位置变成
 *   只读回读，同一坐标不会自动接上另一把。
 */
const store = require('../../utils/training-store.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';

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
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从场内页返回或另一页面实例刚改了同一档案时重新读取，保持回看与本机一致。
    // 打开历史只读，不写盘、不建场次。
    this.loadPage({ keepPicker: true });
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
      this.setData({ notFound: true, route: null, canRecordAgain: false });
      return;
    }

    const history = store.routeHistory(this.archive, this._routeId);
    if (!history.known) {
      this.setData({
        notFound: true,
        route: null,
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
