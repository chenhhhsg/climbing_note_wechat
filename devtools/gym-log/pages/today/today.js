/**
 * 今日攀爬 · 岩馆快速记录本地试用页
 *
 * 目标是在不接云端、不碰正式数据的前提下，走通：
 * 开始场次 → 按岩馆选线路（或快速新建）→ 连续记两把 → 给第二把补备注。
 *
 * 每次点结果先落一条待确认操作，再交给本地模拟保存端按操作 ID 幂等入账；
 * 保存中、回执丢失和重试都保留原条目，不会重复生成尝试。
 *
 * 场次、线路、尝试、待确认操作和当前选择都写入专用本地缓存键，
 * 重新进入页面时可以读回同一场次、线路、备注和待重试操作。
 */
const {
  GYMS,
  LEGACY_SUMMARY_SAMPLE,
  ROUTE_COLORS,
  GRADES,
  clone,
  formatLocalTime,
  todayLocalDate,
  isDateString,
  createInitialState,
  loadState,
  saveState
} = require('../../utils/store.js');
const trialSaveServer = require('../../utils/trial-save-server.js');

const TRIAL_BADGE = '本地试用 · 虚构数据';
const TRIAL_NOTE = '不连接云端，仅保存在本机';
// 模拟网络往返：让「保存中」在真机和开发者工具里都能被看到。
const DEFAULT_SAVE_DELAY_MS = 400;

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
    trialNote: TRIAL_NOTE,

    gyms: [],
    formGymIndex: 0,
    formGymName: '',
    formDate: '',
    sessionFormVisible: false,
    sessionFormTitle: '开始今日场次',
    formError: '',

    activeSession: null,
    sameDaySessions: [],
    allSessions: [],

    routes: [],
    selectedRoute: null,
    attempts: [],
    hasAttempts: false,
    attemptCountText: '0 把',
    routeCountText: '0 把',

    // 已点结果、但模拟保存端尚未确认的操作；与已保存尝试分开显示和计数。
    savingOpId: '',
    pendingAttempts: [],
    hasPending: false,
    pendingCountText: '',
    // 本场本线路还有待确认时，结果按钮锁定，避免把一次攀爬记成两个待确认。
    resultLocked: false,
    resultLockHint: '',
    saveNotice: '',

    // 弱网演练：只影响下一次保存，且只存在于本试用工程。
    faultInjectionArmed: false,
    faultInjectionError: '',

    quickRouteVisible: false,
    quickRouteName: '',
    quickRouteColors: [],
    quickRouteColorIndex: 0,
    quickRouteColorName: '',
    quickRouteGrades: [],
    quickRouteGradeIndex: 0,
    quickRouteGrade: 'V3',
    quickRouteError: '',

    noteEditor: null,

    legacySample: null
  },

  onLoad() {
    this._editingAttemptId = '';
    this._dispatching = {};
    this._pendingFailures = {};
    this._saveDelayMs = DEFAULT_SAVE_DELAY_MS;
    this._unloaded = false;
    this.state = createInitialState();
    this.setData({
      gyms: GYMS,
      legacySample: LEGACY_SUMMARY_SAMPLE,
      quickRouteColors: ROUTE_COLORS,
      quickRouteColorIndex: 0,
      quickRouteColorName: ROUTE_COLORS[0].name,
      quickRouteGrades: GRADES,
      quickRouteGradeIndex: GRADES.indexOf('V3'),
      quickRouteGrade: 'V3'
    });
    this.loadTrial();
  },

  /**
   * 页面已经卸载：之后到达的旧回执只代表请求在途，不能再把实例里的旧快照写回缓存。
   * 定时器不主动取消，正好用来验证“旧回执不覆盖新数据”。
   */
  onUnload() {
    this._unloaded = true;
  },

  /**
   * 从线路详情「今天再爬」返回时，缓存里的当前场次/线路已经变化。
   * 只有检测到外部变化才重新读取，避免冲掉今日页正在填写的表单；
   * 保存中不重读，避免把正在派发的操作覆盖掉。
   */
  onShow() {
    if (!this.data.ready) return;

    if (this.data.savingOpId) {
      this.refreshFaultInjection();
      return;
    }

    const loaded = loadState();
    if (loaded.error) {
      if (loaded.error !== this.data.loadError) this.loadTrial();
      return;
    }

    const current = this.state;
    const next = loaded.state;
    const changed =
      next.activeSessionId !== current.activeSessionId ||
      next.activeRouteId !== current.activeRouteId ||
      next.sessions.length !== current.sessions.length ||
      next.attempts.length !== current.attempts.length ||
      next.pendingSaves.length !== current.pendingSaves.length ||
      next.routes.length !== current.routes.length;

    if (changed) {
      this.loadTrial();
    } else {
      this.refreshFaultInjection();
    }
  },

  /**
   * 首次进入、重试读取和重新进入都走这里。
   * 空缓存正常显示开始场次表单；缓存损坏时只显示错误与重置入口。
   */
  loadTrial() {
    const loaded = loadState();
    this.state = loaded.state;
    this._editingAttemptId = '';
    this._pendingFailures = {};

    const active = findSession(this.state, this.state.activeSessionId);
    const gymIndex = active
      ? Math.max(0, GYMS.findIndex(gym => gym.id === active.gymId))
      : 0;
    const safeGymIndex = GYMS[gymIndex] ? gymIndex : 0;
    // 重新读缓存时仍在本实例派发中的操作要保留“保存中”，不能伪装成可重试。
    const inFlightOpId =
      Object.keys(this._dispatching).find(opId =>
        this.state.pendingSaves.some(op => op.opId === opId)
      ) || '';

    this.setData({
      ready: true,
      loadError: loaded.error,
      storageError: '',
      gyms: GYMS,
      formGymIndex: safeGymIndex,
      formGymName: GYMS[safeGymIndex].name,
      formDate: active ? active.date : todayLocalDate(),
      sessionFormVisible: !loaded.error && !active,
      sessionFormTitle: active ? '开始新场次' : '开始今日场次',
      formError: '',
      quickRouteVisible: false,
      quickRouteName: '',
      quickRouteError: '',
      quickRouteColorIndex: 0,
      quickRouteColorName: ROUTE_COLORS[0].name,
      quickRouteGradeIndex: GRADES.indexOf('V3'),
      quickRouteGrade: 'V3',
      savingOpId: inFlightOpId,
      saveNotice: '',
      noteEditor: null
    });
    this.refreshView();
    this.refreshFaultInjection();
  },

  retryLoad() {
    this.loadTrial();
  },

  /**
   * 从页面状态重新推导展示内容；不改动已保存的数据。
   */
  refreshView() {
    const state = this.state;
    const activeRaw = findSession(state, state.activeSessionId);
    let activeSession = null;
    let sameDaySessions = [];
    let routes = [];
    let selectedRoute = null;
    let attempts = [];
    let pendingAttempts = [];

    if (activeRaw) {
      activeSession = {
        id: activeRaw.id,
        gymId: activeRaw.gymId,
        date: activeRaw.date,
        dateText: activeRaw.date,
        gymName: gymName(activeRaw.gymId),
        label: sessionLabel(state, activeRaw)
      };

      sameDaySessions = state.sessions
        .filter(session => session.date === activeRaw.date)
        .sort((left, right) => left.seq - right.seq)
        .map(session => ({
          id: session.id,
          label: sessionLabel(state, session),
          gymName: gymName(session.gymId),
          isActive: session.id === activeRaw.id
        }));

      routes = state.routes
        .filter(route => route.gymId === activeRaw.gymId)
        .map(route => ({
          id: route.id,
          gymId: route.gymId,
          name: route.name,
          colorName: route.colorName,
          colorHex: route.colorHex,
          grade: route.grade,
          isSelected: route.id === state.activeRouteId
        }));

      selectedRoute =
        routes.find(route => route.id === state.activeRouteId) || null;

      if (selectedRoute) {
        const confirmed = state.attempts
          .filter(
            attempt =>
              attempt.sessionId === activeRaw.id &&
              attempt.routeId === selectedRoute.id
          )
          .sort((left, right) => left.seq - right.seq);
        const pending = state.pendingSaves
          .filter(
            op =>
              op.sessionId === activeRaw.id &&
              op.routeId === selectedRoute.id
          )
          .sort((left, right) => left.seq - right.seq);

        // 已保存与待确认共用尝试序号：重试后编号稳定，不会因失败跳号。
        const ordered = confirmed
          .map(item => ({ key: item.id, seq: item.seq }))
          .concat(pending.map(item => ({ key: item.opId, seq: item.seq })))
          .sort((left, right) => left.seq - right.seq);
        const labels = new Map(
          ordered.map((item, index) => [item.key, '第 ' + (index + 1) + ' 把'])
        );

        attempts = confirmed.map(attempt => ({
          id: attempt.id,
          label: labels.get(attempt.id),
          resultText: attemptResultText(attempt.result),
          timeText: timeText(attempt.createdAt),
          note: attempt.note || '',
          hasNote: Boolean(attempt.note)
        }));

        pendingAttempts = pending.map(op => {
          const isSaving =
            Boolean(this._dispatching[op.opId]) ||
            this.data.savingOpId === op.opId;
          const failure = this._pendingFailures[op.opId] || '';
          let statusText = '保存失败 · 已保留，点击重试';
          if (isSaving) {
            statusText = '保存中…';
          } else if (failure === 'receipt-lost') {
            statusText = '保存失败 · 回执丢失，已保留';
          }
          return {
            opId: op.opId,
            label: labels.get(op.opId),
            resultText: attemptResultText(op.result),
            timeText: timeText(op.createdAt),
            isSaving,
            statusText,
            canRetry: !isSaving
          };
        });
      }
    }

    const allSessions = state.sessions
      .slice()
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) || right.seq - left.seq
      )
      .map(session => ({
        id: session.id,
        gymName: gymName(session.gymId),
        dateText: session.date,
        label: sessionLabel(state, session),
        attemptCount: state.attempts.filter(
          attempt => attempt.sessionId === session.id
        ).length,
        isActive: session.id === state.activeSessionId
      }));

    let noteEditor = null;
    if (this._editingAttemptId && selectedRoute) {
      const editing = attempts.find(
        attempt => attempt.id === this._editingAttemptId
      );
      if (editing) {
        noteEditor = {
          attemptId: editing.id,
          routeName: selectedRoute.name,
          attemptLabel: editing.label,
          resultText: editing.resultText,
          text: editing.note
        };
      } else {
        this._editingAttemptId = '';
      }
    }

    const pendingCountText = pendingAttempts.length
      ? pendingAttempts.length + ' 把待确认'
      : '';
    const routeCountText = pendingAttempts.length
      ? attempts.length + ' 把 · ' + pendingCountText
      : attempts.length + ' 把';
    // 同一场次同一线路尚有保存中/回执丢失的操作时，不允许再派发新的一把。
    const resultLocked = pendingAttempts.length > 0;

    this.setData({
      activeSession,
      sameDaySessions,
      allSessions,
      routes,
      selectedRoute,
      attempts,
      pendingAttempts,
      hasAttempts: attempts.length > 0,
      hasPending: pendingAttempts.length > 0,
      attemptCountText: attempts.length + ' 把',
      pendingCountText,
      routeCountText,
      resultLocked,
      resultLockHint: resultLocked
        ? '上一把还没确认：先在待确认行点「重试保存」，确认后再记下一把'
        : '',
      noteEditor
    });
  },

  /**
   * 显式开始新场次默认本地今天，不沿用当前查看的历史场次日期；
   * 需要回放历史日期时仍在日期选择器里手动改。
   */
  openSessionForm() {
    const active = this.data.activeSession;
    const index = active
      ? Math.max(0, GYMS.findIndex(gym => gym.id === active.gymId))
      : 0;
    const safeIndex = GYMS[index] ? index : 0;

    this.setData({
      sessionFormVisible: true,
      sessionFormTitle: active ? '开始新场次' : '开始今日场次',
      formGymIndex: safeIndex,
      formGymName: GYMS[safeIndex].name,
      formDate: todayLocalDate(),
      formError: ''
    });
  },

  cancelSessionForm() {
    if (!this.data.activeSession) return;
    this.setData({ sessionFormVisible: false, formError: '' });
  },

  onGymChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const safeIndex = GYMS[index] ? index : 0;
    this.setData({
      formGymIndex: safeIndex,
      formGymName: GYMS[safeIndex].name,
      formError: ''
    });
  },

  onDateChange(event) {
    const value = (event && event.detail && event.detail.value) || '';
    this.setData({ formDate: value, formError: '' });
  },

  /**
   * 同一日期可以显式开始第二场；新场次立即成为当前归属。
   */
  startSession() {
    if (this.data.loadError) return;

    const gym = GYMS[this.data.formGymIndex];
    if (!gym) {
      this.setData({ formError: '请选择岩馆' });
      return;
    }
    if (!isDateString(this.data.formDate)) {
      this.setData({ formError: '请选择有效日期' });
      return;
    }

    const outcome = this.commitLatest(next => {
      const seq = next.nextSessionSeq;
      next.nextSessionSeq = seq + 1;
      const session = {
        id: 'session-' + seq,
        seq,
        gymId: gym.id,
        date: this.data.formDate,
        createdAt: new Date().toISOString()
      };
      next.sessions.push(session);
      next.activeSessionId = session.id;
      next.activeRouteId = '';
    });
    if (!outcome.ok) return;

    this._editingAttemptId = '';
    this.setData({
      sessionFormVisible: false,
      formError: '',
      quickRouteVisible: false,
      noteEditor: null
    });
    this.refreshView();
  },

  switchSession(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.sessionId;
    if (!id) return;
    if (this.data.activeSession && this.data.activeSession.id === id) return;

    const outcome = this.commitLatest(next => {
      if (!next.sessions.some(session => session.id === id)) return false;
      next.activeSessionId = id;
      next.activeRouteId = '';
    });
    if (!outcome.ok) {
      if (outcome.skipped) this.refreshView();
      return;
    }

    this._editingAttemptId = '';
    this.setData({
      noteEditor: null,
      quickRouteVisible: false
    });
    this.refreshView();
  },

  selectRoute(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!id || !this.data.activeSession) return;
    if (this.state.activeRouteId === id) return;

    const outcome = this.commitLatest(next => {
      const session = findSession(next, this.state.activeSessionId);
      if (!session) return false;
      const route = next.routes.find(
        item => item.id === id && item.gymId === session.gymId
      );
      if (!route) return false;
      next.activeSessionId = session.id;
      next.activeRouteId = id;
    });
    if (!outcome.ok) {
      if (outcome.skipped) this.refreshView();
      return;
    }

    this._editingAttemptId = '';
    this.setData({ noteEditor: null });
    this.refreshView();
  },

  /**
   * 线路详情按稳定 ID 打开；同色同级或同名的另一条线不会串记录。
   */
  openRouteDetail(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!id) return;
    if (!this.state.routes.some(route => route.id === id)) return;

    wx.navigateTo({
      url: '/pages/route-detail/route-detail?routeId=' + encodeURIComponent(id)
    });
  },

  /**
   * 旧汇总样例：虚构、只读，用于检查原始汇总的可读性，不参与逐次统计。
   */
  openLegacySample() {
    wx.navigateTo({
      url:
        '/pages/route-detail/route-detail?routeId=' +
        encodeURIComponent(LEGACY_SUMMARY_SAMPLE.id)
    });
  },

  /**
   * 每点一次结果只新建一个待确认操作（固定 opId），再交给本地模拟保存端。
   * 保存中或回执丢失时这一把留在待确认区，重试复用同一操作 ID。
   * 本场本线路还有待确认时不再生成新的操作，避免一次攀爬被记成两把。
   */
  recordAttempt(event) {
    if (this.data.loadError) return Promise.resolve();
    if (this._editingAttemptId) return Promise.resolve();

    const result =
      event && event.currentTarget && event.currentTarget.dataset.result;
    if (result !== 'fail' && result !== 'send') return Promise.resolve();

    // 以最新持久状态为准，避免本实例的旧序号与其他页面的新尝试相撞。
    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return Promise.resolve();
    }

    const current = loaded.state;
    const session = findSession(current, this.state.activeSessionId);
    if (!session) {
      this.state = current;
      this.refreshView();
      return Promise.resolve();
    }
    const route = current.routes.find(
      item => item.id === this.state.activeRouteId && item.gymId === session.gymId
    );
    if (!route) {
      this.state = current;
      this.refreshView();
      return Promise.resolve();
    }

    const blocking = current.pendingSaves.find(
      op => op.sessionId === session.id && op.routeId === route.id
    );
    if (blocking) {
      // 界面已禁用结果按钮；这里兜底方法调用，仍不生成第二个待确认。
      this.state = current;
      this.setData({
        saveNotice:
          '上一把还在保存或待确认：请先在待确认行点「重试保存」，确认后再记下一把。'
      });
      this.refreshView();
      return Promise.resolve();
    }

    const next = clone(current);
    const seq = next.nextAttemptSeq;
    next.nextAttemptSeq = seq + 1;
    const op = {
      opId: 'attempt-' + seq,
      seq,
      sessionId: session.id,
      routeId: route.id,
      result,
      note: '',
      createdAt: new Date().toISOString()
    };
    next.pendingSaves.push(op);
    next.activeSessionId = session.id;
    next.activeRouteId = route.id;

    // 先落盘待确认操作：即使随后保存失败或页面重进，也能按同一 ID 重试。
    if (!this.commit(next)) return Promise.resolve();

    this.setData({ saveNotice: '' });
    this.refreshView();
    return this.dispatchPending(op.opId);
  },

  /**
   * 同一 opId 在保存中只派发一次；重复点击该行不会产生第二个请求。
   * 回执可能晚于其他页面实例的写入，交付时只按 opId 合并，不写派发时的旧快照。
   */
  dispatchPending(opId) {
    if (!opId) return Promise.resolve();

    const op = this.state.pendingSaves.find(item => item.opId === opId);
    if (!op) {
      // 别的实例可能已经核销了这条待确认；重新读取后按已保存显示，
      // 不再对同一个操作 ID 发一次请求。
      const loaded = loadState();
      if (!loaded.error && !this._unloaded) {
        this.state = loaded.state;
        this.refreshView();
      }
      return Promise.resolve();
    }
    if (this._dispatching[opId]) return Promise.resolve();

    // 保存操作本身在派发时已经定稿；回执回来时即使本地记录已被别的实例改过，
    // 也只按这份操作数据补一条，不影响其他场次、备注和尝试。
    const opSnapshot = clone(op);

    this._dispatching[opId] = true;
    this.setData({ savingOpId: opId });
    this.refreshView();

    return new Promise(resolve => {
      const deliver = () => {
        let outcome;
        try {
          outcome = trialSaveServer.submitOperation({
            opId: opSnapshot.opId,
            sessionId: opSnapshot.sessionId,
            routeId: opSnapshot.routeId,
            result: opSnapshot.result,
            note: opSnapshot.note
          });
        } catch (error) {
          outcome = {
            ok: false,
            error:
              '模拟保存端异常：' +
              ((error && (error.message || error.errMsg)) || String(error))
          };
        }

        // 已卸载的旧实例只让在途请求走完，不向缓存写回任何旧快照。
        if (!this._unloaded) {
          this.finishDispatch(opId, outcome, opSnapshot);
        }

        delete this._dispatching[opId];
        if (!this._unloaded) {
          const remaining = Object.keys(this._dispatching).find(
            id => id !== opId
          );
          this.setData({ savingOpId: remaining || '' });
          this.refreshView();
          this.refreshFaultInjection();
        }
        resolve();
      };

      // 延迟只用于让「保存中」可见；测试可把 _saveDelayMs 设为 0。
      if (this._saveDelayMs > 0) {
        setTimeout(deliver, this._saveDelayMs);
      } else {
        deliver();
      }
    });
  },

  /**
   * 回执到达时先读最新持久状态，再只核销/合并这一个 opId：
   * - 成功：移除该待确认（若还在），补一条同 ID 尝试（若还没有）；
   * - 失败：不改动缓存，只保留该待确认并提示重试；
   * - 已被其他实例核销：只同步显示，不重复写入。
   * 新场次、备注、其他尝试和其他序号都不由本回调覆盖。
   */
  finishDispatch(opId, outcome, opSnapshot) {
    if (this._unloaded) return;

    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return;
    }

    const latest = loaded.state;
    const pending = latest.pendingSaves.find(item => item.opId === opId) || null;
    const confirmed = latest.attempts.find(item => item.id === opId) || null;

    if (outcome && outcome.ok) {
      // 另一个页面实例已经按同一操作 ID 核销：旧回执只同步显示。
      if (!pending && confirmed) {
        this.state = latest;
        delete this._pendingFailures[opId];
        this.setData({ saveNotice: '' });
        return;
      }

      const source = pending || opSnapshot;
      if (!source) {
        this.state = latest;
        this.setData({ saveNotice: '' });
        return;
      }

      // 重置试用数据后到达的旧回执：不把已经清掉的场次和尝试写回来。
      if (!findSession(latest, source.sessionId)) {
        this.state = latest;
        delete this._pendingFailures[opId];
        this.setData({ saveNotice: '' });
        return;
      }

      const next = clone(latest);
      next.pendingSaves = next.pendingSaves.filter(item => item.opId !== opId);

      // 保存端重复确认时，本地也只保留一条尝试。
      if (!next.attempts.some(item => item.id === opId)) {
        next.attempts.push({
          id: opId,
          seq: source.seq,
          sessionId: source.sessionId,
          routeId: source.routeId,
          result: source.result,
          note: source.note || '',
          createdAt: source.createdAt
        });
      }
      // 不回退其他实例已经推进的序号。
      const sourceSeq =
        Number.isInteger(source.seq) && source.seq > 0
          ? source.seq
          : next.nextAttemptSeq - 1;
      next.nextAttemptSeq = Math.max(next.nextAttemptSeq, sourceSeq + 1);
      delete this._pendingFailures[opId];

      // 账本已确认但本地写入失败：继续保留待确认，下次重试会得到重复确认。
      const saved = saveState(next);
      if (!saved.ok) {
        this.state = latest;
        this.setData({
          storageError: saved.error,
          saveNotice:
            '保存端已确认，但本地写入失败；这一把仍为待确认，可再次重试。'
        });
        return;
      }

      this.state = next;
      this.setData({ saveNotice: '', storageError: '' });
      return;
    }

    // 没拿到回执：持久状态不变，只按最新状态刷新本页面。
    this.state = latest;
    if (pending) {
      this._pendingFailures[opId] =
        outcome && outcome.receiptLost ? 'receipt-lost' : 'save-error';
      this.setData({
        saveNotice:
          outcome && outcome.receiptLost
            ? (outcome.error || '模拟回执丢失') +
              '。这一把保留为待确认，点击该行「重试保存」会复用同一操作 ID，不会重复入账。'
            : (outcome && outcome.error ? outcome.error : '模拟保存端返回失败') +
              '。这一把保留为待确认，可重试。'
      });
      return;
    }

    // 旧失败回执到达前，另一个实例已经确认成功：按成功状态显示，不报失败。
    delete this._pendingFailures[opId];
    this.setData({ saveNotice: '' });
  },

  /**
   * 失败行重试：沿用待确认操作里的 opId，保存端按该 ID 幂等。
   */
  retryPendingAttempt(event) {
    const opId =
      event && event.currentTarget && event.currentTarget.dataset.opId;
    if (!opId) return Promise.resolve();
    if (this.data.loadError) return Promise.resolve();
    return this.dispatchPending(opId);
  },

  /**
   * 弱网演练开关：只设置模拟保存端“下一次丢失回执”，不改变真实网络或正式页面。
   */
  toggleReceiptLossArm() {
    const result = this.data.faultInjectionArmed
      ? trialSaveServer.disarmReceiptLoss()
      : trialSaveServer.armReceiptLoss();
    if (!result.ok) {
      this.setData({ faultInjectionError: result.error });
      return;
    }
    this.refreshFaultInjection();
  },

  refreshFaultInjection() {
    const arm = trialSaveServer.readReceiptLossArm();
    this.setData({
      faultInjectionArmed: arm.armed,
      faultInjectionError: arm.error || ''
    });
  },

  dismissSaveNotice() {
    this.setData({ saveNotice: '' });
  },

  openNoteEditor(event) {
    const id =
      event && event.currentTarget && event.currentTarget.dataset.attemptId;
    if (!id || !this.data.selectedRoute) return;

    const attempt = this.data.attempts.find(item => item.id === id);
    if (!attempt) return;

    this._editingAttemptId = id;
    this.setData({
      noteEditor: {
        attemptId: attempt.id,
        routeName: this.data.selectedRoute.name,
        attemptLabel: attempt.label,
        resultText: attempt.resultText,
        text: attempt.note
      }
    });
  },

  onNoteInput(event) {
    const value = (event && event.detail && event.detail.value) || '';
    this.setData({ 'noteEditor.text': value });
  },

  saveNote() {
    const editor = this.data.noteEditor;
    if (!editor) return;

    const outcome = this.commitLatest(next => {
      const attempt = next.attempts.find(item => item.id === editor.attemptId);
      if (!attempt) return false;
      attempt.note = String(editor.text || '').trim();
    });

    if (!outcome.ok) {
      if (outcome.skipped) {
        // 尝试已经不在最新缓存里（例如被重置），关闭编辑界面而不是写回旧快照。
        this._editingAttemptId = '';
        this.setData({ noteEditor: null });
        this.refreshView();
      }
      return;
    }

    this._editingAttemptId = '';
    this.setData({ noteEditor: null });
    this.refreshView();
  },

  cancelNote() {
    this._editingAttemptId = '';
    this.setData({ noteEditor: null });
  },

  toggleQuickRoute() {
    const visible = !this.data.quickRouteVisible;
    this.setData({
      quickRouteVisible: visible,
      quickRouteError: '',
      quickRouteName: visible ? '' : this.data.quickRouteName
    });
  },

  onQuickRouteNameInput(event) {
    const value = (event && event.detail && event.detail.value) || '';
    this.setData({ quickRouteName: value, quickRouteError: '' });
  },

  onQuickRouteColorChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const safeIndex = ROUTE_COLORS[index] ? index : 0;
    this.setData({
      quickRouteColorIndex: safeIndex,
      quickRouteColorName: ROUTE_COLORS[safeIndex].name
    });
  },

  onQuickRouteGradeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const safeIndex = GRADES[index] ? index : 0;
    this.setData({
      quickRouteGradeIndex: safeIndex,
      quickRouteGrade: GRADES[safeIndex]
    });
  },

  /**
   * 快速新建的线路也使用固定 ID，之后按岩馆筛选和跨天回看都靠它。
   */
  createQuickRoute() {
    if (this.data.loadError) return;

    const name = String(this.data.quickRouteName || '').trim();
    if (!name) {
      this.setData({ quickRouteError: '请先给线路起个名字' });
      return;
    }

    const color =
      ROUTE_COLORS[this.data.quickRouteColorIndex] || ROUTE_COLORS[0];
    const grade = GRADES[this.data.quickRouteGradeIndex] || 'V3';

    const outcome = this.commitLatest(next => {
      const session = findSession(next, this.state.activeSessionId);
      if (!session) return false;
      const seq = next.nextRouteSeq;
      next.nextRouteSeq = seq + 1;
      const route = {
        id: 'route-local-' + seq,
        seq,
        gymId: session.gymId,
        name,
        colorName: color.name,
        colorHex: color.hex,
        grade,
        createdAt: new Date().toISOString()
      };
      next.routes.push(route);
      next.activeSessionId = session.id;
      next.activeRouteId = route.id;
    });

    if (!outcome.ok) {
      if (outcome.skipped) {
        this.setData({ quickRouteError: '请先开始场次' });
        this.refreshView();
      }
      return;
    }

    this._editingAttemptId = '';
    this.setData({
      quickRouteVisible: false,
      quickRouteName: '',
      quickRouteError: '',
      noteEditor: null
    });
    this.refreshView();
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  },

  resetTrialData() {
    if (this.data.savingOpId) {
      this.setData({ storageError: '保存进行中，请稍后再重置本地试用数据' });
      return;
    }

    // 客户端待确认操作与模拟账本一起清空，避免新序号撞上旧账本被当成重复操作。
    const ledgerReset = trialSaveServer.resetLedger();
    if (!ledgerReset.ok) {
      this.setData({ storageError: ledgerReset.error });
      return;
    }

    const next = createInitialState();
    if (!this.commit(next)) return;

    this._editingAttemptId = '';
    this._pendingFailures = {};
    this.setData({
      loadError: '',
      sessionFormVisible: true,
      sessionFormTitle: '开始今日场次',
      formGymIndex: 0,
      formGymName: GYMS[0].name,
      formDate: todayLocalDate(),
      formError: '',
      quickRouteVisible: false,
      quickRouteName: '',
      quickRouteError: '',
      savingOpId: '',
      saveNotice: '',
      faultInjectionError: '',
      noteEditor: null
    });
    this.refreshView();
    this.refreshFaultInjection();
  },

  /**
   * 先读最新持久状态，再只应用本次改动写回。
   * 页面进入时或派发时的快照可能已落后于其他页面实例，
   * 直接整份写回会覆盖别人的场次、备注或尝试。
   * mutator 返回 false 表示条件不成立，此时不写缓存。
   */
  commitLatest(mutator) {
    const loaded = loadState();
    if (loaded.error) {
      this.setData({ storageError: loaded.error });
      return { ok: false, state: null };
    }

    const next = clone(loaded.state);
    if (mutator(next) === false) {
      this.state = loaded.state;
      return { ok: false, state: loaded.state, skipped: true };
    }

    const saved = saveState(next);
    if (!saved.ok) {
      this.state = loaded.state;
      this.setData({ storageError: saved.error });
      return { ok: false, state: loaded.state };
    }

    this.state = next;
    this.setData({ storageError: '' });
    return { ok: true, state: next };
  },

  /**
   * 成功的保存会清掉旧错误；失败时保留原状态，用户重试同一操作即可。
   */
  commit(nextState) {
    const saved = saveState(nextState);
    if (!saved.ok) {
      this.setData({ storageError: saved.error });
      return false;
    }
    this.state = nextState;
    this.setData({ storageError: '' });
    return true;
  }
});
