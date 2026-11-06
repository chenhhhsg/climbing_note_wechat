/**
 * 今日攀爬 · 岩馆快速记录本地试用页
 *
 * 目标是在不接云端、不碰正式数据的前提下，走通：
 * 开始场次 → 按岩馆选线路（或快速新建）→ 连续记两把 → 给第二把补备注。
 *
 * 场次、线路、尝试和当前选择都写入专用本地缓存键，
 * 重新进入页面时可以读回同一场次、线路和备注。
 */
const {
  GYMS,
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

const TRIAL_BADGE = '本地试用 · 虚构数据';
const TRIAL_NOTE = '不连接云端，仅保存在本机';

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

    quickRouteVisible: false,
    quickRouteName: '',
    quickRouteColors: [],
    quickRouteColorIndex: 0,
    quickRouteColorName: '',
    quickRouteGrades: [],
    quickRouteGradeIndex: 0,
    quickRouteGrade: 'V3',
    quickRouteError: '',

    noteEditor: null
  },

  onLoad() {
    this._editingAttemptId = '';
    this.state = createInitialState();
    this.setData({
      gyms: GYMS,
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
   * 首次进入、重试读取和重新进入都走这里。
   * 空缓存正常显示开始场次表单；缓存损坏时只显示错误与重置入口。
   */
  loadTrial() {
    const loaded = loadState();
    this.state = loaded.state;
    this._editingAttemptId = '';

    const active = findSession(this.state, this.state.activeSessionId);
    const gymIndex = active
      ? Math.max(0, GYMS.findIndex(gym => gym.id === active.gymId))
      : 0;
    const safeGymIndex = GYMS[gymIndex] ? gymIndex : 0;

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
      noteEditor: null
    });
    this.refreshView();
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
        attempts = state.attempts
          .filter(
            attempt =>
              attempt.sessionId === activeRaw.id &&
              attempt.routeId === selectedRoute.id
          )
          .sort((left, right) => left.seq - right.seq)
          .map((attempt, index) => ({
            id: attempt.id,
            label: '第 ' + (index + 1) + ' 把',
            resultText: attemptResultText(attempt.result),
            timeText: timeText(attempt.createdAt),
            note: attempt.note || '',
            hasNote: Boolean(attempt.note)
          }));
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

    this.setData({
      activeSession,
      sameDaySessions,
      allSessions,
      routes,
      selectedRoute,
      attempts,
      hasAttempts: attempts.length > 0,
      attemptCountText: attempts.length + ' 把',
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

    const next = clone(this.state);
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

    if (!this.commit(next)) return;

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
    if (!findSession(this.state, id)) return;

    const next = clone(this.state);
    next.activeSessionId = id;
    next.activeRouteId = '';

    if (!this.commit(next)) return;

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

    const route = this.state.routes.find(
      item => item.id === id && item.gymId === this.data.activeSession.gymId
    );
    if (!route) return;

    const next = clone(this.state);
    next.activeRouteId = id;

    if (!this.commit(next)) return;

    this._editingAttemptId = '';
    this.setData({ noteEditor: null });
    this.refreshView();
  },

  /**
   * 每点一次结果只追加一次尝试；保存失败时页面不会出现这一把。
   */
  recordAttempt(event) {
    if (this.data.loadError) return;
    if (this._editingAttemptId) return;

    const result =
      event && event.currentTarget && event.currentTarget.dataset.result;
    if (result !== 'fail' && result !== 'send') return;

    const session = findSession(this.state, this.state.activeSessionId);
    if (!session) return;
    const route = this.state.routes.find(
      item => item.id === this.state.activeRouteId && item.gymId === session.gymId
    );
    if (!route) return;

    const next = clone(this.state);
    const seq = next.nextAttemptSeq;
    next.nextAttemptSeq = seq + 1;
    next.attempts.push({
      id: 'attempt-' + seq,
      seq,
      sessionId: session.id,
      routeId: route.id,
      result,
      note: '',
      createdAt: new Date().toISOString()
    });

    if (!this.commit(next)) return;
    this.refreshView();
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

    const next = clone(this.state);
    const attempt = next.attempts.find(item => item.id === editor.attemptId);
    if (!attempt) {
      this._editingAttemptId = '';
      this.setData({ noteEditor: null });
      this.refreshView();
      return;
    }

    attempt.note = String(editor.text || '').trim();

    if (!this.commit(next)) return;

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

    const session = findSession(this.state, this.state.activeSessionId);
    if (!session) {
      this.setData({ quickRouteError: '请先开始场次' });
      return;
    }

    const name = String(this.data.quickRouteName || '').trim();
    if (!name) {
      this.setData({ quickRouteError: '请先给线路起个名字' });
      return;
    }

    const color =
      ROUTE_COLORS[this.data.quickRouteColorIndex] || ROUTE_COLORS[0];
    const grade = GRADES[this.data.quickRouteGradeIndex] || 'V3';

    const next = clone(this.state);
    const seq = next.nextRouteSeq;
    next.nextRouteSeq = seq + 1;
    const route = {
      id: 'route-local-' + seq,
      gymId: session.gymId,
      name,
      colorName: color.name,
      colorHex: color.hex,
      grade,
      createdAt: new Date().toISOString()
    };
    next.routes.push(route);
    next.activeRouteId = route.id;

    if (!this.commit(next)) return;

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
    const next = createInitialState();
    if (!this.commit(next)) return;

    this._editingAttemptId = '';
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
      noteEditor: null
    });
    this.refreshView();
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
