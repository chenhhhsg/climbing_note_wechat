/**
 * 单线记录页（T036 / T045）
 *
 * 从本场线路列表整行进入，或加线成功后直达。页面只服务**一条长期线路在**一场训练里
 * 的记录：按入口带下来的 archiveId + sessionId + routeId 核对归属，然后把这一条线的
 * 结果按钮、本场把数、本场本线把次（最新在前）与待保存重试放在一页。
 *
 * 数据归属：
 * - 入口缺参、场次/线路不存在、线路不属于这一场，或档案已经换成另一份时，页面只显示
 *   可见原因与返回路径，不展示别场别线的把次，也不接受任何写入；
 * - 把次、撤回状态、待保存与完攀判定全部来自 utils/training-store.js；写入、重试、
 *   按把备注与按把更正走 utils/training-record-actions.js 的共用事件处理，与本场逐把页、
 *   线路历史页是同一份实现；
 * - 照片、卡点、跨天历史与清单操作不在这里重复，页面只提供紧凑照片入口（T041）。
 *
 * T045：现场把次直接排在普通文档流里，最新在前、一把一框（复用 T044 配色与边框）。
 * 每把显示原编号、结果、时间与已有备注；点这一行的「编辑」只打开这一把的备注，视频
 * 沿用原把次视频页。合资格的完攀在行内给「改成未完成」，最近一把在行内给「这把多记了」
 * / 「恢复这一把」，失败重试与撤回后的恢复都留在原框。现场不再有独立的「本场逐把」
 * 跳转与「线路历史」入口；缩略图仍打开原来的二级大图标记页。
 *
 * T048：按场次与长期线路读取原序号倒序。最新一把完整展示结果、时间与一行备注；更早的
 * 把次各占一条紧凑短行（保留边框、原序号、结果色与时间），点旧行只展开这一把的详情，
 * 备注、视频与纠错入口仍在原把次上。展开态只存在本页（expandedAttemptId，按原把次 ID），
 * 不新增存储字段；新一把落盘成功后上一把自动收成短行，失败、取消与待保存都不换层级。
 *
 * T049：最新一把的备注右侧固定一个视频入口：无片显示「＋ 添加视频」，有片在同一位置
 * 显示「回看视频」；旧行收起时只有真有本机视频的那一把显示小视频图标，点行展开后按该把
 * 的真实关联给同一个入口。入口只带这一行的四个原 ID 打开原把次视频页，复用既有的归属
 * 核对、索引只读与本机保存；页面不新增视频字段，也不改播放、索引与保存口径。
 *
 * T050：最新一把右侧原本收着「更多」纠错菜单；现场试用返工后改为一个文字按钮「撤销」，
 * 按一下直接撤回当前这一把（沿用档案层的两段写、原把校验与失败重试）。现场不再有
 * 「改为未完成」菜单、较早把次的行内更正入口，也没有撤销后的「恢复」按钮；更正仍按
 * 原范围在线路历史与本场逐把页处理。撤销成功后这一把离开本场有效记录与逐把列表，
 * 总数减一，前一把只补位显示；下一次成功记把前不出现撤销入口，避免同一坐标连点把
 * 前一把也撤掉。撤销唯一有效完攀后，抱石限制随档案层的有效集合自动解除、可以重记。
 *
 * 返回本场列表后行读数由列表页自己按最新档案重算；本页重开（onShow）也按最新档案
 * 刷新，因此撤销、待保存重试与重记的结果在两边一致。
 *
 * T048 返工：旧把展开只保留「头部（原序、结果、时间、收起）＋ 有备注时的原正文 ＋
 * 下一行同排的备注入口与视频入口」，不再另挂视频状态文字；点「备注」时就地编辑区紧跟
 * 头部替换操作行，输入框约两行高、长文在框内滚动，取消与保存紧随其后。未完成的旧行
 * 不留空纠错槽（现场也不再渲染更正入口）。显示编号（「第 N 把」）只数本场本线的有效
 * 把次——撤回的那一把不占号，现场、归档逐把、线路历史与视频标题共用档案层同一份投影。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const photoMarks = require('../../utils/training-photo-marks.js');
const attemptVideo = require('../../utils/attempt-video.js');
// T048–T050 追加返工：长按删除把次时协调档案、视频索引与文件的三阶段与重开恢复。
const attemptDelete = require('../../utils/training-attempt-delete.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const SESSION_URL = '/pages/training-session/training-session';
const ATTEMPT_VIDEO_URL = '/pages/attempt-video/attempt-video';
const PHOTO_MARKS_URL = '/pages/training-photo-marks/training-photo-marks';
// 撤销成功会收起旧卡、重新排布结果区；同一触点的第二次点按可能落到刚出现的结果按钮。
// 只拦「真实撤销坐标附近、很短时间内的结果事件」，不拦位置明显不同的立即重记，也不拦
// 没有触点信息的程序化调用（测试与数据层直接驱动）。
const UNDO_REBOUND_WINDOW_MS = 600;
const UNDO_REBOUND_RADIUS_PX = 44;
// 长按整张把次卡会先弹「删除这一把」菜单；部分基础库/机型在 longpress 结束后仍补一个
// tap。这里在长按后的短窗口内忽略同一行的展开事件，避免「既弹菜单又展开」。
const LONG_PRESS_TAP_GUARD_MS = 700;
// T054：长按整卡后的第一步菜单只有这一项。
const DELETE_ATTEMPT_MENU_LABEL = '删除这一把';
// 页面令牌只增不减：迟到的确认/异步回执只允许更新发起时的那一页上下文。
let pageTokenSeq = 0;
function nextPageToken() {
  pageTokenSeq += 1;
  return 'page-' + Date.now().toString(36) + '-' + pageTokenSeq;
}

/** 取 tap 事件里真实触点坐标（微信 tap 的 detail 带页面坐标 x/y）；没有就返回 null。 */
function tapPoint(event) {
  const detail = (event && event.detail) || {};
  const x = Number(detail.x);
  const y = Number(detail.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** 事件时间戳；没有就用本机时钟（只在两次事件都带时间戳时比较同一个时钟）。 */
function tapTime(event) {
  return event && Number.isFinite(event.timeStamp) ? event.timeStamp : null;
}

/**
 * 长按事件带回来的 rev 允许数字或数字字符串：这一把的 rev 是 0 时，WXML 渲染成
 * 「0」，部分基础库在 dataset 里给字符串「0」——两种都有效，空值才算缺失。
 */
function isRevisionValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  if (typeof value === 'string') return /^[0-9]+$/.test(value);
  return false;
}

/** 确认框失败时只留非敏感证据：errMsg 里的短错误码，不带用户文案、路径或凭据。 */
function modalErrorCode(error) {
  const message = error && (error.errMsg || error.message);
  if (typeof message !== 'string' || !message) return '';
  const parts = message.split(':');
  return String(parts.length > 1 ? parts[1] : parts[0]).trim().slice(0, 60);
}

/** 原生 fail 里的「取消」不是错误：用户关掉菜单/确认框时不写盘，也不报失败。 */
function isCancelNativeError(error) {
  const message = error && (error.errMsg || error.message);
  return typeof message === 'string' && /cancel|canceled|cancelled|取消/i.test(message);
}

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
    // 现场把次（T045/T048）：本场本线有效把次 + 刚撤回的最近一把，最新在前；
    // 只有最新一把完整展示，更早的把次收成短行，点行展开原把详情。
    attemptCards: [],
    hasAttemptCards: false,
    // 展开态只在当前页面按原把次 ID 记一份（不落盘）：'' = 只有最新一把完整展示。
    expandedAttemptId: '',
    // 行内备注编辑：只作用于所点那一把，保存/取消按原 attemptId 与编辑代次核对。
    noteEditor: null,
    pendingRows: [],
    hasPending: false,
    // 有未落盘的把次时锁定结果按钮：先在待保存行按同一操作重试，确认后才记下一把。
    resultLocked: false,
    resultLockHint: '',

    // 最近一把（T033/T042）：只作为现场把次行的派生输入——最近一把那一行据此拿到
    // 撤回/恢复的预期状态与版本、检索到同一把的重试 opId。null 表示没有可操作的最近一把。
    recentAttempt: null,
    // 长按删除最新一把后的持久门槛（被删除的最大内部 seq）：最近一把的 seq 不大于它时
    // 不给「撤销」入口。只读派生，不落本页。
    undoBarrier: 0,
    // 本页实例的令牌：随长按事件一起带回，迟到事件/回执不能更新另一页上下文。
    pageToken: '',
    // 已删除记录的本机视频副本清理状态（journal 里有未完成条目时才显示）。
    cleanupNotice: '',
    cleanupRetryVisible: false,

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
    // 已打开、还没回应的删除流程（长按整卡后的菜单/确认）：同一把连点沿用这一次，
    // 不叠第二个菜单或确认框。
    this._deletePrompt = null;
    // 长按后的短窗口：同一行在这段时间内的展开事件不生效（原生手势差异兜底）。
    this._lastLongPress = Object.create(null);
    this._recentStatus = null;
    // 上一次渲染时置顶的原把次 ID：新一把落盘成功后上一把自动收成短行（只改本页展示）。
    this._latestAttemptId = '';
    // 本页已经成功撤销过的原把次（原把次 ID + 点击时渲染的版本）：同一按钮的退化事件
    // 不再进共用实现，既不会把「已撤销第 N 把」换成别的提示，也不会落到补位的前一把上。
    this._undoneAttempts = Object.create(null);
    // 最近一次成功撤销的真实触点：只用于拦截同一触点的短时「结果」回弹。
    this._undoRebound = null;
    // 照片控制器只在本页创建一次；照片读写全在控制器里，页面不另存文件或索引。
    this._photoUi = null;
    this._unloaded = false;
    // 每次进入这一页换一个令牌；本页所有删除确认与异步回执都只认这个令牌。
    this._pageToken = nextPageToken();
    this.setData({ pageToken: this._pageToken });
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
    // 长按删除的记录已移出档案后，若视频副本还没清理完，重开这一页自动再试一次；
    // 没有 journal / 没有待清理条目时这一步不碰文件系统。
    this.recoverDeletedMedia();
  },

  /**
   * 离开页面：照片控制器自身的迟到回调据此不再改页面。
   * 照片与标记的写入都在控制器与二级页里完成，本页不持有标记编辑状态。
   */
  onUnload() {
    this._unloaded = true;
    this._correctionPrompt = null;
    // 页面离开后到达的菜单/确认回调不再删除任何东西（回调里还会再查 _unloaded）。
    this._deletePrompt = null;
    // 令牌作废：本次删除的异步回执也不再更新这一页。
    this._pageToken = '';
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
        attemptCards: [],
        hasAttemptCards: false,
        expandedAttemptId: '',
        noteEditor: null,
        pendingRows: [],
        hasPending: false,
        resultLocked: false,
        resultLockHint: '',
        recentAttempt: null,
        undoBarrier: 0,
        pageToken: this._pageToken || '',
        cleanupNotice: '',
        cleanupRetryVisible: false,
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
    const savedRows = store.attemptsFor(archive, {
      sessionId: session.id,
      routeId: route.id
    });
    const attempts = savedRows.map(attempt => ({
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
    // 最近一把这一行仍是原边界：只有它能撤回/恢复；现场把次行据此给这一行两个并排槽。
    // T048–T050 追加返工：长按删除最新一把后，持久门槛会收住补位前一把的「撤销」。
    const undoBarrier = attemptDelete.deletedSeqBarrier(
      archive.archiveId,
      session.id,
      route.id
    );
    const recentAttempt = actions.recentAttemptView.call(
      this,
      archive,
      activeSession,
      selectedRoute,
      pendingRows,
      route,
      { undoBarrier }
    );

    // 现场把次行（T045/T048）：视频关联状态只读索引，一次读给本场本线这些把次；
    // 派生只读，行内动作仍由共用事件处理按原把次 ID 与归属落盘。
    const videoLinks = attemptVideo.videoLinkMap(archive.archiveId, savedRows);
    const baseCards = actions.attemptCardRows(
      archive,
      activeSession,
      selectedRoute,
      route,
      recentAttempt,
      videoLinks,
      this
    );
    // 展开展示（T048）只在页面内按原把次 ID 管理：最新一把始终完整，更早的把次默认短行。
    // 新一把落盘成功（latest 换人）时清空展开态，上一把随之自动收成短行；写失败、取消与
    // 还没落盘的待保存都不会换 latest，所以不会多切一次。
    const latestAttemptId = baseCards.length ? baseCards[0].id : '';
    let expandedAttemptId = this.data.expandedAttemptId || '';
    if (this._latestAttemptId && this._latestAttemptId !== latestAttemptId) {
      expandedAttemptId = '';
    }
    if (expandedAttemptId && !baseCards.some(item => item.id === expandedAttemptId)) {
      expandedAttemptId = '';
    }
    this._latestAttemptId = latestAttemptId;
    const attemptCards = baseCards.map(item => {
      const expanded = item.isLatest || item.id === expandedAttemptId;
      return Object.assign({}, item, {
        expanded,
        // 长按事件除了 deleteRev 还带回本页令牌：过期页面/旧渲染的事件不能落到新上下文。
        pageToken: this._pageToken,
        // T050 返工：撤销入口只给「最新一把且它仍是最近一把」——撤销成功后最近一把
        // 已经变成刚撤回的那一把（它不在现场列表里），前一把虽然补位成最新一把，
        // 却不会再拿到撤销入口；必须再成功记一把才有新的可撤销目标。这样同一个坐标
        // 的第二击不会把前一把也撤掉，写失败时原行仍保留「重试撤销」。
        showWithdraw: Boolean(item.isLatest && item.canUndo),
        // T049：旧行收起时只有这一把真有本机视频才显示小视频图标；展开后在原把详情里
        // 给「＋ 添加视频」或「回看视频」。图标只是提示，点按仍落到整行展开原把。
        showVideoIcon: !expanded && Boolean(item.hasVideo) && Boolean(item.canOpenVideo)
      });
    });
    // 编辑中的这一把若已不在可编辑列表里（被撤回或换档），收起编辑器而不是把输入写到别处。
    let noteEditor = this.data.noteEditor;
    if (noteEditor && !attemptCards.some(item => item.id === noteEditor.attemptId && item.canEditNote)) {
      noteEditor = null;
    }

    // 已删除记录的本机视频副本清理状态：只读 journal，不扫目录；没有未完成条目时留空。
    const cleanup = attemptDelete.pendingStatus(archive.archiveId);

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
      attemptCards,
      hasAttemptCards: attemptCards.length > 0,
      expandedAttemptId,
      noteEditor,
      pendingRows,
      hasPending: pendingRows.length > 0,
      resultLocked,
      resultLockHint: resultLocked
        ? '上一把还没保存：先在「待保存」行点「重试保存」，确认后再记下一把。'
        : '',
      recentAttempt,
      undoBarrier,
      pageToken: this._pageToken || '',
      cleanupNotice: cleanup.text,
      cleanupRetryVisible: cleanup.pending > 0 || Boolean(cleanup.error)
    });
  },

  // ---------------------------------------------------------------- 现场把次（T045 / T048）

  /**
   * 旧把次短行：点一下只展开/收起所点的这一把，最新一把始终保持完整展示。
   * 展开态只存在本页（expandedAttemptId，按原把次 ID），切换、收起与返回都不写盘；
   * 这一下若已不属于本页这一场这一条线（换档、过期行、被撤回），只按最新档案刷新。
   */
  toggleAttemptRow(event) {
    if (this.data.loadError || this.data.contextError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    // 部分基础库在 longpress 结束后还会补一个 tap：同一行在长按后的短窗口内不再展开，
    // 避免「确认框和展开同时发生」。位置/行不同的下一次短按照常。
    const pressedAt = attemptId ? (this._lastLongPress || {})[attemptId] : 0;
    if (pressedAt && Date.now() - pressedAt < LONG_PRESS_TAP_GUARD_MS) return;
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const sessionId = (this._session && this._session.id) || '';
    const routeId = (this._route && this._route.id) || '';
    const row = (this.data.attemptCards || []).find(item => item.id === attemptId) || null;
    const stale =
      !row ||
      (dataset.archiveId && dataset.archiveId !== archiveId) ||
      (dataset.sessionId && dataset.sessionId !== sessionId) ||
      (dataset.routeId && dataset.routeId !== routeId);
    if (stale) {
      this.setData({ notice: '这一行已经变化，没有切换展开；已按最新数据刷新。' });
      this.refreshView();
      return;
    }
    // 最新一把没有收起态：点它的行不改层级，也不触发任何写入。
    if (row.isLatest) return;
    this.setData({
      expandedAttemptId: this.data.expandedAttemptId === attemptId ? '' : attemptId
    });
    this.refreshView();
  },

  /**
   * 行内备注编辑：点的是哪一行就只打开哪一把，再点同一行不重置已输入的内容。
   * 写入语义完全走共用的 actions.openNoteEditor：目标只认原 attemptId 与归属。
   */
  openNoteEditor(event) {
    const attemptId = event && event.currentTarget && event.currentTarget.dataset.attemptId;
    const current = this.data.noteEditor;
    if (current && attemptId && current.attemptId === attemptId) return;
    const outcome = actions.openNoteEditor.call(this, event);
    const editor = this.data.noteEditor;
    if (editor && editor.hasNote === undefined) {
      this.setData({ 'noteEditor.hasNote': Boolean(editor.text) });
    }
    return outcome;
  },

  /**
   * 视频入口：只把这一行渲染时的原把次与归属带到原把次视频页。
   * 打开前按最新档案再核对一次：这一行不属于本页这一条线、这一把被撤回、换了档案或
   * 还没保存时不打开；视频页会用同一组四个 ID 再核对一次。
   */
  openAttemptVideo(event) {
    if (this.data.loadError || this.data.contextError) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const sessionId = (this._session && this._session.id) || '';
    const routeId = (this._route && this._route.id) || '';
    if (!archiveId || !sessionId || !routeId || !attemptId) {
      this.setData({ notice: '无法定位这一把的原归属，请重试。' });
      return;
    }

    // 迟到点击可能还带着上一行渲染时的归属：与当前这一场这一条线不一致就整下拒掉。
    const stale =
      (dataset.archiveId && dataset.archiveId !== archiveId) ||
      (dataset.sessionId && dataset.sessionId !== sessionId) ||
      (dataset.routeId && dataset.routeId !== routeId);
    if (stale) {
      this.setData({ notice: '这一下不属于本场这一条线的把次，没有打开视频页。' });
      this.refreshView();
      return;
    }

    const ids = { archiveId, sessionId, routeId, attemptId };
    const context = attemptVideo.loadVideoContext(ids);
    if (!context.ok) {
      this.loadPage();
      this.setData({ notice: context.error });
      return;
    }

    wx.navigateTo({
      url: ATTEMPT_VIDEO_URL + '?' + attemptVideo.videoQueryString(ids),
      fail: () => {
        this.setData({ notice: '视频页没有打开，请再点一次。' });
      }
    });
  },

  /**
   * 「改成未完成」的确认接线（T042，模板沿用 correctSend 这个绑定名）。
   *
   * T050 返工（现场）：单线记录页不再渲染更正入口——更正的可见范围只在线路历史与本场
   * 逐把页。这里保留原有的确认接线，供页面既有的确认/回读逻辑与旧读数复用；真正的写入
   * 仍是 utils/training-record-actions.js 的同一份 correctSend，不新增第二套持久模型。
   * 确认弹窗写明原把次的日期/场次/岩馆、原序号与原结果，取消时一个字节都不写。
   */
  correctSend(event) {
    if (this.data.loadError || this.data.contextError) return Promise.resolve(null);
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    const row = (this.data.attemptCards || []).find(item => item.id === attemptId) || null;
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const sessionId = (this._session && this._session.id) || '';
    const routeId = (this._route && this._route.id) || '';
    if (!row || !row.correctable || !archiveId || !sessionId || !routeId) {
      this.setData({ notice: '这一把当前没有可更正的完攀，已按最新数据刷新。' });
      this.refreshView();
      return Promise.resolve(null);
    }

    const stale =
      (dataset.routeId && dataset.routeId !== routeId) ||
      (dataset.sessionId && dataset.sessionId !== sessionId) ||
      (dataset.archiveId && dataset.archiveId !== archiveId);
    if (stale) {
      this.setData({ notice: '这一下不属于本场这一条线的把次，没有改动任何记录。' });
      this.refreshView();
      return Promise.resolve(null);
    }

    const activeSession = this.data.activeSession || {};
    return actions.confirmCorrection
      .call(this, {
        attemptId,
        routeId,
        sessionId,
        archiveId,
        label: row.label,
        contextText: [
          activeSession.dateText || '',
          activeSession.label || '',
          activeSession.gymName ? '· ' + activeSession.gymName : ''
        ]
          .filter(Boolean)
          .join(' '),
        resultText: '完攀'
      })
      .then(result => {
        // 更正真正落盘后就地重读；取消或写失败都保留原读数，用户可在原处重试。
        if (this._correctedRows && this._correctedRows[attemptId]) {
          this.refreshView();
        }
        return result === undefined ? null : result;
      });
  },

  /**
   * 长按整张把次卡：先弹「删除这一把」菜单（T054）。
   *
   * 只作用于本页这一场这一条线里**已保存的有效把次**；短按仍走 toggleAttemptRow。
   * 整卡是原生 view，六项身份都在卡根节点自己的 data 上：把次 ID、档案/场次/线路、
   * 这一把的 rev 与页面令牌必须齐备且与本页当前渲染一致，不从触点位置、显示序号
   * 或子节点推测。菜单打开前、选中后与确认后各核对一次；两次异步原生 UI 之间内容
   * 变化（换档、切线、新记、撤销、视频换版）时整条拒绝，不把删除落到补位后的另一把。
   *
   * 打开流程时把四层证据一起记下（原把次与四 ID、rev/备注/结果、视频片段身份、
   * 当前有效把次有序 ID 列表）。菜单或确认取消都只结束本次操作：不写盘、不清备注
   * 草稿、不改展开态；同一把重复长按复用同一次菜单/确认，不叠第二个弹窗。
   */
  requestDeleteAttempt(event) {
    if (this.data.loadError || this.data.contextError) return Promise.resolve(null);
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';

    // 原生手势差异兜底：同一行的 longpress 之后若还补一个 tap，不再展开。
    if (attemptId) {
      this._lastLongPress = this._lastLongPress || Object.create(null);
      this._lastLongPress[attemptId] = Date.now();
    }

    // 同一把连点沿用已经打开的那一次菜单/确认；已有别的确认时不叠第二个弹窗。
    const opened = this._deletePrompt;
    if (opened) return opened.attemptId === attemptId ? opened.promise : Promise.resolve(null);

    // 菜单打开前先核对原目标：不属于本页、已失效或还有待保存时连菜单都不弹。
    const initialTarget = this.resolveDeleteTarget(dataset);
    if (!initialTarget) return Promise.resolve(null);

    const prompt = { attemptId, pageToken: initialTarget.pageToken, promise: null };
    this._deletePrompt = prompt;
    prompt.promise = this.runDeletePrompt(prompt, dataset).then(
      answer => {
        if (this._deletePrompt === prompt) this._deletePrompt = null;
        // 菜单/确认关掉后才可能补到 release tap：守卫窗口从流程结束时刻重新起算，
        // 松手不会把刚长按的这一把展开或收起。
        this.settleAttemptLongPress(attemptId);
        return answer;
      },
      error => {
        if (this._deletePrompt === prompt) this._deletePrompt = null;
        this.settleAttemptLongPress(attemptId);
        if (this._unloaded) return { ok: false, code: 'cancelled' };
        this.notifyDeleteGuard(
          '删除流程没有完成，这次没有删除；请再长按一次这张把次卡重试。',
          '删除流程未完成，未删除'
        );
        return { ok: false, code: 'failed', error: modalErrorCode(error) };
      }
    );
    return prompt.promise;
  },

  /** 长按流程结束（选中、取消或失败）时把短按守卫窗口从此刻重新起算。 */
  settleAttemptLongPress(attemptId) {
    if (!attemptId) return;
    this._lastLongPress = this._lastLongPress || Object.create(null);
    this._lastLongPress[attemptId] = Date.now();
  },

  /**
   * 从长按事件解析本次删除的原目标，并核对原归属、版本、待保存与视频关联。
   * 菜单前和菜单选中后各调用一次；拒绝时给页内 notice + 视口内 toast 并刷新。
   */
  resolveDeleteTarget(dataset) {
    const data = dataset || {};
    const attemptId = data.attemptId || '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const sessionId = (this._session && this._session.id) || '';
    const routeId = (this._route && this._route.id) || '';
    const row = (this.data.attemptCards || []).find(item => item.id === attemptId) || null;

    const stale =
      !row ||
      !archiveId ||
      !sessionId ||
      !routeId ||
      // 事件必须带回渲染这一行时的原身份；缺一项、或与本页这一场这一条线不一致，
      // 都按过期事件处理（0 与「0」是有效的 rev，不算缺失）。
      data.attemptId !== row.id ||
      !data.archiveId ||
      data.archiveId !== archiveId ||
      data.archiveId !== row.archiveId ||
      !data.sessionId ||
      data.sessionId !== sessionId ||
      data.sessionId !== row.sessionId ||
      !data.routeId ||
      data.routeId !== routeId ||
      data.routeId !== row.routeId ||
      !isRevisionValue(data.deleteRev) ||
      Number(data.deleteRev) !== Number(row.deleteRev) ||
      !data.pageToken ||
      data.pageToken !== this._pageToken;
    if (stale) {
      this.notifyDeleteGuard(
        '这一行已经变化，没有打开删除菜单；已按最新数据刷新。',
        '这一行已变化，未删除'
      );
      this.refreshView();
      return null;
    }
    if (row.canDelete === false || row.isUndone) {
      this.notifyDeleteGuard(
        '这一把不在有效记录里，不能长按删除；已按最新数据刷新。',
        '这一把不可删除'
      );
      this.refreshView();
      return null;
    }
    // 真实待保存：先让在途的那一把落盘，删除不能与两段写互相覆盖。
    if (this.data.pendingRows.length > 0 || this.data.resultLocked) {
      this.notifyDeleteGuard(
        '这条线还有一把没保存：先在「待保存」行重试保存，再删除这一把。',
        '还有一把没保存，未删除'
      );
      return null;
    }

    // 视频关联不可读时不猜「有没有视频」，也不删记录：稍后重试。
    const view = attemptVideo.videoClipView(archiveId, attemptId, { sessionId, routeId });
    if (!view || !view.ok) {
      this.notifyDeleteGuard(
        '本机视频关联暂时读取失败，这次没有打开删除菜单；请稍后重试。',
        '视频关联读取失败，未删除'
      );
      return null;
    }
    const clip = view.clip
      ? {
          clipId: view.clip.clipId,
          rev: Number(view.clip.rev) || 0,
          fileId: view.clip.fileId
        }
      : null;

    return {
      archiveId,
      sessionId,
      routeId,
      attemptId,
      label: row.label || '',
      note: row.note || '',
      result: row.isSend ? 'send' : 'fail',
      // rev 是这一把的有效状态版本（撤回/恢复会推进），不是显示序号。
      expectedRev: Number.isInteger(row.deleteRev) ? row.deleteRev : 0,
      clip,
      orderedIds: (this.data.attemptCards || []).map(item => item.id).join('|'),
      pageToken: this._pageToken
    };
  },

  /**
   * 两步原生 UI（菜单 → 确认）。每一步回来都重新核对原目标；取消静默结束，
   * 非取消的原生失败给页内 notice + 视口内 toast，两个字节都不写。
   */
  runDeletePrompt(prompt, dataset) {
    return this.askDeleteMenu().then(answer => {
      if (this._unloaded) return { ok: false, code: 'cancelled' };
      if (!answer || !answer.chosen) {
        if (answer && answer.reason === 'unavailable') {
          this.notifyDeleteGuard(
            '操作菜单没有打开，这次没有删除；请再长按一次这张把次卡重试。',
            '删除菜单未打开，未删除'
          );
          return { ok: false, code: 'menu-unavailable', reason: 'unavailable', error: '' };
        }
        if (answer && answer.reason === 'failed') {
          this.notifyDeleteGuard(
            '操作菜单打开失败' +
              (answer.error ? '（' + answer.error + '）' : '') +
              '，这次没有删除；请再长按一次这张把次卡重试。',
            '删除菜单打开失败，未删除'
          );
          return {
            ok: false,
            code: 'menu-unavailable',
            reason: 'failed',
            error: (answer && answer.error) || ''
          };
        }
        return { ok: false, code: 'cancelled' };
      }

      // 菜单选中后、确认框打开前：页面令牌与原目标都要仍是发起时的那一个。
      if (!this._pageToken || this._pageToken !== prompt.pageToken) {
        this.notifyDeleteGuard(
          '已经离开这条线或换了本机档案，这次删除没有生效；已按最新数据刷新。',
          '页面已变化，未删除'
        );
        this.refreshView();
        return { ok: false, code: 'context-changed' };
      }
      // 按最新档案重读后再核对一次：菜单打开期间被撤回/换档/切线时不再显示确认框，
      // 视频关联也按这一刻的索引重新取（不沿用长按瞬间的旧范围）。
      const loaded = store.loadState();
      if (!loaded.ok) {
        this.archive = loaded.archive || this.archive;
        this.setData({
          storageError: loaded.error,
          notice: '没有删除这一把：本机档案读不出来。'
        });
        this.refreshView();
        return { ok: false, code: 'unreadable' };
      }
      this.archive = loaded.archive;
      this.refreshView();
      const target = this.resolveDeleteTarget(dataset);
      if (!target) return { ok: false, code: 'stale' };

      return this.askDeleteConfirm(target).then(confirmAnswer => {
        if (this._unloaded) return { ok: false, code: 'cancelled' };
        // 弹窗不可用与用户取消要分开：前者给可见重试提示，且同样一个字节都不写。
        if (!confirmAnswer || !confirmAnswer.confirmed) {
          if (confirmAnswer && confirmAnswer.reason !== 'cancelled') {
            this.notifyDeleteGuard(
              '删除确认框没有打开，这次没有删除；请再长按一次这张把次卡重试。',
              '确认框未打开，未删除'
            );
            return {
              ok: false,
              code: 'modal-unavailable',
              reason: (confirmAnswer && confirmAnswer.reason) || 'failed',
              error: (confirmAnswer && confirmAnswer.error) || ''
            };
          }
          return { ok: false, code: 'cancelled' };
        }
        // 确认回来的页面已经不是发起时的那一页：不落任何删除。
        if (!this._pageToken || this._pageToken !== target.pageToken) {
          this.notifyDeleteGuard(
            '已经离开这条线或换了本机档案，这次删除没有生效；已按最新数据刷新。',
            '页面已变化，未删除'
          );
          return { ok: false, code: 'context-changed' };
        }
        return this.performDeleteAttempt(target);
      });
    });
  },

  /**
   * 第一步菜单：只有「删除这一把」。
   * 返回 { chosen, reason: 'chosen'|'cancelled'|'unavailable'|'failed', error }。
   */
  askDeleteMenu() {
    return new Promise(resolve => {
      const api = typeof wx !== 'undefined' ? wx : null;
      if (!api || typeof api.showActionSheet !== 'function') {
        resolve({ chosen: false, reason: 'unavailable', error: '' });
        return;
      }
      try {
        api.showActionSheet({
          itemList: [DELETE_ATTEMPT_MENU_LABEL],
          success(result) {
            const tapIndex = result ? Number(result.tapIndex) : NaN;
            if (tapIndex === 0) {
              resolve({ chosen: true, reason: 'chosen', error: '' });
              return;
            }
            // 只有一项：负索引/undefined 或显式 cancel 都是用户取消；其他索引是原生异常。
            if ((result && result.cancel) || !Number.isFinite(tapIndex) || tapIndex < 0) {
              resolve({ chosen: false, reason: 'cancelled', error: '' });
              return;
            }
            resolve({ chosen: false, reason: 'failed', error: 'invalid-index' });
          },
          fail(error) {
            resolve({
              chosen: false,
              reason: isCancelNativeError(error) ? 'cancelled' : 'failed',
              error: modalErrorCode(error)
            });
          }
        });
      } catch (error) {
        resolve({ chosen: false, reason: 'failed', error: modalErrorCode(error) });
      }
    });
  },

  /**
   * 卡内独立控件（备注入口、编辑区、视频入口、撤销）自己的长按语义：这里只吞掉
   * 冒泡到整卡的长按，避免触碰这些控件时发起父级删除；点按与输入仍由各自处理器负责。
   */
  ignoreLongPress() {},

  /**
   * 长按删除被拒绝、或确认框根本没打开时的可见反馈（T048–T050 追加返工）：
   * 页内 notice 说清原因，同时用非阻塞 toast 保证当前视口里也看得到——长按多发生在
   * 列表下方，页顶的 notice 可能在视口外。只做提示：不写盘，不动草稿与视频字节。
   */
  notifyDeleteGuard(notice, toast) {
    this.setData({ notice });
    const api = typeof wx !== 'undefined' ? wx : null;
    if (!api || typeof api.showToast !== 'function') return;
    try {
      api.showToast({ title: toast || notice, icon: 'none', duration: 2200 });
    } catch (error) {
      // toast 只是补充反馈；不可用时页内 notice 仍然可见。
    }
  },

  /**
   * 删除确认弹窗：返回明确结果，不把「弹窗没弹出来」当成用户取消。
   * - confirmed: true —— 用户点了「删除」；
   * - reason 'cancelled' —— 用户点了「取消」或在弹窗外取消；
   * - reason 'unavailable' —— 当前环境没有 showModal；
   * - reason 'failed' —— fail 回调、同步异常，或 success 既没 confirm 也没 cancel。
   * 失败时带非敏感错误码（errMsg 里的短码），不打印用户文案或凭据。
   * 有视频与无视频的文案不同；取消不写盘、不收起备注编辑器，草稿保持原样。
   */
  askDeleteConfirm(target) {
    return new Promise(resolve => {
      const api = typeof wx !== 'undefined' ? wx : null;
      if (!api || typeof api.showModal !== 'function') {
        resolve({ confirmed: false, reason: 'unavailable', error: '' });
        return;
      }
      try {
        api.showModal({
          title: target.label ? '删除' + target.label + '？' : '删除这一把？',
          content: target.clip
            ? '将删除这把记录、备注及攀笔保存的视频副本。'
            : '将删除这把记录和备注。',
          confirmText: '删除',
          cancelText: '取消',
          success(result) {
            if (result && result.confirm) {
              resolve({ confirmed: true, reason: 'confirmed', error: '' });
              return;
            }
            if (result && result.cancel) {
              resolve({ confirmed: false, reason: 'cancelled', error: '' });
              return;
            }
            // 既没确认也没取消：当作弹窗异常，交给调用方给重试提示。
            resolve({ confirmed: false, reason: 'failed', error: 'no-result' });
          },
          fail(error) {
            resolve({
              confirmed: false,
              reason: isCancelNativeError(error) ? 'cancelled' : 'failed',
              error: modalErrorCode(error)
            });
          }
        });
      } catch (error) {
        resolve({ confirmed: false, reason: 'failed', error: modalErrorCode(error) });
      }
    });
  },

  /**
   * 确认之后、真正下笔之前再按最新档案核对一次：
   * 档案/场次/线路没变、这一条线的有效把次序列与打开确认时完全一致。
   * 任何迟到确认都在这里被拦住，只刷新页面，不删除「现在编号对上的另一把」。
   */
  performDeleteAttempt(target) {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.archive = loaded.archive;
      this.setData({
        storageError: loaded.error,
        notice: '没有删除这一把：本机档案读不出来。'
      });
      this.refreshView();
      return Promise.resolve({ ok: false, code: 'unreadable' });
    }
    this.archive = loaded.archive;

    const contextChanged =
      loaded.archive.archiveId !== target.archiveId ||
      !this._session ||
      this._session.id !== target.sessionId ||
      !this._route ||
      this._route.id !== target.routeId;
    if (contextChanged) {
      this.setData({
        notice: '已经离开这条线或换了本机档案，这次删除没有生效；已按最新数据刷新。'
      });
      this.refreshView();
      return Promise.resolve({ ok: false, code: 'context-changed' });
    }

    const currentIds = store
      .attemptsFor(loaded.archive, {
        sessionId: target.sessionId,
        routeId: target.routeId
      })
      // 现场列表最新在前；attemptsFor 按内部 seq 升序，倒过来与 orderedIds 同向比较。
      .slice()
      .reverse()
      .map(item => item.id)
      .join('|');
    if (currentIds !== target.orderedIds) {
      this.setData({
        notice: '这一条线的把次已经变化，这次删除没有生效；请按最新画面重新长按确认。'
      });
      this.refreshView();
      return Promise.resolve({ ok: false, code: 'stale' });
    }

    this.setData({ storageError: '', notice: '正在删除' + target.label + '…' });
    return attemptDelete
      .deleteAttempt({
        archiveId: target.archiveId,
        sessionId: target.sessionId,
        routeId: target.routeId,
        attemptId: target.attemptId,
        expectedRev: target.expectedRev,
        expectedNote: target.note,
        expectedResult: target.result,
        clip: target.clip
      })
      .then(outcome => this.applyDeleteOutcome(target, outcome));
  },

  /** 删除结果的页面读数：记录与视频副本分别说明，不把「视频没清完」说成两件都完成。 */
  applyDeleteOutcome(target, outcome) {
    // 只在发起这次删除的原页面上下文里更新读数：迟到回执不刷另一页/另一条线。
    const stillOriginalContext =
      !this._unloaded &&
      Boolean(this._pageToken) &&
      this._pageToken === target.pageToken &&
      Boolean(this._session) &&
      this._session.id === target.sessionId &&
      Boolean(this._route) &&
      this._route.id === target.routeId &&
      Boolean(this.archive) &&
      this.archive.archiveId === target.archiveId;
    if (!stillOriginalContext) return outcome;

    // 无论成功、未确认还是失败，都先按最新档案重读一次再做页面派生；module 的写入
    // 不会回写页面实例里的旧快照。
    const reloaded = store.loadState();
    if (reloaded.ok) this.archive = reloaded.archive;
    if (outcome && outcome.ok) {
      const receipt = outcome.receiptLost ? '（回执丢失，已按最新档案确认）' : '';
      const videoStatus = outcome.video && outcome.video.status;
      const videoPending = Boolean(videoStatus === 'pending');
      const videoKept = Boolean(videoStatus === 'kept');
      this.setData({
        storageError: '',
        notice:
          '已删除' +
          target.label +
          receipt +
          (videoPending
            ? '；记录已移出，本机视频副本未清理，可点上方「重试清理」。'
            : videoKept
              ? '；这段视频仍被其他记录使用，攀笔中的副本已按共享引用保留。'
              : '')
      });
      this.refreshView();
      return outcome;
    }

    const code = outcome && outcome.code;
    if (code === 'archive-unverified') {
      // 记录可能已经删掉但读回失败：不报成功，也不让人马上重复长按；凭据会在重开时核对。
      this.setData({
        storageError: (outcome && outcome.error) || '',
        notice: '这次删除的结果暂未确认；重开会按最新档案核对记录与视频副本。'
      });
      this.refreshView();
      return outcome;
    }
    if (
      code === 'archive-write-failed' ||
      code === 'journal-write-failed' ||
      code === 'journal-read-failed'
    ) {
      this.setData({
        storageError: (outcome && outcome.error) || '',
        notice: '这一把没有删除，可以再长按重试。'
      });
      this.refreshView();
      return outcome;
    }
    this.setData({
      storageError: '',
      notice: (outcome && outcome.error) || '这次删除没有生效，已按最新档案刷新。'
    });
    this.refreshView();
    return outcome;
  },

  /**
   * 重开自动恢复：journal 里有未完成条目时尝试一次；没有 journal 时不碰文件系统。
   * 失败保留可见状态与手动重试，不把记录和视频都说成完成。
   */
  recoverDeletedMedia() {
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (!archiveId) return Promise.resolve(null);
    const status = attemptDelete.pendingStatus(archiveId);
    if (!status.pending) {
      this.applyCleanupStatus(status);
      return Promise.resolve(null);
    }
    return attemptDelete
      .recoverPending({ archiveId })
      .then(() => {
        const next = attemptDelete.pendingStatus(archiveId);
        this.applyCleanupStatus(next);
        return next;
      })
      .catch(() => null);
  },

  applyCleanupStatus(status) {
    const state = status || { pending: 0, error: '', text: '' };
    this.setData({
      cleanupNotice: state.text || '',
      cleanupRetryVisible: Boolean(state.pending > 0 || state.error)
    });
  },

  /** 手动重试已删除记录的本机视频副本清理；失败时保留状态，可再次点按。 */
  retryVideoCleanup() {
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (!archiveId) return Promise.resolve(null);
    this.setData({ cleanupNotice: '正在重试清理本机视频副本…', cleanupRetryVisible: false });
    return attemptDelete
      .recoverPending({ archiveId })
      .then(result => {
        const status = attemptDelete.pendingStatus(archiveId);
        this.applyCleanupStatus(status);
        if (status.pending > 0) {
          this.setData({
            notice:
              '本机视频副本仍未清理，可稍后再试。' +
              (status.error ? '（' + status.error + '）' : '')
          });
        } else if (status.error) {
          this.setData({ notice: status.error });
        } else {
          this.setData({ notice: '本机视频副本已清理。' });
        }
        return result;
      })
      .catch(() => {
        this.setData({ notice: '重试清理没有完成，本机视频副本仍保留。' });
        this.refreshView();
        return null;
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

  /**
   * 记一把：目标与两段写仍走共用实现；这里只补一层现场坐标兜底。
   *
   * 撤销成功会收起旧卡、把完攀面板换成结果按钮，页面整体重排；同一根手指的第二次
   * 点按可能落在刚出现的结果区。只有「真实撤销触点附近、短时间内的结果事件」才吞掉
   * 这一下（不写盘、不改提示）；位置明显不同的立即重记、没有触点信息的程序化调用都
   * 照常交给共用实现。
   */
  recordAttempt(event) {
    if (this._isUndoRebound(event)) return;
    this._undoRebound = null;
    return actions.recordAttempt.call(this, event);
  },

  /** 记下成功撤销时的真实触点；没有坐标的事件（程序化调用）不启用坐标兜底。 */
  _rememberUndoTap(event) {
    const point = tapPoint(event);
    if (!point) return;
    this._undoRebound = {
      x: point.x,
      y: point.y,
      at: tapTime(event),
      wallAt: Date.now()
    };
  },

  /** 这一下结果事件是不是刚成功撤销的那根手指在同一位置、短时间内的回弹。 */
  _isUndoRebound(event) {
    const rebound = this._undoRebound;
    if (!rebound) return false;
    const point = tapPoint(event);
    if (!point) return false;
    const at = tapTime(event);
    const elapsed =
      rebound.at !== null && at !== null ? at - rebound.at : Date.now() - rebound.wallAt;
    if (!(elapsed >= 0 && elapsed <= UNDO_REBOUND_WINDOW_MS)) return false;
    const dx = point.x - rebound.x;
    const dy = point.y - rebound.y;
    return Math.sqrt(dx * dx + dy * dy) <= UNDO_REBOUND_RADIUS_PX;
  },

  retryPendingAttempt: actions.retryPendingAttempt,
  // 撤销（T050 返工）：目标、预期状态/版本、失败重试与连点保护都沿用共用实现；这里只补
  // 现场的「已撤销第 N 把」提示（见下方 wrapper）。restoreLatestAttempt 保留为页面方法，
  // 现场不再渲染「恢复」按钮，恢复只用于既有读数与旧测试驱动档案层的原把身份。
  undoLatestAttempt(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    // 本页已经成功撤销过的同一把：原按钮的重复/迟到事件不再交给共用实现。它既不会把
    // 「已撤销第 N 把」换成「最近一把变了」，也不会落到只补位的前一把上。原把次之后若
    // 被别处恢复，重新渲染的按钮会带新的版本（expectedRev），这里不会拦。
    const previous = attemptId
      ? (this._undoneAttempts || (this._undoneAttempts = Object.create(null)))[attemptId]
      : null;
    const expectedRev =
      dataset.expectedRev === undefined || dataset.expectedRev === null
        ? ''
        : String(dataset.expectedRev);
    if (
      previous &&
      previous.expectedRev === expectedRev &&
      previous.expected === (dataset.expected || '')
    ) {
      return { ok: true, changed: false, code: 'already-undone' };
    }
    const row = (this.data.attemptCards || []).find(item => item.id === attemptId) || null;
    const outcome = actions.undoLatestAttempt.call(this, event);
    // 写失败时共用实现按档案层原语义说「撤回未保存」；现场实际控件是原行的「重试撤销」，
    // 这里把提示换成同一个控件名，存储失败与后续重试仍走共用实现。
    if (outcome && outcome.code === 'write-failed') {
      this.setData({
        notice: '撤销未保存，可在原行点「重试撤销」按同一把重试。'
      });
      return outcome;
    }
    // 只认「这次调用确实把这一把撤回了」：重复点按（already undone）、写失败、
    // 过期点击与「盘上已是撤回态但不是这次写的」都保留共用实现自己的提示。
    if (!row || !row.label || !outcome || !outcome.changed) return outcome;
    // 同一原按钮的后续事件（重复点按、迟到点击）按原 ID 识别，不再进共用实现。
    this._undoneAttempts[attemptId] = {
      expectedRev,
      expected: dataset.expected || ''
    };
    // 撤销成功可能让同一触点下方换成结果按钮：记下真实触点，只拦短时同点回弹。
    this._rememberUndoTap(event);
    // 回执丢失但盘上确实带着这次操作的凭据：仍报「已撤销第 N 把」，同时保留「回执丢失」
    // 这一句，避免把一次没收到回执的写入说成一次干净的成功。
    this.setData({
      notice:
        outcome.code === 'write-failed-recovered'
          ? '已撤销' + row.label + '（回执丢失，已按最新档案确认）'
          : '已撤销' + row.label
    });
    return outcome;
  },
  restoreLatestAttempt: actions.restoreLatestAttempt,
  changeRecentAttempt: actions.changeRecentAttempt,
  // 行内备注（T045）：只作用于打开时的那一把，保存/取消按原 attemptId 与编辑代次核对。
  onNoteInput: actions.onNoteInput,
  cancelNote: actions.cancelNote,
  saveNote: actions.saveNote,

  // ---------------------------------------------------------------- 更正结果（T042 / T045）

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
