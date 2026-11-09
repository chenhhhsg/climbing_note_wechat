/**
 * 线路详情 · 同一条线跨天接着记
 *
 * 从今日页按稳定线路 ID 进入，按日期与场次分组回看每条尝试的结果、时间和备注。
 * 「今天再爬」选用该岩馆今天的场次（没有就新建一场），把线路设回今日页继续记录。
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
  routeCompletion
} = require('../../utils/store.js');
const {
  createPhotoController,
  buildView
} = require('../../utils/photo-controller.js');
const { climbTypeOf } = require('../../utils/route-rules.js');

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
      '）：回到原把次点「重试保存」，确认后只能回看。'
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
 */
function noticeForClosed(state, routeId, completedText) {
  if (completedText) return completedText;
  const info = pendingRetryInfo(state, routeId);
  if (!info) {
    return '这条抱石线路的完攀还在待确认：请先在原把次上重试保存；确认后只能回看。';
  }
  return (
    '这条抱石线路的完攀还在待确认（' +
    info.sessionText +
    ' ' +
    info.attemptLabel +
    '）：先回原把次重试保存，确认后只能回看。'
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
    // 已完攀的抱石线只能回看：不显示「今天再爬」，迟到事件也不再新增。
    routeCompleted: false,
    routeClosed: false,
    canRecordAgain: true,
    routeStateText: '',
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
    this.state = createInitialState();
    this.load();
  },

  onShow() {
    if (!this.data.ready) return;
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
        // 旧汇总样例没有逐次尝试，也不参与新增流程。
        routeCompleted: false,
        routeClosed: false,
        canRecordAgain: false,
        routeStateText: '',
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
        attempts: attempts.map((attempt, index) => ({
          id: attempt.id,
          label: '第 ' + (index + 1) + ' 把',
          resultText: attemptResultText(attempt.result),
          timeText: timeText(attempt.createdAt),
          note: attempt.note || '',
          hasNote: Boolean(attempt.note)
        }))
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
            ? '这条抱石线路已完攀，只能回看，不能再新增把次。'
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
            ? '这条抱石线路已完攀，只能回看，本次选场未生效。'
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
