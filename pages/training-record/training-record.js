/**
 * 单线记录页（T036）
 *
 * 从本场线路列表整行进入，或加线成功后直达。页面只服务**一条长期线路在**一场训练里
 * 的记录：按入口带下来的 archiveId + sessionId + routeId 核对归属，然后把这一条线的
 * 结果按钮、本场把数、最近一把的撤回／恢复与「更正结果」、待保存重试放在一页。
 *
 * 数据归属：
 * - 入口缺参、场次/线路不存在、线路不属于这一场，或档案已经换成另一份时，页面只显示
 *   可见原因与返回路径，不展示别场别线的把次，也不接受任何写入；
 * - 把次、撤回状态、待保存与完攀判定全部来自 utils/training-store.js；写入、重试与
 *   按把更正走 utils/training-record-actions.js 的共用事件处理，与本场逐把页、线路
 *   历史页是同一份实现；
 * - 照片、卡点、跨天历史与清单操作不在这里重复，页面只提供「线路历史」入口。
 *
 * T041 在本页首屏加一行紧凑的线路照片入口：现场记把时就地留一张。没有照片时给「添加线路
 * 照片」（拍照 / 相册），有照片时显示缩略图与当前照片版本的标记数量。照片的读写仍由
 * utils/training-photo-controller.js 的同一份控制器与照片服务完成，预览—确认—取消—失败
 * 重试的流程与线路历史页完全一致；照片文件与索引、场次、把次、备注都不经过本页另写一份。
 * 有照片时点这一行进原来的二级大图标记页（pages/training-photo-marks），按本机档案、
 * 长期线路与**当前**照片版本核对后才打开，换图与移除仍在二级页，不在首屏铺第二套编辑。
 *
 * 返回本场列表后行读数由列表页自己按最新档案重算；本页重开（onShow）也按最新档案
 * 刷新，因此撤回、恢复与待保存重试的结果在两边一致。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const photoMarks = require('../../utils/training-photo-marks.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const SESSION_URL = '/pages/training-session/training-session';
const ROUTE_URL = '/pages/training-route/training-route';
const ATTEMPTS_URL = '/pages/training-attempts/training-attempts';
const PHOTO_MARKS_URL = '/pages/training-photo-marks/training-photo-marks';

Page({
  data: {
    ready: false,
    loadError: '',     // 本机档案损坏/版本不支持/读取失败的可见报错
    contextError: '',  // 入口缺参、串档或线路不属于这一场的可见原因（不写盘）
    storageError: '',  // 本次操作未落盘（不报已保存）
    notice: '',        // 说明性提示（守卫、快速双击等），不改数据

    archiveId: '',
    activeSession: null,
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

    // 最近一把的撤回、恢复与「更正结果」：结果按钮下方的固定操作区。null 表示不显示。
    // 较早的合资格把次在本场逐把页各自一行处理，本页不再铺独立更正区。
    recentAttempt: null,

    // 线路主照片（T041）：现场入口只渲染控制器推导的状态。
    // null = 本页不展示（缺参、串档或还没读档）；其余状态与线路历史页同一套。
    recordPhoto: null,
    // 照片动作标记只读当前照片版本的数量，编辑在二级大图页。
    photoMarkCount: 0,
    photoMarkCountText: '',
    photoMarksError: ''
  },

  onLoad(query) {
    // 本实例的临时状态，全部不落盘（与旧场内页同名，便于沿用事件语义）：
    // _lastTap 快速双击窗口；_correctedRows / _correctionFailures 按把更正的只读回读
    // 与失败重试标记；_recentStatus 刚落盘成功的那一次动作带来的状态（只用于本页确认
    // 文案）。没落盘的保存与撤回/恢复请求跨页面实例保留在 actions 的应用运行期缓存里，
    // 这里不另存一份页面副本。
    this._lastTap = {};
    this._correctedRows = {};
    this._correctionFailures = {};
    // 已打开、还没回应的更正确认：同一把连点沿用这一次，不叠第二个弹窗。
    this._correctionPrompt = null;
    this._recentStatus = null;
    // 照片控制器只在本页创建一次；照片读写全在控制器里，页面不另存文件或索引。
    this._photoUi = null;
    this._unloaded = false;
    this._context = actions.parseRecordQuery(query);
    this.loadPage();
    this.loadRecordPhoto();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从明细或线路历史返回、或页面重新显示：按最新档案重算同一场同一线。
    // 照片也重读一次，与线路历史页、二级大图页看到的是同一张主照片与同一版标记。
    this.loadPage();
    this.loadRecordPhoto();
  },

  /**
   * 离开页面：照片控制器自身的迟到回调据此不再改页面。
   * 照片与标记的写入都在控制器与二级页里完成，本页不持有标记编辑状态。
   */
  onUnload() {
    this._unloaded = true;
    this._correctionPrompt = null;
  },

  /**
   * 按入口参数重新读档并核对归属。只读；缺参/串档/失效时不写盘。
   */
  loadPage() {
    const context = actions.loadRecordContext(this._context);
    if (!context.ok) {
      this.archive = context.archive || null;
      this._session = null;
      this._route = null;
      this.setData({
        ready: true,
        loadError: context.code === 'unreadable' ? context.error : '',
        contextError: context.code === 'unreadable' ? '' : context.error,
        storageError: '',
        notice: '',
        archiveId: '',
        activeSession: null,
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
        resultLocked: false,
        resultLockHint: '',
        recentAttempt: null,
        // 入口/档案不可用：不展示任何照片，也不受理照片写入。
        recordPhoto: null,
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: ''
      });
      return;
    }

    this.archive = context.archive;
    this._session = context.session;
    this._route = context.route;
    this.setData({
      ready: true,
      loadError: '',
      contextError: '',
      storageError: '',
      notice: ''
    });
    this.refreshView();
  },

  retryLoad() {
    this.loadPage();
  },

  /**
   * 由当前档案重新推导这条线在本场的展示；不改动任何已保存数据。
   */
  refreshView() {
    const archive = this.archive;
    const session = this._session;
    const route = this._route;
    if (!archive || !session || !route) return;

    const activeSession = {
      id: session.id,
      gymId: session.gymId,
      gymName: store.gymName(archive, session.gymId),
      dateText: session.date,
      label: store.sessionLabel(archive, session)
    };
    const completion = store.routeCompletion(archive, route.id);
    const selectedRoute = {
      id: route.id,
      name: route.name,
      // 旧 V 级线路没有 climbType，按抱石读取；只读展示，不回写档案。
      climbType: climbTypeOf(route),
      grade: route.grade,
      colorName: route.colorName || '',
      colorHex: route.colorHex || '#dee2e6',
      isCompleted: Boolean(completion.completed),
      isClosed: Boolean(completion.closed),
      completionText: actions.completionText(completion)
    };

    const labels = actions.attemptLabelMap(archive, session.id, route.id);
    const attempts = store
      .attemptsFor(archive, { sessionId: session.id, routeId: route.id })
      .map(attempt => ({
        id: attempt.id,
        label: labels.get(attempt.id) || '',
        resultText: actions.attemptResultText(attempt.result),
        timeText: actions.timeText(attempt.createdAt),
        note: attempt.note || '',
        hasNote: Boolean(attempt.note)
      }));

    // 待保存行：档案里的「进行中」操作 + 当前应用运行期里第一段写就失败、还没落盘的
    // 操作（换页回来仍按原 opId 重试；跨档案按 archiveId 隔离）。
    const fromArchive = (archive.pendingSaves || [])
      .filter(op => op.sessionId === session.id && op.routeId === route.id)
      .sort((left, right) => (left.seq || 0) - (right.seq || 0))
      .map(op => ({
        opId: op.opId,
        // 重试按钮把发起时这一条待保存记录的归属一起带回：换档后同 ID 的旧事件
        // 在写入前就能被档案层/事件层识别，不会提交到另一份档案的同名场次线路。
        archiveId: archive.archiveId,
        sessionId: op.sessionId,
        routeId: op.routeId,
        label: labels.get(op.opId) || '',
        resultText: actions.attemptResultText(op.result),
        statusText: '未保存 · 点「重试保存」按同一把重试',
        canRetry: true
      }));
    const localOnly = actions
      .failedSaveEntries(archive)
      .filter(
        op =>
          op.sessionId === session.id &&
          op.routeId === route.id &&
          !fromArchive.some(row => row.opId === op.opId)
      )
      .map(op => ({
        opId: op.opId,
        archiveId: op.archiveId || archive.archiveId,
        sessionId: op.sessionId,
        routeId: op.routeId,
        label: '',
        resultText: actions.attemptResultText(op.result),
        statusText: '未保存 · 点「重试保存」按同一把重试',
        canRetry: true
      }));
    const pendingRows = fromArchive.concat(localOnly);

    const resultLocked = pendingRows.length > 0;
    const routeCountText = pendingRows.length
      ? attempts.length + ' 把 · ' + pendingRows.length + ' 把待保存'
      : attempts.length + ' 把';
    // 最近一把旁只放这一把自己的撤回／恢复与「更正结果」；较早的合资格把次与跨场候选
    // 各有原来的目的地（本场逐把 / 线路历史），本页不再铺第二套更正区。
    const recentAttempt = actions.recentAttemptView.call(
      this,
      archive,
      activeSession,
      selectedRoute,
      pendingRows,
      route
    );

    this.setData({
      archiveId: archive.archiveId,
      activeSession,
      selectedRoute,
      routeStateText: actions.completionText(completion),
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
      recentAttempt
    });
  },

  // ---------------------------------------------------------------- 页面入口

  /**
   * 本场逐把：只带这一场、这一条线的原 ID；逐把页按同一组参数再核对一次归属。
   */
  openAttempts() {
    if (this.data.loadError || this.data.contextError) return;
    if (!this.archive || !this._session || !this._route) return;
    wx.navigateTo({
      url:
        ATTEMPTS_URL +
        '?' +
        actions.recordQueryString({
          archiveId: this.archive.archiveId,
          sessionId: this._session.id,
          routeId: this._route.id
        })
    });
  },

  /**
   * 线路历史：按原长期 routeId 进入照片、卡点、跨天历史与清单操作。
   * 同时带上渲染这一页时的本机档案 ID：换了档案之后同名的 routeId 不能顶替原线路，
   * 历史页已有入口归属核验（旧资料直达只带 routeId 的兼容路径不变）。
   */
  openRouteProfile() {
    if (this.data.loadError || this.data.contextError) return;
    const archiveId = this.archive && this.archive.archiveId;
    const routeId = this._route && this._route.id;
    if (!archiveId || !routeId) return;
    wx.navigateTo({
      url:
        ROUTE_URL +
        '?' +
        actions.recordQueryString({ archiveId, routeId })
    });
  },

  // ---------------------------------------------------------------- 线路照片（T041）

  /**
   * 照片控制器只在本页创建一次；档案 ID 由控制器从本机档案读取。
   * 打开本页本身不写照片，只有用户点按拍照/相册/确认才动文件与索引。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createTrainingPhotoController(this, {
        onChange: () => this.applyPhotoView(),
        onNotice: text => this.setData({ notice: text })
      });
    }
    return Promise.resolve(this._photoUi.init());
  },

  /**
   * 读回这条线的当前主照片。缺参、串档或档案换成另一份时不读、不展示，
   * 也不受理任何照片写入（控制器按档案代次拒掉迟到回调）。
   */
  loadRecordPhoto() {
    const routeId = this._route && this._route.id;
    if (this.data.loadError || this.data.contextError || !routeId) {
      if (this._photoUi) this._photoUi.clear();
      this.setData({
        recordPhoto: null,
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: ''
      });
      return Promise.resolve();
    }
    // 先过一遍 initPhotoUi：档案 ID 变化（重置本机档案）后照片服务要跟上。
    return Promise.resolve(this.initPhotoUi()).then(() => {
      if (!this._photoUi) return;
      return this._photoUi.load([routeId]).then(() => this.applyPhotoView());
    });
  },

  /**
   * 只更新当前线路的照片展示，并按当前照片版本重读标记数量；不改任何已保存数据。
   */
  applyPhotoView() {
    const routeId = this._route && this._route.id;
    if (!this._photoUi || !routeId || !this.archive) return;
    const view = this._photoUi.view(routeId);
    this.setData({ recordPhoto: view });
    this.refreshPhotoMarkCount();
  },

  /** 当前照片版本：档案 + 线路 + 当前照片 ID；缺一不读数量。 */
  photoMarkTarget() {
    const view = this.data.recordPhoto || {};
    return {
      archiveId: (this.archive && this.archive.archiveId) || '',
      routeId: (this._route && this._route.id) || '',
      photoId: view.photoId || ''
    };
  },

  /**
   * 只读当前照片上的标记数量：与线路历史页读同一份标记记录。
   * 损坏或版本不支持时显示可见原因，不显示 0 个的假成功。打开本页与从二级页返回都走这里。
   */
  refreshPhotoMarkCount() {
    const target = this.photoMarkTarget();
    if (!target.archiveId || !target.routeId || !target.photoId) {
      this.setData({ photoMarkCount: 0, photoMarkCountText: '', photoMarksError: '' });
      return;
    }
    const listed = photoMarks.listMarks(target);
    if (!listed.ok) {
      this.setData({
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: listed.error
      });
      return;
    }
    this.setData({
      photoMarkCount: listed.marks.length,
      photoMarkCountText: '照片动作标记 · ' + listed.marks.length + ' 个',
      photoMarksError: ''
    });
  },

  /**
   * 打开原来的二级大图标记页：带齐本机档案、长期线路与**当前**照片 ID。
   * 入口带的是渲染那一刻的三个 ID；与当前照片版本不一致（二级页刚换了照片）时只刷新
   * 并提示，不再按旧照片打开，避免把操作落到另一张图上。
   */
  openRoutePhotoMarks(event) {
    if (this.data.loadError || this.data.contextError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const routeId = (this._route && this._route.id) || '';
    const photoId = (this.data.recordPhoto && this.data.recordPhoto.photoId) || '';
    if (!archiveId || !routeId || !photoId) {
      this.loadRecordPhoto();
      this.setData({ notice: '这条线路当前没有可打开的照片，请先添加照片。' });
      return;
    }
    const stale =
      (dataset.archiveId && dataset.archiveId !== archiveId) ||
      (dataset.routeId && dataset.routeId !== routeId) ||
      (dataset.photoId && dataset.photoId !== photoId);
    if (stale) {
      this.loadRecordPhoto();
      this.setData({ notice: '照片或线路已经变化，请按当前缩略图重新进入。' });
      return;
    }
    wx.navigateTo({
      url:
        PHOTO_MARKS_URL +
        '?archiveId=' +
        encodeURIComponent(archiveId) +
        '&routeId=' +
        encodeURIComponent(routeId) +
        '&photoId=' +
        encodeURIComponent(photoId),
      fail: () => {
        this.setData({ notice: '大图标记页没有打开，请再点一次缩略图。' });
      }
    });
  },

  /**
   * 照片事件的归属：只认本页这一条线。
   * 入口不属于当前档案，或带的是另一条线（同名 B 线、换页后的旧事件）时拿不到 routeId，
   * 控制器不会收到写入请求。
   */
  photoRouteId(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = (this._route && this._route.id) || '';
    if (!routeId) return '';
    if (dataset.routeId && dataset.routeId !== routeId) return '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (dataset.archiveId && dataset.archiveId !== archiveId) return '';
    return routeId;
  },

  chooseRecordPhoto(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const source = dataset.source;
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId || (source !== 'camera' && source !== 'album')) {
      return Promise.resolve();
    }
    return this._photoUi.choose(routeId, source);
  },

  confirmRecordPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.confirm(routeId);
  },

  cancelRecordPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    // 取消预览只丢掉临时路径：照片索引、主图与既有卡点都不变。
    this._photoUi.cancelPreview(routeId);
    this.applyPhotoView();
  },

  retryRecordPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.retry(routeId);
  },

  dismissRecordPhotoFailure(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return;
    this._photoUi.dismiss(routeId);
    this.applyPhotoView();
  },

  reloadRecordPhoto(event) {
    const routeId = this.photoRouteId(event);
    if (!this._photoUi || !routeId) return Promise.resolve();
    return this._photoUi.load([routeId]).then(() => this.applyPhotoView());
  },

  /**
   * 回到本场线路列表：正常路径就是系统返回；这里显式给缺参/失效时一个可点的出口。
   */
  backToList() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: SESSION_URL });
  },

  // ---------------------------------------------------------------- 共用事件

  recordAttempt: actions.recordAttempt,
  retryPendingAttempt: actions.retryPendingAttempt,
  undoLatestAttempt: actions.undoLatestAttempt,
  restoreLatestAttempt: actions.restoreLatestAttempt,
  changeRecentAttempt: actions.changeRecentAttempt,

  // ---------------------------------------------------------------- 更正结果（T042）

  /**
   * 最近一把旁的「更正结果」（模板里沿用 correctSend 这个绑定名）：先核对这一下仍指向
   * 当前这一把可更正的完攀，再确认。
   *
   * 确认弹窗写明原把次的日期/场次/岩馆、原序号与原结果（完攀 → 未完成），取消时一个
   * 字节都不写；确认后仍走 utils/training-record-actions.js 的同一份 correctSend，
   * 只翻这一把的结果、不改把数。连点同一把只弹一次确认；这一下若已不属于当前这一把，
   * 只提示并按最新档案刷新。本页界面不再直接调用无确认的写入口。
   */
  correctSend(event) {
    if (this.data.loadError || this.data.contextError) return Promise.resolve(null);
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const recent = this.data.recentAttempt;
    const attemptId = dataset.attemptId || '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (!recent || !recent.correctable || !attemptId || recent.attemptId !== attemptId) {
      this.setData({ notice: '这一把当前没有可更正的完攀，已按最新数据刷新。' });
      this.refreshView();
      return Promise.resolve(null);
    }

    const stale =
      (dataset.routeId && dataset.routeId !== recent.routeId) ||
      (dataset.sessionId && dataset.sessionId !== recent.sessionId) ||
      (dataset.archiveId && dataset.archiveId !== recent.archiveId) ||
      recent.routeId !== ((this._route && this._route.id) || '') ||
      recent.sessionId !== ((this._session && this._session.id) || '') ||
      recent.archiveId !== archiveId;
    if (stale) {
      this.setData({ notice: '这一下不属于当前这一把，没有改动任何记录。' });
      this.refreshView();
      return Promise.resolve(null);
    }

    return actions.confirmCorrection.call(this, {
      attemptId,
      routeId: recent.routeId,
      sessionId: recent.sessionId,
      archiveId: recent.archiveId,
      label: recent.correctLabel,
      contextText: recent.correctContextText,
      resultText: '完攀'
    });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
