/**
 * 正式场内记录页（T017 记把 / T019 主照片）
 *
 * 从首页「开始训练」或「继续本场」进入，走通一次真实到馆记录：
 * 填自己的岩馆开始场次（同日可主动另开）→ 选原线或新建抱石/顶绳/先锋线路 →
 * 逐把记录「未完成 / 完攀」→ 给某一把补备注 → 抱石误点完攀时按原把次
 * 「改为未完成」。
 *
 * 数据层只用 T016 的正式本机档案 utils/training-store.js：
 * - 本页不接云、不引用试用工程，也不向旧 climbing_records 双写；新增路径没有云调用，
 *   断网照常记录；
 * - 每一次写都是「档案层先读最新档案、再增量追加」，页面不把旧快照整体写回，
 *   因此两个页面实例的迟到操作与重复提交不会覆盖新数据；
 * - 落盘失败不报「已保存」：失败的这一把留在页面上提示未保存，重试沿用同一操作
 *   ID（opId），只提交一次；
 * - 抱石确认完攀后收起新增结果入口，只保留按把「改为未完成」；顶绳、先锋可继续记。
 *
 * T019 在本页加上线路主照片：新建线路时可在表单里先选一张照片（可选），线路创建
 * 成功后进入预览确认；当前线路也能在照片卡片里更换或移除。照片只动本机文件与正式
 * 照片索引，不写档案里的场次/把次/备注，也不回滚已创建的线路。
 *
 * T027 在本页加上「下次想爬」清单：当前岩馆收藏过的长期线路排在这里，带照片或无图
 * 状态、累计把数与最近一条非空备注；点开就是把那条长期线路关联到本场次并选中
 * （同一个线路 ID，不新建同名线路），直接续记。加入、撤下与拆线归档只改清单这一份
 * 独立记录（utils/training-wishlist.js），不动线路、照片、把次与备注。
 *
 * T029 在本页加上「本次小结」：离馆时按**本场**回看这一场爬了哪些线、共几把、哪些
 * 完攀（utils/training-session-summary.js），未完成的线可就地勾进本馆「下次想爬」，
 * 走的就是 T027 的那一套增删接口。小结只读训练记录：只算已提交把次，待保存、旧云汇总
 * 与自测成绩都不计入；打开、返回、重开本页都不会结束或新建场次。本页可以用
 * ?sessionId= 只读回看另一场，也可以直接在小结区的只读选择器里选日期 · 岩馆 · 第 N 场
 * （回看本身不改当前场次、不建场次、不写训练，也不会挤占上方首屏的结果按钮）。
 *
 * 页面自己只保存「展示用的当前状态」与本实例的临时信息（未落盘操作、已更正的只读
 * 回读行、快速双击窗口），不承担数据权威。
 *
 * T030 把「本场线路 · 加线」搬到首屏：空场首屏直接是「添加第一条线路」，有线时在
 * 「本场线路」旁常驻「＋ 加线」。加线面板只有两个来源——本馆已有线路（复用
 * resumeRouteInSession：同一个 routeId 关联进本场并选中，重复关联幂等）与新建线路
 * （复用 createRoute 与原类型/等级校验，名称、类型、等级在首层，颜色收起仍可创建）。
 * 关联成功而选中失败时页面不报成功，改在首屏保留可点的重试入口（linkRetry）；
 * 打开与取消面板都不写盘，取消后线路、关联与当前选择与打开前完全相同。
 *
 * T031 在结果按钮上方加上「换线」：不用滚回页顶的「本场线路」就能换线。1–3 条时直接列出
 * 本场全部线路；超过 3 条时只列当前线与最多两条不重复的近期线路，其余由「全部 N 条」展开。
 * 短列表与全集都只用本场关联（store.routesForSession）派生的同一个 routeId 数组，点线路名
 * 走的就是原来那一个 selectRoute：只改当前选择，不新建线路、不加关联、不产生把次；「全部 N
 * 条」按真实本场关联计数，别的场次独有的线路不会出现。展开/收起只切本页展示，不改当前线，
 * 返回后仍在结果按钮旁原地记结果。
 *
 * T032 让本页的把数、逐把列表、完攀状态与「第 N 把」编号都按**有效把次**（未撤回的那些）
 * 计算：撤回一把后本场把数与逐把列表同步减一，恢复后回到原位置，与其他读数端同一口径。
 * 撤回/恢复的按钮与操作区域由 T033 接在这份读数上，本页本身不新增第二套存储。
 *
 * T033 把 T032 的撤回与恢复接进场内：结果按钮下方常驻一段「最近一把」，写明当前场次、
 * 当前线路最新那一把的线路名、原序号（按序号排位、含已撤回的把次，因此不跳号）与结果，
 * 并给出撤回动作。目标只认这一行渲染时带下来的原把次 ID 与归属，不看行下标、名称、
 * 当前可见行或按钮文字，去掉一行也不会改到别的把次。
 * 撤回后这一行留在原处变成「已撤回」，撤回按钮的位置留空（行高不变），因此刚才点过的
 * 坐标既不会被另一把接管，也不会被相反动作接管；「恢复这一把」落在下方独立一行里，
 * 须有意点击。撤回/恢复沿用档案层 T032 的持久凭据（原把次 ID + opId + 预期状态）与
 * 两段写重试，不靠计时防抖：失败时显示失败、按原动作与同一个 opId 重试，页面上的把数、
 * 完攀状态与逐把列表只按**已落盘**的档案显示。这条线还有未落盘的把次时整个操作区收起，
 * 待保存的一把不当作已保存可撤回项。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
const { buildSessionSummary } = require('../../utils/training-session-summary.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');
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

const PROFILE_URL = '/pages/profile/profile';

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

// 「同一把按钮的同一结果」在窗口内重复点击视为一次误触：真实一次攀爬不会在
// 几百毫秒内发生两次，记两把之间必然隔着一次攀爬和一次落盘。
const SAME_TAP_WINDOW_MS = 300;

// 主操作区滚入视口（T030 复验）：把结果区顶部对齐到视口下方留一点余量的位置。
// 这里只是一个「对齐到哪」的偏移量，真正滚到哪由真实布局接口现量（见 revealElement），
// 不凭换线面板里的旧坐标或固定像素算位置。
const REVEAL_TOP_OFFSET = 12;
// 主操作区看的「门」：换线 + 结果按钮这一块。它已经完整可见就不滚（用户不必被抖一下）。
const MAIN_OPERATION_GATE = '#result-anchor';
// 主操作区滚的「位」：本场线路（加线）到结果这一整段的顶端。滚到这里，加线、换线、
// 结果同时落在首屏里，不会为了露出结果按钮把「＋ 加线」挤到屏幕上方之外。
const MAIN_OPERATION_ANCHOR = '#session-routes';
// 场次表单锚点：表单常驻在页顶，从页面下方点「开始新场次」时要把表单滚回可见处，
// 否则表单渲染在当前滚动位置之上，用户看不到自己刚打开的输入框。
const SESSION_FORM_ANCHOR = '#session-form';

// 颜色是可选属性：没展开、没选过就是「不指定」，不替用户填一个没看到的颜色。
const UNSET_COLOR_TEXT = '不指定';
const COLOR_TOGGLE_CLOSED = '＋ 颜色（可选）';
const COLOR_TOGGLE_OPEN = '收起颜色';

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function attemptResultText(result) {
  return result === 'send' ? '完攀' : '未完成';
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * 线路上的完攀状态文案：已确认完攀与「完攀待确认」分开显示。
 * 判定来自档案层 routeCompletion，场内页与首页、历史页共用同一份结果。
 */
function completionText(completion) {
  if (!completion || !completion.known) return '';
  if (completion.completed) return '已完攀';
  if (completion.closed) return '完攀待确认';
  return '';
}

/**
 * 新建线路表单的默认类型与等级：抱石 V3。
 * 默认等级必须属于默认类型，否则留空让用户重选，不静默取首个等级。
 *
 * 颜色（T030）不设默认值：它是可选属性，收起时按「不指定」保存，
 * 不替用户记一个他没看过的颜色；展开后才按所选颜色落盘。
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
 * 结果按钮旁换线的「近期」顺序（T031）：从本机档案只读推导，不建立第二套存储。
 *
 * 一条线路在本场的近期程度取「本场最近一次把次时间」与「它在本场的关联时间」中较新者；
 * 两者都取不到的线路排最后。返回的是线路 ID，从最近到最远。
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
 * 结果按钮旁的短列表（T031）：1–3 条时按本场顺序直接列出全部线路；
 * 超过 3 条时只列当前线与最多两条不重复的近期线路，其余交给「全部 N 条」。
 *
 * 只排展示用的顺序，不改 routes、不写盘；选中的是原来的 routeId，
 * 因此换线不会新建线路、不会多出关联，也不产生把次。
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

/**
 * 「第 N 把」：同一场次同一线路内按把次序号排出的**稳定原序号**。
 * 已保存（含已撤回的那一把）与仍待确认的把次共用序号，因此重试后编号稳定，不会因为
 * 补齐而跳号；撤回一把后序号也不整体前移——撤回第 3 把之后再记的一把是第 4 把，原来
 * 的第 3 把还是第 3 把（判定只有档案层那一份 attemptOrdinalMap，不拿全局 seq 当编号）。
 */
function attemptLabelMap(archive, sessionId, routeId) {
  const ordinals = store.attemptOrdinalMap(archive, sessionId, routeId, { includePending: true });
  const labels = new Map();
  ordinals.forEach((value, key) => labels.set(key, '第 ' + value + ' 把'));
  return labels;
}

/**
 * 结果按钮下方「最近一把」的目标（T033）：当前场次、当前线路里序号最大的一把
 * **已提交**把次——连已撤回的那一把一起看，撤回后这一行留在原处，恢复入口就落在
 * 原来那一把上，不会被悄悄换成前一把。
 *
 * 返回 { attempt, number }：attempt 是原把次；number 是它的**原序号**（按序号在本场
 * 本线路里排位，含已撤回的把次），撤回前后都是同一个数，因此「第 3 把」在撤回后
 * 不会变成「第 2 把」。没有已提交把次时返回 null。
 * 只读派生：不看行下标、名称与当前可见行，也不把档案里「待保存」的那一条算进来
 * （待保存的一把还没落盘，不是可撤回项）。
 */
function recentAttemptTarget(archive, sessionId, routeId) {
  if (!sessionId || !routeId) return null;
  const ordered = store.attemptsFor(archive, {
    sessionId,
    routeId,
    includeUndone: true
  });
  if (!ordered.length) return null;
  const attempt = ordered[ordered.length - 1];
  // number 用档案层的稳定原序号（撤回也占位），不是这一份可见列表的下标。
  const ordinals = store.attemptOrdinalMap(archive, sessionId, routeId);
  return { attempt, number: ordinals.get(attempt.id) || ordered.length };
}

/**
 * 这条线在这一场次里是否还有未落盘的把次（档案里的「进行中」标记）。
 * 有的话最近一把的撤回区先收起：待保存的一把不是已保存可撤回项，也不把上一条
 * 已保存的把次留在这里等着被误撤。
 */
function hasPendingOnRoute(archive, sessionId, routeId) {
  if (!sessionId || !routeId) return false;
  return ((archive && archive.pendingSaves) || []).some(
    op => op.sessionId === sessionId && op.routeId === routeId
  );
}

Page({
  data: {
    ready: false,
    loadError: '',      // 本机档案损坏/版本不支持/读取失败的可见报错
    storageError: '',   // 本次操作未落盘（不报已保存）
    notice: '',         // 说明性提示（守卫、快速双击等），不改数据

    // 场次表单
    sessionFormVisible: false,
    sessionFormTitle: '开始训练',
    gymName: '',
    sessionDate: '',
    formError: '',

    activeSession: null,
    sameDaySessions: [],

    // 本场记录
    routes: [],
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

    // 结果按钮旁换线（T031）：短列表（1–3 条全列，更多时当前线 + 两条近期线）、
    // 展开后的全集与「全部 N 条」。N 就是本场关联数；展开状态只在本页，不落盘。
    routeSwitchRows: [],
    routeSwitchAllRows: [],
    routeSwitchTotal: 0,
    routeSwitchHasMore: false,
    routeSwitchMoreText: '',
    routeSwitchExpanded: false,

    // 按把「改为未完成」：每一把各有自己的控件
    correctionRows: [],
    correctionStatusText: '',

    // 最近一把的撤回与恢复（T033）：结果按钮下方的固定操作区。null 表示不显示
    // （没有已提交把次、这条线还有未落盘的把次，或没有当前线路）。
    recentAttempt: null,

    noteEditor: null,

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

    // 线路主照片（T019）：新建表单里先选的一张，与当前线路的已保存照片
    newRoutePhoto: null,
    routePhoto: null,
    photoNotice: '',

    // 下次想爬（T027）：本馆清单按想爬/已完成/已归档分组，照片按 routeId 推导
    wishlistReady: false,
    wishlistError: '',
    wishlistWanted: [],
    wishlistCompleted: [],
    wishlistArchived: [],
    wishlistCountText: '',
    hasWishlist: false,
    // 当前选中线路在清单里的状态（加入/撤下/归档入口）
    selectedWishlist: null,

    // 本次小结（T029）：按原 sessionId 回看本场已提交把次、去重线路与完攀线路。
    // 勾选状态一律取清单的实际存储，写失败时显示的也是实际保存状态。
    summaryRows: [],
    summaryReady: false,
    summaryError: '',
    summarySessionId: '',
    summaryGymId: '',
    summaryGymName: '',
    summaryDate: '',
    summaryLabel: '',
    summaryViewingOther: false,
    summaryCountText: '',
    summarySendText: '',
    summaryPendingText: '',
    summaryWishlistError: '',
    summaryHintText: '',
    summaryEmpty: true,
    hasSummaryRows: false,
    // 小结内的只读回看入口（T029）：日期 · 岩馆 · 场次序号，选择只换所看的小结。
    summarySessionOptions: [],
    summarySessionPickerVisible: false,
    summarySessionIndex: -1,
    summarySessionValue: ''
  },

  onLoad(query) {
    // 本实例的临时状态，全部不落盘：
    // _failedOps  本实例发起但未落盘的把次（按线路分组），重试沿用同一 opId；
    // _lastTap    快速双击窗口；
    // _correctedRows / _correctionFailures  按把更正的只读回读与失败重试标记；
    // _attemptOps  本次实例发起但没落盘的撤回/恢复意图（按 把次 ID + 动作 记原 opId，
    //              重试沿用同一个 ID；落盘成功即清掉，不用计时窗口防抖）；
    // _recentStatus  刚落盘成功的那一次动作**带来的状态**（撤回→已撤回、恢复→有效），
    //              只用于行下方的确认文案，不落盘；重开后以档案里的撤回状态为准。
    // _formDirty / _newRouteDirty  正在填写的场次表单与新建线路表单（不重读、不冲掉输入）；
    // _lastCreateTap  快速重复点击「创建并选中」的窗口，避免连点建出两条线；
    // _photoUi / _newRoutePhotoPath  照片控制器与新建表单里已选的临时照片路径；
    // _wishlistRows  本馆「下次想爬」的派生条目（不落盘，照片状态叠加在上面）。
    // _summarySessionId  本页显式指定「要回看哪一场」的小结目标（只读，不写盘）。
    this._failedOps = {};
    this._lastTap = {};
    this._lastCreateTap = 0;
    this._correctedRows = {};
    this._correctionFailures = {};
    this._attemptOps = {};
    this._recentStatus = null;
    this._formDirty = false;
    this._newRouteDirty = false;
    this._photoUi = null;
    this._newRoutePhotoPath = '';
    this._wishlistRows = [];
    this._summaryRows = [];
    // ?sessionId=xxx：只读回看这一天/这一家岩馆的另一场小结，不改当前场次；
    // 用户在场内页自己切换场次或开始新场次时清掉它，小结回到当前场次。
    this._summarySessionId =
      (query && (query.sessionId || query.sessionid)) || '';
    // 首页「开始训练」带 ?start=1：直接展开场次表单。
    this._formOpen = Boolean(query && (query.start === '1' || query.start === 1));
    this.loadPage();
    this.loadPhotos();
  },

  onShow() {
    if (!this.data.ready) return;
    // 备注编辑中不重读页面，避免冲掉正在输入的内容；其余情况按最新档案刷新。
    if (this.data.noteEditor) {
      this.refreshView();
      this.loadPhotos();
      return;
    }
    // 正在填写的场次表单与新建线路表单都不重读重算，避免把输入冲掉；
    // 已经打开的加线面板也保持打开（返回本页不把用户刚打开的面板关掉）。
    const keepForm =
      (this._formDirty && this._formOpen) ||
      (this._newRouteDirty && this.data.newRouteVisible) ||
      this.data.addRouteVisible;
    this.loadPage({ keepForm });
    this.loadPhotos();
  },

  /**
   * 照片控制器只在本页创建一次；档案 ID 由控制器从本机档案读取。
   * 打开场内页本身不写照片，只有用户点按拍照/相册/确认/移除才动文件与索引。
   * 这里只做初始化，不读取照片，避免和 loadPhotos 相互递归。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createTrainingPhotoController(this, {
        // 照片状态变化同时刷新当前线路与「下次想爬」清单行的展示。
        onChange: () => this.applyPhotoState(),
        onNotice: text => this.setData({ photoNotice: text })
      });
    }
    return Promise.resolve(this._photoUi.init());
  },

  /**
   * 只读取当前选中线路与「下次想爬」清单行的照片；没有选中线路也没有清单行时
   * 清空页面上的照片展示（不删除任何文件或索引）。
   *
   * 每次先过一遍 initPhotoUi：本机档案是在「开始场次」之后才存在的，
   * 刚建好档案的这一次刷新必须让照片服务跟上当前档案 ID。
   */
  loadPhotos() {
    return Promise.resolve(this.initPhotoUi()).then(() => {
      if (!this._photoUi) return;
      const selectedId = this.data.selectedRoute && this.data.selectedRoute.id;
      const ids = [];
      if (selectedId) ids.push(selectedId);
      (this._wishlistRows || []).forEach(row => {
        if (row.routeId && ids.indexOf(row.routeId) === -1) ids.push(row.routeId);
      });
      if (!ids.length) {
        this._photoUi.clear();
        this.applyPhotoView();
        return;
      }
      return this._photoUi.load(ids).then(() => this.applyPhotoView());
    });
  },

  /**
   * 照片控制器每次报告状态变化都重算展示：当前线路的照片卡与清单行的照片状态。
   */
  applyPhotoState() {
    this.applyPhotoView();
    this.applyWishlistPhotos();
  },

  applyPhotoView() {
    if (!this._photoUi) return;
    const routeId = this.data.selectedRoute && this.data.selectedRoute.id;
    this.setData({
      routePhoto: routeId ? this._photoUi.view(routeId) : null
    });
  },

  /**
   * 清单行上的照片状态：只读控制器已经读到的结果，不改照片、不发起保存。
   * 没有照片或照片文件不可用都照常显示条目，并写明「无图 / 照片不可用」。
   */
  wishlistPhotoView(routeId) {
    const view = this._photoUi ? this._photoUi.view(routeId) : null;
    const hasPhoto = Boolean(view && view.hasPhoto);
    const missing = Boolean(view && view.missing);
    return {
      hasPhoto,
      thumbnailPath: hasPhoto ? view.thumbnailPath || view.mainPath || '' : '',
      photoStatusText: hasPhoto ? '有照片' : missing ? '照片不可用' : '无图'
    };
  },

  /**
   * 把清单条目（数据层派生）与照片状态合成到页面展示；只重算展示，不写盘。
   */
  wishlistView(entries) {
    const rows = (entries || []).map(entry =>
      Object.assign({}, entry, this.wishlistPhotoView(entry.routeId))
    );
    const wanted = rows.filter(row => row.status === 'wanted');
    const completed = rows.filter(row => row.status === 'completed');
    const archived = rows.filter(row => row.status === 'archived');
    const parts = [];
    if (wanted.length) parts.push(wanted.length + ' 条想爬');
    if (completed.length) parts.push(completed.length + ' 条已完成');
    if (archived.length) parts.push(archived.length + ' 条已归档');
    return {
      wishlistWanted: wanted,
      wishlistCompleted: completed,
      wishlistArchived: archived,
      hasWishlist: rows.length > 0,
      wishlistCountText: parts.length ? parts.join(' · ') : ''
    };
  },

  /**
   * 只重算清单行上的照片状态（照片控制器报告变化时调用，不重读清单）。
   */
  applyWishlistPhotos() {
    if (!this.data.wishlistReady || !this._wishlistRows.length) return;
    this.setData(this.wishlistView(this._wishlistRows));
  },

  /**
   * 本馆「下次想爬」清单（只读）：按当前场次所属岩馆读清单并按状态分组。
   * 没有当前场次时清空展示；清单损坏、版本不支持或读取失败时显示可见错误、
   * 收回写入口，保留原清单，本场记录与照片不受影响。
   */
  refreshWishlist() {
    const session = this.data.activeSession;
    if (!session) {
      this._wishlistRows = [];
      this.setData({
        wishlistReady: false,
        wishlistError: '',
        wishlistWanted: [],
        wishlistCompleted: [],
        wishlistArchived: [],
        wishlistCountText: '',
        hasWishlist: false,
        selectedWishlist: null
      });
      return;
    }

    const listed = wishlist.listWishlist(this.archive, { gymId: session.gymId });
    this._wishlistRows = listed.ok ? listed.items : [];
    this.setData(
      Object.assign(
        {
          wishlistReady: listed.ok,
          wishlistError: listed.ok ? '' : listed.error,
          selectedWishlist: this.selectedWishlistView()
        },
        listed.ok
          ? this.wishlistView(listed.items)
          : {
              wishlistWanted: [],
              wishlistCompleted: [],
              wishlistArchived: [],
              wishlistCountText: '',
              hasWishlist: false
            }
      )
    );
  },

  /**
   * 当前选中线路在清单里的状态（只读）：加入、撤下与归档入口据此显示，
   * 与线路详情页共用数据层的同一份判定文案。
   */
  selectedWishlistView() {
    const routeId = this.data.selectedRoute && this.data.selectedRoute.id;
    if (!routeId || !this.archive) return null;
    const listed = wishlist.wishlistEntry(this.archive, routeId);
    if (!listed.ok) {
      return Object.assign(wishlist.wishlistActionView(null), {
        error: listed.error,
        canAdd: false,
        stateText: ''
      });
    }
    return Object.assign({ error: '' }, wishlist.wishlistActionView(listed.entry));
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
    if (!keepForm) {
      this._newRouteDirty = false;
      // 表单被关掉/重开时，已选的临时照片不再属于当前表单。
      this._newRoutePhotoPath = '';
    }

    this.setData({
      ready: true,
      loadError: loaded.error || '',
      storageError: '',
      notice: '',
      photoNotice: '',
      noteEditor: null,
      routePhoto: null,
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
      newRouteError: keepForm ? this.data.newRouteError : '',
      newRoutePhoto: keepForm ? this.data.newRoutePhoto : null
    });
    this.refreshView();
    this.loadPhotos();
  },

  retryLoad() {
    this.loadPage({ keepForm: this._formDirty });
  },

  findSession(sessionId) {
    const archive = this.archive || store.loadState().archive;
    return (archive.sessions || []).find(item => item.id === sessionId) || null;
  },

  // ---------------------------------------------------------------- 视口定位

  /**
   * 当前视口高度（px）。拿不到就返回 0，当作「不知道」处理。
   */
  viewportHeight() {
    if (typeof wx === 'undefined') return 0;
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const info = wx.getWindowInfo();
        if (info && info.windowHeight) return info.windowHeight;
      }
      if (typeof wx.getSystemInfoSync === 'function') {
        const info = wx.getSystemInfoSync();
        if (info && info.windowHeight) return info.windowHeight;
      }
    } catch (error) {
      return 0;
    }
    return 0;
  },

  /**
   * 把一个已经渲染出来的元素滚进可见位置（T030 复验）。
   *
   * 只做两件事：等这一次重绘的布局落定（wx.nextTick）之后，用真实布局接口现量元素的位置
   * 与当前滚动量，再决定要不要滚——不拿面板里的旧坐标、也不按固定像素猜。
   *
   * gateSelector 是「已经看得见就不用动」的那个元素；targetSelector 是真正滚到的位置。
   * 两者可以在一次查询里一起量：门已经完整可见就什么都不做，所以「已经看得到」的情形
   * 不会为了报一次成功而抖一下；否则按目标块的现量位置算滚动量
   * （当前滚动量 + 目标块相对视口的 top - 偏移），因此和滚动位置无关。
   *
   * 撤回、恢复、重试保存这些原地动作不调用它：它们只改这一块里的读数，位置本来就不变。
   */
  revealElement(gateSelector, topOffset, targetSelector) {
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') return;
    const offset = typeof topOffset === 'number' ? topOffset : REVEAL_TOP_OFFSET;
    const measure = () => {
      let query = null;
      try {
        query = wx.createSelectorQuery();
      } catch (error) {
        return;
      }
      if (!query || typeof query.select !== 'function') return;
      query.select(gateSelector).boundingClientRect();
      query.select(targetSelector || gateSelector).boundingClientRect();
      query.selectViewport().scrollOffset();
      query.exec(result => {
        const gate = result && result[0];
        const target = (result && result[1]) || gate;
        const viewport = result && result[2];
        if (!gate || !target || !viewport) return;
        const height = this.viewportHeight();
        const visible = gate.top >= 0 && (!height || gate.bottom <= height);
        if (visible) return;
        const scrollTop = Math.max(0, (viewport.scrollTop || 0) + target.top - offset);
        if (typeof wx.pageScrollTo === 'function') {
          wx.pageScrollTo({ scrollTop, duration: 0 });
        }
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure);
    else measure();
  },

  /**
   * 换线与结果这一块滚回可见位置：新建、关联选中、换线、切场次之后都落在这里，用户不必
   * 自己再往上找一次结果按钮。滚到「本场线路」这一段顶端，所以「＋ 加线」也还在首屏里。
   */
  revealResultRegion() {
    this.revealElement(MAIN_OPERATION_GATE, REVEAL_TOP_OFFSET, MAIN_OPERATION_ANCHOR);
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
    let attempts = [];
    let pendingRows = [];
    let correctionRows = [];
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
          completionText: completionText(completion)
        };
      });

      selectedRoute = routes.find(route => route.id === archive.activeRouteId) || null;

      const labels = attemptLabelMap(archive, activeRaw.id, selectedRoute ? selectedRoute.id : '');

      if (selectedRoute) {
        attempts = store.attemptsFor(archive, {
          sessionId: activeRaw.id,
          routeId: selectedRoute.id
        }).map(attempt => ({
          id: attempt.id,
          label: labels.get(attempt.id) || '',
          resultText: attemptResultText(attempt.result),
          timeText: timeText(attempt.createdAt),
          note: attempt.note || '',
          hasNote: Boolean(attempt.note)
        }));

        // 待保存行：档案里的「进行中」操作 + 本实例发起但完全没落盘的操作。
        const fromArchive = (archive.pendingSaves || [])
          .filter(op => op.sessionId === activeRaw.id && op.routeId === selectedRoute.id)
          .sort((left, right) => (left.seq || 0) - (right.seq || 0))
          .map(op => ({
            opId: op.opId,
            label: labels.get(op.opId) || '',
            resultText: attemptResultText(op.result),
            statusText: '未保存 · 点「重试保存」按同一把重试',
            canRetry: true
          }));

        const localOnly = Object.keys(this._failedOps)
          .map(key => this._failedOps[key])
          .filter(
            op =>
              op.sessionId === activeRaw.id &&
              op.routeId === selectedRoute.id &&
              !fromArchive.some(row => row.opId === op.opId)
          )
          .map(op => ({
            opId: op.opId,
            label: '',
            resultText: attemptResultText(op.result),
            statusText: '未保存 · 点「重试保存」按同一把重试',
            canRetry: true
          }));

        pendingRows = fromArchive.concat(localOnly);

        // 按把「改为未完成」：这条线每一把仍可更正的已确认完攀各占一行。
        // 本实例刚改好的那一把留在原位置变成只读回读，同一坐标不会自动接上下一把。
        correctionRows = store.routeCorrectionTargets(archive, selectedRoute.id).map(target => {
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
            label: target.label,
            contextText: target.contextText,
            state,
            buttonText: state === 'retry' ? '重试改为未完成' : '改为未完成',
            statusText: corrected ? corrected.statusText : ''
          };
        });
      }

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

    const completion = selectedRoute ? store.routeCompletion(archive, selectedRoute.id) : null;
    const resultLocked = pendingRows.length > 0;
    const routeCountText = pendingRows.length
      ? attempts.length + ' 把 · ' + pendingRows.length + ' 把待保存'
      : attempts.length + ' 把';
    const correctionStatusText = correctionRows.some(row => row.state === 'retry')
      ? '更正未保存 · 点「重试改为未完成」按同一把重试'
      : '';

    // 结果按钮旁换线（T031）：只排展示顺序。「全部 N 条」计数就是本场关联数
    // （routes 由 store.routesForSession 派生，别的场次独有的线路不在里面）。
    const routeSwitchAllRows = routes.slice();
    const routeSwitchRows = routeSwitchShortList(
      routes,
      selectedRoute ? selectedRoute.id : '',
      recentRouteIdsInSession(archive, activeRaw ? activeRaw.id : '', routes)
    );

    // 最近一把的撤回与恢复（T033）：目标、原序号与两种动作都只从这一份只读派生来。
    const recentAttempt = this.recentAttemptView(
      archive,
      activeRaw ? activeSession : null,
      selectedRoute,
      pendingRows
    );

    this.setData({
      activeSession,
      sameDaySessions,
      routes,
      selectedRoute,
      recentAttempt,
      routeStateText: completion && completion.completed
        ? '已完攀'
        : completion && completion.closed
          ? '完攀待确认'
          : '',
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
      routeSwitchRows,
      routeSwitchAllRows,
      routeSwitchTotal: routeSwitchAllRows.length,
      routeSwitchHasMore: routeSwitchAllRows.length > 3,
      routeSwitchMoreText: '全部 ' + routeSwitchAllRows.length + ' 条',
      gymRoutes,
      // 照片展示与逐把记录各自独立：照片由控制器按 routeId 推导，不改档案数据。
      routePhoto: selectedRoute && this._photoUi
        ? this._photoUi.view(selectedRoute.id)
        : null
    });

    // 本馆「下次想爬」清单：只读清单与档案派生，不写盘。
    this.refreshWishlist();
    // 本次小结：同样只读，按原 sessionId 重算，不与上面共用任何缓存。
    this.refreshSummary();
  },

  /**
   * 小结内的只读回看入口（T029）：列出「可以回看哪几场」供用户直接点选，
   * 不必手工拼 ?sessionId=。
   *
   * 只列本机档案里已经有已提交把次的场次，外加当前正在记录的场次与用户已经指定的那一场
   * （哪怕它还是空场，也总能选回当前场、并让选择器如实显示正在看哪一场）；按本地日期新
   * 在前、同日序号大在前排序，每项写明 日期 · 岩馆 · 第 N 场。有把次才列，是因为小结只算
   * 已提交把次，别的空场没有内容可看。
   *
   * 选择项本身不写任何数据：只决定「看哪一场的小结」，不选场次、不建场次、
   * 不写训练，因此不改变正在记录的 activeSession，也不挤占上方首屏的结果按钮。
   * 只有一场可选时不显示选择器。
   */
  summarySessionChoice() {
    const archive = this.archive;
    const activeId = (archive && archive.activeSessionId) || '';
    // 选了哪一场就是哪一场；没选时看当前场次。
    const wanted = this._summarySessionId || activeId;
    // 有**有效**把次才列（T032）：只剩撤回把次的场次没有内容可看，与小结口径一致。
    const withAttempts = new Set(
      store
        .effectiveAttempts((archive && archive.attempts) || [])
        .map(attempt => attempt.sessionId)
    );
    const options = ((archive && archive.sessions) || [])
      .filter(
        session =>
          withAttempts.has(session.id) ||
          session.id === activeId ||
          session.id === wanted
      )
      .sort((left, right) => right.date.localeCompare(left.date) || right.seq - left.seq)
      .map(session => ({
        id: session.id,
        label:
          session.date +
          ' · ' +
          (store.gymName(archive, session.gymId) || '未知岩馆') +
          ' · ' +
          store.sessionLabel(archive, session),
        isActive: session.id === activeId
      }));

    const index = options.findIndex(option => option.id === wanted);
    return {
      summarySessionOptions: options,
      summarySessionPickerVisible: options.length > 1,
      summarySessionIndex: index,
      summarySessionValue: index === -1 ? '选择要回看的场次' : options[index].label
    };
  },

  /**
   * 本次小结（T029，只读）：按原 sessionId 从档案派生本场已提交把次、去重线路与
   * 完攀线路，并把每行与「下次想爬」清单的勾选状态合成到展示。
   *
   * - 默认看当前场次；本页可用 ?sessionId= 指定回看另一场，也可以直接在小结区的
   *   只读选择器里选（见 summarySessionChoice），回看只读：不改当前场次、不结束也
   *   不新建场次、不写任何键；
   * - 场次已不在档案里（例如本机档案被重置）时显示可见错误，不猜、不补；
   * - 勾选状态一律来自清单的实际存储，写失败或清单损坏时显示实际状态并收回写入口。
   */
  refreshSummary() {
    const activeId = (this.data.activeSession && this.data.activeSession.id) || '';
    const requested = this._summarySessionId || activeId;
    const summary = buildSessionSummary(this.archive, requested);
    const choice = this.summarySessionChoice();

    if (!summary.known) {
      this._summaryRows = [];
      this.setData(
        Object.assign(choice, {
          summaryRows: [],
          summaryReady: false,
          summaryError: requested
            ? '找不到这场训练，可能本机档案已重置；本场记录与照片不受影响'
            : '',
          summarySessionId: '',
          summaryGymId: '',
          summaryGymName: '',
          summaryDate: '',
          summaryLabel: '',
          summaryViewingOther: false,
          summaryCountText: '',
          summarySendText: '',
          summaryPendingText: '',
          summaryWishlistError: '',
          summaryHintText: '',
          summaryEmpty: true,
          hasSummaryRows: false
        })
      );
      return;
    }

    // 一次读盘拿到这批线路的清单状态；清单读不出来时按实际错误显示并收回写入口。
    const membership = wishlist.wishlistMembership(
      this.archive,
      summary.routes.map(row => row.routeId)
    );
    const rows = summary.routes.map(row => {
      const entry = membership.ok ? membership.entries.get(row.routeId) || null : null;
      const archived = Boolean(entry && entry.archived);
      const checked = Boolean(entry) && !archived;
      return Object.assign({}, row, {
        // canPick 只表示「现在能不能点」：未完成 + 清单可读；pickable 是本场状态。
        canPick: row.pickable && membership.ok,
        checked,
        inList: Boolean(entry),
        wishlistStateText: !entry
          ? ''
          : archived
            ? '已归档（岩馆拆线）'
            : entry.completed
              ? '已完成 · 在清单里'
              : '已在下次想爬',
        pickText: checked
          ? '✓ 已加入下次想爬'
          : archived
            ? '重新加入下次想爬'
            : '加入下次想爬'
      });
    });

    this._summaryRows = rows;
    this.setData(
      Object.assign(choice, {
        summaryRows: rows,
        summaryReady: true,
        summaryError: '',
        summarySessionId: summary.sessionId,
        summaryGymId: summary.gymId,
        summaryGymName: summary.gymName,
        summaryDate: summary.date,
        summaryLabel: summary.label,
        // 回看另一场时明确写出来，避免用户以为当前场次被改了。
        summaryViewingOther: Boolean(activeId) && summary.sessionId !== activeId,
        summaryCountText: summary.summaryText,
        summarySendText: summary.sendCountText,
        summaryPendingText: summary.pendingCountText,
        summaryWishlistError: membership.ok ? '' : membership.error,
        summaryHintText: rows.some(row => row.pickable)
          ? '没爬完的线可以直接勾上：下次进这家岩馆就能从「下次想爬」按原线路 ID 续记。'
          : '',
        summaryEmpty: summary.isEmpty,
        hasSummaryRows: rows.length > 0
      })
    );
  },

  /**
   * 选择要回看哪一场小结（T029，只读）：只换所看的小结，不选场次、不建场次、
   * 不写训练，因此正在记录的当前场次与线路都不变；选回当前场次即恢复默认。
   * 返回本页（onShow 重算）后仍停留在所选场次上。
   */
  onSummarySessionChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.summarySessionOptions || [];
    const option = options[index];
    if (!option) return;
    this._summarySessionId = option.isActive ? '' : option.id;
    this.refreshSummary();
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
    // 场次表单常驻页顶（T030 复验把场次标题与日期移到主操作区之后，表单仍在页顶）：
    // 从页面下方点「开始新场次」时，表单渲染在当前滚动位置之上，这里把它滚回可见处。
    this.revealElement(SESSION_FORM_ANCHOR);
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
    this._lastTap = {};
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
    this._lastTap = {};
    // 用户自己切场次：小结跟着当前场次走，不再停留在 ?sessionId= 的回看目标上。
    this._summarySessionId = '';
    this.setData({ storageError: '', notice: '', noteEditor: null, routeSwitchExpanded: false });
    this.refreshView();
    // 换场次后当前线路可能不同：按新选中线路读取照片。
    this.loadPhotos();
    // 「本日场次」入口按 T030 复验排在主操作区之后：切完场次把换线与结果这一块带回
    // 可见处，用户不用自己往上找回结果按钮。这一步只挪视口，不改任何数据。
    this.revealResultRegion();
  },

  // ---------------------------------------------------------------- 线路

  selectRoute(event) {
    if (this.data.loadError) return;
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId) return;
    // 点的就是当前线（例如在「全部 N 条」里点当前那一行退回结果处）：只收起展示，
    // 不重复写盘、不改任何数据；但要把用户带回结果按钮那一块。
    if (routeId === this.archive.activeRouteId) {
      if (this.data.routeSwitchExpanded) this.setData({ routeSwitchExpanded: false });
      this.revealResultRegion();
      return;
    }

    const outcome = store.selectRoute(routeId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      if (outcome.archive) this.archive = outcome.archive;
      // 选线失败：保留换线列表与展开状态，用户可以原地再点同一条重试。
      this.refreshView();
      return;
    }
    this.archive = outcome.archive;
    this._lastTap = {};
    // 选中成功即上一次「选中失败」已经解决，重试入口可以收掉；换线后回到短列表，
    // 结果按钮就在换线区下方，原地继续记这一把。
    this.setData({
      storageError: '',
      notice: '',
      noteEditor: null,
      linkRetry: null,
      routeSwitchExpanded: false
    });
    this.refreshView();
    // 换线路后按新选中线路读取照片（同一线路的照片不重复请求）。
    this.loadPhotos();
    // 从「全部 N 条」的展开列表里选完线：列表收起、内容上移，把结果按钮带回可见处。
    this.revealResultRegion();
  },

  /**
   * 「全部 N 条」（T031）：把本场所有线路都列出来，便于线路多时换线。
   * 只切本页展示，不选线路、不写盘，当前线不变；N 就是真实的本场关联数。
   */
  expandRouteSwitch() {
    if (this.data.loadError) return;
    if (this.data.routeSwitchExpanded) return;
    this.setData({ routeSwitchExpanded: true });
  },

  /**
   * 收起全部线路列表，回到结果按钮旁的短列表（T031）。
   * 只切展示：当前线、把次、照片与备注都不变。
   */
  closeRouteSwitch() {
    if (!this.data.routeSwitchExpanded) return;
    this.setData({ routeSwitchExpanded: false });
  },

  /**
   * 把加线面板的展示状态收回到关闭时的样子（含新建表单回到默认类型/等级/颜色）。
   * 只返回数据补丁，不写盘：取消加线不产生线路、关联或选择上的任何变化。
   */
  addRouteFormPatch() {
    const form = defaultNewRouteForm();
    const patch = {
      addRouteVisible: false,
      addRouteMode: 'existing',
      newRouteVisible: false,
      newRouteName: '',
      newRouteError: '',
      newRoutePhoto: null
    };
    Object.keys(form).forEach(key => {
      patch[key] = form[key];
    });
    return patch;
  },

  /**
   * 首屏加线入口（T030）：打开「本馆已有 / 新建线路」面板。
   * 有本馆旧线时默认停在「本馆已有」（首屏只差一步），没有就直接进新建表单。
   * 面板已经开着时只切来源、不重置已输入的内容；打开面板本身不写盘，
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
      // 已经打开：只按入口指定的来源切换，不把正在填的名称/类型/等级冲掉。
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
    // 重开面板丢掉上一次未提交的临时照片选择；重新打开表单也是一次新的提交起点。
    this._newRoutePhotoPath = '';
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
   * 取消后本场线路、本场关联与当前选择都保持与打开面板前完全相同。
   */
  cancelAddRoute() {
    this._newRouteDirty = false;
    this._newRoutePhotoPath = '';
    this.setData(this.addRouteFormPatch());
  },

  /**
   * 加线来源切换：本馆已有线路 / 新建线路。
   * 只换面板里显示哪一块，已输入的名称与类型等级都留着，切回来还是原样。
   */
  switchAddRouteMode(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const mode = dataset.mode === 'new' ? 'new' : 'existing';
    // 切到「新建线路」是另一次提交的起点，不受上一次连点保护影响。
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
   * 关联成功后选中失败的可见重试入口（T030）：按同一个 routeId 再走一次
   * 「关联 + 选中」——关联是幂等的，因此重试成功时本场仍然只有一条关联。
   */
  retryLinkSelection(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId || (this.data.linkRetry && this.data.linkRetry.routeId);
    return this.resumeRouteInSession(routeId);
  },

  /**
   * 继续原线：把这条长期线路关联到当前场次并选中（关联幂等，重复点不新增关联）。
   * 「选原线」与「下次想爬」清单的条目共用这一条路径，因此清单里点开的就是
   * 清单上那个长期线路 ID，不会另建一条同名线路，也不会把把次记到别的线上。
   *
   * T030：关联成功、选中失败时不报成功——不提示「已加入」、不收起加线面板，
   * 而是把这条线写进 linkRetry，让首屏留着一个可点的「重试选中」入口；
   * 关联成功且选中成功才收起面板并回到记结果处。
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
    const route = ((this.archive && this.archive.routes) || []).find(item => item.id === routeId);
    this._lastTap = {};
    this._newRouteDirty = false;
    this._newRoutePhotoPath = '';
    this.setData(
      Object.assign(this.addRouteFormPatch(), {
        storageError: '',
        notice: route
          ? '已把「' + route.name + '」加入本场并选中，直接记这一把。'
          : '已把这条线路加入本场并选中，直接记这一把。',
        noteEditor: null,
        linkRetry: null,
        routeSwitchExpanded: false
      })
    );
    this.refreshView();
    this.loadPhotos();
    // 关联并选中成功：加线面板收起后内容整体上移，把换线与结果带回可见处。
    this.revealResultRegion();
  },

  /**
   * 新建线路表单的开关。加线面板（T030）与旧的直接调用共用它：
   * 打开即进入面板的「新建线路」来源，收起则整个面板收起。
   */
  toggleNewRouteForm() {
    const visible = !this.data.newRouteVisible;
    const form = defaultNewRouteForm();
    this._newRouteDirty = false;
    // 收起或重开表单都会丢掉上一次未提交的临时照片选择；
    // 重新打开表单也是一次新的提交起点（连点保护只针对同一次提交）。
    this._newRoutePhotoPath = '';
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
      newRouteError: '',
      newRoutePhoto: null
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
   * 切换攀岩类型立即重算等级选项：原等级在新类型里仍有效就保留
   * （顶绳 5.10a 切先锋），失效就清空并显示「请选择等级」，绝不静默落到首个等级。
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
      // 越界索引不静默落到首个颜色，回到「不指定」。
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
   * 不新建线路、不改当前线路，也不静默回落到首个等级；错误组合由档案层再次把关，
   * 不落盘。
   *
   * 颜色（T030）不是必填：收起或没选过就是「不指定」，按空颜色保存，
   * 不替用户记一个他没看过的颜色；照片同样可以跳过，保存后还能从当前线路补。
   *
   * 快速重复点击保存不重复建线：同一次提交在窗口内的第二次点击只提示、不再建线。
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
    // 新建表单里已选的照片（临时路径）在这里交给照片控制器：创建成功后才保存。
    const pendingPhotoPath = this._newRoutePhotoPath;
    this._newRouteDirty = false;
    this._newRoutePhotoPath = '';
    this._lastTap = {};
    const createdName = (outcome.route && outcome.route.name) || name;
    this.setData(
      Object.assign(this.addRouteFormPatch(), {
        storageError: '',
        // 线路已创建并选中：直接回到记结果处，选中线与可记录目标一致。
        notice: '已新建并选中「' + createdName + '」，直接记这一把。',
        noteEditor: null,
        linkRetry: null,
        routeSwitchExpanded: false
      })
    );
    this.refreshView();
    // 新建并选中成功：加线面板收起、内容整体上移，把换线与结果带回可见处再读照片。
    this.revealResultRegion();

    // 线路已创建并选中；照片保存失败只影响照片，不回滚线路，也不阻止记把次。
    if (pendingPhotoPath && outcome.route) {
      return Promise.resolve(this.initPhotoUi())
        .then(() => {
          if (!this._photoUi) return null;
          this._photoUi.beginPreview(outcome.route.id, pendingPhotoPath);
          return this._photoUi.confirm(outcome.route.id);
        })
        .then(() => this.loadPhotos());
    }
    return this.loadPhotos();
  },

  // ---------------------------------------------------------------- 下次想爬

  /**
   * 清单写入口的原归属：本页渲染时用的档案 ID。数据层据此核对这条操作是不是还落在
   * 同一份档案上——换档之后（例如档案被重置或换成另一份）的迟到点击会被拒绝，
   * 不会把另一份档案里同名线路 ID 的收藏改掉。
   */
  wishlistOwnership() {
    const archiveId = this.archive && this.archive.archiveId;
    return archiveId ? { archiveId: archiveId } : undefined;
  },

  /**
   * 从「下次想爬」清单继续原线：关联并选中同一条长期线路，接着在它上面记把次。
   */
  continueWishlistRoute(event) {
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    return this.resumeRouteInSession(routeId);
  },

  /**
   * 已完攀或已归档的条目：回到线路详情按原线路 ID 回看照片、把次与历史。
   * 只读打开，不新建场次、不改当前线路。
   */
  openWishlistRoute(event) {
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId) return;
    wx.navigateTo({
      url: '/pages/training-route/training-route?routeId=' + routeId
    });
  },

  /**
   * 加入、撤下与拆线归档共用这一条落盘路径：只改清单这一份独立记录，线路、照片、
   * 把次与备注都不动。失败不报已保存，可原地重试；重复点击幂等，不产生第二条，
   * 并明确说明这条线现在的状态（已在清单里 / 本来不在 / 已经归档）。
   */
  applyWishlistAction(outcome, label, doneText, repeatText) {
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? label + '未保存，可再点一次重试。' : outcome.error
      });
    } else {
      this.setData({
        storageError: '',
        notice: outcome.duplicate ? repeatText || '' : doneText
      });
    }
    this.refreshView();
    this.loadPhotos();
  },

  addSelectedToWishlist() {
    if (this.data.loadError) return;
    const routeId = this.data.selectedRoute && this.data.selectedRoute.id;
    if (!routeId) return;
    const outcome = wishlist.addWishlist(routeId, this.wishlistOwnership());
    this.applyWishlistAction(
      outcome,
      '收藏',
      outcome.code === 'reactivated' ? '已重新加入下次想爬。' : '已加入下次想爬。',
      '这条线路已经在下次想爬清单里。'
    );
  },

  removeSelectedFromWishlist() {
    if (this.data.loadError) return;
    const routeId = this.data.selectedRoute && this.data.selectedRoute.id;
    if (!routeId) return;
    const outcome = wishlist.removeWishlist(routeId, this.wishlistOwnership());
    this.applyWishlistAction(
      outcome,
      '撤下',
      '已从下次想爬撤下；线路、照片与把次都不变。',
      '这条线路本来就不在清单里。'
    );
  },

  /**
   * 拆线归档：岩馆把这条线拆了，把它从活跃清单移到已归档；照片、把次与历史都保留。
   */
  archiveSelectedWishlist() {
    if (this.data.loadError) return;
    const routeId = this.data.selectedRoute && this.data.selectedRoute.id;
    if (!routeId) return;
    const outcome = wishlist.archiveWishlist(routeId, this.wishlistOwnership());
    this.applyWishlistAction(
      outcome,
      '归档',
      '已归档；照片、把次与历史都保留，仍可按原线路 ID 回看。',
      '这条线路已经归档。'
    );
  },

  // ---------------------------------------------------------------- 本次小结

  /**
   * 小结里勾选 / 取消「下次想爬」（T029）：只走 T027 的清单接口，只改清单里的这一条，
   * 线路、照片、把次、备注、场次与其他收藏一律不动；同一线路最多一条，重复点击幂等。
   *
   * 写失败不报已保存：提示未保存并立刻重读清单，勾选框显示的是实际保存状态，可以原地
   * 再点一次重试；内容冲突、线路已不存在等拒绝也按数据层给的原因原样显示。
   */
  toggleSummaryPick(event) {
    if (this.data.loadError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId;
    if (!routeId) return;

    const row = (this.data.summaryRows || []).find(item => item.routeId === routeId);
    if (!row) return;
    // 已完攀的线不在小结里勾选（按 T027 语义归到「已完成」），点它不产生任何写入。
    if (!row.pickable) return;
    // 清单读不出来（损坏、版本不支持、读取失败）：说明原因并收回写入口，不落盘。
    if (!row.canPick) {
      this.setData({
        notice: this.data.summaryWishlistError || '下次想爬清单当前不可用，稍后可再试。'
      });
      return;
    }

    const outcome = row.checked
      ? wishlist.removeWishlist(routeId, this.wishlistOwnership())
      : wishlist.addWishlist(routeId, this.wishlistOwnership());

    if (!outcome.ok) {
      const writeFailed = outcome.code === 'write-failed';
      this.setData({
        storageError: writeFailed ? outcome.error : '',
        notice: writeFailed ? '勾选未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      this.loadPhotos();
      return;
    }

    this.setData({ storageError: '', notice: this.summaryPickNotice(outcome) });
    this.refreshView();
    this.loadPhotos();
  },

  /**
   * 勾选结果文案：按数据层实际落盘的结果说明这条线现在的状态（含幂等与「本来就没有」）。
   */
  summaryPickNotice(outcome) {
    switch (outcome.code) {
      case 'added':
        return '已加入下次想爬；下次进这家岩馆就能从清单里按原线路 ID 续记。';
      case 'reactivated':
        return '这条线已重新加入下次想爬；照片、把次与历史都保留。';
      case 'duplicate':
        return '这条线路已经在下次想爬清单里。';
      case 'removed':
        return '已撤下这条线的收藏；其他收藏、照片与把次都不变。';
      case 'absent':
        return '这条线路本来就不在下次想爬清单里。';
      default:
        return '';
    }
  },

  /**
   * 从小结回看原线：按长期线路 ID 打开线路详情，看原照片、卡点与跨日历史。
   * 只读打开，不新建场次、不改当前线路，也不写任何键。
   */
  openSummaryRoute(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId;
    if (!routeId) return;
    wx.navigateTo({
      url: '/pages/training-route/training-route?routeId=' + routeId
    });
  },

  // ---------------------------------------------------------------- 线路照片

  dismissPhotoNotice() {
    this.setData({ photoNotice: '' });
  },

  /**
   * 新建线路表单里先选一张照片（可选）：
   * 只记住选择器给的临时路径用于本机预览，创建成功后才会写进档案目录；
   * 选择器是异步原生调用，期间换档/重置时丢弃这次选择。
   */
  chooseNewRoutePhoto(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = dataset.source;
    if (!this._photoUi || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    const context = this._photoUi.captureContext();
    return this._photoUi.pickFile(source).then(outcome => {
      if (!outcome.ok) {
        if (!outcome.cancelled) {
          const label = source === 'camera' ? '拍照' : '相册';
          this.setData({
            newRouteError: outcome.permissionDenied
              ? '未获得' + label + '权限，可跳过照片或稍后添加'
              : '选择照片失败：' + outcome.error
          });
        }
        return outcome;
      }
      if (!this._photoUi.isContextCurrent(context)) {
        return {
          ok: false,
          staleContext: true,
          cancelled: false,
          error: '本机档案已更换，已放弃这次选择'
        };
      }
      this._newRoutePhotoPath = outcome.path;
      this._newRouteDirty = true;
      this.setData({
        newRoutePhoto: {
          path: outcome.path,
          statusText: '已选择照片，创建线路后保存到本机'
        },
        newRouteError: ''
      });
      return outcome;
    });
  },

  /**
   * 取消照片：临时路径直接丢弃，不产生任何文件或索引记录；
   * 想重选可立刻再点拍照/相册。
   */
  cancelNewRoutePhoto() {
    this._newRoutePhotoPath = '';
    this.setData({ newRoutePhoto: null, newRouteError: '' });
  },

  photoRouteId(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    if (dataset.routeId) return dataset.routeId;
    return this.data.selectedRoute ? this.data.selectedRoute.id : '';
  },

  chooseRoutePhoto(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = dataset.source;
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    return this._photoUi.choose(routeId, source);
  },

  confirmRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.confirm(routeId);
  },

  cancelRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.cancelPreview(routeId);
    // 取消预览不改动已保存照片：原来有主图就继续显示原主图。
    this.applyPhotoView();
  },

  retryRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.retry(routeId);
  },

  dismissRoutePhotoFailure(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.dismiss(routeId);
    this.applyPhotoView();
  },

  removeRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.remove(routeId);
  },

  previewRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.preview(routeId);
  },

  reloadRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.load([routeId]);
  },

  /**
   * 缩略图是可重建缓存：清缓存或被系统清理后，用持久主图重建一次。
   * 只补缓存，主图、关联与档案数据都不变。
   */
  rebuildRoutePhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve(null);
    return this._photoUi.rebuildThumbs();
  },

  /**
   * 空间不足时页面上给出的出口：可重建缓存的清理入口在「我的」。
   */
  goToClearCache() {
    wx.switchTab({ url: PROFILE_URL });
  },

  // ---------------------------------------------------------------- 逐把

  /**
   * 记一把「未完成 / 完攀」。
   *
   * 先按最新档案判定：抱石已完攀（含待确认）时不再新增；同一场次同一线路还有
   * 未落盘的把次时先重试那一把，不生成第二把。然后交给档案层以两段写落盘：
   * 失败不报已保存，这一把留在待保存行，重试沿用同一操作 ID，只会多出一把。
   *
   * T030 复验：结果按钮把渲染时在场的场次与线路写进 dataset。切场次或换线之后才送到
   * 的这一下（旧按钮的迟到点击）如果和当前不一致，整条拒掉——不把新的一把写进别的
   * 场次，也不写进别的线路。没带 dataset 的调用（数据层与老测试直接驱动）按当前值处理。
   */
  recordAttempt(event) {
    if (this.data.loadError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const result = dataset.result;
    if (result !== 'fail' && result !== 'send') return;

    const active = this.data.activeSession;
    if (!active) {
      this.setData({ notice: '请先开始一场训练' });
      return;
    }

    // 迟到点击：按钮渲染时带的场次与当前场次不同 → 这一下属于上一场，不落到新场次。
    const boundSessionId = dataset.sessionId || '';
    if (boundSessionId && boundSessionId !== active.id) {
      this.setData({
        notice: '这一下是上一场的按钮，已经切到别的场次，没有记录这一把。'
      });
      this.refreshView();
      return;
    }

    const currentRouteId = this.archive.activeRouteId;
    // 迟到点击：按钮渲染时带的线路与当前线路不同 → 这一下属于上一条线，不落到新线路。
    const boundRouteId = dataset.routeId || '';
    if (boundRouteId && boundRouteId !== currentRouteId) {
      this.setData({
        notice: '这一下是上一条线路的按钮，当前线路已经换了，没有记录这一把。'
      });
      this.refreshView();
      return;
    }

    const routeId = boundRouteId || currentRouteId;
    if (!routeId) {
      this.setData({ notice: '请先选原线或新建一条线路' });
      return;
    }

    // 快速双击保护：同一把按钮的同一结果在窗口内只算一次，避免一次攀爬记成两把。
    const tapKey = active.id + '\u0000' + routeId + '\u0000' + result;
    const now = Date.now();
    if (this._lastTap[tapKey] && now - this._lastTap[tapKey] < SAME_TAP_WINDOW_MS) {
      this.setData({ notice: '刚记过这一把，落盘确认后再点下一次结果。' });
      return;
    }

    const pending = (this.archive.pendingSaves || []).some(
      op => op.sessionId === active.id && op.routeId === routeId
    );
    if (pending) {
      this.setData({
        notice: '上一把还没保存：先在「待保存」行点「重试保存」，确认后再记下一把。'
      });
      return;
    }

    const outcome = store.saveAttempt({
      // 记下这一把属于哪一份本机档案：换档之后的迟到重试不能把这次操作写进新档案。
      archiveId: this.archive.archiveId,
      sessionId: active.id,
      routeId,
      result,
      note: ''
    });

    if (outcome.archive) this.archive = outcome.archive;

    if (outcome.ok) {
      this._lastTap[tapKey] = now;
      delete this._failedOps[active.id + '\u0000' + routeId];
      this.setData({ storageError: '', notice: '' });
      this.refreshView();
      return;
    }

    // 抱石守卫等业务拒绝：不改数据，说明原因。
    if (outcome.blocked) {
      this.setData({ notice: outcome.error, storageError: '' });
      this.refreshView();
      return;
    }

    // 落盘失败：记下这一把的操作 ID（含两段写都没落盘的情况）与它属于哪一份档案，
    // 提示未保存，重试时沿用同一个 opId，只提交一次。
    this._failedOps[active.id + '\u0000' + routeId] = {
      archiveId: this.archive.archiveId,
      opId: outcome.opId,
      sessionId: active.id,
      routeId,
      result,
      note: ''
    };
    this.setData({ storageError: outcome.error, notice: '这一把未保存，可在「待保存」行重试。' });
    this.refreshView();
  },

  /**
   * 重试保存：沿用待保存行里的操作 ID，档案层按该 ID 幂等，只多出预期的一把。
   *
   * 这次重试绑定**发起时的那一份档案**：先按最新档案读一次，待保存记录（无论来自档案
   * 里的「进行中」标记还是本实例没落盘的那一条）带的 archiveId 与当前档案不一致时
   * （换档/换了账号之后又点到旧页面），整条不落盘，也不把这一把写进新的档案。
   */
  retryPendingAttempt(event) {
    if (this.data.loadError) return;
    const opId = event && event.currentTarget && event.currentTarget.dataset.opId;
    if (!opId) return;

    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({ storageError: loaded.error });
      this.refreshView();
      return;
    }
    const archive = loaded.archive;
    this.archive = archive;

    const fromArchive = (archive.pendingSaves || []).find(op => op.opId === opId) || null;
    const localKey = Object.keys(this._failedOps).find(
      key => this._failedOps[key].opId === opId
    );
    const source = fromArchive || (localKey ? this._failedOps[localKey] : null);
    if (!source) {
      this.setData({ notice: '这条待保存记录已不存在，正在按最新档案刷新。' });
      this.loadPage({ keepForm: this._formDirty && this._formOpen });
      return;
    }

    // 待保存记录属于哪一份档案：档案里的「进行中」标记天然属于当前这一份；本实例的
    // 那一条记着发起时的档案 ID，换档之后不再往新档案里写这一把。
    const sourceArchiveId = fromArchive
      ? archive.archiveId
      : source.archiveId || archive.archiveId;
    if (sourceArchiveId !== archive.archiveId) {
      if (localKey) delete this._failedOps[localKey];
      this.setData({
        storageError: '',
        notice: '这一把属于原来的本机档案，未做改动；已按当前档案刷新。'
      });
      this.refreshView();
      return;
    }

    const outcome = store.saveAttempt({
      opId,
      archiveId: archive.archiveId,
      sessionId: source.sessionId,
      routeId: source.routeId,
      result: source.result,
      note: typeof source.note === 'string' ? source.note : ''
    });
    if (outcome.archive) this.archive = outcome.archive;

    if (outcome.ok) {
      if (localKey) delete this._failedOps[localKey];
      this._lastTap[source.sessionId + '\u0000' + source.routeId + '\u0000' + source.result] = Date.now();
      this.setData({ storageError: '', notice: '' });
      this.refreshView();
      return;
    }

    if (outcome.blocked) {
      if (localKey) delete this._failedOps[localKey];
      this.setData({ storageError: '', notice: outcome.error });
      this.refreshView();
      return;
    }

    // 仍然没落盘：保留同一个 opId 与它属于哪一份档案，可再次重试。
    const keptArchiveId = localKey
      ? this._failedOps[localKey].archiveId || archive.archiveId
      : archive.archiveId;
    if (localKey) {
      this._failedOps[localKey] = Object.assign({}, this._failedOps[localKey], {
        archiveId: keptArchiveId,
        opId: outcome.opId || opId
      });
    } else if (outcome.opId) {
      this._failedOps[source.sessionId + '\u0000' + source.routeId] = {
        archiveId: keptArchiveId,
        opId: outcome.opId,
        sessionId: source.sessionId,
        routeId: source.routeId,
        result: source.result,
        note: typeof source.note === 'string' ? source.note : ''
      };
    }
    this.setData({ storageError: outcome.error, notice: '这一把仍未保存，可再次重试。' });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 最近一把的撤回与恢复

  /**
   * 结果按钮下方「最近一把」的展示（T033，只读派生，不写盘）。
   *
   * - 没有当前场次、没有当前线路、这条线还没有已提交把次：不显示（返回 null）；
   * - 这条线还有未落盘的把次：整个操作区收起，待保存的一把不当作已保存可撤回项，
   *   上一条已保存的把次也不会留在原地等着被误撤；
   * - 已撤回的那一把仍留在这一行（标题写「已撤回」，序号与结果保持原样）：这一行是同一个
   *   永久操作区里的两个并排槽——左槽撤回、右槽恢复，各占一半宽度、等高。当前不可用的那
   *   一个动作在自己那一槽里留一块等宽等高的非交互空位（没有绑定），所以两个动作的命中
   *   矩形在任何状态下都不相交：刚才点过的坐标不会被另一把、被相反动作或旁边的控件接管；
   * - 失败（写盘失败）时保留原动作与同一个 opId 的重试文案；成功的那一次在本行下方
   *   写一句确认（只在本页显示，不落盘，重开后以档案里的撤回状态为准）。
   */
  recentAttemptView(archive, activeSession, selectedRoute, pendingRows) {
    if (!activeSession || !selectedRoute) return null;
    if (pendingRows.length || hasPendingOnRoute(archive, activeSession.id, selectedRoute.id)) {
      return null;
    }

    const target = recentAttemptTarget(archive, activeSession.id, selectedRoute.id);
    if (!target) return null;

    const attempt = target.attempt;
    const undone = store.isUndoneAttempt(attempt);
    // 这一行现在提供哪个动作：已撤回给「恢复」，未撤回给「撤回」。重试文案只看当前动作，
    // 因此同一个坐标上的按钮始终是同一个动作、同一把次。
    const offered = undone ? 'restore' : 'undo';
    const offeredText = undone ? '恢复' : '撤回';
    // 反过来：当前状态是被哪个动作做出来的（已撤回 ← 撤回，有效 ← 恢复），确认文案用它。
    const madeByText = undone ? '撤回' : '恢复';
    const retry = this._attemptOps[attempt.id + '\u0000' + offered] || null;

    let stateText = '';
    if (retry) {
      stateText = offeredText + '未保存 · 点「重试' + offeredText + '这一把」按同一把重试';
    } else if (
      this._recentStatus &&
      this._recentStatus.attemptId === attempt.id &&
      this._recentStatus.undone === undone
    ) {
      // 只数有效把次：这一句里的把数就是页面上正在显示的那一份（已落盘状态）。
      const counted = store.attemptsFor(archive, {
        sessionId: activeSession.id,
        routeId: selectedRoute.id
      }).length;
      stateText = '已' + madeByText + '这一把 · 本场 ' + counted + ' 把';
    }

    return {
      attemptId: attempt.id,
      routeId: attempt.routeId,
      sessionId: attempt.sessionId,
      // 渲染这一行时用的档案 ID 与这一把的有效状态版本（rev）。两者都随点击一起交回
      // 档案层：档案 ID 不一致（换档后的迟到点击）或版本不一致（ABA 式的旧事件）时
      // 一律拒绝，不落盘。
      archiveId: archive.archiveId,
      expectedRev: store.attemptRev(attempt),
      // 渲染这一行时这一把的状态，随点击一起交回档案层做预期状态核对。
      expected: undone ? 'undone' : 'effective',
      titleText:
        (undone ? '已撤回 · ' : '刚才 · ') +
        selectedRoute.name +
        ' 第 ' +
        target.number +
        ' 把 · ' +
        attemptResultText(attempt.result),
      metaText:
        '本场 ' + activeSession.label + ' · ' + activeSession.gymName + ' · ' + timeText(attempt.createdAt),
      stateText,
      canUndo: !undone,
      undoText: retry && !undone ? '重试撤回这一把' : '撤回这一把',
      canRestore: undone,
      restoreText: retry && undone ? '重试恢复这一把' : '恢复这一把'
    };
  },

  /**
   * 撤回最近一把（T033）：结果按钮下方那一行的「撤回这一把」。
   */
  undoLatestAttempt(event) {
    this.changeRecentAttempt(event, 'undo');
  },

  /**
   * 恢复最近一把（T033）：撤回后同一区域下方那一行的「恢复这一把」。
   * 恢复拿回的是原来那一把（同 ID、同序号、同结果），只在抱石守卫拒绝时不动任何数据。
   */
  restoreLatestAttempt(event) {
    this.changeRecentAttempt(event, 'restore');
  },

  /**
   * 撤回 / 恢复共用的一段（T033）：两个入口只在动作本身不同，目标核对、预期状态与
   * 预期版本、去重凭据、失败重试与「只按已落盘状态显示」完全相同，因此共用。
   *
   * 目标只从点击这一行带下来的原把次 ID 与归属取，并**先按最新档案复核**它仍是本场
   * 本线路的最近一把：晚到的点击（这一把已经不是最近一把、这条线又多了未落盘的把次、
   * 已经切到别的场次/线路、档案已被重置）一律不落盘，只按最新档案刷新。行下标、名称与
   * 当前可见行都不参与判定，所以去掉一行也不会改到别的把次。
   *
   * 交给档案层的这一次动作带着三样从渲染那一刻带下来的东西：档案 ID（dataset.archiveId）、
   * 有效状态版本（dataset.expectedRev）与预期状态（dataset.expected）。任一与最新持久
   * 状态不符（换档后的迟到点击、3→2→3 之后重放的旧事件）都不落盘。幂等来自档案层的持久
   * 凭据（原把次上的 settledOps + 撤回状态 + rev），不是计时防抖：同一个 opId 的迟到重试
   * 被认成「早已结清」，只回读状态，不会把撤回翻回成恢复、也不会把恢复翻回成撤回。
   *
   * 写失败或回执丢失（write-failed / unreadable）时**重新读一次落盘状态**再显示：页面
   * 上的把数、完攀状态与最近一把一律以已落盘的档案为准，未落盘的那一次保留原动作与同一个
   * opId 的重试入口。只有原档案 ID、这一把的场次/线路归属与**这次操作自己**的落盘凭据都
   * 对上，才把那一次认成「其实已落盘、只是回执丢了」；否则按盘上真实状态显示，并说明盘上
   * 那一把不是这次写入的（另一个写者或另一份档案），不认领别人的结果。
   */
  changeRecentAttempt(event, action) {
    if (this.data.loadError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId;
    if (!attemptId) return;

    const loaded = store.loadState();
    if (!loaded.ok) {
      // 档案读不出来：不猜状态、不写盘，只报出真实错误。
      this.setData({ storageError: loaded.error });
      this.refreshView();
      return;
    }
    const archive = loaded.archive;
    this.archive = archive;

    const asUndo = action === 'undo';
    const noun = asUndo ? '撤回' : '恢复';
    const sessionId = dataset.sessionId || '';
    const routeId = dataset.routeId || '';
    const key = attemptId + '\u0000' + action;
    // **原按钮捕获的**档案 ID：页面上的这一行只属于渲染它的那一份档案。写失败后重读比对
    // 「盘上这一份还是我原来那一份吗」用的就是它——不能拿已经被 outcome.archive 覆盖过的
    // this.archive 顶替这个原引用，否则换档后的重读会被当成同一份档案。
    const originArchiveId = dataset.archiveId || archive.archiveId;

    // 换档之后的迟到点击：事件带的是**渲染那一刻**的档案 ID，与当前档案不一致时整条
    // 不落盘，也不按新档案改写任何把次。
    if (
      typeof dataset.archiveId === 'string' &&
      dataset.archiveId &&
      dataset.archiveId !== archive.archiveId
    ) {
      delete this._attemptOps[key];
      this.setData({
        storageError: '',
        notice: '这一把属于原来的本机档案，这次' + noun + '没有生效，已按当前档案刷新。'
      });
      this.refreshView();
      return;
    }

    // 已经切到别的场次/线路：这一行渲染时的归属不再是当前画面，旧事件一律拒绝，不改
    // 任何一把、也不改归属。
    if (
      (sessionId && sessionId !== archive.activeSessionId) ||
      (routeId && routeId !== archive.activeRouteId)
    ) {
      delete this._attemptOps[key];
      this.setData({
        storageError: '',
        notice: '已经切到别的场次或线路，这次' + noun + '没有生效，已按最新档案刷新。'
      });
      this.refreshView();
      return;
    }

    if (hasPendingOnRoute(archive, sessionId, routeId)) {
      this.setData({
        storageError: '',
        notice: '这条线还有一把没保存：先在「待保存」行重试保存，再' + noun + '。'
      });
      this.refreshView();
      return;
    }

    const target = recentAttemptTarget(archive, sessionId, routeId);
    if (!target || target.attempt.id !== attemptId) {
      // 这一把已经不是最近一把（例如又记了一把）：只刷新，不撤回非最近的一把。
      delete this._attemptOps[key];
      this.setData({
        storageError: '',
        notice: '最近一把已经变了，已按最新档案刷新；' + noun + '只在最近这一把上生效。'
      });
      this.refreshView();
      return;
    }

    // 已经是要的状态（撤回一个已撤回的、恢复一个有效的）：不写盘，只说明下一步。
    // 回执丢失后的重试也会走到这里——按最新档案看，这次意图其实已经落盘。
    const undone = store.isUndoneAttempt(target.attempt);
    if (asUndo === undone) {
      delete this._attemptOps[key];
      this._recentStatus = { attemptId, undone: asUndo };
      this.setData({
        storageError: '',
        notice: asUndo
          ? '这一把已经撤回，可用下方的「恢复这一把」找回。'
          : '这一把已经在本场里了，不用再恢复。'
      });
      this.refreshView();
      return;
    }

    const previous = this._attemptOps[key];
    const outcome = (asUndo ? store.undoAttempt : store.restoreAttempt)(attemptId, {
      routeId,
      sessionId,
      // 渲染那次点击时用的档案 ID；页面上的这一行不属于当前档案时不落盘。
      archiveId: originArchiveId,
      // 预期状态就是这一次点击所依据的画面（WXML 把渲染时的状态随点击带下来）。
      // 与档案层读到的最新持久状态不符时按 stale 拒绝，基于过时画面的操作不落盘。
      expected:
        dataset.expected === 'undone' || dataset.expected === 'effective'
          ? dataset.expected
          : asUndo
            ? 'effective'
            : 'undone',
      // 渲染时这一把的 rev：与最新持久版本不符（旧的撤回/恢复事件在状态又变过之后才
      // 送到）时按过期事件拒绝，一个字都不写。
      expectedRev: Number.isInteger(dataset.expectedRev) ? dataset.expectedRev : undefined,
      opId: previous ? previous.opId : ''
    });
    if (outcome.archive) this.archive = outcome.archive;

    if (outcome.ok) {
      delete this._attemptOps[key];
      // 记下这次动作带来的状态：撤回成功即「已撤回」，恢复成功即「有效」。
      this._recentStatus = { attemptId, undone: asUndo };
      this.setData({ storageError: '', notice: '' });
      this.refreshView();
      return;
    }

    if (outcome.code === 'write-failed' || outcome.code === 'unreadable') {
      // 未确认落盘：不显示乐观结果，先按**最新落盘状态**重读一次档案，把数、完攀状态、
      // 最近一把与逐把列表都以磁盘为准。
      const reloaded = store.loadState();
      if (reloaded.ok) {
        this.archive = reloaded.archive;
        const fresh = reloaded.archive.attempts.find(item => item.id === attemptId) || null;
        const stateMatches = Boolean(fresh && store.isUndoneAttempt(fresh) === asUndo);
        // 「这一次确实写进去了，只是回执没回来」要说准，三样都得对上：
        //   1) 盘上仍是**原来那一份档案**（reloaded.archive.archiveId 与点击时原按钮捕获的
        //      档案 ID 相等）。另一份档案可以把把次、场次、线路乃至已结清操作的 opId 全都
        //      复用一遍，只比后面几项就会把别人的结果认成这次的；
        //   2) 这一把确实属于这次点击带下来的场次与线路；
        //   3) 这一把上留着**这次操作自己**的落盘凭据（outcome.opId 记在 settledOps 里，
        //      且意图相符）。
        // 只比状态是不够的：另一个写者、另一份档案或另一个 opId 都可能把这一把带到同样的
        // 状态，那时不能说「此前那次已成功」。
        const sameArchive = reloaded.archive.archiveId === originArchiveId;
        const receipt =
          sameArchive &&
          fresh &&
          (!sessionId || fresh.sessionId === sessionId) &&
          (!routeId || fresh.routeId === routeId)
            ? store.attemptSettledOp(fresh, outcome.opId)
            : null;
        const landedByThisOperation = Boolean(receipt && receipt.undone === asUndo);
        if (stateMatches && landedByThisOperation) {
          // 清掉重试入口，按盘上状态给出确认。
          delete this._attemptOps[key];
          this._recentStatus = { attemptId, undone: asUndo };
          this.setData({
            storageError: '',
            notice: noun + '已经落盘（回执丢失），已按最新档案确认。'
          });
          this.refreshView();
          return;
        }
        if (stateMatches) {
          // 盘上已经是这个状态，但凭据不属于这次操作：可能是同一份档案里另一个写入完成的，
          // 也可能是盘上已经换成了另一份本机档案（把次与 opId 撞名）。按真实盘上状态显示
          // （把数、完攀状态与最近一把都以磁盘为准），明确区别开：既不认领那次回执，也不让
          // 人重试一个已经成立的动作。
          delete this._attemptOps[key];
          this.setData({
            storageError: '',
            notice: sameArchive
              ? '盘上这一把已经是' +
                (asUndo ? '已撤回' : '有效') +
                '状态，但不是这次' +
                noun +
                '写入的（可能由另一处写入完成）；已按最新档案显示。'
              : '盘上这一把已经是' +
                (asUndo ? '已撤回' : '有效') +
                '状态，但盘上已经换成另一份本机档案，不是这次' +
                noun +
                '写入的；已按最新档案显示。'
          });
          this.refreshView();
          return;
        }
      }
      // 确实没落盘：保留原动作与同一个 opId 的重试入口（同一把、同一动作，不会换成
      // 相反动作或另一把），并把失败原因显示出来。
      this._attemptOps[key] = { opId: outcome.opId, error: outcome.error };
      this.setData({
        storageError: outcome.error,
        notice: noun + '未保存，可再点一次「重试' + noun + '这一把」。'
      });
      this.refreshView();
      return;
    }

    // 守卫拒绝（例如抱石会变成第二次完攀）、过期的点击或这一把已不存在：不动任何数据。
    delete this._attemptOps[key];
    this.setData({
      storageError: '',
      notice: outcome.error || '这次' + noun + '没有生效，已按最新档案刷新。'
    });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 备注

  openNoteEditor(event) {
    const attemptId = event && event.currentTarget && event.currentTarget.dataset.attemptId;
    if (!attemptId || !this.data.selectedRoute) return;
    const attempt = this.data.attempts.find(item => item.id === attemptId);
    if (!attempt) return;

    this.setData({
      noteEditor: {
        attemptId: attempt.id,
        routeId: this.data.selectedRoute.id,
        sessionId: this.data.activeSession ? this.data.activeSession.id : '',
        routeName: this.data.selectedRoute.name,
        attemptLabel: attempt.label,
        resultText: attempt.resultText,
        text: attempt.note
      }
    });
  },

  onNoteInput(event) {
    this.setData({
      'noteEditor.text': (event && event.detail && event.detail.value) || ''
    });
  },

  cancelNote() {
    this.setData({ noteEditor: null });
  },

  /**
   * 只改这一把的备注：把数、结果、序号、场次与其他把次（含第一把）都不动。
   */
  saveNote() {
    const editor = this.data.noteEditor;
    if (!editor) return;

    const outcome = store.setAttemptNote(editor.attemptId, {
      note: editor.text,
      routeId: editor.routeId,
      sessionId: editor.sessionId
    });
    if (outcome.archive) this.archive = outcome.archive;

    if (!outcome.ok) {
      this.setData({ storageError: outcome.error, notice: '备注未保存，可重试。' });
      this.refreshView();
      return;
    }

    this.setData({ noteEditor: null, storageError: '', notice: '' });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 按把更正

  /**
   * 「改为未完成」：只改正渲染这一行对应的那一把已确认完攀。
   *
   * 目标来自该行按钮带下来的原把次 ID 与归属，天然与这一行一一对应：
   * 连点/双击原坐标只会重复更正同一把（第二次幂等返回 resolved），不会改到另一把；
   * 只翻这一把的 result，把数、ID、序号、场次与备注都不变；之后可以正常再记完攀。
   */
  correctSend(event) {
    if (this.data.loadError) return;
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
      // 已改好的这一把留在原位置变成只读回读：下面的行不上移，同一坐标不会被
      // 下一把的控件接管（另一把必须再点它自己那一行）。
      this._correctedRows[attemptId] = {
        statusText: '已改为未完成 · 本把次保留原时间、场次与备注'
      };
      this.setData({ storageError: '', notice: outcome.code === 'resolved' ? '这一把已经是未完成。' : '' });
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
