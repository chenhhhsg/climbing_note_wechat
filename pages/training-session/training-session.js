/**
 * 正式场内页（T017 开场 / T030 首屏加线 / T036 入口收敛到单线页）
 *
 * 从首页「开始训练」或「继续本场」进入，走通一次真实到馆记录的前半段：
 * 填自己的岩馆开始场次（同日可主动另开）→ 选原线或新建抱石/顶绳/先锋线路。
 *
 * T036 把「记这一把」的写入、待提交、撤回／恢复、按把备注与按把更正搬到独立页：
 * - 整条本场线路点入 pages/training-record（单线记录，带 archiveId + sessionId + routeId），
 *   选已有线或新建成功也直达那条线；返回本场列表再点 B 就是换线；
 * - 逐把备注在 pages/training-attempts，照片/卡点/跨天历史在 pages/training-route；
 *   这三个目的地各自按原 ID 核对归属，本页不再保留第二套写入或长页详情。
 *
 * 数据层仍只用 T016 的正式本机档案 utils/training-store.js：
 * - 本页不接云、不引用试用工程，也不向旧 climbing_records 双写；
 * - 加线、关联与选线沿用档案层既有接口；加线面板打开与取消都不写盘；
 * - 每次返回本页都按最新档案重算线路行（本场有效把数与完攀状态），行读数与单线页一致。
 *
 * 本页的标识与状态：activeSession / routes / selectedRoute / gymRoutes / addRoute* /
 * newRoute*（类型、等级、颜色；照片改在资料页）/ routeSwitch*（列表展示）/ summaryEntry*。
 * 页面自己只保存展示状态与正在填写的表单，不承担数据权威。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const {
  CLIMB_TYPES,
  DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE,
  GRADE_PLACEHOLDER,
  climbTypeOf,
  gradesForType,
  isClimbType,
  isGradeForType,
  gradeText,
  resolveGradeForType
} = require('../../utils/training-rules.js');

const RECORD_URL = '/pages/training-record/training-record';

// 线路颜色：只用于本页展示与新建线路的可选属性，不是必填项。
const ROUTE_COLORS = [
  { name: '蓝色', hex: '#2f6fe4' },
  { name: '绿色', hex: '#2f9e44' },
  { name: '红色', hex: '#e03131' },
  { name: '黄色', hex: '#f0b400' },
  { name: '黑色', hex: '#212529' },
  { name: '白色', hex: '#dee2e6' },
  { name: '其他', hex: '#868e96' }
];

// 新建线路的一次提交在窗口内的第二次点击只提示、不再建线。
const SAME_TAP_WINDOW_MS = 300;

// 颜色是可选属性：没展开、没选过就是「不指定」，不替用户填一个没看到的颜色。
const UNSET_COLOR_TEXT = '不指定';
const COLOR_TOGGLE_CLOSED = '＋ 颜色（可选）';
const COLOR_TOGGLE_OPEN = '收起颜色';

/**
 * 新建线路表单的默认类型与等级：抱石 V3。
 * 默认等级必须属于默认类型，否则留空让用户重选，不静默取首个等级。
 */
function defaultNewRouteForm() {
  const grades = gradesForType(DEFAULT_CLIMB_TYPE);
  const gradeIndex = grades.indexOf(DEFAULT_GRADE);
  const grade = gradeIndex === -1 ? '' : grades[gradeIndex];
  return {
    newRouteTypeIndex: CLIMB_TYPES.indexOf(DEFAULT_CLIMB_TYPE),
    newRouteType: DEFAULT_CLIMB_TYPE,
    newRouteGrades: grades,
    newRouteGradeIndex: gradeIndex,
    newRouteGrade: grade,
    newRouteGradeText: gradeText(grade),
    newRouteColorIndex: -1,
    newRouteColorName: '',
    newRouteColorText: UNSET_COLOR_TEXT,
    newRouteColorVisible: false,
    newRouteColorToggleText: COLOR_TOGGLE_CLOSED
  };
}

/**
 * 本场线路列表的「近期」顺序（T031）：从本机档案只读推导，不建立第二套存储。
 * 一条线路在本场的近期程度取「本场最近一次把次时间」与「它在本场的关联时间」中较新者。
 */
function recentRouteIdsInSession(archive, sessionId, routes) {
  const lastAttemptAt = new Map();
  ((archive && archive.attempts) || []).forEach(attempt => {
    if (attempt.sessionId !== sessionId) return;
    const at = typeof attempt.createdAt === 'string' ? attempt.createdAt : '';
    if (!at) return;
    const current = lastAttemptAt.get(attempt.routeId) || '';
    if (at > current) lastAttemptAt.set(attempt.routeId, at);
  });
  const linkedAt = new Map();
  ((archive && archive.sessionRoutes) || []).forEach(link => {
    if (link.sessionId !== sessionId) return;
    linkedAt.set(link.routeId, typeof link.addedAt === 'string' ? link.addedAt : '');
  });

  return routes
    .map((route, index) => {
      const attemptAt = lastAttemptAt.get(route.id) || '';
      const linkAt = linkedAt.get(route.id) || '';
      return { id: route.id, at: attemptAt > linkAt ? attemptAt : linkAt, index };
    })
    .sort((left, right) => {
      if (left.at === right.at) return left.index - right.index;
      return left.at > right.at ? -1 : 1;
    })
    .map(entry => entry.id);
}

/**
 * 本场线路的短列表：1–3 条时直接列出全部；超过 3 条时只列当前线与最多两条近期线路，
 * 其余由「全部 N 条」展开。只排展示顺序；点任意一条都是打开那条线的单线记录。
 */
function routeSwitchShortList(routes, activeRouteId, recentIds) {
  if (routes.length <= 3) return routes.slice();
  const picked = [];
  const push = id => {
    if (!id || picked.some(route => route.id === id)) return;
    const route = routes.find(item => item.id === id);
    if (route) picked.push(route);
  };
  push(activeRouteId);
  (recentIds || []).forEach(id => {
    if (picked.length >= 3) return;
    push(id);
  });
  return picked;
}

Page({
  data: {
    ready: false,
    loadError: '',      // 本机档案损坏/版本不支持/读取失败的可见报错
    storageError: '',   // 本次操作未落盘（不报已保存）
    notice: '',         // 说明性提示（守卫、快速双击等），不改数据

    archiveId: '',

    // 场次表单
    sessionFormVisible: false,
    sessionFormTitle: '开始训练',
    gymName: '',
    sessionDate: '',
    formError: '',

    activeSession: null,
    sameDaySessions: [],

    // 本场线路：一行一条长期线路；整行点入单线记录
    routes: [],
    selectedRoute: null,

    // 结果按钮旁的短列表（T031）现在就是「本场线路」列表：1–3 条全列，更多时当前线 +
    // 最多两条近期线，其余由「全部 N 条」展开。N 就是本场关联数；展开只在本页。
    routeSwitchRows: [],
    routeSwitchAllRows: [],
    routeSwitchTotal: 0,
    routeSwitchHasMore: false,
    routeSwitchMoreText: '',
    routeSwitchExpanded: false,

    // 选原线 / 新建线路
    gymRoutes: [],
    // 加线面板（T030）：首屏「本场线路」旁打开，只有「本馆已有 / 新建线路」两个来源
    addRouteVisible: false,
    addRouteMode: 'existing',
    // 已有线关联成功但选中失败：保留可见的重试入口，界面不给出成功状态
    linkRetry: null,
    newRouteVisible: false,
    newRouteName: '',
    newRouteColors: ROUTE_COLORS,
    newRouteColorIndex: -1,
    newRouteColorName: '',
    newRouteColorText: UNSET_COLOR_TEXT,
    newRouteColorVisible: false,
    newRouteColorToggleText: COLOR_TOGGLE_CLOSED,
    newRouteTypes: CLIMB_TYPES,
    newRouteTypeIndex: 0,
    newRouteType: DEFAULT_CLIMB_TYPE,
    newRouteGrades: [],
    newRouteGradeIndex: -1,
    newRouteGrade: '',
    newRouteGradeText: '',
    newRouteError: '',

    // 本次小结入口（T034）：完整小结在独立页 pages/training-summary。
    summaryEntryReady: false,
    summaryEntrySessionId: '',
    summaryEntryLabel: '',
    summaryEntryHintText: '',
    summaryEntryViewingOther: false
  },

  onLoad(query) {
    // 本实例的临时状态，全部不落盘：
    // _formDirty / _newRouteDirty  正在填写的场次表单与新建线路表单（不冲掉输入）；
    // _lastCreateTap  快速重复点击「创建并选中」的窗口，避免连点建出两条线；
    // _summarySessionId  小结入口要打开哪一场（只读目标，不写盘）；空表示跟着当前场次。
    this._formDirty = false;
    this._newRouteDirty = false;
    this._lastCreateTap = 0;
    // ?sessionId=xxx：小结入口指向另一场（只读回看），不改当前场次。
    this._summarySessionId =
      (query && (query.sessionId || query.sessionid)) || '';
    // 首页「开始训练」带 ?start=1：直接展开场次表单。
    this._formOpen = Boolean(query && (query.start === '1' || query.start === 1));
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 正在填写的场次表单与新建线路表单都不重读重算，避免把输入冲掉；
    // 已经打开的加线面板也保持打开（返回本页不把用户刚打开的面板关掉）。
    const keepForm =
      (this._formDirty && this._formOpen) ||
      (this._newRouteDirty && this.data.newRouteVisible) ||
      this.data.addRouteVisible;
    this.loadPage({ keepForm });
  },

  /**
   * 从本机档案重新载入页面（首次进入、重试读取、返回本页都走这里）。
   * 档案损坏或版本不支持时只显示错误，不写盘、不覆盖原数据。
   */
  loadPage(options) {
    const keepForm = Boolean(options && options.keepForm);
    const loaded = store.loadState();
    this.archive = loaded.archive;

    const active = this.findSession(loaded.archive.activeSessionId);
    // 空档必须能建立场次；已经有当前场次时只有显式「开始新场次」才展开表单。
    if (!active && !loaded.error) this._formOpen = true;
    const formVisible = !loaded.error && this._formOpen;
    const form = defaultNewRouteForm();

    const gymName = active ? store.gymName(loaded.archive, active.gymId) : '';
    const date = store.todayLocalDate();
    if (!keepForm) this._newRouteDirty = false;

    this.setData({
      ready: true,
      archiveId: (loaded.archive && loaded.archive.archiveId) || '',
      loadError: loaded.error || '',
      storageError: '',
      notice: '',
      sessionFormVisible: formVisible,
      sessionFormTitle: active ? '开始新场次（同日另开）' : '开始训练',
      gymName: keepForm ? this.data.gymName : gymName,
      sessionDate: keepForm ? this.data.sessionDate : date,
      formError: keepForm ? this.data.formError : '',
      addRouteVisible: keepForm ? this.data.addRouteVisible : false,
      addRouteMode: keepForm ? this.data.addRouteMode : 'existing',
      newRouteVisible: keepForm ? this.data.newRouteVisible : false,
      newRouteName: keepForm ? this.data.newRouteName : '',
      newRouteColorIndex: keepForm ? this.data.newRouteColorIndex : form.newRouteColorIndex,
      newRouteColorName: keepForm ? this.data.newRouteColorName : form.newRouteColorName,
      newRouteColorText: keepForm ? this.data.newRouteColorText : form.newRouteColorText,
      newRouteColorVisible: keepForm ? this.data.newRouteColorVisible : form.newRouteColorVisible,
      newRouteColorToggleText: keepForm
        ? this.data.newRouteColorToggleText
        : form.newRouteColorToggleText,
      newRouteTypeIndex: keepForm ? this.data.newRouteTypeIndex : form.newRouteTypeIndex,
      newRouteType: keepForm ? this.data.newRouteType : form.newRouteType,
      newRouteGrades: keepForm ? this.data.newRouteGrades : form.newRouteGrades,
      newRouteGradeIndex: keepForm ? this.data.newRouteGradeIndex : form.newRouteGradeIndex,
      newRouteGrade: keepForm ? this.data.newRouteGrade : form.newRouteGrade,
      newRouteGradeText: keepForm ? this.data.newRouteGradeText : form.newRouteGradeText,
      newRouteError: keepForm ? this.data.newRouteError : ''
    });
    this.refreshView();
  },

  retryLoad() {
    this.loadPage({ keepForm: this._formDirty });
  },

  findSession(sessionId) {
    const archive = this.archive || store.loadState().archive;
    return (archive.sessions || []).find(item => item.id === sessionId) || null;
  },

  /**
   * 由当前档案重新推导展示内容；不改动任何已保存数据。
   */
  refreshView() {
    const archive = this.archive;
    const activeRaw = this.findSession(archive.activeSessionId);
    let activeSession = null;
    let sameDaySessions = [];
    let routes = [];
    let selectedRoute = null;
    let gymRoutes = [];

    if (activeRaw) {
      activeSession = {
        id: activeRaw.id,
        gymId: activeRaw.gymId,
        gymName: store.gymName(archive, activeRaw.gymId),
        dateText: activeRaw.date,
        label: store.sessionLabel(archive, activeRaw)
      };

      sameDaySessions = store.sessionsOnDate(archive, activeRaw.date).map(session => ({
        id: session.id,
        label: store.sessionLabel(archive, session),
        gymName: store.gymName(archive, session.gymId),
        isActive: session.id === activeRaw.id
      }));

      routes = store.routesForSession(archive, activeRaw.id).map(route => {
        const completion = store.routeCompletion(archive, route.id);
        const attemptCount = store.attemptsFor(archive, {
          sessionId: activeRaw.id,
          routeId: route.id
        }).length;
        return {
          id: route.id,
          name: route.name,
          // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写档案。
          climbType: climbTypeOf(route),
          grade: route.grade,
          colorName: route.colorName || '',
          colorHex: route.colorHex || '#dee2e6',
          isSelected: route.id === archive.activeRouteId,
          isCompleted: Boolean(completion.completed),
          isClosed: Boolean(completion.closed),
          completionText: actions.completionText(completion),
          attemptCount,
          attemptCountText: attemptCount + ' 把'
        };
      });

      selectedRoute = routes.find(route => route.id === archive.activeRouteId) || null;

      // 选原线：本岩馆里还没有进本场次的线路。
      const linkedIds = new Set(
        (archive.sessionRoutes || [])
          .filter(link => link.sessionId === activeRaw.id)
          .map(link => link.routeId)
      );
      gymRoutes = store
        .routesForGym(archive, activeRaw.gymId)
        .filter(route => !linkedIds.has(route.id))
        .map(route => ({
          id: route.id,
          name: route.name,
          climbType: climbTypeOf(route),
          grade: route.grade,
          colorName: route.colorName || ''
        }));
    }

    // 本场线路列表：只排展示顺序。「全部 N 条」计数就是本场关联数。
    const routeSwitchAllRows = routes.slice();
    const routeSwitchRows = routeSwitchShortList(
      routes,
      selectedRoute ? selectedRoute.id : '',
      recentRouteIdsInSession(archive, activeRaw ? activeRaw.id : '', routes)
    );

    this.setData({
      archiveId: (archive && archive.archiveId) || '',
      activeSession,
      sameDaySessions,
      routes,
      selectedRoute,
      routeSwitchRows,
      routeSwitchAllRows,
      routeSwitchTotal: routeSwitchAllRows.length,
      routeSwitchHasMore: routeSwitchAllRows.length > 3,
      routeSwitchMoreText: '全部 ' + routeSwitchAllRows.length + ' 条',
      gymRoutes
    });

    // 本次小结入口：只算入口目标与文案，不读清单、不算把数；完整小结在独立页。
    this.refreshSummaryEntry();
  },

  /**
   * 本次小结入口（T034，只读派生）：指向入口渲染时的场次（默认当前场次）。
   */
  refreshSummaryEntry() {
    const archive = this.archive;
    const activeId = (archive && archive.activeSessionId) || '';
    const targetId = this._summarySessionId || activeId;
    const session =
      ((archive && archive.sessions) || []).find(item => item.id === targetId) || null;

    if (!session) {
      this.setData({
        summaryEntryReady: false,
        summaryEntrySessionId: '',
        summaryEntryLabel: '',
        summaryEntryHintText: '',
        summaryEntryViewingOther: false
      });
      return;
    }

    this.setData({
      summaryEntryReady: true,
      summaryEntrySessionId: session.id,
      summaryEntryLabel:
        session.date +
        ' · ' +
        (store.gymName(archive, session.gymId) || '未知岩馆') +
        ' · ' +
        store.sessionLabel(archive, session),
      summaryEntryHintText: '只读回看这一场的线路、把数与完攀；不改当前场次。',
      summaryEntryViewingOther: Boolean(activeId) && session.id !== activeId
    });
  },

  /**
   * 打开本次小结（T034）：按入口渲染时的那一场与本机档案 ID 跳到独立小结页。
   * 只跳转，不选场次、不建场次、不写训练。
   */
  openSessionSummary() {
    if (this.data.loadError) return;
    const sessionId = this.data.summaryEntrySessionId;
    if (!sessionId) {
      this.setData({ notice: '还没有可看的场次，先开始一场训练。' });
      return;
    }
    const archiveId = this.archive && this.archive.archiveId;
    const params = ['sessionId=' + encodeURIComponent(sessionId)];
    if (archiveId) params.push('archiveId=' + encodeURIComponent(archiveId));
    wx.navigateTo({
      url: '/pages/training-summary/training-summary?' + params.join('&')
    });
  },

  // ---------------------------------------------------------------- 场次

  onGymNameInput(event) {
    this._formDirty = true;
    this.setData({
      gymName: (event && event.detail && event.detail.value) || '',
      formError: ''
    });
  },

  onSessionDateChange(event) {
    this._formDirty = true;
    this.setData({
      sessionDate: (event && event.detail && event.detail.value) || '',
      formError: ''
    });
  },

  /**
   * 显式开始新场次：日期默认回到本地今天，同日另开由用户明确发起。
   */
  openSessionForm() {
    if (this.data.loadError) return;
    const active = this.data.activeSession;
    this._formOpen = true;
    this._formDirty = false;
    this.setData({
      sessionFormVisible: true,
      sessionFormTitle: active ? '开始新场次（同日另开）' : '开始训练',
      gymName: active ? active.gymName : this.data.gymName,
      sessionDate: store.todayLocalDate(),
      formError: ''
    });
  },

  cancelSessionForm() {
    if (!this.data.activeSession) return;
    this._formOpen = false;
    this._formDirty = false;
    this.setData({ sessionFormVisible: false, formError: '' });
  },

  /**
   * 用自己输入的岩馆开始一场训练。落盘失败或档案损坏时不报成功，
   * 保留表单输入便于直接重试。
   */
  startSession() {
    if (this.data.loadError) return;
    const name = String(this.data.gymName || '').trim();
    if (!name) {
      this.setData({ formError: '请填写岩馆名称' });
      return;
    }
    if (!store.isDateString(this.data.sessionDate)) {
      this.setData({ formError: '请选择有效日期' });
      return;
    }

    const outcome = store.startSession({ gymName: name, date: this.data.sessionDate });
    if (!outcome.ok) {
      this.setData({ formError: '', storageError: outcome.error });
      this.loadPage({ keepForm: true });
      return;
    }

    this._formOpen = false;
    this._formDirty = false;
    // 开始新场次后小结回到新场次（清掉 ?sessionId= 的回看目标）。
    this._summarySessionId = '';
    this.loadPage();
  },

  /**
   * 同日场次切换：只改当前归属，不新建场次。
   */
  switchSession(event) {
    if (this.data.loadError) return;
    const sessionId = event && event.currentTarget && event.currentTarget.dataset.sessionId;
    if (!sessionId || sessionId === this.archive.activeSessionId) return;

    const outcome = store.selectSession(sessionId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      if (outcome.archive) this.archive = outcome.archive;
      this.refreshView();
      return;
    }
    this.archive = outcome.archive;
    // 用户自己切场次：小结跟着当前场次走，不再停留在 ?sessionId= 的回看目标上。
    this._summarySessionId = '';
    this.setData({ storageError: '', notice: '', routeSwitchExpanded: false });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 线路

  /**
   * 只改当前选中线路（不导航、不建线、不产生把次）。
   * 单线记录页使用入口自己的 routeId；这里保留选中用于列表高亮与资料页的「当前场次」。
   */
  selectRoute(event) {
    if (this.data.loadError) return { ok: false };
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId) return { ok: false };
    if (routeId === this.archive.activeRouteId) {
      // 点的就是当前线（例如在「全部 N 条」里点当前那一行）：只收起展示，不重复写盘。
      if (this.data.routeSwitchExpanded) this.setData({ routeSwitchExpanded: false });
      return { ok: true };
    }
    const outcome = store.selectRoute(routeId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      if (outcome.archive) this.archive = outcome.archive;
      this.refreshView();
      return outcome;
    }
    this.archive = outcome.archive;
    this.setData({ storageError: '', notice: '', linkRetry: null, routeSwitchExpanded: false });
    this.refreshView();
    return outcome;
  },

  /**
   * 本场线路入口（T036）：整行点入这条线的单线记录页。
   *
   * 点击带下来的归属（archiveId / sessionId / routeId）先与当前页核对：切场次或换档
   * 之后才送到的旧点击不打开页、也不改任何选择。选中与导航都成功才离开本页；
   * 选中落盘失败时留在列表上显示原因，可原地再点同一条重试。
   */
  openRecord(event) {
    if (this.data.loadError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId;
    if (!routeId) return;

    const active = this.data.activeSession;
    if (!active) {
      this.setData({ notice: '请先开始一场训练' });
      return;
    }
    const boundSessionId = dataset.sessionId || '';
    if (boundSessionId && boundSessionId !== active.id) {
      this.setData({ notice: '这一下是上一场列表的按钮，已经切到别的场次，没有打开。' });
      this.refreshView();
      return;
    }
    const boundArchiveId = dataset.archiveId || '';
    if (boundArchiveId && this.archive && boundArchiveId !== this.archive.archiveId) {
      this.setData({ notice: '这一下属于原来的本机档案，档案已经更换，没有打开。' });
      this.refreshView();
      return;
    }
    const route = this.data.routes.find(item => item.id === routeId);
    if (!route) {
      this.setData({ notice: '这条线路已经不在本场，已按最新档案刷新。' });
      this.loadPage({ keepForm: true });
      return;
    }

    if (routeId !== this.archive.activeRouteId) {
      const outcome = this.selectRoute(event);
      if (!outcome || !outcome.ok) return;
    }
    this.goToRecord(routeId);
  },

  /**
   * 打开一条线在本场的单线记录：带齐档案、场次与长期线路 ID。
   * 导航失败时留在本场列表，可再点同一行重试。
   */
  goToRecord(routeId) {
    const archiveId = this.archive && this.archive.archiveId;
    const sessionId = this.data.activeSession && this.data.activeSession.id;
    if (!archiveId || !sessionId || !routeId) {
      this.setData({ notice: '无法打开单线记录：缺少场次或线路归属，请从本场线路重试。' });
      return;
    }
    const url =
      RECORD_URL +
      '?archiveId=' +
      encodeURIComponent(archiveId) +
      '&sessionId=' +
      encodeURIComponent(sessionId) +
      '&routeId=' +
      encodeURIComponent(routeId);
    wx.navigateTo({
      url,
      fail: () => {
        this.setData({ notice: '单线记录页没有打开，请再点一次这条线路。' });
      }
    });
  },

  /**
   * 「全部 N 条」：把本场所有线路都列出来。只切本页展示，不选线路、不写盘。
   */
  expandRouteSwitch() {
    if (this.data.loadError) return;
    if (this.data.routeSwitchExpanded) return;
    this.setData({ routeSwitchExpanded: true });
  },

  /**
   * 收起全部线路列表，回到短列表。只切展示：当前线、把次与照片都不变。
   */
  closeRouteSwitch() {
    if (!this.data.routeSwitchExpanded) return;
    this.setData({ routeSwitchExpanded: false });
  },

  /**
   * 把加线面板的展示状态收回到关闭时的样子。只返回数据补丁，不写盘。
   */
  addRouteFormPatch() {
    const form = defaultNewRouteForm();
    const patch = {
      addRouteVisible: false,
      addRouteMode: 'existing',
      newRouteVisible: false,
      newRouteName: '',
      newRouteError: ''
    };
    Object.keys(form).forEach(key => {
      patch[key] = form[key];
    });
    return patch;
  },

  /**
   * 首屏加线入口：打开「本馆已有 / 新建线路」面板。打开面板本身不写盘，
   * 没开始场次时只提示，不改任何数据。
   */
  openAddRoute(event) {
    if (this.data.loadError) return;
    if (!this.data.activeSession) {
      this.setData({ notice: '请先开始一场训练' });
      return;
    }
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const wanted = dataset.mode;
    if (this.data.addRouteVisible) {
      if (wanted) this.switchAddRouteMode(event);
      return;
    }
    const mode =
      wanted === 'new' || wanted === 'existing'
        ? wanted
        : this.data.gymRoutes.length > 0
          ? 'existing'
          : 'new';
    this._newRouteDirty = false;
    this._lastCreateTap = 0;
    this.setData(
      Object.assign(this.addRouteFormPatch(), {
        addRouteVisible: true,
        addRouteMode: mode,
        newRouteVisible: mode === 'new'
      })
    );
  },

  /**
   * 取消加线：只收起面板并清掉未提交的输入，不写盘。
   */
  cancelAddRoute() {
    this._newRouteDirty = false;
    this.setData(this.addRouteFormPatch());
  },

  /**
   * 加线来源切换：本馆已有线路 / 新建线路。只换面板里显示哪一块。
   */
  switchAddRouteMode(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const mode = dataset.mode === 'new' ? 'new' : 'existing';
    if (mode === 'new') this._lastCreateTap = 0;
    this.setData({
      addRouteMode: mode,
      newRouteVisible: mode === 'new',
      newRouteError: ''
    });
  },

  /**
   * 选原线：把本岩馆已有的线路关联到当前场次并选中。
   * 关联本身幂等；关联成功后紧接着选中，两步都失败可原地重试，不会改动把次。
   */
  pickGymRoute(event) {
    if (this.data.loadError) return;
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    return this.resumeRouteInSession(routeId);
  },

  /**
   * 关联成功后选中失败的可见重试入口：按同一个 routeId 再走一次「关联 + 选中」。
   */
  retryLinkSelection(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId || (this.data.linkRetry && this.data.linkRetry.routeId);
    return this.resumeRouteInSession(routeId);
  },

  /**
   * 继续原线：把这条长期线路关联到当前场次并选中（关联幂等，重复点不新增关联）。
   *
   * T030：关联成功、选中失败时不报成功——不收起加线面板，而是把这条线写进
   * linkRetry，让首屏留着一个可点的「重试选中」入口；两步都成功才收起面板并
   * 直达这条线的单线记录（T036）。
   */
  resumeRouteInSession(routeId) {
    if (this.data.loadError) return;
    const active = this.data.activeSession;
    if (!routeId) return;
    if (!active) {
      this.setData({ notice: '请先开始一场训练' });
      return;
    }

    const linked = store.linkRouteToSession(active.id, routeId);
    if (!linked.ok) {
      if (linked.archive) this.archive = linked.archive;
      this.setData({ storageError: linked.error, linkRetry: null });
      this.refreshView();
      return;
    }

    const selected = store.selectRoute(routeId);
    this.archive = (selected.ok ? selected.archive : linked.archive) || this.archive;
    if (!selected.ok) {
      const route = ((this.archive && this.archive.routes) || []).find(
        item => item.id === routeId
      );
      this.setData({
        storageError: '',
        notice: '',
        linkRetry: {
          routeId,
          routeName: route ? route.name : '这条线路',
          error: selected.error
        }
      });
      this.refreshView();
      return;
    }
    this._newRouteDirty = false;
    this.setData(
      Object.assign(this.addRouteFormPatch(), {
        storageError: '',
        notice: '',
        linkRetry: null,
        routeSwitchExpanded: false
      })
    );
    this.refreshView();
    // 关联并选中成功：直达这条线的单线记录；返回本场列表后行读数已更新。
    this.goToRecord(routeId);
  },

  /**
   * 新建线路表单的开关（旧直接调用仍然可用）：打开即进入面板的「新建线路」来源，
   * 收起则整个面板收起。
   */
  toggleNewRouteForm() {
    const visible = !this.data.newRouteVisible;
    const form = defaultNewRouteForm();
    this._newRouteDirty = false;
    this._lastCreateTap = 0;
    if (!visible) {
      this.setData(this.addRouteFormPatch());
      return;
    }
    const patch = {
      addRouteVisible: true,
      addRouteMode: 'new',
      newRouteVisible: true,
      newRouteName: '',
      newRouteError: ''
    };
    Object.keys(form).forEach(key => {
      patch[key] = form[key];
    });
    this.setData(patch);
  },

  /**
   * 颜色是可选属性：默认收起，展开后才填写；收起时按「不指定」保存。
   */
  toggleNewRouteColor() {
    const visible = !this.data.newRouteColorVisible;
    this._newRouteDirty = true;
    this.setData({
      newRouteColorVisible: visible,
      newRouteColorToggleText: visible ? COLOR_TOGGLE_OPEN : COLOR_TOGGLE_CLOSED
    });
  },

  /**
   * 清除已选颜色，回到「不指定」：不替用户留一个他不想记的颜色。
   */
  clearNewRouteColor() {
    this._newRouteDirty = true;
    this.setData({
      newRouteColorIndex: -1,
      newRouteColorName: '',
      newRouteColorText: UNSET_COLOR_TEXT
    });
  },

  onNewRouteNameInput(event) {
    this._newRouteDirty = true;
    this.setData({
      newRouteName: (event && event.detail && event.detail.value) || '',
      newRouteError: ''
    });
  },

  /**
   * 切换攀岩类型立即重算等级选项：原等级在新类型里仍有效就保留，
   * 失效就清空并显示「请选择等级」，绝不静默落到首个等级。
   */
  onNewRouteTypeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    if (!CLIMB_TYPES[index]) return;

    const type = CLIMB_TYPES[index];
    const grades = gradesForType(type);
    const grade = resolveGradeForType(type, this.data.newRouteGrade);
    const gradeIndex = grade ? grades.indexOf(grade) : -1;

    this.setData({
      newRouteTypeIndex: index,
      newRouteType: type,
      newRouteGrades: grades,
      newRouteGradeIndex: gradeIndex,
      newRouteGrade: grade,
      newRouteGradeText: gradeText(grade),
      newRouteError: ''
    });
  },

  /**
   * 等级选择器只在当前类型的选项内生效；越界索引清空并要求重选。
   */
  onNewRouteGradeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const grades = this.data.newRouteGrades || [];
    if (!grades[index]) {
      this.setData({
        newRouteGradeIndex: -1,
        newRouteGrade: '',
        newRouteGradeText: GRADE_PLACEHOLDER,
        newRouteError: ''
      });
      return;
    }
    this.setData({
      newRouteGradeIndex: index,
      newRouteGrade: grades[index],
      newRouteGradeText: grades[index],
      newRouteError: ''
    });
  },

  onNewRouteColorChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const color = ROUTE_COLORS[index];
    this._newRouteDirty = true;
    if (!color) {
      this.setData({
        newRouteColorIndex: -1,
        newRouteColorName: '',
        newRouteColorText: UNSET_COLOR_TEXT
      });
      return;
    }
    this.setData({
      newRouteColorIndex: index,
      newRouteColorName: color.name,
      newRouteColorText: color.name
    });
  },

  /**
   * 新建线路并选中。类型与等级必须各自有效且相互匹配：空值、越界或错配都直接拒绝，
   * 不新建线路、不改当前线路，也不静默回落到首个等级。
   *
   * 颜色不是必填：收起或没选过就是「不指定」。线路创建成功并选中后直达这条线的
   * 单线记录（T036）；照片在资料页补，不在创建表单里写第二套文件/索引逻辑。
   */
  createRoute() {
    if (this.data.loadError) return;
    const active = this.data.activeSession;
    if (!active) {
      this.setData({ newRouteError: '请先开始一场训练' });
      return;
    }

    const name = String(this.data.newRouteName || '').trim();
    if (!name) {
      this.setData({ newRouteError: '请填写线路名称' });
      return;
    }
    const climbType = this.data.newRouteType;
    if (!isClimbType(climbType)) {
      this.setData({ newRouteError: '请选择攀岩类型' });
      return;
    }
    const grade = this.data.newRouteGrade;
    if (!grade) {
      this.setData({ newRouteError: GRADE_PLACEHOLDER });
      return;
    }
    if (!isGradeForType(climbType, grade)) {
      this.setData({
        newRouteError: '等级与攀岩类型不匹配，请重新选择' + GRADE_PLACEHOLDER
      });
      return;
    }

    // 按钮连点/双击不能建出两条线：窗口内的第二次提交直接忽略（不改任何数据）。
    const now = Date.now();
    if (this._lastCreateTap && now - this._lastCreateTap < SAME_TAP_WINDOW_MS) {
      this.setData({ notice: '刚提交过这条线路，落盘确认后再提交下一条。' });
      return;
    }
    this._lastCreateTap = now;

    const color = ROUTE_COLORS[this.data.newRouteColorIndex] || null;
    const outcome = store.createRoute({
      sessionId: active.id,
      name,
      climbType,
      grade,
      colorName: color ? color.name : '',
      colorHex: color ? color.hex : ''
    });
    if (!outcome.ok) {
      // 没落盘就不算提交过：用户可以立刻原地重试。
      this._lastCreateTap = 0;
      if (outcome.archive) this.archive = outcome.archive;
      this.setData({ newRouteError: outcome.error, storageError: '' });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    this._newRouteDirty = false;
    const createdId = outcome.route && outcome.route.id;
    this.setData(
      Object.assign(this.addRouteFormPatch(), {
        storageError: '',
        notice: '',
        linkRetry: null,
        routeSwitchExpanded: false
      })
    );
    this.refreshView();
    // 线路已创建并选中：直达这条线的单线记录；返回本场列表后行读数已更新。
    if (createdId) this.goToRecord(createdId);
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
