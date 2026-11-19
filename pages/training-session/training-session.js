/**
 * 正式场内页（T017 开场 / T030 首屏加线 / T036 入口收敛到单线页 / T037 统一线路列表）
 *
 * 从首页「开始训练」或「继续本场」进入，走通一次真实到馆记录的前半段：
 * 填自己的岩馆开始场次（同日可主动另开）→ 选原线或新建抱石/顶绳/先锋线路。
 *
 * T037 把首屏收敛成**一份**统一线路列表：本场每一条线各占一行（名称、等级、类型、
 * 本场有效把数与适用的文字状态），整行点入单线记录。空场是「添加第一条线路」，
 * 有线时标题行里有「＋ 加线」；0、1、4 条以上都是同一种行，不再有「近期短列表 +
 * 全部 N 条」的第二套换线区，页内也没有第二条列表。
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
 * 本页的标识与状态：activeSession / routes（统一列表行）/ selectedRoute / gymRoutes /
 * addRoute* / newRoute*（类型、等级、颜色；照片改在资料页）/ summaryEntry*。
 * 页面自己只保存展示状态与正在填写的表单，不承担数据权威。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const sessionDeleteActions = require('../../utils/training-session-delete-actions.js');
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

Page({
  data: {
    ready: false,
    loadError: '',      // 本机档案损坏/版本不支持/读取失败的可见报错
    storageError: '',   // 本次操作未落盘（不报已保存）
    notice: '',         // 说明性提示（守卫、快速双击等），不改数据

    // T053 本日场次按钮长按删除：与记录页共用同一流程；清理重试只作用于本档案。
    sessionDeleteBusy: false,
    sessionCleanupText: '',
    sessionCleanupVisible: false,

    archiveId: '',

    // 场次表单
    sessionFormVisible: false,
    sessionFormTitle: '开始训练',
    gymName: '',
    sessionDate: '',
    formError: '',

    activeSession: null,
    sameDaySessions: [],

    // 本场线路（T037 统一列表）：一行一条长期线路，整行点入单线记录。
    // 每行带名称、等级、类型、本场有效把数与适用的文字状态（完攀／完攀待确认）。
    routes: [],
    routeCountText: '',
    selectedRoute: null,

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
    // _openRecordTap  同一行快速连点的窗口，避免一次点击排出两个单线页；
    // _summarySessionId  小结入口要打开哪一场（只读目标，不写盘）；空表示跟着当前场次。
    // _displaySessionId 本页正在显示的那一场：首次载入钉在当时的当前场次，之后只由
    //   用户显式「开始新场次 / 切场次」改写。别处（另一页、同步回调）改了活动场次时，
    //   本页只刷新数据、不跟着换场次，返回本页仍显示原来那一场，也不写回活动场次。
    this._formDirty = false;
    this._newRouteDirty = false;
    this._lastCreateTap = 0;
    this._openRecordTap = null;
    this._displaySessionId = '';
    // ?sessionId=xxx：小结入口指向另一场（只读回看），不改当前场次。
    this._summarySessionId =
      (query && (query.sessionId || query.sessionid)) || '';
    // 首页「开始训练」带 ?start=1：直接展开场次表单。
    this._formOpen = Boolean(query && (query.start === '1' || query.start === 1));
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 回到本场（从单线记录或别的目的地返回）：上一次点击的窗口作废，同一行可以立刻再点。
    this._openRecordTap = null;
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

    // 显示目标：首次载入钉住当时的当前场次；原场次已经不在档案里（或本来就没有）
    // 时才退回最新活动场次。活动场次被别处改掉的返回不换掉本页显示的那一场。
    const latestActiveId = (loaded.archive && loaded.archive.activeSessionId) || '';
    if (!this._displaySessionId) this._displaySessionId = latestActiveId;
    if (this._displaySessionId && !this.findSession(this._displaySessionId)) {
      this._displaySessionId = latestActiveId;
    }

    const active = this.findSession(this._displaySessionId);
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
    // 本页显示的是钉住的那一场，不一定是档案里的活动场次：别处改了活动场次，
    // 这里仍按原场次列表渲染，直到用户显式开场或切场次。
    const displayId = this._displaySessionId || archive.activeSessionId;
    const activeRaw = this.findSession(displayId);
    const showingActive = Boolean(activeRaw) && activeRaw.id === archive.activeSessionId;
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

      // 统一列表的行：按本场关联顺序固定排列（store.routesForSession 的原顺序）。
      // 刻意不按「最近记过」重排——记完一把回到本场时，刚才点过的行必须还在原处，
      // 否则同一坐标会落到另一条线上。当前线用行上的选中态标出，不靠移动行位置。
      routes = store.routesForSession(archive, activeRaw.id).map(route => {
        const completion = store.routeCompletion(archive, route.id);
        const attemptCount = store.attemptsFor(archive, {
          sessionId: activeRaw.id,
          routeId: route.id
        }).length;
        const stateText = actions.completionText(completion);
        return {
          id: route.id,
          name: route.name,
          // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写档案。
          climbType: climbTypeOf(route),
          // 等级原样显示：抱石 V 级与顶绳/先锋 YDS 都按档案里的那一个写法，
          // 不用表单占位文案（空等级在列表里就是空，不假装「请选择等级」）。
          grade: route.grade || '',
          colorName: route.colorName || '',
          colorHex: route.colorHex || '#dee2e6',
          // 选中态只在「显示的就是活动场次」时才成立：活动场次已被别处改到另一场时，
          // 它的当前线路不属于本页这一场，不能在列表里冒充本场的选中线。
          isSelected: showingActive && route.id === archive.activeRouteId,
          isCompleted: Boolean(completion.completed),
          isClosed: Boolean(completion.closed),
          // 适用的文字状态：只在真的适用时才有字（已完攀 / 完攀待确认）。
          stateText,
          stateKind: stateText ? (completion.completed ? 'done' : 'pending') : '',
          attemptCount,
          attemptCountText: attemptCount + ' 把'
        };
      });

      selectedRoute = routes.find(route => route.isSelected) || null;

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

    this.setData({
      archiveId: (archive && archive.archiveId) || '',
      activeSession,
      sameDaySessions,
      routes,
      // 计数就是本场关联数：0 条时标题行不写数量（空态自己说「还没有线路」）。
      routeCountText: routes.length > 0 ? '本场 ' + routes.length + ' 条' : '',
      selectedRoute,
      gymRoutes
    });

    // 本次小结入口：只算入口目标与文案，不读清单、不算把数；完整小结在独立页。
    this.refreshSummaryEntry();
    // 已删场次的本机视频副本清理状态：只读 journal，不扫目录。
    this.refreshSessionCleanup();
  },

  /**
   * 本次小结入口（T034，只读派生）：指向本页正在显示的那一场（默认当前场次）。
   * 活动场次被别处改掉时，入口仍跟本页显示的原场次一致，不会跳到另一场小结。
   */
  refreshSummaryEntry() {
    const archive = this.archive;
    const displayId = (this.data.activeSession && this.data.activeSession.id) || '';
    const targetId = this._summarySessionId || displayId;
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
      summaryEntryViewingOther: Boolean(displayId) && session.id !== displayId
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
    // 显式开始新场次：本页显示目标跟着换到刚建立的这一场。
    this._displaySessionId = outcome.session.id;
    // 开始新场次后小结回到新场次（清掉 ?sessionId= 的回看目标）。
    this._summarySessionId = '';
    this.loadPage();
  },

  /**
   * 同日场次切换：只改当前归属，不新建场次。
   * 这是用户显式换场次：本页显示目标一并换到这一场（活动场次写入失败则仍留在原场）。
   */
  switchSession(event) {
    if (this.data.loadError) return;
    const sessionId = event && event.currentTarget && event.currentTarget.dataset.sessionId;
    // 长按这个按钮后基础库可能补一个 tap：同一原场次的补发不切场；
    // 菜单/确认取消后的下一次短按照常切换。
    if (sessionDeleteActions.consumeLongPressTap(this, sessionId)) return;
    if (!sessionId || sessionId === this._displaySessionId) return;

    const outcome = store.selectSession(sessionId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      if (outcome.archive) this.archive = outcome.archive;
      this.refreshView();
      return;
    }
    this.archive = outcome.archive;
    this._displaySessionId = sessionId;
    // 用户自己切场次：小结跟着当前场次走，不再停留在 ?sessionId= 的回看目标上。
    this._summarySessionId = '';
    // 列表已经换成另一场：上一次点击的窗口作废（同一条长期线路在另一场里是另一次点击）。
    this._openRecordTap = null;
    this.setData({ storageError: '', notice: '' });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 场次长按删除（T053）

  /**
   * T053 的页面适配：只提供可见状态与本页重读；确认、档案写入与视频清理都在
   * T052 协调器里，页面不另写一份存档或删文件。
   */
  sessionDeleteHost() {
    return {
      // 共用流程用页面实例做连续长按去重，而不是每次新建的适配对象。
      page: this,
      archiveId: () =>
        (this.archive && this.archive.archiveId) || this.data.archiveId || '',
      notify: (message, options) => {
        if (options && options.error) {
          this.setData({ storageError: message || '', notice: '' });
        } else {
          this.setData({ notice: message || '', storageError: '' });
        }
      },
      setBusy: busy => this.setData({ sessionDeleteBusy: Boolean(busy) }),
      setCleanup: status => {
        const value = status || {};
        this.setData({
          sessionCleanupText: value.text || '',
          sessionCleanupVisible: Boolean(value.pending > 0 || value.error)
        });
      },
      // 删除后本页重新载入：场次编号、当前场、本场线路与本次小结都从同一份档案重算。
      refresh: () => this.loadPage({ keepForm: true }),
      contextMatches: context =>
        Boolean(this.archive && this.archive.archiveId === context.archiveId),
      // 小结入口原本指向被删的这一场时，回到当前/接续场；不清理别的小结目标。
      afterDelete: context => {
        if (this._summarySessionId === context.sessionId) this._summarySessionId = '';
      }
    };
  },

  /**
   * 长按整个「本日场次」按钮（含按钮内空白）：身份只取同一个原生 view 的
   * data-archive-id 与 data-session-id。先记短按守卫，再交给共用流程；
   * 当日只有一场时按钮同样存在，长按照样可删。
   */
  requestDeleteSession(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const sessionId = dataset.sessionId || '';
    if (!sessionId) return Promise.resolve(null);
    sessionDeleteActions.markLongPress(this, sessionId);
    const row = (this.data.sameDaySessions || []).find(item => item.id === sessionId);
    return sessionDeleteActions.requestSessionDelete(this.sessionDeleteHost(), {
      archiveId:
        dataset.archiveId || (this.archive && this.archive.archiveId) || this.data.archiveId || '',
      sessionId,
      date: this.data.activeSession ? this.data.activeSession.dateText : '',
      gymName: row ? row.gymName : '',
      label: row ? row.label : ''
    });
  },

  /** 只读刷新本场次视频副本清理状态；不扫描目录、不改档案。 */
  refreshSessionCleanup() {
    return sessionDeleteActions.refreshSessionCleanup(this.sessionDeleteHost());
  },

  /** 可见重试：只按本档案恢复 T052 自己的场次清理 journal。 */
  retrySessionCleanup() {
    return sessionDeleteActions.retrySessionCleanup(this.sessionDeleteHost());
  },

  // ---------------------------------------------------------------- 线路

  /**
   * 显式往本页这一场里加线/选线之前，把档案的活动场次对齐到本页显示的那一场。
   *
   * 只有用户主动往列表里写数据时才对齐；单纯返回本页、看小结回来都不会写活动场次。
   * 写失败就留在本页显示原因，不加线也不改其他场次的当前线路。
   */
  adoptDisplayedSession() {
    if (this.isDisplayingActiveSession()) return true;
    const sessionId = this.data.activeSession && this.data.activeSession.id;
    if (!sessionId) return false;
    const outcome = store.selectSession(sessionId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error, notice: '' });
      if (outcome.archive) this.archive = outcome.archive;
      this.refreshView();
      return false;
    }
    this.archive = outcome.archive;
    return true;
  },

  /**
   * 本页显示的是不是档案里的活动场次。
   * 只有这种情况下才去写全局的「当前线路」；显示的是原场次而活动场次已被别处
   * 改到另一场时，选中/记一把都只认本页这一场，不改另一场的当前线路。
   */
  isDisplayingActiveSession() {
    const archive = this.archive;
    const displayId = (this.data.activeSession && this.data.activeSession.id) || this._displaySessionId;
    return Boolean(archive && displayId && archive.activeSessionId === displayId);
  },

  /**
   * 只改当前选中线路（不导航、不建线、不产生把次）。
   * 单线记录页使用入口自己的 routeId；这里保留选中用于列表行高亮与资料页的「当前场次」。
   */
  selectRoute(event) {
    if (this.data.loadError) return { ok: false };
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId) return { ok: false };
    // 显示原场次、活动场次已被别处换到另一场：只把点击当作「打开这一场的这条线」，
    // 不把另一场的当前线路改成本页的行；返回本页仍按原场次只读显示。
    if (!this.isDisplayingActiveSession()) return { ok: true };
    if (routeId === this.archive.activeRouteId) {
      // 点的就是当前线：不重复写盘（同一行的第二次点击也不再产生第二次选中）。
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
    this.setData({ storageError: '', notice: '', linkRetry: null });
    this.refreshView();
    return outcome;
  },

  /**
   * 本场线路入口（T036 统一列表的整行点击，T037 也只是这一条路径）：整行点入单线记录页。
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
      // 先按最新档案刷新，再写提示：loadPage 会重置本页说明文字，顺序反过来会被清掉。
      this.loadPage({ keepForm: true });
      this.setData({ notice: '这条线路已经不在本场，已按最新档案刷新。' });
      return;
    }

    if (routeId !== this.archive.activeRouteId) {
      const outcome = this.selectRoute(event);
      if (!outcome || !outcome.ok) return;
    }
    this.goToRecord(routeId);
  },

  /**
   * 打开一条线在本场的单线记录：带齐档案、场次与长期线路 ID（归属只来自入口自己）。
   *
   * 同一行的快速连点只走一次：这一次点击已经带着原 routeId 去开页了，窗口内的第二次
   * 不再发出第二个导航（也没机会再写一次选中）。导航失败会立刻把这个窗口作废，所以
   * 失败后可以马上点同一条重试；从单线页返回本场（onShow）也作废，回来就能再点。
   */
  goToRecord(routeId) {
    const archiveId = this.archive && this.archive.archiveId;
    const sessionId = this.data.activeSession && this.data.activeSession.id;
    if (!archiveId || !sessionId || !routeId) {
      this.setData({ notice: '无法打开单线记录：缺少场次或线路归属，请从本场线路重试。' });
      return;
    }
    const now = Date.now();
    const lastTap = this._openRecordTap;
    if (
      lastTap &&
      lastTap.routeId === routeId &&
      now - lastTap.at < SAME_TAP_WINDOW_MS
    ) {
      return;
    }
    this._openRecordTap = { routeId, at: now };

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
        // 没打开就不留窗口：同一行立刻可以再点一次重试。
        if (this._openRecordTap && this._openRecordTap.at === now) this._openRecordTap = null;
        this.setData({ notice: '单线记录页没有打开，请再点一次这条线路。' });
      }
    });
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

    // 用户主动选线：先把活动场次对齐到本页显示的那一场，关联与选中都落在这一场。
    if (!this.adoptDisplayedSession()) return;

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
        linkRetry: null
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

    // 用户主动往本场加线：先把活动场次对齐到本页显示的那一场，新线与选中都归这一场。
    if (!this.adoptDisplayedSession()) {
      this._lastCreateTap = 0;
      return;
    }

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
        linkRetry: null
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
