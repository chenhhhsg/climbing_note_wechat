/**
 * 今日攀爬 · 岩馆快速记录本地试用页
 *
 * 目标是在不接云端、不碰正式数据的前提下，走通：
 * 开始场次 → 按岩馆选线路（或快速新建）→ 连续记两把 → 给第二把补备注。
 *
 * 每次点结果先落一条待确认操作，再交给本地模拟保存端按操作 ID 幂等入账；
 * 保存中、回执丢失和重试都保留原条目，不会重复生成尝试。
 *
 * 抱石线路按「首次完攀」记录：一旦这条抱石线已完攀（确认或待确认），
 * 跨场次、跨页面、不同操作 ID 都不能再新增把次或待确认项；顶绳和先锋可重复完攀。
 * 判定复用 store.routeCompletion 与 route-rules 的同一份规则。
 *
 * 场次、线路、尝试、待确认操作和当前选择都写入专用本地缓存键，
 * 重新进入页面时可以读回同一场次、线路、备注和待重试操作。
 */
const {
  GYMS,
  LEGACY_SUMMARY_SAMPLE,
  ROUTE_COLORS,
  STORE_KEY,
  clone,
  formatLocalTime,
  todayLocalDate,
  isDateString,
  createInitialState,
  loadState,
  saveState,
  routeCompletion
} = require('../../utils/store.js');
const {
  CLIMB_TYPES,
  DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE,
  GRADE_PLACEHOLDER,
  climbTypeOf,
  gradesForType,
  isClimbType,
  isGradeForType,
  gradeText
} = require('../../utils/route-rules.js');
const trialSaveServer = require('../../utils/trial-save-server.js');
const {
  createPhotoController,
  buildView
} = require('../../utils/photo-controller.js');
const { nextTrialDatasetId } = require('../../utils/trial-profile.js');

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

/**
 * 线路上的完攀标记文案（T015）：判定来自 store.routeCompletion，
 * 今日页、历史选线与详情页显示同一份结果。
 * - 已确认完攀：抱石线只能回看；
 * - 完攀还在待确认：提示先处理原把次；
 * - 顶绳、先锋可重复完攀，不显示标记。
 */
function completionText(completion) {
  if (!completion || !completion.known) return '';
  if (completion.completed) return '已完攀';
  if (completion.hasPendingSend) return '完攀待确认';
  return '';
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '--:--' : formatLocalTime(date);
}

/**
 * 新建表单的默认类型与等级：抱石 V3。
 * 默认等级必须属于默认类型，否则宁可留空让用户重选，也不静默取首个等级。
 */
function defaultFormSelection() {
  const grades = gradesForType(DEFAULT_CLIMB_TYPE);
  const index = grades.indexOf(DEFAULT_GRADE);
  const grade = index === -1 ? '' : grades[index];
  return {
    typeIndex: CLIMB_TYPES.indexOf(DEFAULT_CLIMB_TYPE),
    type: DEFAULT_CLIMB_TYPE,
    grades,
    gradeIndex: index,
    grade,
    gradeText: gradeText(grade)
  };
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
    // 当前线路的完攀状态（复用 store.routeCompletion）：
    // 抱石首次完攀后 routeClosed 为真，全部新增入口关闭；T015 据此显示「已完攀」。
    routeCompleted: false,
    routeClosed: false,
    routeRepeatable: true,
    routeSendCount: 0,
    routeStateText: '',
    saveNotice: '',

    // 弱网演练：只影响下一次保存，且只存在于本试用工程。
    faultInjectionArmed: false,
    faultInjectionError: '',

    quickRouteVisible: false,
    quickRouteName: '',
    quickRouteColors: [],
    quickRouteColorIndex: 0,
    quickRouteColorName: '',
    // 攀岩类型在左、等级在右；等级选项随类型重算，失效时清空并要求重选。
    quickRouteTypes: [],
    quickRouteTypeIndex: 0,
    quickRouteType: DEFAULT_CLIMB_TYPE,
    quickRouteGrades: [],
    quickRouteGradeIndex: 0,
    quickRouteGrade: DEFAULT_GRADE,
    quickRouteGradeText: DEFAULT_GRADE,
    quickRouteError: '',

    noteEditor: null,

    // 线路照片：每条线路至多一张，可选；文件与关联都在本机。
    routePhoto: null,
    photoNotice: '',
    quickRoutePhoto: null,

    // 照片空间：实际文件占用、提醒线、管理入口与可重建缓存。
    photoSpace: null,
    photoSpaceExpanded: false,

    legacySample: null
  },

  onLoad(query) {
    this._editingAttemptId = '';
    this._dispatching = {};
    this._pendingFailures = {};
    this._saveDelayMs = DEFAULT_SAVE_DELAY_MS;
    this._unloaded = false;
    this._photoUi = null;
    this._baseRoutes = [];
    this._baseSelectedRoute = null;
    this._quickPhotoSource = '';
    // 从详情页容量失败入口返回时直接展开管理区。
    this._focusSpace = Boolean(query && query.manageSpace);
    this.state = createInitialState();
    const form = defaultFormSelection();
    this.setData({
      gyms: GYMS,
      legacySample: LEGACY_SUMMARY_SAMPLE,
      quickRouteColors: ROUTE_COLORS,
      quickRouteColorIndex: 0,
      quickRouteColorName: ROUTE_COLORS[0].name,
      quickRouteTypes: CLIMB_TYPES,
      quickRouteTypeIndex: form.typeIndex,
      quickRouteType: form.type,
      quickRouteGrades: form.grades,
      quickRouteGradeIndex: form.gradeIndex,
      quickRouteGrade: form.grade,
      quickRouteGradeText: form.gradeText
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
      this.refreshPhotos();
      this.refreshPhotoSpace();
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
      this.refreshPhotos();
      this.refreshPhotoSpace();
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
    this._quickPhotoSource = '';

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
    const formDefaults = defaultFormSelection();

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
      quickRouteTypes: CLIMB_TYPES,
      quickRouteTypeIndex: formDefaults.typeIndex,
      quickRouteType: formDefaults.type,
      quickRouteGrades: formDefaults.grades,
      quickRouteGradeIndex: formDefaults.gradeIndex,
      quickRouteGrade: formDefaults.grade,
      quickRouteGradeText: formDefaults.gradeText,
      savingOpId: inFlightOpId,
      saveNotice: '',
      photoNotice: '',
      quickRoutePhoto: null,
      photoSpace: null,
      noteEditor: null
    });
    this.refreshView();
    this.refreshFaultInjection();
    // 没有当前场次时既不展示线路照片，也不读取照片索引；
    // 开始/切换场次后再初始化服务，显示照片空间与线路照片状态。
    if (this.data.activeSession) {
      this._photoReady = this.initPhotoUi();
    } else {
      this._photoReady = Promise.resolve();
    }
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
        .map(route => {
          // 每条线路的完攀状态同样来自共用规则，历史列表与详情一致。
          const completion = routeCompletion(state, route.id);
          return {
            id: route.id,
            gymId: route.gymId,
            name: route.name,
            // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写缓存。
            climbType: climbTypeOf(route),
            colorName: route.colorName,
            colorHex: route.colorHex,
            grade: route.grade,
            isSelected: route.id === state.activeRouteId,
            isCompleted: Boolean(completion.completed),
            isClosed: Boolean(completion.closed),
            completionText: completionText(completion)
          };
        });

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

    // 当前线路的完攀状态：抱石首次完攀（含待确认）后关闭全部新增入口。
    const completion = selectedRoute
      ? routeCompletion(state, selectedRoute.id)
      : null;

    // 照片展示是叠加在尝试视图上的独立状态，不改变线路与尝试本身。
    this._baseRoutes = routes;
    this._baseSelectedRoute = selectedRoute;

    this.setData({
      activeSession,
      sameDaySessions,
      allSessions,
      routes: this.decorateRoutes(routes),
      selectedRoute: this.decorateRoute(selectedRoute),
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
      routeCompleted: Boolean(completion && completion.completed),
      routeClosed: Boolean(completion && completion.closed),
      routeRepeatable: !completion || completion.repeatable,
      routeSendCount: completion ? completion.sendCount : 0,
      routeStateText:
        completion && completion.completed
          ? '已完攀'
          : completion && completion.hasPendingSend
            ? '完攀待确认'
            : '',
      routePhoto: selectedRoute ? this.photoView(selectedRoute.id) : null,
      noteEditor
    });
  },

  /**
   * 照片服务在页面首次进入时初始化；恢复只执行一次，避免从详情页返回时
   * 中止另一个页面正在进行的照片保存。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createPhotoController(this, {
        onChange: () => {
          this.applyPhotoViews();
          this.applyPhotoSpace();
        },
        onNotice: text => this.setData({ photoNotice: text })
      });
    }
    this._photoUi.init(this.state.datasetId);
    return Promise.resolve(this.refreshPhotos())
      .then(() => this.refreshPhotoSpace())
      .then(() => {
        if (this._focusSpace) {
          this._focusSpace = false;
          this.setData({ photoSpaceExpanded: true });
        }
      });
  },

  /**
   * 只刷新当前场次可见线路的照片状态；照片读取是只读操作，不写场次/尝试缓存。
   */
  refreshPhotos() {
    if (!this._photoUi) return Promise.resolve();
    if (!this.data.activeSession) {
      this._photoUi.clear();
      this.applyPhotoViews();
      return Promise.resolve();
    }
    const routeIds = (this._baseRoutes || []).map(route => route.id);
    return this._photoUi.load(routeIds).then(() => this.applyPhotoViews());
  },

  photoView(routeId) {
    if (!this._photoUi || !routeId) return buildView(null, null);
    return this._photoUi.view(routeId);
  },

  decorateRoute(route) {
    if (!route) return null;
    const photo = this.photoView(route.id);
    return Object.assign({}, route, {
      photoThumb: photo.thumbnailPath || '',
      hasPhoto: Boolean(photo.hasPhoto),
      photoMissing: photo.status === 'missing',
      photoBusy: Boolean(photo.busy),
      photoButtonText: photo.listActionText
    });
  },

  decorateRoutes(routes) {
    return (routes || []).map(route => this.decorateRoute(route));
  },

  /**
   * 用控制器最新状态重绘线路与当前线路的照片区域。
   * 只覆盖照片字段，不重新读写场次、尝试或备注。
   */
  applyPhotoViews() {
    if (this._unloaded) return;
    this.setData({
      routes: this.decorateRoutes(this._baseRoutes),
      selectedRoute: this.decorateRoute(this._baseSelectedRoute),
      routePhoto: this._baseSelectedRoute
        ? this.photoView(this._baseSelectedRoute.id)
        : null
    });
  },

  dismissPhotoNotice() {
    this.setData({ photoNotice: '' });
  },

  /**
   * 照片空间卡片只展示实际受管文件计量结果；管理操作不放宽预算，
   * 也不把主图或照片索引当作普通缓存。
   */
  applyPhotoSpace() {
    if (this._unloaded || !this._photoUi) return;
    this.setData({ photoSpace: this._photoUi.spaceView() });
  },

  refreshPhotoSpace() {
    if (!this._photoUi) return Promise.resolve();
    return this._photoUi.refreshSpace().then(result => {
      this.applyPhotoSpace();
      return result;
    });
  },

  togglePhotoSpaceManage() {
    this.setData({ photoSpaceExpanded: !this.data.photoSpaceExpanded });
  },

  openPhotoSpaceManager() {
    this.setData({ photoSpaceExpanded: true });
    if (typeof wx !== 'undefined' && typeof wx.pageScrollTo === 'function') {
      try {
        wx.pageScrollTo({ selector: '#photo-space-card', duration: 300 });
      } catch (error) {
        // 滚动失败不影响管理入口展开。
      }
    }
  },

  clearPhotoCache() {
    if (!this._photoUi) return Promise.resolve(null);
    return this._photoUi.clearCache().then(result => {
      this.applyPhotoSpace();
      return result;
    });
  },

  rebuildPhotoThumbs() {
    if (!this._photoUi) return Promise.resolve(null);
    return this._photoUi.rebuildThumbs().then(result => {
      this.applyPhotoSpace();
      return result;
    });
  },

  cleanupPhotoOrphans() {
    if (!this._photoUi) return Promise.resolve(null);
    return this._photoUi.cleanupOrphans().then(result => {
      this.applyPhotoSpace();
      return result;
    });
  },

  /**
   * 当前线路拍照或从相册选图；选择后只做预览，确认后才保存。
   * 从「选线路」快速入口发起时先切到该线路，再打开同一条线路的照片操作。
   */
  chooseRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = detail.source;
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return Promise.resolve();
    if (source !== 'camera' && source !== 'album') {
      return Promise.resolve();
    }

    if (this.state.activeRouteId !== routeId) {
      this.selectRoute({ currentTarget: { dataset: { routeId } } });
      if (this.state.activeRouteId !== routeId) {
        this.setData({
          photoNotice: '请先在当前场次里选中这条线路，再添加照片'
        });
        return Promise.resolve();
      }
    }

    return this._photoUi.choose(routeId, source);
  },

  /**
   * 历史/选线路列表里的照片入口：先明确选中该线路，再让用户选择来源。
   */
  openRoutePhotoPicker(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = detail.routeId;
    if (!routeId) return;
    if (this._photoUi && this._photoUi.view(routeId).busy) {
      this.setData({ photoNotice: '这条线路的照片正在处理，请稍后再试' });
      return;
    }

    if (this.state.activeRouteId !== routeId) {
      this.selectRoute({ currentTarget: { dataset: { routeId } } });
      if (this.state.activeRouteId !== routeId) {
        this.setData({
          photoNotice: '请先在当前场次里选中这条线路，再添加照片'
        });
        return;
      }
    }

    if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') {
      this.setData({
        photoNotice: '已选中线路，可在「本场记录」里拍照或从相册添加照片'
      });
      return;
    }

    // 来源选择弹层也是异步的：先固定上下文，重置/切线后迟到的选择不再生效。
    const context = this._photoUi.captureContext();
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: result => {
        if (!this._photoUi || !this._photoUi.isContextCurrent(context)) return;
        const source = result && result.tapIndex === 0 ? 'camera' : 'album';
        this.chooseRoutePhoto({
          currentTarget: { dataset: { routeId, source } }
        });
      },
      fail: () => {
        // 取消来源选择时不改变任何照片或线路状态。
      }
    });
  },

  confirmRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.confirm(routeId);
  },

  cancelRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return;
    this._photoUi.cancelPreview(routeId);
  },

  retryRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.retry(routeId);
  },

  dismissRoutePhotoFailure(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return;
    this._photoUi.dismiss(routeId);
  },

  removeRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.remove(routeId);
  },

  previewRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return;
    this._photoUi.preview(routeId);
  },

  reloadRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId =
      detail.routeId ||
      (this._baseSelectedRoute && this._baseSelectedRoute.id) ||
      '';
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.load([routeId]);
  },

  /**
   * 新建线路可选一张照片：先在本机预览，创建成功后再保存；
   * 照片失败不回滚已创建的线路，也不影响随后记尝试。
   * 选择器是异步原生调用：先固定发起时的数据集/代次，期间发生重置就丢弃这次选择，
   * 避免旧选择被新数据集的新线路接收。
   */
  chooseQuickRoutePhoto(event) {
    const detail = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = detail.source;
    if (!this._photoUi || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    const context = this._photoUi.captureContext();
    return this._photoUi.pickFile(source).then(outcome => {
      if (!outcome.ok) {
        if (!outcome.cancelled) {
          const label = source === 'camera' ? '拍照' : '相册';
          this.setData({
            quickRouteError: outcome.permissionDenied
              ? '未获得' + label + '权限，可跳过照片或稍后添加'
              : '选择照片失败：' + outcome.error
          });
        }
        return outcome;
      }
      if (!this._photoUi.isContextCurrent(context)) {
        // 重置/切换后迟到的选择结果不再进入新建表单。
        return {
          ok: false,
          staleContext: true,
          cancelled: false,
          error: '试用数据已重置，已放弃这次选择'
        };
      }
      this._quickPhotoSource = outcome.path;
      this.setData({
        quickRoutePhoto: {
          path: outcome.path,
          statusText: '已选择照片，创建线路后保存到本机'
        },
        quickRouteError: ''
      });
      return outcome;
    });
  },

  cancelQuickRoutePhoto() {
    this._quickPhotoSource = '';
    this.setData({ quickRoutePhoto: null, quickRouteError: '' });
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
    return this.initPhotoUi();
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
    return this.initPhotoUi();
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
    return this.initPhotoUi();
  },

  /**
   * 线路列表项的用户入口（T015）：先按共用规则判定完攀状态。
   * - 已完攀的抱石线：历史项直达详情回看（逐把备注与照片），不进入新增流程，
   *   也不改动当前选线；
   * - 其余情况（含完攀待确认）仍按原逻辑选中该线路，待确认行留在本场原处可重试。
   * 直接调用 selectRoute 的行为不变，页面入口的差异只体现在这里。
   */
  onRouteTap(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!id || !this.data.activeSession) return;

    const completion = routeCompletion(this.state, id);
    if (completion.known && completion.completed) {
      return this.openRouteDetail({
        currentTarget: { dataset: { routeId: id } }
      });
    }
    if (this.state.activeRouteId === id) return;
    return this.selectRoute(event);
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

    // 抱石首次完攀后关闭全部新增入口：跨场次、跨页面、不同操作 ID 都不再新增把次。
    // 已确认完攀与仍在待确认的完攀都算封闭；顶绳和先锋可重复，不受此限。
    const completion = routeCompletion(current, route.id);
    if (completion.closed) {
      this.state = current;
      this.setData({
        saveNotice: completion.completed
          ? '这条抱石线路已完攀，只能回看，不能再记新的把次。'
          : '这条抱石线路的完攀还在待确认：请先在原把次上重试保存；确认后只能回看。'
      });
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
          // 只提交这一把操作本身：线路类型与归属由保存端按试用数据里的权威线路
          // 和当前上下文判定，页面不自带（可省略、可伪造的）声明。
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
   * - 这条线路已完攀或完攀还在待确认：撤销本条重复的待确认（见 settleConflictingPending）；
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

    // 保存端已有该抱石线路的完攀：不同操作 ID 也不能重复入账。
    // 这条待确认不再保留，按最新状态刷新并说明该线路已完攀。
    if (outcome && outcome.alreadySent) {
      return this.settleConflictingPending(
        latest,
        opId,
        '这条抱石线路已完攀（保存端已有记录），本条待确认已撤销，只能回看。'
      );
    }

    // 同一个抱石线路的完攀还在别处待确认：这条重复的待确认同样不留，
    // 让用户回到原把次重试，不把一次攀爬记成两条待确认。
    if (outcome && outcome.pendingSend) {
      return this.settleConflictingPending(
        latest,
        opId,
        '这条抱石线路的完攀仍在待确认：请先在原把次上重试保存，本条待确认已撤销。'
      );
    }

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
   * 保存端判定这条待确认与这条线路的完攀冲突（已完攀，或完攀还在别处待确认）：
   * 只撤销本条待确认，其他场次、备注、尝试和序号都不动。
   * 撤销本身写失败时保留该待确认并提示再试，不静默丢掉本地记录。
   */
  settleConflictingPending(latest, opId, notice) {
    const settled = clone(latest);
    settled.pendingSaves = settled.pendingSaves.filter(
      item => item.opId !== opId
    );
    delete this._pendingFailures[opId];

    const cleaned = saveState(settled);
    if (!cleaned.ok) {
      this.state = latest;
      this.setData({
        storageError: cleaned.error,
        saveNotice: notice + '本地撤销尚未写入，可再次重试保存。'
      });
      return;
    }

    this.state = settled;
    this.setData({ storageError: '', saveNotice: notice });
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

  /**
   * 切换攀岩类型立即重算等级选项：
   * 原等级在新类型里仍有效就保留（如顶绳 5.10a 切到先锋），
   * 失效就清空并显示「请选择等级」，绝不静默落到首个等级。
   * 颜色与已选照片属于当前表单，切换类型时不改动。
   */
  onQuickRouteTypeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    if (!CLIMB_TYPES[index]) return;

    const type = CLIMB_TYPES[index];
    const grades = gradesForType(type);
    const current = this.data.quickRouteGrade;
    const keep = isGradeForType(type, current);
    const grade = keep ? current : '';
    this.setData({
      quickRouteTypeIndex: index,
      quickRouteType: type,
      quickRouteGrades: grades,
      quickRouteGradeIndex: keep ? grades.indexOf(current) : -1,
      quickRouteGrade: grade,
      quickRouteGradeText: gradeText(grade),
      quickRouteError: ''
    });
  },

  /**
   * 等级选择器只在当前类型的选项范围内生效；
   * 越界索引不静默取首个等级，而是清空并提示重选。
   */
  onQuickRouteGradeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const grades = this.data.quickRouteGrades || [];
    if (!grades[index]) {
      this.setData({
        quickRouteGradeIndex: -1,
        quickRouteGrade: '',
        quickRouteGradeText: GRADE_PLACEHOLDER,
        quickRouteError: ''
      });
      return;
    }
    this.setData({
      quickRouteGradeIndex: index,
      quickRouteGrade: grades[index],
      quickRouteGradeText: grades[index],
      quickRouteError: ''
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

    // 类型与等级必须各自有效且相互匹配。空值、越界或错配都直接拒绝：
    // 不新建线路、不改当前线路、不动已选照片，也不静默回落到首个等级。
    const climbType = this.data.quickRouteType;
    if (!isClimbType(climbType)) {
      this.setData({ quickRouteError: '请选择攀岩类型' });
      return;
    }
    const grade = this.data.quickRouteGrade;
    if (!grade) {
      this.setData({ quickRouteError: GRADE_PLACEHOLDER });
      return;
    }
    if (!isGradeForType(climbType, grade)) {
      this.setData({
        quickRouteError: '等级与攀岩类型不匹配，请重新选择' + GRADE_PLACEHOLDER
      });
      return;
    }

    const color =
      ROUTE_COLORS[this.data.quickRouteColorIndex] || ROUTE_COLORS[0];

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
        climbType,
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
    const photoSource = this._quickPhotoSource;
    this._quickPhotoSource = '';
    this.setData({
      quickRouteVisible: false,
      quickRouteName: '',
      quickRouteError: '',
      quickRoutePhoto: null,
      noteEditor: null
    });
    this.refreshView();

    // 线路已创建并选中；照片失败只影响照片，不回滚线路，也不阻止记尝试。
    let photoSave = null;
    if (photoSource && this._photoUi) {
      const routeId = this.state.activeRouteId;
      this._photoUi.beginPreview(routeId, photoSource);
      photoSave = this._photoUi.confirm(routeId);
    }
    const refresh = this.refreshPhotos();
    return photoSave || refresh;
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  },

  resetTrialData() {
    if (this.data.savingOpId) {
      this.setData({ storageError: '保存进行中，请稍后再重置本地试用数据' });
      return Promise.resolve(false);
    }
    if (this._photoUi && this._photoUi.hasActiveOperation()) {
      this.setData({
        storageError: '照片正在保存或移除，请稍后再重置本地试用数据'
      });
      return Promise.resolve(false);
    }

    // 照片文件和线路关联属于用户资料：重置会丢掉关联，本轮先阻止并说明。
    // 普通清缓存与安全重置在 T012 单独实现，不能借重置静默清掉照片。
    // 没有当前场次时页面不主动加载照片，但重置前仍要初始化服务并核对索引。
    const prepared = this._photoUi
      ? Promise.resolve()
      : this.initPhotoUi();
    const check = prepared.then(() =>
      this._photoUi
        ? this._photoUi.countPhotos()
        : { ok: true, photos: [] }
    );

    return check.then(result => {
      if (!result || !result.ok) {
        this.setData({
          storageError:
            '照片索引不可用，为保护已保存照片暂不重置：' +
            ((result && result.error) || '未知错误')
        });
        return false;
      }
      const photos = result.photos || [];
      if (photos.length > 0) {
        // 有照片时必须明确确认；确认后轮换数据集，旧照片与索引保留在本机，
        // 但不会挂到重置后复用编号的新线路上。
        return this.confirmResetWithPhotos(photos.length).then(confirmed => {
          if (!confirmed) return false;
          const nextDatasetId = nextTrialDatasetId(this.state.datasetId);
          if (!this.applyTrialReset(nextDatasetId)) return false;
          this.setData({
            photoNotice:
              '试用数据已重置；原有 ' +
              photos.length +
              ' 张照片仍保留在本机旧数据集，不会挂到新线路上。'
          });
          return true;
        });
      }

      return this.applyTrialReset(this.state.datasetId);
    });
  },

  confirmResetWithPhotos(count) {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(false);
        return;
      }
      try {
        wx.showModal({
          title: '重置试用数据？',
          content:
            '本机已有 ' +
            count +
            ' 张线路照片。照片文件和关联索引属于用户资料；重置会清空场次、线路和尝试，' +
            '原有照片仍保留在本机旧数据集，但不会再挂到重置后新建的线路上。确定继续？',
          confirmText: '仍要重置',
          cancelText: '保留资料',
          success(result) {
            resolve(Boolean(result && result.confirm));
          },
          fail() {
            resolve(false);
          }
        });
      } catch (error) {
        resolve(false);
      }
    });
  },

  /**
   * 清空客户端场次/线路/尝试与模拟账本，并写入指定试用数据集。
   * 照片文件和照片索引不在这里删除；轮换数据集后旧关联自然不可见。
   * 账本先重置、客户端后写入；客户端写入失败时恢复原账本，原有资料保持不变。
   */
  applyTrialReset(datasetId) {
    let ledgerBefore = '';
    try {
      ledgerBefore = wx.getStorageSync(trialSaveServer.LEDGER_KEY) || '';
    } catch (error) {
      this.setData({
        storageError:
          '读取模拟保存账本失败，重置未执行：' +
          ((error && (error.errMsg || error.message)) || String(error))
      });
      return false;
    }

    // 客户端待确认操作与模拟账本一起清空，避免新序号撞上旧账本被当成重复操作。
    const ledgerReset = trialSaveServer.resetLedger();
    if (!ledgerReset.ok) {
      this.setData({ storageError: ledgerReset.error });
      return false;
    }

    const next = createInitialState();
    next.datasetId = datasetId || next.datasetId;
    if (!this.commit(next)) {
      // 客户端写入失败：原场次/尝试没有变化；把账本恢复到重置前，便于直接重试。
      const restored = trialSaveServer.restoreLedger(ledgerBefore);
      this.setData({
        storageError: restored.ok
          ? '重置未完成，原有资料与账本已保留，可重试。'
          : '重置未完成，原有资料保留；' + restored.error
      });
      return false;
    }

    this._editingAttemptId = '';
    this._pendingFailures = {};
    this._quickPhotoSource = '';
    const resetForm = defaultFormSelection();
    if (this._photoUi) {
      // 数据集变化时控制器会清空旧检索并创建新数据集的服务；
      // 相同数据集只重新读取，不删除照片。
      this._photoUi.init(next.datasetId);
    }
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
      quickRouteColorIndex: 0,
      quickRouteColorName: ROUTE_COLORS[0].name,
      quickRouteTypes: CLIMB_TYPES,
      quickRouteTypeIndex: resetForm.typeIndex,
      quickRouteType: resetForm.type,
      quickRouteGrades: resetForm.grades,
      quickRouteGradeIndex: resetForm.gradeIndex,
      quickRouteGrade: resetForm.grade,
      quickRouteGradeText: resetForm.gradeText,
      quickRoutePhoto: null,
      photoNotice: '',
      photoSpace: null,
      routePhoto: null,
      savingOpId: '',
      saveNotice: '',
      faultInjectionError: '',
      noteEditor: null
    });
    this.refreshView();
    this.refreshFaultInjection();
    this._photoReady = Promise.resolve(this.refreshPhotos())
      .then(() => this.refreshPhotoSpace());
    return true;
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
