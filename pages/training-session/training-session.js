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
 * 页面自己只保存「展示用的当前状态」与本实例的临时信息（未落盘操作、已更正的只读
 * 回读行、快速双击窗口），不承担数据权威。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
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
    newRouteGradeText: gradeText(grade)
  };
}

/**
 * 「第 N 把」：同一场次同一线路内按把次序号排出的位置。
 * 已保存与仍待确认的把次共用序号，因此重试后编号稳定，不会因为补齐而跳号。
 */
function attemptLabelMap(archive, sessionId, routeId) {
  const confirmed = (archive.attempts || [])
    .filter(item => item.sessionId === sessionId && item.routeId === routeId)
    .map(item => ({ key: item.id, seq: item.seq || 0 }));
  const pending = (archive.pendingSaves || [])
    .filter(item => item.sessionId === sessionId && item.routeId === routeId)
    .map(item => ({ key: item.opId, seq: item.seq || 0 }));
  const ordered = confirmed.concat(pending).sort((left, right) => left.seq - right.seq);
  const labels = new Map();
  ordered.forEach((entry, index) => labels.set(entry.key, '第 ' + (index + 1) + ' 把'));
  return labels;
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

    // 按把「改为未完成」：每一把各有自己的控件
    correctionRows: [],
    correctionStatusText: '',

    noteEditor: null,

    // 选原线 / 新建线路
    gymRoutes: [],
    newRouteVisible: false,
    newRouteName: '',
    newRouteColors: ROUTE_COLORS,
    newRouteColorIndex: 0,
    newRouteColorName: ROUTE_COLORS[0].name,
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
    selectedWishlist: null
  },

  onLoad(query) {
    // 本实例的临时状态，全部不落盘：
    // _failedOps  本实例发起但未落盘的把次（按线路分组），重试沿用同一 opId；
    // _lastTap    快速双击窗口；
    // _correctedRows / _correctionFailures  按把更正的只读回读与失败重试标记；
    // _photoUi / _newRoutePhotoPath  照片控制器与新建表单里已选的临时照片路径；
    // _wishlistRows  本馆「下次想爬」的派生条目（不落盘，照片状态叠加在上面）。
    this._failedOps = {};
    this._lastTap = {};
    this._correctedRows = {};
    this._correctionFailures = {};
    this._formDirty = false;
    this._newRouteDirty = false;
    this._photoUi = null;
    this._newRoutePhotoPath = '';
    this._wishlistRows = [];
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
    // 正在填写的场次表单与新建线路表单都不重读重算，避免把输入冲掉。
    const keepForm =
      (this._formDirty && this._formOpen) ||
      (this._newRouteDirty && this.data.newRouteVisible);
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
      newRouteVisible: keepForm ? this.data.newRouteVisible : false,
      newRouteName: keepForm ? this.data.newRouteName : '',
      newRouteColorIndex: keepForm ? this.data.newRouteColorIndex : 0,
      newRouteColorName: keepForm ? this.data.newRouteColorName : ROUTE_COLORS[0].name,
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

    this.setData({
      activeSession,
      sameDaySessions,
      routes,
      selectedRoute,
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
      gymRoutes,
      // 照片展示与逐把记录各自独立：照片由控制器按 routeId 推导，不改档案数据。
      routePhoto: selectedRoute && this._photoUi
        ? this._photoUi.view(selectedRoute.id)
        : null
    });

    // 本馆「下次想爬」清单：只读清单与档案派生，不写盘。
    this.refreshWishlist();
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
    this._lastTap = {};
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
    this.setData({ storageError: '', notice: '', noteEditor: null });
    this.refreshView();
    // 换场次后当前线路可能不同：按新选中线路读取照片。
    this.loadPhotos();
  },

  // ---------------------------------------------------------------- 线路

  selectRoute(event) {
    if (this.data.loadError) return;
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId || routeId === this.archive.activeRouteId) return;

    const outcome = store.selectRoute(routeId);
    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      if (outcome.archive) this.archive = outcome.archive;
      this.refreshView();
      return;
    }
    this.archive = outcome.archive;
    this._lastTap = {};
    this.setData({ storageError: '', notice: '', noteEditor: null });
    this.refreshView();
    // 换线路后按新选中线路读取照片（同一线路的照片不重复请求）。
    this.loadPhotos();
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
   * 继续原线：把这条长期线路关联到当前场次并选中（关联幂等，重复点不新增关联）。
   * 「选原线」与「下次想爬」清单的条目共用这一条路径，因此清单里点开的就是
   * 清单上那个长期线路 ID，不会另建一条同名线路，也不会把把次记到别的线上。
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
      this.setData({ storageError: linked.error });
      this.refreshView();
      return;
    }

    const selected = store.selectRoute(routeId);
    this.archive = (selected.ok ? selected.archive : linked.archive) || this.archive;
    if (!selected.ok) {
      this.setData({
        storageError: selected.error
      });
      this.refreshView();
      return;
    }
    this._lastTap = {};
    this.setData({ storageError: '', notice: '', noteEditor: null });
    this.refreshView();
    this.loadPhotos();
  },

  toggleNewRouteForm() {
    const visible = !this.data.newRouteVisible;
    const form = defaultNewRouteForm();
    this._newRouteDirty = false;
    // 收起或重开表单都会丢掉上一次未提交的临时照片选择。
    this._newRoutePhotoPath = '';
    this.setData(
      visible
        ? {
            newRouteVisible: true,
            newRouteName: '',
            newRouteError: '',
            newRoutePhoto: null,
            newRouteColorIndex: 0,
            newRouteColorName: ROUTE_COLORS[0].name,
            newRouteTypeIndex: form.newRouteTypeIndex,
            newRouteType: form.newRouteType,
            newRouteGrades: form.newRouteGrades,
            newRouteGradeIndex: form.newRouteGradeIndex,
            newRouteGrade: form.newRouteGrade,
            newRouteGradeText: form.newRouteGradeText
          }
        : { newRouteVisible: false, newRouteName: '', newRouteError: '', newRoutePhoto: null }
    );
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
    const safeIndex = ROUTE_COLORS[index] ? index : 0;
    this.setData({
      newRouteColorIndex: safeIndex,
      newRouteColorName: ROUTE_COLORS[safeIndex].name
    });
  },

  /**
   * 新建线路并选中。类型与等级必须各自有效且相互匹配：空值、越界或错配都直接拒绝，
   * 不新建线路、不改当前线路，也不静默回落到首个等级；错误组合由档案层再次把关，
   * 不落盘。
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

    const color = ROUTE_COLORS[this.data.newRouteColorIndex] || ROUTE_COLORS[0];
    const outcome = store.createRoute({
      sessionId: active.id,
      name,
      climbType,
      grade,
      colorName: color.name,
      colorHex: color.hex
    });
    if (!outcome.ok) {
      if (outcome.archive) this.archive = outcome.archive;
      this.setData({ newRouteError: outcome.error, storageError: '' });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    const form = defaultNewRouteForm();
    // 新建表单里已选的照片（临时路径）在这里交给照片控制器：创建成功后才保存。
    const pendingPhotoPath = this._newRoutePhotoPath;
    this._newRouteDirty = false;
    this._newRoutePhotoPath = '';
    this._lastTap = {};
    this.setData({
      newRouteVisible: false,
      newRouteName: '',
      newRouteError: '',
      newRoutePhoto: null,
      storageError: '',
      notice: '',
      noteEditor: null,
      newRouteTypeIndex: form.newRouteTypeIndex,
      newRouteType: form.newRouteType,
      newRouteGrades: form.newRouteGrades,
      newRouteGradeIndex: form.newRouteGradeIndex,
      newRouteGrade: form.newRouteGrade,
      newRouteGradeText: form.newRouteGradeText
    });
    this.refreshView();

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
    const outcome = wishlist.addWishlist(routeId);
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
    const outcome = wishlist.removeWishlist(routeId);
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
    const outcome = wishlist.archiveWishlist(routeId);
    this.applyWishlistAction(
      outcome,
      '归档',
      '已归档；照片、把次与历史都保留，仍可按原线路 ID 回看。',
      '这条线路已经归档。'
    );
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
   */
  recordAttempt(event) {
    if (this.data.loadError) return;
    const result = event && event.currentTarget && event.currentTarget.dataset.result;
    if (result !== 'fail' && result !== 'send') return;

    const active = this.data.activeSession;
    if (!active) {
      this.setData({ notice: '请先开始一场训练' });
      return;
    }
    const routeId = this.archive.activeRouteId;
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

    // 落盘失败：记下这一把的操作 ID（含两段写都没落盘的情况），提示未保存，
    // 重试时沿用同一个 opId，只提交一次。
    this._failedOps[active.id + '\u0000' + routeId] = {
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
   */
  retryPendingAttempt(event) {
    if (this.data.loadError) return;
    const opId = event && event.currentTarget && event.currentTarget.dataset.opId;
    if (!opId) return;

    const fromArchive = (this.archive.pendingSaves || []).find(op => op.opId === opId) || null;
    const localKey = Object.keys(this._failedOps).find(
      key => this._failedOps[key].opId === opId
    );
    const source = fromArchive || (localKey ? this._failedOps[localKey] : null);
    if (!source) {
      this.setData({ notice: '这条待保存记录已不存在，正在按最新档案刷新。' });
      this.loadPage({ keepForm: this._formDirty && this._formOpen });
      return;
    }

    const outcome = store.saveAttempt({
      opId,
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

    if (localKey) {
      this._failedOps[localKey] = Object.assign({}, this._failedOps[localKey], {
        opId: outcome.opId || opId
      });
    } else if (outcome.opId) {
      this._failedOps[source.sessionId + '\u0000' + source.routeId] = {
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
