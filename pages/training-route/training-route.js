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
 * T028 在本页加上「照片卡点标记」：从主照片进入标记模式，点选岩点位置、填一句手法/
 * 脚法提示、移动、改字与删除都由 utils/training-photo-marks.js 驱动：
 * - 标记按「当前档案 + 线路 ID + 主照片 ID」归属，位置按原图归一化保存，换屏、
 *   旋转或跨天重开都会换算回原图上的同一个点；点在照片外的留白上不生成标记；
 * - 只写本机标记记录这一份独立数据，主图字节、把次、备注与体测都不动，也不烧进
 *   照片、不上传、不生成第二份图片；
 * - 换了（或移了）主照片后照片 ID 变，旧标记不再叠加到新照片上；取消更换时照片 ID
 *   没变，原标记照旧显示。
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
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
const photoMarks = require('../../utils/training-photo-marks.js');
const recordActions = require('../../utils/training-record-actions.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const RECORD_URL = '/pages/training-record/training-record';
const SESSION_URL = '/pages/training-session/training-session';
const PROFILE_URL = '/pages/profile/profile';

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

    // 线路主照片（T019）：展示状态由控制器推导，页面只渲染
    routePhoto: null,
    photoNotice: '',

    // 照片卡点标记（T028）：只读写本机标记记录，主图字节、把次与备注都不动
    marksReady: true,        // 标记记录可读（损坏/版本不支持时为 false）
    marksError: '',          // 标记记录不可读时的可见原因
    markNotice: '',          // 标记相关提示，不改数据
    markSaveError: '',       // 本次标记改动未落盘（不报已保存）
    markLayoutError: '',     // 读不到照片显示尺寸时的可见原因
    markPoints: [],          // 图上的点（含显示框内像素位置）
    markList: [],            // 文字清单：照片不可用时也能读回已写的提示
    markCountText: '',
    markHiddenText: '',      // 属于同一线路旧照片、未叠加显示的标记数量
    markKinds: photoMarks.MARK_KINDS_VIEW,
    markTextMax: photoMarks.MARK_TEXT_MAX,

    // 标记模式与当前编辑对象
    markMode: false,
    markKind: photoMarks.DEFAULT_MARK_KIND,
    markText: '',
    markSelected: null,      // 选中的已有标记
    markDraft: null,         // 刚点下、还没保存的草稿点
    markEditable: false,
    markMoving: false,

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

    // 按把「改为未完成」：每一把各占一行、各带自己的控件
    correctionRows: [],
    correctionStatusText: '',
    routeCorrectable: false,

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
    // 同日选场面板的实例代次：每次打开面板换一个号，随按钮 dataset 一起带回，
    // 旧面板上的迟到选择不能套用到后来打开的另一个面板。
    this._sessionPickerSeq = 0;
    this._photoUi = null;
    // 标记：当前照片上的标记内存快照、显示框布局缓存、图片尺寸缓存与各类代次。
    // - _markIdentity 是「档案 + 线路 + 主照片」三者拼出的当前归属；换了任意一项就递增
    //   _markGeneration，早期的异步回调据此丢弃，不把旧点位写到新照片上；
    // - _markLayoutSeq 是显示框测量的请求序号：每次重新测量都换一个号，更早的测量回来
    //   时若已经不是最新一次，就直接作废（换屏后旧矩形不得覆盖新屏的最新布局）；
    // - _markModeSeq 是标记模式的进出序号：退出或重入都会换号，退出前的旧点击不会
    //   再把编辑区打开；
    // - _markMoveOp 记录「正在进行的移动」这一次操作（序号 + 标记 ID + 当时归属）：
    //   点新位置的测量期间若换了选中，这次点击不再提交坐标。
    this._markMarks = [];
    this._markLayout = null;
    this._markLayoutIdentity = '';
    this._markLayoutSeq = 0;
    this._markIdentity = '';
    this._markGeneration = 0;
    this._markModeSeq = 0;
    this._markMoveSeq = 0;
    this._markMoveOp = null;
    this._markDraftContext = null;
    this._imageSizes = {};
    this._unloaded = false;
    this.loadPage();
    this.loadRoutePhoto();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从场内页返回或另一页面实例刚改了同一档案时重新读取，保持回看与本机一致。
    // 打开历史只读，不写盘、不建场次。
    this.loadPage({ keepPicker: true });
    this.loadRoutePhoto();
  },

  /**
   * 屏幕尺寸变化（旋转、分屏、字体与窗口变化）：标记按原图归一化保存，
   * 只需丢掉旧的显示框布局重新测量，位置就会落回原图上的同一个点。
   */
  onResize() {
    this.invalidateMarkLayout();
    this.ensureMarkLayout();
  },

  /**
   * 离开页面：标记自己的异步回调据此丢弃，不在页面已销毁后再写数据或提示。
   * 只中止本页标记的迟到回调，照片控制器与档案数据都不受影响。
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
   * 只更新当前线路的照片展示；线路或档案变化时按最新档案重算。
   * 归属（档案 + 线路 + 主照片）变化——确认换图、移图或移除主照片——时递增标记代次、
   * 丢掉旧布局，并让旧草稿、选中、移动与待决回调一并失效：旧照片上的标记不再叠加到
   * 新照片，旧草稿也不能再被保存到新照片上。取消更换时归属没变，原照片与标记照旧。
   */
  applyPhotoView() {
    if (!this._photoUi || !this.data.route) return;
    const view = this._photoUi.view(this.data.route.id);
    const identity = [
      (this.archive && this.archive.archiveId) || '',
      (this.data.route && this.data.route.id) || this._routeId || '',
      (view && view.photoId) || ''
    ].join('|');
    const patch = { routePhoto: view };
    if (identity !== this._markIdentity) {
      this._markIdentity = identity;
      this._markGeneration += 1;
      this.invalidateMarkLayout();
      Object.assign(patch, this.resetMarkEditing());
    }
    this.setData(patch);
    this.refreshMarkView();
    this.ensureMarkLayout();
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

  // ------------------------------------------------------------ 照片卡点标记
  //
  // 标记只读写 utils/training-photo-marks.js 里的那份本机记录：主图文件、照片索引、
  // 把次、备注与体测原值都不动。位置按原图归一化保存，页面只把当前显示框换算成像素。

  /** 当前标记归属：当前档案 + 长期线路 ID + 主照片 ID，三者缺一不显示也不写。 */
  markTarget() {
    return {
      archiveId: (this.archive && this.archive.archiveId) || '',
      routeId: (this.data.route && this.data.route.id) || this._routeId || '',
      photoId: (this.data.routePhoto && this.data.routePhoto.photoId) || ''
    };
  },

  /**
   * 丢掉显示框布局缓存，并换一个测量请求号：已经在路上的旧测量回来时直接作废。
   * 换屏、重新加载主图、换照片或移除照片都走这里。
   */
  invalidateMarkLayout() {
    this._markLayout = null;
    this._markLayoutIdentity = '';
    this._markLayoutSeq += 1;
  },

  /**
   * 收回编辑区：草稿、选中、移动与它们的待决身份一起失效。
   * 返回可直接并入 setData 的补丁；换图/移除照片、退出标记模式与重读页面都用它，
   * 避免旧草稿在归属变化后被保存到新照片上。
   */
  resetMarkEditing() {
    this._markDraftContext = null;
    this._markMoveOp = null;
    return {
      markSelected: null,
      markDraft: null,
      markEditable: false,
      markMoving: false,
      markText: ''
    };
  },

  /**
   * 发起异步操作前固定上下文（档案 + 线路 + 照片 + 照片代次 + 模式序号）。
   * 读取显示框、读取图片尺寸和确认弹窗都可能晚于换图/换档/退出标记模式返回，
   * 旧回调必须按发起时的上下文校验，不能把旧点位写到新照片上，也不能在退出后
   * 又把编辑区打开。
   */
  captureMarkContext() {
    const target = this.markTarget();
    return {
      archiveId: target.archiveId,
      routeId: target.routeId,
      photoId: target.photoId,
      generation: this._markGeneration,
      modeSeq: this._markModeSeq
    };
  },

  isMarkContextCurrent(context) {
    if (!context) return false;
    const target = this.markTarget();
    return (
      context.archiveId === target.archiveId &&
      context.routeId === target.routeId &&
      context.photoId === target.photoId &&
      context.generation === this._markGeneration &&
      context.modeSeq === this._markModeSeq
    );
  },

  /**
   * 读取当前照片上的标记并重算展示；只读，不写盘。
   * 记录损坏或版本不支持时显示可见原因并收回写入口，原标记保持不动。
   */
  refreshMarkView() {
    const target = this.markTarget();
    if (!target.routeId || !target.photoId || !target.archiveId) {
      // 还没有主照片（或档案不可读）时不猜归属：不显示、也不写。
      this._markMarks = [];
      this.setData(Object.assign(
        {
          marksReady: true,
          marksError: '',
          markPoints: [],
          markList: [],
          markCountText: '',
          markHiddenText: '',
          markMode: false,
          markLayoutError: ''
        },
        this.resetMarkEditing()
      ));
      return;
    }

    const listed = photoMarks.listMarks(target);
    if (!listed.ok) {
      this._markMarks = [];
      this.setData(Object.assign(
        {
          marksReady: false,
          marksError: listed.error,
          markPoints: [],
          markList: [],
          markCountText: '',
          markHiddenText: '',
          markMode: false
        },
        this.resetMarkEditing()
      ));
      return;
    }

    this._markMarks = listed.marks;
    const patch = {
      marksReady: true,
      marksError: '',
      markCountText: photoMarks.markCountText(listed.marks),
      markList: photoMarks.markListRows(listed.marks),
      markHiddenText:
        listed.otherPhotoCount > 0
          ? '另有 ' +
            listed.otherPhotoCount +
            ' 条卡点属于这张线路的旧照片，已不叠加在当前照片上。'
          : ''
    };
    // 选中的那条已经不在了（被删除或换了照片）：收回编辑区，不保留悬空选中。
    const selected = this.data.markSelected;
    if (selected && !listed.marks.some(mark => mark.markId === selected.markId)) {
      patch.markSelected = null;
      patch.markEditable = Boolean(this.data.markDraft);
      patch.markMoving = false;
    }
    this.setData(patch);
    this.applyMarkPoints();
  },

  /**
   * 图上标记行的像素位置来自当前显示框布局；照片不可显示或还没读到布局时不上图
   * （此时靠下面的文字清单读回提示，并由 markLayoutError 说明原因）。
   */
  applyMarkPoints() {
    const photo = this.data.routePhoto || {};
    if (photo.status !== 'saved') {
      this.setData({ markPoints: [] });
      return;
    }
    const selected = this.data.markSelected;
    this.setData({
      markPoints: photoMarks
        .markPointsView(this._markMarks, this._markLayout, {
          selectedMarkId: selected ? selected.markId : '',
          movingMarkId: this.data.markMoving && selected ? selected.markId : '',
          draft: this.data.markDraft
        })
        .filter(pin => pin.visible)
    });
  },

  /**
   * 显示框布局：原图按 aspectFit 装进照片显示区，标记再换回同一个原图位置。
   * 布局只用于本次渲染；已缓存的布局在同一张照片上不重复测量。
   */
  ensureMarkLayout() {
    const target = this.markTarget();
    const photo = this.data.routePhoto || {};
    if (!target.routeId || !target.photoId || !photo.mainPath || photo.status !== 'saved') {
      return Promise.resolve(null);
    }
    const identity = [target.archiveId, target.routeId, target.photoId].join('|');
    if (this._markLayout && this._markLayout.ok && this._markLayoutIdentity === identity) {
      this.applyMarkPoints();
      return Promise.resolve(this._markLayout);
    }
    return this.refreshMarkLayout(identity, photo.mainPath);
  },

  refreshMarkLayout(identity, mainPath) {
    const context = this.captureMarkContext();
    const generation = context.generation;
    // 这次测量领一个请求号：只有仍是最新一次测量的结果才允许落回布局。
    const seq = ++this._markLayoutSeq;
    return Promise.all([this.queryMarkStageRect(), this.resolveImageSize(mainPath)]).then(
      results => {
        const rect = results[0];
        const size = results[1];
        if (this._unloaded) return null;
        if (generation !== this._markGeneration) return null;
        // 更晚的一次测量（换屏、重新加载主图、换照片）已经开始：这次量到的旧矩形作废，
        // 不能把已经显示好的新布局覆盖回旧屏幕上的位置。
        if (seq !== this._markLayoutSeq) return null;
        if (!this.isMarkContextCurrent(context)) {
          // 测量期间换了图/换了档：丢掉这次结果，并让用户看到原因。
          this.setData({ markLayoutError: '照片或线路已变化，这次测量已放弃。' });
          return null;
        }
        if (!rect || !size) {
          this._markLayout = null;
          this.setData({
            markLayoutError: '还没有读到照片显示尺寸，暂时只能看下面的文字清单。'
          });
          return null;
        }
        const layout = photoMarks.imageLayout({
          imageWidth: size.width,
          imageHeight: size.height,
          viewWidth: rect.width,
          viewHeight: rect.height
        });
        this._markLayout = layout.ok ? layout : null;
        this._markLayoutIdentity = layout.ok ? identity : '';
        this.setData({
          markLayoutError: layout.ok ? '' : layout.error || '照片尺寸不可用'
        });
        this.applyMarkPoints();
        return layout.ok ? layout : null;
      }
    );
  },

  queryMarkStageRect() {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') {
        resolve(null);
        return;
      }
      try {
        const query = wx.createSelectorQuery();
        if (query && typeof query.in === 'function') query.in(this);
        query
          .select('#route-photo-stage')
          .boundingClientRect(rect => {
            resolve(rect && rect.width > 0 && rect.height > 0 ? rect : null);
          })
          .exec();
      } catch (error) {
        resolve(null);
      }
    });
  },

  /** 原图实际尺寸：读一次就缓存，避免每次点击都读文件。 */
  resolveImageSize(mainPath) {
    const src = typeof mainPath === 'string' ? mainPath : '';
    if (!src) return Promise.resolve(null);
    if (this._imageSizes[src]) return Promise.resolve(this._imageSizes[src]);
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.getImageInfo !== 'function') {
        resolve(null);
        return;
      }
      try {
        wx.getImageInfo({
          src,
          success: info => {
            const size = photoMarks.imageSizeFromInfo(info);
            if (!size.ok) {
              resolve(null);
              return;
            }
            this._imageSizes[src] = { width: size.width, height: size.height };
            resolve(this._imageSizes[src]);
          },
          fail: () => resolve(null)
        });
      } catch (error) {
        resolve(null);
      }
    });
  },

  enterMarkMode() {
    const photo = this.data.routePhoto || {};
    if (!this.data.marksReady) {
      this.setData({ markNotice: this.data.marksError });
      return Promise.resolve(null);
    }
    if (photo.status === 'missing') {
      this.setData({
        markNotice: '本机照片不可用（文件可能已被清理），重新添加后才能标记；已写的卡点见下面的清单。'
      });
      return Promise.resolve(null);
    }
    if (photo.status !== 'saved') {
      this.setData({ markNotice: '先添加线路主照片，才能在上面标记卡点。' });
      return Promise.resolve(null);
    }
    // 进入标记模式换一个模式序号：更早一次（上一轮模式）里发起的点击测量据此作废。
    this._markModeSeq += 1;
    this.setData(Object.assign(
      {
        markMode: true,
        markNotice: '',
        markKind: photoMarks.DEFAULT_MARK_KIND,
        markSaveError: ''
      },
      this.resetMarkEditing()
    ));
    return this.ensureMarkLayout();
  },

  exitMarkMode() {
    // 退出也换模式序号：退出前发起的旧点击回来时不能再把编辑区打开。
    this._markModeSeq += 1;
    this.setData(Object.assign(
      {
        markMode: false,
        markNotice: '',
        markSaveError: ''
      },
      this.resetMarkEditing()
    ));
    this.applyMarkPoints();
  },

  dismissMarkNotice() {
    this.setData({ markNotice: '' });
  },

  dismissMarkSaveError() {
    this.setData({ markSaveError: '' });
  },

  /**
   * 点照片：非标记模式打开大图（沿用原入口）；标记模式下在照片上落点。
   * 落点在照片外的留白上不生成标记，并明确提示。
   */
  tapPhotoStage(event) {
    if (this.data.loadError || this.data.notFound) return Promise.resolve(null);
    if (!this.data.markMode) {
      this.previewRoutePhoto(event);
      return Promise.resolve(null);
    }
    return this.handleMarkTap(event);
  },

  handleMarkTap(event) {
    const photo = this.data.routePhoto || {};
    if (photo.status === 'missing') {
      this.setData({
        markNotice: '本机照片不可用（文件可能已被清理），重新添加后才能标记。'
      });
      return Promise.resolve(null);
    }
    if (photo.status !== 'saved') {
      this.setData({ markNotice: '先添加线路主照片，才能在上面标记卡点。' });
      return Promise.resolve(null);
    }
    const target = this.markTarget();
    if (!target.routeId || !target.photoId || !target.archiveId) {
      this.setData({ markNotice: '还没有确认这张照片的归属，暂时不能标记。' });
      return Promise.resolve(null);
    }

    const context = this.captureMarkContext();
    // 这次点击落在哪一次移动上：测量期间若换了选中或退出移动，这次点击不提交坐标。
    const moveOp = this.data.markMoving ? this._markMoveOp : null;
    return Promise.all([this.queryMarkStageRect(), this.resolveImageSize(photo.mainPath)]).then(
      results => {
        if (this._unloaded) return null;
        if (!this.isMarkContextCurrent(context)) {
          this.setData({ markNotice: '照片或线路已变化，这次点击没有生成卡点。' });
          return null;
        }
        const outcome = photoMarks.markPointFromTap(event, results[0], results[1]);
        if (!outcome.ok) {
          this.setData({ markNotice: outcome.error });
          return null;
        }
        if (this.data.markMoving) return this.applyMarkMove(outcome.point, moveOp);
        return this.startMarkDraft(outcome);
      }
    );
  },

  /**
   * 草稿点只存在这次渲染里：确认保存才落盘，取消不留痕迹。
   * 草稿带一个稳定的客户端操作身份（opId）并记下当时的归属：同一次落点重试几次都用
   * 同一个 opId（写成功后回执丢失也不会变成两条），归属变了则整份草稿作废。
   */
  startMarkDraft(outcome) {
    const kind = this.data.markKind || photoMarks.DEFAULT_MARK_KIND;
    if (outcome.layout && outcome.layout.ok) {
      // 这次落点用的是刚量到的最新矩形：换一个测量请求号，作废此前的迟到测量。
      this._markLayout = outcome.layout;
      const target = this.markTarget();
      this._markLayoutIdentity = [target.archiveId, target.routeId, target.photoId].join('|');
      this._markLayoutSeq += 1;
    }
    this.setData({
      markDraft: {
        x: outcome.point.x,
        y: outcome.point.y,
        kind,
        text: '',
        opId: store.newOperationId()
      },
      markSelected: null,
      markEditable: true,
      markMoving: false,
      markText: '',
      markKind: kind,
      markSaveError: '',
      markLayoutError: '',
      markNotice: '已在照片上落点，写一句手法/脚法提示后点「保存卡点」。'
    });
    this._markMoveOp = null;
    this._markDraftContext = this.captureMarkContext();
    this.applyMarkPoints();
    return outcome;
  },

  saveMarkDraft() {
    const draft = this.data.markDraft;
    if (!draft) return null;
    // 保存前先核对发起落点时的归属（档案 + 线路 + 照片 + 代次 + 模式序号）：
    // 换图、移图、移除照片或退出标记模式之后，这份旧草稿一律不落盘。
    if (!this._markDraftContext || !this.isMarkContextCurrent(this._markDraftContext)) {
      this._markDraftContext = null;
      this.setData(Object.assign(
        {
          markNotice: '这张照片（或标记模式）已经变化，这次草稿没有保存。',
          markSaveError: ''
        },
        this.resetMarkEditing()
      ));
      this.applyMarkPoints();
      return {
        ok: false,
        code: 'stale-draft',
        error: '这张照片（或标记模式）已经变化，这次草稿没有保存',
        mark: null
      };
    }
    const target = this.markTarget();
    const outcome = photoMarks.addMark({
      archiveId: target.archiveId,
      routeId: target.routeId,
      photoId: target.photoId,
      opId: draft.opId,
      x: draft.x,
      y: draft.y,
      kind: this.data.markKind,
      text: this.data.markText
    });
    if (!outcome.ok) {
      // 不报已保存；落盘失败时序号不消耗，再点一次拿到同一个稳定 ID。
      // 同一次落点带同一个 opId：若这次其实已经落盘（回执丢失），重试只会复用那一条。
      this.setData({
        markSaveError: outcome.code === 'write-failed' ? outcome.error : '',
        markNotice:
          outcome.code === 'write-failed' ? '卡点未保存，可再点一次「保存卡点」重试。' : outcome.error
      });
      return outcome;
    }
    this._markDraftContext = null;
    this.setData({
      markDraft: null,
      markSaveError: '',
      markSelected: this.markSelectionView(outcome.mark),
      markKind: outcome.mark.kind,
      markText: outcome.mark.text,
      markEditable: true,
      markNotice: '已保存卡点，只记在本机；照片、把次与备注都不变。'
    });
    this.refreshMarkView();
    return outcome;
  },

  selectMarkPoint(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const markId = dataset.markId;
    if (!markId) return;
    const mark = (this._markMarks || []).find(item => item.markId === markId);
    if (!mark) {
      this.setData({ markNotice: '这条卡点已经不在本机。' });
      this.refreshMarkView();
      return;
    }
    this.setData({
      markMode: true,
      markSelected: this.markSelectionView(mark),
      markDraft: null,
      markKind: mark.kind,
      markText: mark.text,
      markEditable: true,
      markMoving: false,
      markSaveError: '',
      markNotice: ''
    });
    // 换了选中：这一次选择取代此前的移动操作，旧的移动点击不再属于任何人。
    this._markMoveOp = null;
    this.applyMarkPoints();
  },

  markSelectionView(mark) {
    const list = this._markMarks || [];
    const index = list.findIndex(item => item.markId === mark.markId) + 1;
    return {
      markId: mark.markId,
      index,
      kind: mark.kind,
      kindText: photoMarks.MARK_KIND_TEXT[mark.kind] || '',
      text: mark.text,
      x: mark.x,
      y: mark.y
    };
  },

  onMarkTextInput(event) {
    const value = (event && event.detail && event.detail.value) || '';
    this.setData({ markText: typeof value === 'string' ? value : '' });
  },

  pickMarkKind(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const kind = dataset.kind;
    if (photoMarks.MARK_KINDS.indexOf(kind) < 0) return;
    const patch = { markKind: kind };
    if (this.data.markDraft) {
      patch.markDraft = Object.assign({}, this.data.markDraft, {
        kind,
        text: this.data.markText
      });
    }
    this.setData(patch);
    this.applyMarkPoints();
  },

  /** 改字/换手法脚法：只改这一条，别人不动。 */
  saveMarkEdit() {
    const selected = this.data.markSelected;
    if (!selected) return null;
    const outcome = photoMarks.updateMark({
      markId: selected.markId,
      text: this.data.markText,
      kind: this.data.markKind
    });
    if (!outcome.ok) {
      if (outcome.code === 'missing') {
        this.setData({
          markSelected: null,
          markEditable: false,
          markMoving: false,
          markNotice: outcome.error
        });
        this.refreshMarkView();
        return outcome;
      }
      this.setData({
        markSaveError: outcome.code === 'write-failed' ? outcome.error : '',
        markNotice:
          outcome.code === 'write-failed' ? '改动未保存，可再点一次「保存修改」重试。' : outcome.error
      });
      return outcome;
    }
    this.setData({
      markSaveError: '',
      markSelected: this.markSelectionView(outcome.mark),
      markNotice: outcome.code === 'unchanged' ? '内容没有变化。' : '已保存改动。'
    });
    this.refreshMarkView();
    return outcome;
  },

  startMarkMove() {
    const selected = this.data.markSelected;
    if (!selected) return;
    // 这一次移动领一个操作号，并记下要移动的标记与当时的归属：点新位置的测量期间若换了
    // 选中或换了照片，迟到的点击凭这个号知道它已经不归自己，不再提交坐标。
    this._markMoveSeq += 1;
    this._markMoveOp = {
      opId: this._markMoveSeq,
      markId: selected.markId,
      context: this.captureMarkContext()
    };
    this.setData({
      markMoving: true,
      markSaveError: '',
      markNotice: '点照片上的新位置，把这条卡点移过去；点「取消移动」保持原位。'
    });
    this.applyMarkPoints();
  },

  cancelMarkMove() {
    this._markMoveOp = null;
    this.setData({ markMoving: false, markNotice: '' });
    this.applyMarkPoints();
  },

  /**
   * 把选中的那条移到新位置：只改位置，文字、手法/脚法与别的标记都不变。
   * 提交坐标前先核对这次点击所属的移动操作：与当前正在移动的标记不是同一条、
   * 或归属/模式已经变化时，一律不写，位置保持原值。
   */
  applyMarkMove(point, op) {
    const selected = this.data.markSelected;
    if (!selected || !this.data.markMoving) {
      this.setData({ markMoving: false, markNotice: '没有选中要移动的卡点。' });
      return null;
    }
    const moveOp = this._markMoveOp;
    if (
      !moveOp ||
      !op ||
      op.opId !== moveOp.opId ||
      op.markId !== selected.markId ||
      !this.isMarkContextCurrent(op.context)
    ) {
      this.setData({
        markNotice: '这次点击属于更早的一次移动（期间选中或照片已变化），位置没有改动，请再点一次新位置。'
      });
      return null;
    }
    const outcome = photoMarks.moveMark({
      markId: selected.markId,
      x: point.x,
      y: point.y
    });
    if (!outcome.ok) {
      if (outcome.code === 'missing') {
        this._markMoveOp = null;
        this.setData({
          markSelected: null,
          markEditable: false,
          markMoving: false,
          markNotice: outcome.error
        });
        this.refreshMarkView();
        return outcome;
      }
      this.setData({
        markSaveError: outcome.code === 'write-failed' ? outcome.error : '',
        markNotice:
          outcome.code === 'write-failed'
            ? '新位置未保存，原位置不变；可再点一次重试。'
            : outcome.error
      });
      return outcome;
    }
    this._markMoveOp = null;
    this.setData({
      markSaveError: '',
      markMoving: false,
      markSelected: this.markSelectionView(outcome.mark),
      markNotice: '已移动这条卡点到新位置。'
    });
    this.refreshMarkView();
    return outcome;
  },

  /** 删除前先确认：标记是本机唯一一份，删掉要重新点。 */
  askRemoveMark(mark) {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(false);
        return;
      }
      const label = (mark && mark.text) || '这条卡点';
      try {
        wx.showModal({
          title: '删除卡点',
          content: '只删除「' + label + '」这一条；照片、把次与备注都不会改变。',
          confirmText: '删除',
          cancelText: '保留',
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

  deleteMarkPoint() {
    const selected = this.data.markSelected;
    if (!selected) return Promise.resolve(null);
    const context = this.captureMarkContext();
    return this.askRemoveMark(selected).then(confirmed => {
      if (!confirmed || this._unloaded) return null;
      if (!this.isMarkContextCurrent(context)) {
        this.setData({ markNotice: '照片或线路已变化，这次删除已取消。' });
        return null;
      }
      const outcome = photoMarks.removeMark(selected.markId);
      if (!outcome.ok) {
        this.setData({
          markSaveError: outcome.code === 'write-failed' ? outcome.error : '',
          markNotice:
            outcome.code === 'write-failed'
              ? '删除未保存，这条卡点还在；可再点一次重试。'
              : outcome.error
        });
        this.refreshMarkView();
        return outcome;
      }
      this.setData({
        markSelected: null,
        markEditable: false,
        markMoving: false,
        markText: '',
        markSaveError: '',
        markNotice: outcome.removed
          ? '已删除这条卡点；照片、把次与备注都不变。'
          : '这条卡点本来就不在本机。'
      });
      this.refreshMarkView();
      return outcome;
    });
  },

  reloadMarkImage() {
    this.invalidateMarkLayout();
    this.setData({ markLayoutError: '' });
    return this.ensureMarkLayout();
  },

  /**
   * 主图渲染完成后再测量一次：第一次进入页面时显示区可能还没布局好，
   * 这时量到的是空矩形，指示点就不上图；图加载完成后按真实矩形补一次。
   */
  onMarkImageLoad() {
    this.invalidateMarkLayout();
    return this.ensureMarkLayout();
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

    // 重读页面等于离开编辑：换一个模式序号，上一轮模式里发起的旧点击与旧草稿一并失效。
    this._markModeSeq += 1;
    this.setData(Object.assign(
      {
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
        // 卡点标记的临时状态一并归零：按最新照片与标记记录重算（标记本身不删）。
        markNotice: '',
        markSaveError: '',
        markLayoutError: '',
        markMode: false,
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
        correctionStatusText: '',
        routeCorrectable: false,
        sessionPicker: keepPicker ? this.data.sessionPicker : null
      },
      this.resetMarkEditing()
    ));

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
      this.setData({ route: null, notFound: false, routePhoto: null, wishlistState: null, canRecordAgain: false });
      return;
    }

    if (!this._routeId) {
      this.setData({ notFound: true, route: null, canRecordAgain: false, routePhoto: null, wishlistState: null });
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
        correctionStatusText: '',
        routeCorrectable: false
      });
      return;
    }

    const route = history.route;
    const completion = history.completion;

    // 逐把更正行：这条抱石线的每一把仍可更正的完攀各占一行；本实例刚改好的那一把
    // 留在原位置变成只读回读行，行与行之间不塌陷，同一坐标不会被另一把接手。
    const correctionRows = store
      .routeCorrectionRows(this.archive, route.id, Object.keys(this._correctedRows))
      .map(row => {
        if (row.state === 'corrected') {
          const readback = this._correctedRows[row.attemptId];
          return {
            attemptId: row.attemptId,
            routeId: row.routeId,
            sessionId: row.sessionId,
            archiveId: this.archive.archiveId,
            label: row.label,
            contextText: row.contextText,
            state: 'corrected',
            buttonText: '',
            statusText: (readback && readback.statusText) || '已改为未完成 · 本把次保留原时间、场次与备注'
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
          state: needsRetry ? 'retry' : 'ready',
          buttonText: needsRetry ? '重试改为未完成' : '改为未完成',
          statusText: ''
        };
      });

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
        attempts: group.attempts.map(attempt => ({
          id: attempt.id,
          label: attempt.label,
          resultText: attempt.resultText,
          isSend: attempt.result === 'send',
          timeText: timeText(attempt.createdAt),
          note: attempt.note,
          hasNote: Boolean(attempt.note)
        }))
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
      correctionRows,
      correctionStatusText: correctionRows.some(row => row.state === 'retry')
        ? '更正未保存 · 点「重试改为未完成」按同一把重试'
        : '',
      routeCorrectable: correctionRows.some(row => row.state !== 'corrected')
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

  // ---------------------------------------------------------------- 按把更正

  /**
   * 「改为未完成」：只改正渲染这一行对应的那一把已确认完攀。
   *
   * 目标来自该行按钮带下来的原把次 ID 与归属，连点/双击原坐标只会重复更正同一把
   * （第二次幂等返回 resolved），不会改到另一把；只翻这一把的 result，把数、ID、
   * 序号、场次、时间与备注都不变，之后可以正常再记并再次完攀。
   *
   * T036：与单线记录页共用 utils/training-record-actions.js 的同一份实现，避免两个
   * 不一致的写实现；本页的 _correctedRows / _correctionFailures 由 refreshView 读取。
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
