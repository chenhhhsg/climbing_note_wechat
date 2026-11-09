/**
 * 线路详情 · 同一条线跨天接着记
 *
 * 从今日页按稳定线路 ID 进入，按日期与场次分组回看每条尝试的结果、时间和备注。
 * 「今天再爬」选用该岩馆今天的场次（没有就新建一场），把线路设回今日页继续记录。
 * 抱石线已完攀后不再显示「今天再爬」，改为在原把次上「改为未完成」更正误点的完攀。
 *
 * 旧汇总样例只按原始汇总展示，不生成逐次尝试，也不参与逐次统计。
 */
const {
  GYMS,
  LEGACY_SUMMARY_SAMPLE,
  clone,
  formatLocalTime,
  todayLocalDate,
  createInitialState,
  loadState,
  saveState,
  routeCompletion,
  pendingCorrectionFor,
  // 「改为未完成」的共用逻辑（与今日页同一份）：
  // 目标校验、入队、请求格式与回执结清都在 utils/store.js。
  // routeCorrectionTargets/correctionRows 逐把列出可更正的原把次：
  // 页面为每一把各渲染一个控件，更正成功后在原位置变成只读结果，不会自动接下一把。
  correctionRows,
  correctionReadbackRow,
  correctionDataset,
  correctionTargetFromDataset,
  correctionStatusNotice,
  enqueueCorrection,
  correctionRequest,
  finishCorrectionJob
} = require('../../utils/store.js');
const {
  createPhotoController,
  buildView
} = require('../../utils/photo-controller.js');
const { climbTypeOf } = require('../../utils/route-rules.js');
const trialSaveServer = require('../../utils/trial-save-server.js');

const TRIAL_BADGE = '本地试用 · 虚构数据';
const TODAY_URL = '/pages/today/today';

function findSession(state, id) {
  return state.sessions.find(session => session.id === id) || null;
}

function sessionLabel(state, session) {
  const sameDay = state.sessions
    .filter(item => item.date === session.date)
    .sort((left, right) => left.seq - right.seq);
  return '第 ' + (sameDay.findIndex(item => item.id === session.id) + 1) + ' 场';
}

function gymName(gymId) {
  const gym = GYMS.find(item => item.id === gymId);
  return gym ? gym.name : '未知岩馆';
}

function attemptResultText(result) {
  return result === 'send' ? '完攀' : '未完成';
}

/**
 * 待确认完攀的原始把次（T015）：这条抱石线还在待确认的完攀属于哪个场次、第几把。
 *
 * 只读计算，供详情页展示「完攀待确认」状态与回原把次重试的入口使用；
 * 不新建场次、不生成新的 opId，也不改动任何记录。
 * 找不到原场次（例如已被重置）时返回 null，由调用方按最新状态刷新，不猜、不补。
 */
function pendingRetryInfo(state, routeId) {
  const op =
    (state.pendingSaves || [])
      .filter(item => item.routeId === routeId && item.result === 'send')
      .sort((left, right) => left.seq - right.seq)[0] || null;
  if (!op) return null;

  const session = findSession(state, op.sessionId);
  if (!session) return null;

  // 同一把的序号与已确认把次共用：重试后编号稳定，用户能对上原把次。
  const ordered = (state.attempts || [])
    .filter(item => item.sessionId === session.id && item.routeId === routeId)
    .map(item => item.seq)
    .concat([op.seq])
    .sort((left, right) => left - right);
  const label = '第 ' + (ordered.indexOf(op.seq) + 1) + ' 把';

  return {
    opId: op.opId,
    sessionId: session.id,
    attemptLabel: label,
    sessionText:
      session.date +
      ' ' +
      sessionLabel(state, session) +
      ' · ' +
      gymName(session.gymId),
    hint:
      '这条抱石线的完攀还在待确认（' +
      session.date +
      ' ' +
      sessionLabel(state, session) +
      ' ' +
      label +
      '）：回到原把次点「重试保存」；确认后只能回看，或在该把次上「改为未完成」。'
  };
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '--:--' : formatLocalTime(date);
}

/**
 * 已确认或仍在待确认时，迟到的「今天再爬」/选场事件给出的说明（T015）。
 *
 * 待确认时优先点名原场次与原把次，避免只给泛泛提示、让用户猜原场次；
 * 找不到原把次（例如已被重置）时退回原有说明，不新建场次也不改数据。
 * 已完攀的抱石线仍可回看与「改为未完成」更正，说明里一并讲清。
 */
function noticeForClosed(state, routeId, completedText) {
  if (completedText) return completedText;
  const info = pendingRetryInfo(state, routeId);
  if (!info) {
    return '这条抱石线路的完攀还在待确认：请先在原把次上重试保存；确认后只能回看或改为未完成。';
  }
  return (
    '这条抱石线路的完攀还在待确认（' +
    info.sessionText +
    ' ' +
    info.attemptLabel +
    '）：先回原把次重试保存，确认后只能回看或改为未完成。'
  );
}

Page({
  data: {
    ready: false,
    loadError: '',
    storageError: '',
    trialBadge: TRIAL_BADGE,

    route: null,
    isLegacy: false,
    notFound: false,
    legacySummary: null,

    groups: [],
    hasAttempts: false,
    attemptCount: 0,
    attemptCountText: '0 把',
    sendCount: 0,
    summaryText: '0 天 · 0 场 · 0 把',

    // 完攀状态（T015）：与今日页、历史选线共用 store.routeCompletion 的同一份判定。
    // 已完攀的抱石线只能回看与「改为未完成」更正：不显示「今天再爬」，迟到事件也不再新增。
    routeCompleted: false,
    routeClosed: false,
    canRecordAgain: true,
    routeStateText: '',
    // 误点完攀的更正入口（T015 返工）：已完攀时隐藏「完攀」，每一把原把次
    // 各有一个「改为未完成」控件（见 routeCorrectionRows 与每行的 correction* 字段）。
    routeCorrectable: false,
    routeCorrectionRows: [],
    routeCorrectionPending: false,
    routeCorrectionSaving: false,
    routeCorrectionStatusText: '',
    // 待确认的完攀（T015）：与已确认的「已完攀」分开展示，并给出回原把次重试的入口。
    routePendingSend: false,
    pendingRetry: null,
    pendingRetryHint: '',
    recordNotice: '',

    // 主照片可以在详情页直接补、换、移除；列表缩略图仍由今日页读取同一索引。
    routePhoto: null,
    photoNotice: '',

    sessionPicker: null
  },

  onLoad(query) {
    this._routeId = (query && query.routeId) || '';
    this._photoUi = null;
    this._unloaded = false;
    this._photoReady = Promise.resolve();
    // 更正（改为未完成）与普通保存分开派发：同一原把次只派发一次。
    this._dispatchingCorrections = {};
    this._correctionFailures = {};
    // 本实例刚改正成功的把次：留在原位显示只读结果，避免下面的行上移、
    // 把同一坐标让给下一把的控件。刷新与 onShow 都不重置它。
    this._correctedRows = {};
    this._saveDelayMs = 0;
    this.state = createInitialState();
    this.load();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从今日页返回、或另一页面实例刚改了同一条线路时重新读取缓存再刷新，
    // 让详情的完攀状态、统计与逐把结果和今日页保持一致。
    if (!this.data.savingCorrectionId) {
      const loaded = loadState();
      if (loaded.error) {
        if (loaded.error !== this.data.loadError) this.load();
        return;
      }
      this.state = loaded.state;
      this.refreshView();
    }
    this.loadPhotos();
  },

  onUnload() {
    this._unloaded = true;
  },

  /**
   * 详情页只读取缓存；刷新不会写回，避免把只读样例变成记录。
   */
  load() {
    const loaded = loadState();
    this.state = loaded.state;
    this._correctionFailures = {};

    this.setData({
      ready: true,
      loadError: loaded.error,
      storageError: '',
      trialBadge: TRIAL_BADGE,
      route: null,
      isLegacy: false,
      notFound: false,
      legacySummary: null,
      groups: [],
      hasAttempts: false,
      attemptCount: 0,
      attemptCountText: '0 把',
      sendCount: 0,
      summaryText: '0 天 · 0 场 · 0 把',
      routeCompleted: false,
      routeClosed: false,
      canRecordAgain: true,
      routeStateText: '',
      routeCorrectable: false,
      routeCorrectionRows: [],
      routeCorrectionPending: false,
      routeCorrectionSaving: false,
      routeCorrectionStatusText: '',
      routePendingSend: false,
      pendingRetry: null,
      pendingRetryHint: '',
      recordNotice: '',
      routePhoto: null,
      photoNotice: '',
      sessionPicker: null
    });

    if (loaded.error) return;
    this.refreshView();
    this._photoReady = this.initPhotoUi();
  },

  retryLoad() {
    this.load();
  },

  /**
   * 详情页与今日页共享同一个试用照片服务与索引；这里只读取当前线路的照片。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createPhotoController(this, {
        onChange: () => this.applyPhotoView(),
        onNotice: text => this.setData({ photoNotice: text })
      });
    }
    this._photoUi.init(this.state.datasetId);
    return this.loadPhotos();
  },

  loadPhotos() {
    if (
      !this._photoUi ||
      !this.data.route ||
      this.data.isLegacy ||
      this.data.notFound
    ) {
      return Promise.resolve();
    }
    return this._photoUi
      .load([this.data.route.id])
      .then(() => this.applyPhotoView());
  },

  applyPhotoView() {
    if (this._unloaded) return;
    if (!this._photoUi || !this.data.route || this.data.isLegacy) {
      this.setData({ routePhoto: null });
      return;
    }
    this.setData({ routePhoto: this._photoUi.view(this.data.route.id) });
  },

  photoRouteId(event) {
    const detail =
      (event && event.currentTarget && event.currentTarget.dataset) || {};
    return detail.routeId || this._routeId;
  },

  dismissPhotoNotice() {
    this.setData({ photoNotice: '' });
  },

  dismissRecordNotice() {
    this.setData({ recordNotice: '' });
  },

  chooseDetailPhoto(event) {
    const detail =
      (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = detail.source;
    if (!this._photoUi || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    const routeId = this.photoRouteId(event);
    if (!routeId || routeId !== this._routeId) return Promise.resolve();
    return this._photoUi.choose(routeId, source);
  },

  confirmDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId || routeId !== this._routeId) {
      return Promise.resolve();
    }
    return this._photoUi.confirm(routeId);
  },

  cancelDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.cancelPreview(routeId);
  },

  retryDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.retry(routeId);
  },

  dismissDetailPhotoFailure(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.dismiss(routeId);
  },

  removeDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.remove(routeId);
  },

  previewDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.preview(routeId);
  },

  reloadDetailPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.load([routeId]);
  },

  /**
   * 空间不足等需要管理照片时，回到今日页并直接展开照片空间管理区。
   * 不在这里删除主图或索引。
   */
  openSpaceManager() {
    if (typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
      wx.reLaunch({ url: TODAY_URL + '?manageSpace=1' });
    }
  },

  refreshView() {
    const state = this.state;

    if (!this._routeId) {
      this.setData({ notFound: true, routePhoto: null });
      return;
    }

    if (this._routeId === LEGACY_SUMMARY_SAMPLE.id) {
      this.setData({
        route: {
          id: LEGACY_SUMMARY_SAMPLE.id,
          gymId: LEGACY_SUMMARY_SAMPLE.gymId,
          name: LEGACY_SUMMARY_SAMPLE.name,
          // 旧样例没有类型字段，按抱石只读展示，不改写缓存。
          climbType: climbTypeOf(LEGACY_SUMMARY_SAMPLE),
          colorName: LEGACY_SUMMARY_SAMPLE.colorName,
          colorHex: LEGACY_SUMMARY_SAMPLE.colorHex,
          grade: LEGACY_SUMMARY_SAMPLE.grade,
          gymName: gymName(LEGACY_SUMMARY_SAMPLE.gymId)
        },
        isLegacy: true,
        notFound: false,
        legacySummary: {
          label: LEGACY_SUMMARY_SAMPLE.legacy.label,
          summaryText: LEGACY_SUMMARY_SAMPLE.legacy.summaryText,
          hint: LEGACY_SUMMARY_SAMPLE.legacy.hint
        },
        groups: [],
        hasAttempts: false,
        attemptCount: 0,
        attemptCountText: '0 把',
        sendCount: 0,
        summaryText: '0 天 · 0 场 · 0 把',
        // 旧汇总样例没有逐次尝试，也不参与新增流程与更正。
        routeCompleted: false,
        routeClosed: false,
        canRecordAgain: false,
        routeStateText: '',
        routeCorrectable: false,
        routeCorrectionRows: [],
        routeCorrectionPending: false,
        routeCorrectionSaving: false,
        routeCorrectionStatusText: '',
        routePendingSend: false,
        pendingRetry: null,
        pendingRetryHint: '',
        routePhoto: null
      });
      return;
    }

    const route = state.routes.find(item => item.id === this._routeId);
    if (!route) {
      this.setData({
        route: null,
        notFound: true,
        routePhoto: null,
        routeCompleted: false,
        routeClosed: false,
        canRecordAgain: false,
        routeStateText: '',
        routeCorrectable: false,
        routeCorrectionRows: [],
        routeCorrectionPending: false,
        routeCorrectionSaving: false,
        routeCorrectionStatusText: '',
        routePendingSend: false,
        pendingRetry: null,
        pendingRetryHint: ''
      });
      return;
    }

    const related = state.attempts.filter(
      attempt =>
        attempt.routeId === route.id && Boolean(findSession(state, attempt.sessionId))
    );
    const sessionIds = new Set(related.map(attempt => attempt.sessionId));
    const sessions = state.sessions
      .filter(session => sessionIds.has(session.id))
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) || right.seq - left.seq
      );

    // 误点完攀的更正入口（T015 返工）：不再有「自动挑下一把」的单个按钮。
    // 每一把仍可更正的已确认完攀都单独成行、各带自己的控件（写明日期/场次/第几把），
    // 本实例刚改好的那一把留在原位置显示只读结果。于是同一个位置永远不会自动
    // 接上下一把：双击/连点原坐标只会读到「已改为未完成」，不会写到另一把。
    const pendingCorrection = pendingCorrectionFor(state, route.id);
    const savingCorrectionId = this.data.savingCorrectionId || '';
    const routeCorrectionRows = correctionRows(state, route.id, {
      corrected: this._correctedRows,
      savingId: savingCorrectionId,
      failures: this._correctionFailures
    });
    const correctionRowById = {};
    routeCorrectionRows.forEach(row => {
      correctionRowById[row.attemptId] = row;
    });
    // 「还有能点的更正控件」才叫可更正；只剩只读回读时不再给入口。
    const routeCorrectable = routeCorrectionRows.some(
      row => row.state !== 'corrected'
    );
    let routeCorrectionStatusText = '';
    if (routeCorrectionRows.some(row => row.state === 'correcting')) {
      routeCorrectionStatusText = '更正保存中…';
    } else if (routeCorrectionRows.some(row => row.state === 'retry')) {
      routeCorrectionStatusText =
        '更正未确认 · 点「重试改为未完成」按同一把重试';
    }

    const groups = sessions.map(session => {
      const attempts = related
        .filter(attempt => attempt.sessionId === session.id)
        .sort((left, right) => left.seq - right.seq);
      return {
        sessionId: session.id,
        dateText: session.date,
        sessionLabel: sessionLabel(state, session),
        gymName: gymName(session.gymId),
        countText: attempts.length + ' 把',
        attempts: attempts.map((attempt, index) => {
          const row = correctionRowById[attempt.id] || null;
          // 每行都带固定高度的操作位：控件与只读结果占同一格，改完不塌陷，
          // 下面的行不上移，也就不会把同一坐标让给下一把。
          return {
            id: attempt.id,
            label: '第 ' + (index + 1) + ' 把',
            resultText: attemptResultText(attempt.result),
            timeText: timeText(attempt.createdAt),
            note: attempt.note || '',
            hasNote: Boolean(attempt.note),
            correctionState: row ? row.state : '',
            correctionStatusText: row ? row.statusText : '',
            correctionDisabled: row ? row.disabled : false,
            // 只读回读行不带 dataset：没有可点的按钮，也不参与任何写操作。
            correctionContext:
              row && row.state !== 'corrected' ? row.context : null
          };
        })
      };
    });

    const dayCount = new Set(groups.map(group => group.dateText)).size;
    const sendCount = related.filter(attempt => attempt.result === 'send').length;
    // 完攀状态与今日页、历史选线同源：已完攀的抱石线只回看，顶绳和先锋可再记。
    const completion = routeCompletion(state, route.id);
    // 待确认与已确认分开：只有已确认才显示「已完攀」；待确认给出回原把次的入口。
    // 只有因此被关闭入口的抱石线才算「完攀待确认」——顶绳、先锋可重复完攀。
    const pendingSend = completion.closed && !completion.completed;
    const pendingRetry = pendingSend ? pendingRetryInfo(state, route.id) : null;

    this.setData({
      route: {
        id: route.id,
        gymId: route.gymId,
        name: route.name,
        // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写缓存。
        climbType: climbTypeOf(route),
        colorName: route.colorName,
        colorHex: route.colorHex,
        grade: route.grade,
        gymName: gymName(route.gymId)
      },
      isLegacy: false,
      notFound: false,
      legacySummary: null,
      groups,
      hasAttempts: related.length > 0,
      attemptCount: related.length,
      attemptCountText: related.length + ' 把',
      sendCount,
      routeCompleted: completion.completed,
      routeClosed: completion.closed,
      canRecordAgain: completion.canRecord,
      routeStateText: completion.completed
        ? '已完攀'
        : completion.closed
          ? '完攀待确认'
          : '',
      routeCorrectable,
      routeCorrectionRows,
      routeCorrectionPending: Boolean(pendingCorrection),
      routeCorrectionSaving: Boolean(savingCorrectionId),
      routeCorrectionStatusText,
      routePendingSend: pendingSend,
      pendingRetry,
      pendingRetryHint: pendingRetry ? pendingRetry.hint : '',
      summaryText:
        dayCount + ' 天 · ' + groups.length + ' 场 · ' + related.length + ' 把',
      routePhoto: this._photoUi
        ? this._photoUi.view(route.id)
        : buildView(null, null)
    });
  },

  /**
   * 今天该岩馆只有一场时直接复用；没有就新建；有多场时先让用户明确归属。
   * 选择权交给用户，避免静默把当前场次改成另一场。
   * 只改当前场次与已选线路，不改动与这条线无关的记录。
   *
   * 进入详情时的快照可能早于今日页刚完成的保存回执，因此写回前重新读缓存，
   * 只把「当前场次/线路」合并进去，不拿旧快照覆盖新的尝试或待确认操作。
   */
  recordAgain() {
    if (this.data.loadError || this.data.notFound || this.data.isLegacy) return;

    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return;
    }
    this.state = loaded.state;

    // 迟到的「今天再爬」事件（例如另一页面刚确认了这条抱石线的首次完攀）：
    // 按最新持久状态重新判定，已完攀只刷新回看，不新建场次也不发起尝试。
    const completion = routeCompletion(loaded.state, routeId);
    if (completion.known && completion.closed) {
      this.refreshView();
      this.setData({
        storageError: '',
        recordNotice: noticeForClosed(
          loaded.state,
          routeId,
          completion.completed
            ? '这条抱石线路已完攀，不能再新增把次；点错了可在原把次上「改为未完成」更正，也可以回看记录。'
            : ''
        )
      });
      return;
    }

    const next = clone(loaded.state);
    const target = next.routes.find(item => item.id === routeId);
    if (!target) {
      this.setData({ storageError: '找不到这条线路，请返回今日页重试' });
      return;
    }

    const today = todayLocalDate();
    const todaySessions = next.sessions
      .filter(item => item.date === today && item.gymId === target.gymId)
      .sort((left, right) => left.seq - right.seq);

    if (todaySessions.length > 1) {
      this._pendingRouteId = target.id;
      this.setData({
        storageError: '',
        sessionPicker: {
          routeName: target.name,
          dateText: today,
          gymName: gymName(target.gymId),
          sessions: todaySessions.map(session => ({
            id: session.id,
            label: sessionLabel(next, session),
            timeText: timeText(session.createdAt),
            isCurrent: session.id === next.activeSessionId
          }))
        }
      });
      return;
    }

    let session = todaySessions[0] || null;

    if (!session) {
      const seq = next.nextSessionSeq;
      next.nextSessionSeq = seq + 1;
      session = {
        id: 'session-' + seq,
        seq,
        gymId: target.gymId,
        date: today,
        createdAt: new Date().toISOString()
      };
      next.sessions.push(session);
    }

    next.activeSessionId = session.id;
    next.activeRouteId = target.id;

    const saved = saveState(next);
    if (!saved.ok) {
      this.setData({ storageError: saved.error });
      return;
    }

    this.state = next;
    this.setData({ storageError: '' });
    this.goBackToToday();
  },

  /**
   * 用户从同日场次列表中明确选中一场后才切换归属并返回。
   * 写入失败时保留选择界面与原场次，用户可重试。
   * 同样先读最新缓存再合并，避免详情页快照把今日页刚保存的回执覆盖掉。
   */
  chooseSessionForAgain(event) {
    const sessionId =
      event && event.currentTarget && event.currentTarget.dataset.sessionId;
    const picker = this.data.sessionPicker;
    if (!sessionId || !picker) return;
    if (!picker.sessions.some(item => item.id === sessionId)) return;

    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return;
    }
    this.state = loaded.state;

    // 弹层打开期间这条抱石线可能在别处完成完攀：按最新状态判定，
    // 已完攀时收起弹层并只刷新回看，不切换场次、不发起尝试。
    const completion = routeCompletion(loaded.state, this._pendingRouteId);
    if (completion.known && completion.closed) {
      const routeId = this._pendingRouteId;
      this._pendingRouteId = '';
      this.setData({
        sessionPicker: null,
        storageError: '',
        recordNotice: noticeForClosed(
          loaded.state,
          routeId,
          completion.completed
            ? '这条抱石线路已完攀，本次选场未生效；可在原把次上「改为未完成」更正，也可以回看记录。'
            : ''
        )
      });
      this.refreshView();
      return;
    }

    const next = clone(loaded.state);
    const target = next.routes.find(
      item => item.id === this._pendingRouteId
    );
    if (!target) {
      this.setData({
        sessionPicker: null,
        storageError: '找不到这条线路，请返回今日页重试'
      });
      return;
    }

    const session = next.sessions.find(
      item =>
        item.id === sessionId &&
        item.date === picker.dateText &&
        item.gymId === target.gymId
    );
    if (!session) {
      this.setData({
        storageError: '找不到这个场次，请重新选择'
      });
      return;
    }

    next.activeSessionId = session.id;
    next.activeRouteId = target.id;

    const saved = saveState(next);
    if (!saved.ok) {
      this.setData({ storageError: saved.error });
      return;
    }

    this.state = next;
    this._pendingRouteId = '';
    this.setData({ storageError: '', sessionPicker: null });
    this.goBackToToday();
  },

  /**
   * 取消选择不写缓存、不切场次，留在详情页继续看原数据。
   */
  cancelSessionPicker() {
    this._pendingRouteId = '';
    this.setData({ sessionPicker: null });
  },

  /**
   * 待确认完攀的回原把次入口（T015）：把「当前场次/线路」指到原把次所在的场次与
   * 这条线路，再返回今日页，让用户在原待确认行点「重试保存」。
   *
   * 只切换当前选择，不新建场次、不生成新的 opId、不发起任何尝试：
   * 重试始终复用原 opId，保存端按该 ID 幂等。
   * 原把次已不在（被确认或被重置）时按最新状态刷新，不猜、不补一个新场次。
   */
  openPendingRetry() {
    if (this.data.loadError || this.data.notFound || this.data.isLegacy) return;

    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return;
    }

    const next = clone(loaded.state);
    const route = next.routes.find(item => item.id === routeId);
    const info = pendingRetryInfo(next, routeId);
    const session = info ? findSession(next, info.sessionId) : null;
    if (!route || !session) {
      this.state = next;
      this.refreshView();
      return;
    }

    next.activeSessionId = session.id;
    next.activeRouteId = route.id;

    const saved = saveState(next);
    if (!saved.ok) {
      this.setData({ storageError: saved.error });
      return;
    }

    this.state = next;
    this.setData({ storageError: '' });
    this.goBackToToday();
  },

  /**
   * 改为未完成（T015 返工）：只改正渲染这一把时展示的那个已确认完攀。
   *
   * - 目标来自按钮渲染当时带下来的上下文（原 attempt/op ID 与原把次的线路、场次、
   *   世代、数据集、归属）：只针对这一把，不新建场次、不新增把次，原来的把数、时间、
   *   序号、备注、照片与所属场次都不变；之后可以正常再记并再次完攀；
   * - 跨天历史进入或重开详情时同样是这个入口，不依赖任何页面内的临时标记；
   * - 参数缺失或已过时（页面刷新、重置/换数据集、原把次已被改过）时给出提示，
   *   绝不默默拿「最新一把」来改正，也不会误重试另一个目标；
   * - 保存端与本地模型都要改：先落一条待更正，确认后才改本地那一把；任一步失败
   *   都保留待更正，再点一次按同一把重试（保存端按原 opId 幂等）。
   */
  correctSend(event) {
    if (this.data.loadError || this.data.notFound || this.data.isLegacy) {
      return Promise.resolve();
    }
    if (this.data.savingCorrectionId) return Promise.resolve();

    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return Promise.resolve();

    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return Promise.resolve();
    }

    const target = correctionTargetFromDataset(
      loaded.state,
      correctionDataset(event),
      routeId
    );
    if (target.status !== 'ok') {
      this.state = loaded.state;
      this.refreshView();
      this.setData({ recordNotice: correctionStatusNotice(target.status) });
      return Promise.resolve();
    }

    // 已有待更正：只有点的就是同一把时才沿用重试；已有另一把在正更中时不改目标。
    const pending = pendingCorrectionFor(loaded.state, routeId);
    if (pending) {
      this.state = loaded.state;
      if (pending.attemptId !== target.attempt.id) {
        this.refreshView();
        this.setData({ recordNotice: '已有另一把正在更正，请先完成它。' });
        return Promise.resolve();
      }
      this.refreshView();
      return this.dispatchCorrection(pending.attemptId);
    }

    // 只记下更正意图：当前场次、线路、把次、备注与照片都不动，也不新建场次。
    const next = enqueueCorrection(loaded.state, target.attempt);
    const saved = saveState(next);
    if (!saved.ok) {
      this.state = loaded.state;
      this.setData({ storageError: saved.error });
      return Promise.resolve();
    }

    this.state = next;
    this.setData({ storageError: '', recordNotice: '' });
    this.refreshView();
    return this.dispatchCorrection(target.attempt.id);
  },

  /**
   * 同一条待更正只派发一次；重复点击只复用同一条，不产生第二个请求。
   * 回执可能晚于其他页面实例的写入，交付时只按原把次 ID 合并，不写派发时的旧快照。
   */
  dispatchCorrection(attemptId) {
    if (!attemptId) return Promise.resolve();

    const correction = (this.state.pendingCorrections || []).find(
      item => item.attemptId === attemptId
    );
    if (!correction) {
      const loaded = loadState();
      if (!loaded.error && !this._unloaded) {
        this.state = loaded.state;
        this.refreshView();
      }
      return Promise.resolve();
    }
    if (this._dispatchingCorrections[attemptId]) return Promise.resolve();

    const snapshot = clone(correction);

    this._dispatchingCorrections[attemptId] = true;
    this.setData({ savingCorrectionId: attemptId });
    this.refreshView();

    return new Promise(resolve => {
      const deliver = () => {
        let outcome;
        try {
          // 只报「要改正的原把次」：线路类型、归属与结果都由保存端按试用数据与
          // 账本判定，页面不自带（可省略、可伪造的）声明；世代用于识别迟到的旧请求。
          outcome = trialSaveServer.submitCorrection(correctionRequest(snapshot));
        } catch (error) {
          outcome = {
            ok: false,
            error:
              '模拟保存端异常：' +
              ((error && (error.message || error.errMsg)) || String(error))
          };
        }

        if (!this._unloaded) {
          this.finishCorrection(attemptId, outcome, snapshot);
        }

        delete this._dispatchingCorrections[attemptId];
        if (!this._unloaded) {
          const remaining = Object.keys(this._dispatchingCorrections)[0] || '';
          this.setData({ savingCorrectionId: remaining });
          this.refreshView();
        }
        resolve();
      };

      if (this._saveDelayMs > 0) {
        setTimeout(deliver, this._saveDelayMs);
      } else {
        deliver();
      }
    });
  },

  /**
   * 更正回执到达时只核销这一个原把次：具体的读最新状态、只翻那一把、失败保留待更正
   * 都由 utils/store.js 的 finishCorrectionJob 共用一份（与今日页同一份），
   * 这里只把结论落到详情页自己的提示字段上。
   * - 成功：只把那一把原位改成未完成（ID、序号、场次、时间与备注都不变），再移除待更正；
   * - 账本已改、本地写入失败：保留待更正并提示重试，不半途改数据；
   * - 原把次已不是完攀（别的实例已改正或被重置）：只清掉待更正，不改写其他把次；
   * - 重置/切换后的迟到回执、保存端拒绝的跨归属更正：只同步显示，不写回新数据；
   * - 失败或丢回执：不改动缓存，保留待更正，可再点「改为未完成」按同一把重试。
   */
  finishCorrection(attemptId, outcome, correctionSnapshot) {
    if (this._unloaded) return;

    const decision = finishCorrectionJob(
      attemptId,
      outcome,
      correctionSnapshot
    );
    if (!decision.state) {
      this.setData({ storageError: decision.storageError });
      return;
    }

    if (decision.failure) {
      this._correctionFailures[attemptId] = decision.failure;
    } else {
      delete this._correctionFailures[attemptId];
    }
    // 改成功后把这一把记成「原位只读结果」：它在列表里的位置不消失，
    // 下面的行不上移，同一坐标不会被下一把的控件接管。
    if (decision.code === 'corrected' || decision.code === 'noop') {
      const readback = correctionReadbackRow(decision.state, attemptId);
      if (readback) this._correctedRows[attemptId] = readback;
    }
    this.state = decision.state;
    this.setData({
      storageError: decision.storageError,
      recordNotice: decision.notice
    });
    this.refreshView();
  },

  goBackToToday() {
    const fallback = () => {
      if (typeof wx.reLaunch === 'function') {
        wx.reLaunch({ url: TODAY_URL });
      }
    };
    if (typeof wx.navigateBack === 'function') {
      wx.navigateBack({ delta: 1, fail: fallback });
    } else {
      fallback();
    }
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
