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
  saveState
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

function timeText(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '--:--' : formatLocalTime(date);
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
        routePhoto: null
      });
      return;
    }

    const route = state.routes.find(item => item.id === this._routeId);
    if (!route) {
      this.setData({ route: null, notFound: true, routePhoto: null });
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
