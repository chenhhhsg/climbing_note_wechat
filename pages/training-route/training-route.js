/**
 * 正式长期线路详情页（T018 回看 / T019 主照片）
 *
 * 从正式记录 tab 的「本机训练历史」按长期线路 ID 进入，回看这条线跨日、跨场次的
 * 逐把结果与备注：按本地日期和场次分组，场次新的在前，同一天多场各自保留原归属。
 *
 * T019 在本页加上线路主照片：展示、预览确认、更换与移除都由 utils/training-photo-
 * controller.js 驱动，照片文件落在本机档案目录、索引落在正式照片索引键；照片操作
 * 不写旧云记录，也不改场次、把次与备注。
 *
 * T027 在本页加上「下次想爬」：加入、撤下与拆线归档都只改清单这一份独立记录
 * （utils/training-wishlist.js），不动线路、照片、把次与备注；清单状态由档案推导，
 * 关注的抱石完攀后显示已完成，把那一把改为未完成后自动回到想爬。
 *
 * T028 的照片卡点标记在 T040 移到独立大图页（pages/training-photo-marks）：本页有照片
 * 时只显示可点击缩略图与「照片动作标记 · N 个」，数量按当前照片版本从本机标记记录读回；
 * 大图、换图、移除与标记的新增/移动/改字/删除都在二级页，数据与文件格式不变。没有照片
 * 时本页仍保留添加入口（拍照/相册、预览确认、失败重试）。
 *
 * 本页只读本机档案（utils/training-store.js），与旧云记录完全分开：
 * - 打开历史本身不建场次、不改当前选择、不写任何数据；损坏或版本不支持时可见报错
 *   并保留原数据；
 * - 「当天再记」是唯一的档案写入口，且必须由用户明确点按：当日该岩馆恰好一场就直接
 *   复用，还没有场次才新建一场，同日多场先让用户显式选一场（原归属不动）；抱石已
 *   完攀时不新增把次，只提示按把更正；
 * - 「改为未完成」按渲染那一行带下来的原把次 ID 与归属逐个更正：只翻那一把的
 *   result，把数、ID、序号、场次、时间与备注都不变；改好的那一把留在原位置变成
 *   只读回读，同一坐标不会自动接上另一把。
 *
 * T039 把更正入口合到原把次旁：资格仍由 store.routeCorrectionRows 给出（只认仍有效
 * 的抱石已确认完攀），「更正」就显示在原场次分组里的那一把行上；点它先弹出确认，
 * 写明日期、场次、原序号、原结果和「完攀改成未完成；这把还计入总把数，完攀次数减 1」。
 * 确认后才按该行捕获的档案、场次、线路、把次四个 ID 在**最新**档案上重新核对并调用
 * 同一份 correctSend；取消不写盘，写失败保留同一把的「重试更正」。本页不再另设独立的
 * 「点错了完攀？」区，历史里只有原把次旁的这一处入口，也不另开一套写实现。
 *
 * T023 在跨日历史的每一把上加视频关联状态与文字入口：按这一组的**原场次**、当前
 * 长期线路与这一把的原 attemptId 进入视频页；关联状态只读视频索引，选片与待确认
 * 预览都在视频页，本页不创建任何视频文件或索引。
 *
 * 从大图标记页返回时 onShow 重读照片与数量，立刻反映刚才的改动。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
const photoMarks = require('../../utils/training-photo-marks.js');
const recordActions = require('../../utils/training-record-actions.js');
const attemptVideo = require('../../utils/attempt-video.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const RECORD_URL = '/pages/training-record/training-record';
const SESSION_URL = '/pages/training-session/training-session';
const PROFILE_URL = '/pages/profile/profile';
const ATTEMPT_VIDEO_URL = '/pages/attempt-video/attempt-video';
const PHOTO_MARKS_URL = '/pages/training-photo-marks/training-photo-marks';

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * 完攀状态文案：与首页、场内页共用档案层 routeCompletion 的同一份判定。
 */
function completionText(completion) {
  if (!completion || !completion.known) return '';
  if (completion.completed) return '已完攀';
  if (completion.closed) return '完攀待确认';
  return '';
}

Page({
  data: {
    ready: false,
    loadError: '',      // 档案损坏 / 版本不支持 / 读取失败
    claimError: '',     // 入口带的档案 ID 与本机现在这一份不一致（不展示、不受理写入）
    storageError: '',   // 本次操作未落盘（不报已成功）
    notice: '',         // 说明性提示，不改数据

    route: null,
    notFound: false,
    // 当前本机档案 ID：缩略图入口带着它进入大图页，二级页据此核对归属。
    archiveId: '',

    // 线路主照片（T019）：展示状态由控制器推导，页面只渲染
    routePhoto: null,
    photoNotice: '',

    // 照片动作标记（T040）：本页只读当前照片版本的数量，编辑在大图二级页
    photoMarkCount: 0,
    photoMarkCountText: '',
    photoMarksError: '',

    // 下次想爬（T027）：加入/撤下/拆线归档都只改清单，状态由档案推导
    wishlistState: null,

    groups: [],
    hasAttempts: false,
    attemptCount: 0,
    attemptCountText: '0 把',
    sendCount: 0,
    summaryText: '0 天 · 0 场 · 0 把',

    // 完攀状态：抱石已完攀时不显示「当天再记」，改为按把更正
    routeCompleted: false,
    routeClosed: false,
    canRecordAgain: false,
    routeStateText: '',

    // 按把「改为未完成」（T039）：内部的行数据只用来核对目标与原场次那一把；
    // 界面入口只有历史里原把次旁的那一处，不再渲染独立更正区。
    correctionRows: [],

    // 同日多场：先让用户明确选一场
    sessionPicker: null
  },

  onLoad(query) {
    this._routeId = (query && (query.routeId || query.routeid)) || '';
    // 新入口的明示归属（T037）：场内单线页、小结与想爬清单点资料时都会带上渲染那一页
    // 所用的 archiveId。旧资料直达只带 routeId（兼容保留：不带就只按 routeId 读）。
    this._archiveIdClaim = (query && (query.archiveId || query.archiveid)) || '';
    this._claimBlocked = false;
    // 本实例临时状态，不落盘：
    // _correctedRows 刚改好的那一把（原位只读回读）；_correctionFailures 失败可重试标记。
    this._correctedRows = {};
    this._correctionFailures = {};
    // 确认弹窗：_correctionPrompt 是正在等回执的那一次确认（连点同一把只弹一次），
    // 它按对象身份清理，不会把后来打开的另一行确认顶掉。
    this._correctionPrompt = null;
    // 同日选场面板的实例代次：每次打开面板换一个号，随按钮 dataset 一起带回，
    // 旧面板上的迟到选择不能套用到后来打开的另一个面板。
    this._sessionPickerSeq = 0;
    this._photoUi = null;
    this._unloaded = false;
    this.loadPage();
    this.loadRoutePhoto();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从场内页、大图标记页返回或另一页面实例刚改了同一档案时重新读取，
    // 保持回看、照片与「照片动作标记 · N 个」与本机一致。打开历史只读，不写盘。
    this.loadPage({ keepPicker: true });
    this.loadRoutePhoto();
  },

  /**
   * 离开页面：照片控制器自身的迟到回调据此不再改页面。
   * 照片与标记的写入都在各自页面里完成，本页不持有标记编辑状态。
   */
  onUnload() {
    this._unloaded = true;
  },

  /**
   * 照片控制器只在本页创建一次；档案 ID 由控制器从本机档案读取。
   * 打开详情本身不写照片，只有用户点按拍照/相册/确认/移除才动文件与索引。
   * 这里只做初始化，不读取照片，避免和 loadRoutePhoto 相互递归。
   */
  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createTrainingPhotoController(this, {
        onChange: () => this.applyPhotoView(),
        onNotice: text => this.setData({ photoNotice: text })
      });
    }
    return Promise.resolve(this._photoUi.init());
  },

  loadRoutePhoto() {
    if (this._claimBlocked) {
      this.setData({ routePhoto: null });
      return Promise.resolve();
    }
    if (!this._routeId) {
      this.setData({ routePhoto: null });
      return Promise.resolve();
    }
    // 先过一遍 initPhotoUi：档案 ID 变化（重置本机档案）后照片服务要跟上。
    return Promise.resolve(this.initPhotoUi()).then(() => {
      if (!this._photoUi) return;
      return this._photoUi
        .load([this._routeId])
        .then(() => this.applyPhotoView());
    });
  },

  /**
   * 只更新当前线路的照片展示，并按当前照片版本重读标记数量。
   * 换图、移除与标记编辑都在二级页，本页只读；从二级页返回时 onShow 重读，
   * 这里把最新数量显示到「照片动作标记 · N 个」。
   */
  applyPhotoView() {
    if (!this._photoUi || !this.data.route) return;
    const view = this._photoUi.view(this.data.route.id);
    this.setData({ routePhoto: view });
    this.refreshPhotoMarkCount();
  },

  /** 当前照片版本：档案 + 线路 + 当前照片 ID；缺一不读数量。 */
  photoMarkTarget() {
    const view = this.data.routePhoto || {};
    return {
      archiveId: (this.archive && this.archive.archiveId) || '',
      routeId: (this.data.route && this.data.route.id) || this._routeId || '',
      photoId: view.photoId || ''
    };
  },

  /**
   * 只读当前照片上的标记数量：损坏或版本不支持时显示可见原因，不显示 0 个的假成功。
   * 打开历史与从二级页返回都走这里，不写盘。
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
   * 打开大图标记页：带齐档案、线路与**当前**照片 ID。
   * 历史上的入口带的是渲染那一刻的三个 ID；与当前照片版本不一致（另一页刚换了照片）
   * 时只刷新历史并提示，不再按旧照片打开，避免把操作落到另一张图上。
   */
  openPhotoMarks(event) {
    if (this.data.loadError || this.data.notFound || this._claimBlocked) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const routeId = (this.data.route && this.data.route.id) || this._routeId || '';
    const photoId = (this.data.routePhoto && this.data.routePhoto.photoId) || '';
    if (!archiveId || !routeId || !photoId) {
      this.refreshView();
      this.setData({ notice: '这条线路当前没有可打开的照片，请先添加照片。' });
      return;
    }
    const stale =
      (dataset.archiveId && dataset.archiveId !== archiveId) ||
      (dataset.routeId && dataset.routeId !== routeId) ||
      (dataset.photoId && dataset.photoId !== photoId);
    if (stale) {
      this.loadPage({ keepPicker: true });
      this.loadRoutePhoto();
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

  photoRouteId(event) {
    // 入口不属于当前档案：照片与卡点的动作拿不到 routeId，任何写入都不会发生。
    if (this._claimBlocked) return '';
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    return dataset.routeId || this._routeId || '';
  },

  dismissPhotoNotice() {
    this.setData({ photoNotice: '' });
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
    // 取消预览后留下的只是临时路径，不进入索引；旧照片（若有）继续显示。
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


  /**
   * 读取本机档案并按最新数据重算展示；只读，不写盘。
   */
  loadPage(options) {
    const keepPicker = Boolean(options && options.keepPicker);
    const loaded = store.loadState();
    this.archive = loaded.archive;

    // 入口归属核对（T037）：带了 archiveId 的入口在本机档案已经换成另一份之后不再展示、
    // 也不再受理任何写入——同一份档案里同名的 routeId 不能顶替入口本来那一条线。
    // 旧资料直达（只带 routeId）不核对，保持原来的兼容行为。
    this._claimBlocked = Boolean(
      this._archiveIdClaim &&
        loaded.archive &&
        this._archiveIdClaim !== loaded.archive.archiveId
    );

    this.setData({
      ready: true,
      loadError: loaded.error || '',
      claimError: this._claimBlocked
        ? '这个入口属于另一份本机档案（' +
          this._archiveIdClaim +
          '），未展示任何线路内容，也不接受改动；请从当前的场内页重新打开这条线。'
        : '',
      storageError: '',
      notice: '',
      route: null,
      notFound: false,
      routePhoto: null,
      photoNotice: '',
      // 照片动作标记只显示当前照片版本的数量；标记本身与照片文件都不动。
      photoMarkCount: 0,
      photoMarkCountText: '',
      photoMarksError: '',
      wishlistState: null,
      groups: [],
      hasAttempts: false,
      attemptCount: 0,
      attemptCountText: '0 把',
      sendCount: 0,
      summaryText: '0 天 · 0 场 · 0 把',
      routeCompleted: false,
      routeClosed: false,
      canRecordAgain: false,
      routeStateText: '',
      correctionRows: [],
      sessionPicker: keepPicker ? this.data.sessionPicker : null
    });

    this.refreshView();
  },

  retryLoad() {
    this.loadPage({ keepPicker: true });
  },

  /**
   * 由当前档案重新推导展示内容；不改动任何已保存数据。
   */
  refreshView() {
    if (this.data.loadError) return;
    // 入口不属于当前档案：不读这条线的历史、照片、清单与更正行，也不受理写入。
    if (this._claimBlocked) {
      this.setData({
        route: null,
        notFound: false,
        routePhoto: null,
        wishlistState: null,
        canRecordAgain: false,
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: ''
      });
      return;
    }

    if (!this._routeId) {
      this.setData({
        notFound: true,
        route: null,
        canRecordAgain: false,
        routePhoto: null,
        wishlistState: null,
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: ''
      });
      return;
    }

    const history = store.routeHistory(this.archive, this._routeId);
    if (!history.known) {
      this.setData({
        notFound: true,
        route: null,
        routePhoto: null,
        wishlistState: null,
        groups: [],
        hasAttempts: false,
        attemptCount: 0,
        attemptCountText: '0 把',
        sendCount: 0,
        summaryText: '0 天 · 0 场 · 0 把',
        routeCompleted: false,
        routeClosed: false,
        canRecordAgain: false,
        routeStateText: '',
        correctionRows: [],
        photoMarkCount: 0,
        photoMarkCountText: '',
        photoMarksError: ''
      });
      return;
    }

    const route = history.route;
    const completion = history.completion;

    // 逐把更正行：这条抱石线的每一把仍可更正的完攀各占一行；本实例刚改好的那一把
    // 留在原位置变成只读回读行，行与行之间不塌陷，同一坐标不会被另一把接手。
    // T039：行里补上这一把的**原结果**（确认弹窗要显示），并把行按 attemptId 挂回
    // 原场次分组里的那一把；行数据只用于核对目标，界面上只在原把次旁显示一处「更正」。
    const attemptById = new Map((this.archive.attempts || []).map(item => [item.id, item]));
    const correctionRows = store
      .routeCorrectionRows(this.archive, route.id, Object.keys(this._correctedRows))
      .map(row => {
        const source = attemptById.get(row.attemptId);
        const resultText = recordActions.attemptResultText(source ? source.result : 'send');
        if (row.state === 'corrected') {
          return {
            attemptId: row.attemptId,
            routeId: row.routeId,
            sessionId: row.sessionId,
            archiveId: this.archive.archiveId,
            label: row.label,
            contextText: row.contextText,
            resultText,
            state: 'corrected',
            buttonText: '',
            // 本页的回读口径：只翻结果，原时间、场次、备注与已关联视频都保留。
            statusText: '已改为未完成 · 本把次保留原时间、场次、备注与视频'
          };
        }
        const needsRetry = Boolean(
          this._correctionFailures[row.attemptId] ||
            (this.archive.pendingCorrections || []).some(item => item.attemptId === row.attemptId)
        );
        return {
          attemptId: row.attemptId,
          routeId: row.routeId,
          sessionId: row.sessionId,
          archiveId: this.archive.archiveId,
          label: row.label,
          contextText: row.contextText,
          resultText,
          state: needsRetry ? 'retry' : 'ready',
          buttonText: needsRetry ? '重试改为未完成' : '改为未完成',
          statusText: ''
        };
      });
    const correctionById = new Map(correctionRows.map(row => [row.attemptId, row]));

    // 逐把视频（T023）：关联状态只读视频索引，跨日历史按分组里的原场次与原把次进入。
    const videoLinks = attemptVideo.videoLinkMap(
      this.archive.archiveId,
      history.groups.reduce((all, group) => all.concat(group.attempts), [])
    );

    this.setData({
      route: {
        id: route.id,
        gymId: route.gymId,
        name: route.name,
        // 旧 V 级线路没有 climbType，按抱石只读展示，不回写档案。
        climbType: climbTypeOf(route),
        colorName: route.colorName || '',
        colorHex: route.colorHex || '#dee2e6',
        grade: route.grade,
        gymName: store.gymName(this.archive, route.gymId)
      },
      notFound: false,
      archiveId: (this.archive && this.archive.archiveId) || '',
      // 照片展示与逐把回看各自独立：照片由控制器按 routeId 推导，不改逐把数据。
      routePhoto: this._photoUi
        ? this._photoUi.view(route.id)
        : this.data.routePhoto,
      wishlistState: this.wishlistView(route.id),
      groups: history.groups.map(group => ({
        sessionId: group.sessionId,
        dateText: group.date,
        sessionLabel: group.sessionLabel,
        gymName: group.gymName,
        countText: group.countText,
        attempts: group.attempts.map(attempt => {
          const link = videoLinks.get(attempt.id) || {
            hasVideo: false,
            stateText: '未添加视频',
            entryText: '添加视频 ›'
          };
          // 完攀更正（T039）：入口只出现在 routeCorrectionRows 认可的那一把旁边；
          // 已改好的那一把在这一行原位显示回读文案，控件不再出现。
          const correction = correctionById.get(attempt.id) || null;
          return {
            id: attempt.id,
            label: attempt.label,
            resultText: attempt.resultText,
            isSend: attempt.result === 'send',
            timeText: timeText(attempt.createdAt),
            note: attempt.note,
            hasNote: Boolean(attempt.note),
            hasVideo: link.hasVideo,
            videoStateText: link.stateText,
            videoEntryText: link.entryText,
            archiveId: this.archive.archiveId,
            correctionState: correction ? correction.state : '',
            correctionButtonText:
              correction && correction.state !== 'corrected'
                ? correction.state === 'retry'
                  ? '重试更正'
                  : '更正'
                : '',
            correctionStatusText:
              correction && correction.state === 'corrected' ? correction.statusText : ''
          };
        })
      })),
      hasAttempts: history.attemptCount > 0,
      attemptCount: history.attemptCount,
      attemptCountText: history.attemptCount + ' 把',
      sendCount: history.sendCount,
      summaryText:
        history.dayCount + ' 天 · ' + history.sessionCount + ' 场 · ' + history.attemptCount + ' 把',
      routeCompleted: Boolean(completion && completion.completed),
      routeClosed: Boolean(completion && completion.closed),
      canRecordAgain: Boolean(completion && completion.canRecord),
      routeStateText: completionText(completion),
      correctionRows
    });
  },

  // ---------------------------------------------------------------- 下次想爬

  /**
   * 这条线在「下次想爬」清单里的状态（只读，不写盘）。
   *
   * 状态由档案推导：清单里的活跃条目是「想爬」，关注的抱石出现完攀后变「已完成」，
   * 把那一把改为未完成后又会回到「想爬」，都不需要另存一份状态。
   * 清单损坏、版本不支持或读取失败时只显示可见错误并收回写入口，保留原清单。
   */
  wishlistView(routeId) {
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
   * 清单写入口的原归属：本页渲染时用的档案 ID。数据层据此核对这条操作是不是还落在
   * 同一份档案上——换档之后的迟到点击会被拒绝，不会改到另一份档案里同名线路 ID 的收藏。
   */
  wishlistOwnership() {
    const archiveId = this.archive && this.archive.archiveId;
    return archiveId ? { archiveId: archiveId } : undefined;
  },

  /**
   * 加入下次想爬。只写清单这一份独立记录：线路、照片、把次与备注都不动。
   * 重复点击幂等（已在清单里不写盘）；落盘失败不报已保存，可再点一次重试。
   */
  addToWishlist() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.addWishlist(routeId, this.wishlistOwnership());
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '收藏未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.code === 'duplicate'
        ? '这条线路已经在下次想爬清单里。'
        : outcome.code === 'reactivated'
          ? '已重新加入下次想爬。'
          : '已加入下次想爬。'
    });
    this.refreshView();
  },

  /**
   * 撤下收藏：只从清单里移除这一条，线路、照片、把次、备注与历史都保留。
   */
  removeFromWishlist() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.removeWishlist(routeId, this.wishlistOwnership());
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '撤下未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.removed ? '已从下次想爬撤下；线路、照片与把次都不变。' : '这条线路本来就不在清单里。'
    });
    this.refreshView();
  },

  /**
   * 拆线归档：岩馆把这条线拆了，把它从活跃清单移到已归档。
   * 只改清单里的这一条，照片文件、照片索引、把次、备注与跨日历史都不动。
   */
  archiveWishlistItem() {
    if (this.data.loadError || this.data.notFound) return;
    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = wishlist.archiveWishlist(routeId, this.wishlistOwnership());
    if (!outcome.ok) {
      this.setData({
        storageError: outcome.code === 'write-failed' ? outcome.error : '',
        notice: outcome.code === 'write-failed' ? '归档未保存，可再点一次重试。' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.setData({
      storageError: '',
      notice: outcome.code === 'already-archived'
        ? '这条线路已经归档。'
        : '已归档；照片、把次与历史都保留，仍可按原线路 ID 回看。'
    });
    this.refreshView();
  },

  // ---------------------------------------------------------------- 当天再记
  /**
   * 「当天再记」：把当前场次与线路指到这条线所在岩馆的本地当日场次。
   *
   * 只有用户点这一下才可能新建场次（当日该岩馆还没有场次时）；同日多场先返回选场，
   * 不静默改归属；抱石已完攀或落盘失败都不离开本页、不改任何数据。
   */
  recordAgain() {
    if (this.data.loadError || this.data.notFound || this._claimBlocked) return;

    const routeId = this.data.route && this.data.route.id;
    if (!routeId) return;

    const outcome = store.resumeRouteToday(routeId);
    if (outcome.archive && !outcome.ok) this.archive = outcome.archive;

    if (outcome.code === 'choose-session') {
      const pickerArchiveId =
        (outcome.archive && outcome.archive.archiveId) ||
        (this.archive && this.archive.archiveId) ||
        '';
      this._sessionPickerSeq += 1;
      this.setData({
        storageError: '',
        notice: '',
        sessionPicker: {
          // 面板的归属与代次：档案、线路、日期与本次打开序号拼成的标识随每个选项
          // 一起渲染；选择时先按这组原值核对最新档案，再决定是否写场次。
          archiveId: pickerArchiveId,
          pickerKey: [pickerArchiveId, routeId, outcome.date, this._sessionPickerSeq].join('|'),
          routeId: routeId,
          routeName: this.data.route.name,
          dateText: outcome.date,
          gymName: this.data.route.gymName,
          sessions: outcome.sessions.map(session => ({
            id: session.id,
            label: store.sessionLabel(this.archive, session),
            isCurrent: session.id === this.archive.activeSessionId
          }))
        }
      });
      return;
    }

    if (!outcome.ok) {
      this.setData({
        notice: outcome.code === 'closed' ? outcome.error : '',
        storageError: outcome.code === 'closed' ? '' : outcome.error
      });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    this.setData({ storageError: '', notice: '', sessionPicker: null });
    this.refreshView();
    this.goToRecord(outcome.archive.activeSessionId, routeId);
  },

  /**
   * 同日多场时用户明确选一场：只改当前场次与线路，不动任何把次与备注。
   * 选中的场次必须属于该岩馆当日；落盘失败时保留选择界面与原场次，可重试。
   *
   * 真实按钮把渲染那一刻的档案 ID、原线路 ID 与选场面板标识一起带回来（T037 返工）：
   * 先按这组原值与**最新**档案核对，再看面板里的场次。换了本机档案后复用同一组
   * sessionId / routeId 的旧面板事件一律不写盘，不能改到另一份档案的活动场次。
   */
  chooseSessionForAgain(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const sessionId = dataset.sessionId;
    const picker = this.data.sessionPicker;
    if (!sessionId || !picker) return;
    if (!picker.sessions.some(item => item.id === sessionId)) return;

    const boundArchiveId = typeof dataset.archiveId === 'string' ? dataset.archiveId : '';
    const boundRouteId = typeof dataset.routeId === 'string' ? dataset.routeId : '';
    const boundPickerKey = typeof dataset.pickerKey === 'string' ? dataset.pickerKey : '';
    const pickerArchiveId =
      picker.archiveId ||
      this._archiveIdClaim ||
      (this.archive && this.archive.archiveId) ||
      '';
    const pickerRouteId = picker.routeId || '';

    // 事件自带的原档案/原线路/原面板与当前面板不是同一次渲染：整条拒绝，不写盘。
    const staleEvent =
      (boundArchiveId && boundArchiveId !== pickerArchiveId) ||
      (boundArchiveId && this._archiveIdClaim && boundArchiveId !== this._archiveIdClaim) ||
      (boundRouteId && boundRouteId !== pickerRouteId) ||
      (boundPickerKey && picker.pickerKey && boundPickerKey !== picker.pickerKey) ||
      (this.data.route && this.data.route.id !== pickerRouteId);
    if (staleEvent) {
      this.setData({
        storageError: '',
        notice: '这次选场来自原来的页面，已经失效；没有改动当前场次。'
      });
      this.refreshView();
      return;
    }

    // 写盘前再读一次最新档案：盘上已经换成另一份档案时，面板连同它的场次/线路整体作废。
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({ storageError: loaded.error });
      this.refreshView();
      return;
    }
    const latestArchiveId = (loaded.archive && loaded.archive.archiveId) || '';
    if (
      (pickerArchiveId && pickerArchiveId !== latestArchiveId) ||
      (boundArchiveId && boundArchiveId !== latestArchiveId)
    ) {
      this.archive = loaded.archive;
      this.setData({
        storageError: '',
        notice: '这次选场属于原来的本机档案，未做改动；已按当前档案刷新。'
      });
      this.refreshView();
      return;
    }
    if (
      !pickerRouteId ||
      !(loaded.archive.routes || []).some(route => route.id === pickerRouteId)
    ) {
      this.archive = loaded.archive;
      this.setData({
        storageError: '',
        notice: '这条线路已经不在当前本机档案里，这次选场没有生效。'
      });
      this.refreshView();
      return;
    }
    this.archive = loaded.archive;

    const outcome = store.chooseRouteSession(pickerRouteId, sessionId, { date: picker.dateText });
    if (outcome.archive && !outcome.ok) this.archive = outcome.archive;

    if (!outcome.ok) {
      this.setData({ storageError: outcome.error });
      this.refreshView();
      return;
    }

    this.archive = outcome.archive;
    this.setData({ storageError: '', notice: '', sessionPicker: null });
    this.refreshView();
    this.goToRecord(sessionId, pickerRouteId);
  },

  /**
   * 取消选场：不写盘、不改归属，留在详情页继续看原数据。
   */
  cancelSessionPicker() {
    this.setData({ sessionPicker: null });
  },

  /**
   * 当天再记 / 选场之后：进入这条线在指定场次的单线记录页（T036）。
   * 带齐档案、场次与长期线路 ID；单线页再按同一组参数核对归属。
   * 目标不明确时不猜场次，只提示并留在本页。
   */
  goToRecord(sessionId, routeId) {
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const targetRouteId = routeId || this._routeId || '';
    if (!archiveId || !sessionId || !targetRouteId) {
      this.setData({ notice: '无法定位这一场这条线的单线记录，请重试。' });
      return;
    }
    wx.navigateTo({
      url:
        RECORD_URL +
        '?archiveId=' +
        encodeURIComponent(archiveId) +
        '&sessionId=' +
        encodeURIComponent(sessionId) +
        '&routeId=' +
        encodeURIComponent(targetRouteId),
      fail: () => {
        this.setData({ notice: '单线记录页没有打开，请再点一次「当天再记」。' });
      }
    });
  },

  /**
   * 跨天历史按原场次回到对应的单线记录（T036）：只认这一组渲染时的 sessionId 与
   * 当前长期线路 ID；同一天两场各自保留原归属，不会并到别的场次。
   */
  openRecordFromHistory(event) {
    if (this.data.loadError || this.data.notFound || this._claimBlocked) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const sessionId = dataset.sessionId || '';
    const routeId = dataset.routeId || this._routeId || '';
    this.goToRecord(sessionId, routeId);
  },

  /**
   * 跨日历史的视频入口（T023）：只认这一组渲染时的**原场次**、当前长期线路与这一把的
   * 原 attemptId——同一把在别的日子回看，用的仍是它当初记下的那一场。
   * 打开前按最新档案再核对一次（撤回、换档、待保存与旧汇总都打不开）；视频页再按同一
   * 组四个 ID 核对一次。
   */
  openAttemptVideoFromHistory(event) {
    if (this.data.loadError || this.data.notFound || this._claimBlocked) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    const sessionId = dataset.sessionId || '';
    const routeId = dataset.routeId || this._routeId || '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (!archiveId || !sessionId || !routeId || !attemptId) {
      this.setData({ notice: '无法定位这一把的原归属，请重试。' });
      return;
    }

    const ids = { archiveId, sessionId, routeId, attemptId };
    const context = attemptVideo.loadVideoContext(ids);
    if (!context.ok) {
      this.loadPage({ keepPicker: true });
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

  // ---------------------------------------------------------------- 按把更正

  /**
   * 原把次旁的「更正」（T039）：先确认，再走同一份按把更正。
   *
   * 事件里的四个 ID（档案、场次、线路、把次）是那一行渲染时写下来的。这里先核对它们
   * 与当前页面上仍可更正的同一行一致——串档、串线或已经改好的迟到事件不会打开确认；
   * 连点同一把只弹一次确认，两行来回各弹各的，确认哪一行就只准备改哪一行。
   * 用户取消时一个字节都不写；确认后才把同一组 ID 交给 correctSend，由它在最新档案上
   * 再核对一次（换档、撤回或已改好的把次都不写），失败则保留同一把的重试入口。
   */
  confirmCorrectSend(event) {
    if (this.data.loadError || this.data.notFound || this._claimBlocked) {
      return Promise.resolve(null);
    }
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const target = this.correctionTarget(dataset);
    if (!target) {
      this.setData({ notice: '这一把当前没有可更正的完攀，已按最新数据刷新。' });
      this.refreshView();
      return Promise.resolve(null);
    }

    const pending = this._correctionPrompt;
    if (pending && pending.attemptId === target.attemptId) {
      // 连点同一把：沿用已经打开的那一次确认，不叠第二个弹窗，也不会改两次。
      return pending.promise;
    }

    const prompt = { attemptId: target.attemptId, promise: null };
    prompt.promise = this.askCorrectConfirm(target).then(confirmed => {
      if (this._correctionPrompt === prompt) this._correctionPrompt = null;
      if (this._unloaded || !confirmed) return null;
      return this.applyCorrection(target);
    });
    this._correctionPrompt = prompt;
    return prompt.promise;
  },

  /**
   * 把这一行的四个 ID 与当前仍可更正的那一行对上；对不上（缺参、串档、串线、
   * 已经改好）返回 null，确认弹窗与写入口都不打开。
   */
  correctionTarget(dataset) {
    const attemptId = (dataset && dataset.attemptId) || '';
    if (!attemptId) return null;
    const routeId = (this.data.route && this.data.route.id) || '';
    const archiveId = (this.archive && this.archive.archiveId) || '';
    if (!routeId || !archiveId) return null;

    const row = (this.data.correctionRows || []).find(item => item.attemptId === attemptId);
    if (!row || row.state === 'corrected') return null;
    // 行里带的原归属必须与这一行渲染时一致：迟到的旧事件不能借同名线路/同序号改另一把。
    if (dataset.routeId && dataset.routeId !== row.routeId) return null;
    if (dataset.sessionId && dataset.sessionId !== row.sessionId) return null;
    if (dataset.archiveId && dataset.archiveId !== row.archiveId) return null;
    if (row.routeId !== routeId || row.archiveId !== archiveId) return null;

    return {
      attemptId,
      routeId: row.routeId,
      sessionId: row.sessionId,
      archiveId: row.archiveId,
      label: row.label,
      contextText: row.contextText,
      resultText: row.resultText || '完攀'
    };
  },

  /**
   * 更正前的确认：写明日期、场次、原序号、原结果，并说清这把仍计入总把数。
   * 弹窗不可用时按取消处理，不写盘。
   */
  askCorrectConfirm(target) {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(false);
        return;
      }
      try {
        wx.showModal({
          title: '更正这一把？',
          content:
            (target.contextText ? target.contextText + ' · ' : '') +
            target.label +
            ' · 原结果：' +
            target.resultText +
            '\n完攀改成未完成；这把还计入总把数，完攀次数减 1。',
          confirmText: '更正',
          cancelText: '取消',
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
   * 确认后按确认弹窗里那一行的四个 ID 重新核对并更正。
   * 只把捕获的 ID 交给共用实现；本页不另写档案。
   */
  applyCorrection(target) {
    return recordActions.correctSend.call(this, {
      currentTarget: {
        dataset: {
          attemptId: target.attemptId,
          routeId: target.routeId,
          sessionId: target.sessionId,
          archiveId: target.archiveId
        }
      }
    });
  },

  /**
   * 「改为未完成」：只改正渲染这一行对应的那一把已确认完攀。
   *
   * 目标来自该行按钮带下来的原把次 ID 与归属，连点/双击原坐标只会重复更正同一把
   * （第二次幂等返回 resolved），不会改到另一把；只翻这一把的 result，把数、ID、
   * 序号、场次、时间与备注都不变，之后可以正常再记并再次完攀。
   *
   * T036：与单线记录页共用 utils/training-record-actions.js 的同一份实现，避免两个
   * 不一致的写实现；本页的 _correctedRows / _correctionFailures 由 refreshView 读取。
   * T039：界面入口统一经 confirmCorrectSend 确认后调用它；直接调用只用于内部与测试。
   */
  correctSend: recordActions.correctSend,

  /**
   * 回归属不符入口的出口（T037）：这一页不展示任何线路内容，只让用户回到本场线路重开。
   * 正常路径就是系统返回；没有上一页（直接打开旧入口）时重开正式场内页。
   */
  backToList() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (typeof wx.reLaunch === 'function') wx.reLaunch({ url: SESSION_URL });
        }
      });
      return;
    }
    if (typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
      wx.reLaunch({ url: SESSION_URL });
    }
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
