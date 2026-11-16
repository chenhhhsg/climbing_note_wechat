/**
 * 线路照片大图 · 照片动作标记（T040）
 *
 * 从线路历史的缩略图 / 「照片动作标记 · N 个」进入，只针对入口带来的那一张照片：
 * 档案、长期线路与照片 ID 在打开时逐项核对；线路历史只留缩略图和标记数量，本页承接
 * 主图、已有标记、换图、移除与完整的标记编辑。
 *
 * 标记仍由 utils/training-photo-marks.js 驱动，照片仍由 utils/training-photo-controller.js
 * 驱动，数据与文件格式都不变：
 * - 标记按「档案 + 线路 ID + 当前主照片 ID」归属，位置按原图归一化保存；换了照片后
 *   照片 ID 变，旧标记不再叠加到新照片上，只提示另有几条属于旧照片；
 * - 打开时按入口的档案、线路与照片 ID 重新读取当前版本：照片已被更换时按当前照片
 *   显示，入口里的旧照片 ID 只用于核对与只读提示，任何写入都按当前照片归属；
 * - 只写本机标记记录与照片索引/文件，不写旧档案、不改把次与备注，也不上传；
 * - 点照片外的留白不生成标记；移动、改字、删除与换图前的旧草稿都按发起时的归属
 *   校验，换图、换档或退出标记模式之后的迟到回调一律不写另一张图。
 *
 * 有未保存的草稿或改动时启用返回确认：返回会丢弃这次编辑，已保存的标记不受影响。
 */
const store = require('../../utils/training-store.js');
const photoMarks = require('../../utils/training-photo-marks.js');
const { climbTypeOf } = require('../../utils/training-rules.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

const SESSION_URL = '/pages/training-session/training-session';
const PROFILE_URL = '/pages/profile/profile';

Page({
  data: {
    ready: false,
    loadError: '',        // 档案损坏 / 版本不支持 / 读取失败
    claimError: '',       // 入口带的档案 ID 与本机现在这一份不一致（不展示、不受理写入）
    notice: '',           // 说明性提示，不改数据
    route: null,
    notFound: false,

    // 线路主照片：展示、预览确认、更换与移除都由照片控制器驱动
    routePhoto: null,
    photoNotice: '',
    photoChangedNotice: '',  // 入口里的照片已被更换：按当前照片显示，不叠加旧点

    // 照片动作标记：只读写本机标记记录，主图字节、把次与备注都不动
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
    markMoving: false
  },

  onLoad(query) {
    this._routeId = (query && (query.routeId || query.routeid)) || '';
    // 入口的明示归属：线路历史渲染那一页使用的档案 ID 与照片 ID。
    this._archiveIdClaim = (query && (query.archiveId || query.archiveid)) || '';
    this._photoIdClaim = (query && (query.photoId || query.photoid)) || '';
    this._claimBlocked = false;
    this._unloaded = false;
    this._photoUi = null;
    // 标记：当前照片上的标记内存快照、显示框布局缓存、图片尺寸缓存与各类代次。
    // - _markIdentity 是「档案 + 线路 + 当前照片」三者拼出的当前归属；换了任意一项就
    //   递增 _markGeneration，早期的异步回调据此丢弃，不把旧点位写到新照片上；
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
    this._unloadAlertOn = false;
    this.loadPage();
    this.loadRoutePhoto();
  },

  /**
   * 页面重新显示：另一页面实例可能刚换了照片或改了标记，按最新版本重读。
   * 打开本页只读，不写盘。
   */
  onShow() {
    if (!this.data.ready) return;
    this.loadPage();
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
    this.disableUnloadAlert();
  },

  /**
   * 照片控制器只在本页创建一次；档案 ID 由控制器从本机档案读取。
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
    if (this._claimBlocked || !this._routeId) {
      this.setData({ routePhoto: null });
      return Promise.resolve();
    }
    return Promise.resolve(this.initPhotoUi()).then(() => {
      if (!this._photoUi) return;
      return this._photoUi
        .load([this._routeId])
        .then(() => this.applyPhotoView());
    });
  },

  /**
   * 只更新当前线路的照片展示；归属（档案 + 线路 + 当前照片）变化——确认换图、
   * 移图或移除主照片——时递增标记代次、丢掉旧布局，并让旧草稿、选中、移动与待决
   * 回调一并失效：旧照片上的标记不再叠加到新照片，旧草稿也不能再被保存到新照片上。
   * 入口里的照片 ID 与当前版本不一致时只提示，写入仍按当前照片归属。
   */
  applyPhotoView() {
    if (!this._photoUi || !this.data.route) return;
    const view = this._photoUi.view(this.data.route.id);
    const photoChanged = Boolean(
      this._photoIdClaim &&
        view.photoId &&
        view.status === 'saved' &&
        view.photoId !== this._photoIdClaim
    );
    const identity = [
      (this.archive && this.archive.archiveId) || '',
      (this.data.route && this.data.route.id) || this._routeId || '',
      this.markTargetPhotoId(view)
    ].join('|');
    const patch = {
      routePhoto: view,
      photoChangedNotice: photoChanged
        ? '这条线路的照片已经更换，本页按当前照片显示；旧照片上的卡点不会叠加。'
        : ''
    };
    if (identity !== this._markIdentity) {
      this._markIdentity = identity;
      this._markGeneration += 1;
      this.invalidateMarkLayout();
      Object.assign(patch, this.resetMarkEditing());
    }
    this.setData(patch);
    this.refreshMarkView();
    this.ensureMarkLayout();
    this.syncUnloadAlert();
  },

  /**
   * 当前照片 ID：以本机当前版本为准；照片记录还在但文件/索引暂不可读时退回入口
   * 带来的照片 ID，只用于读回那一版已写的提示文字，写入口仍要求照片可用。
   */
  markTargetPhotoId(view) {
    const photo = view || this.data.routePhoto || {};
    if (photo.photoId) return photo.photoId;
    if (photo.status === 'missing' || photo.status === 'error') {
      return this._photoIdClaim || '';
    }
    return '';
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

  dismissPhotoChangedNotice() {
    this.setData({ photoChangedNotice: '' });
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

  /** 当前标记归属：当前档案 + 长期线路 ID + 当前照片 ID，三者缺一不显示也不写。 */
  markTarget() {
    return {
      archiveId: (this.archive && this.archive.archiveId) || '',
      routeId: (this.data.route && this.data.route.id) || this._routeId || '',
      photoId: this.markTargetPhotoId()
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
    this.syncUnloadAlert();
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
    this.syncUnloadAlert();
  },

  dismissMarkNotice() {
    this.setData({ markNotice: '' });
  },

  dismissMarkSaveError() {
    this.setData({ markSaveError: '' });
  },

  /**
   * 有未保存的草稿或改动时提示返回确认：返回会丢弃这次编辑，已保存的标记不动。
   * 小程序没有拦截返回的同步钩子，这里用系统的「离开确认」能力；不可用时退回静默。
   */
  hasUnsavedEditing() {
    if (this.data.markDraft) return true;
    const selected = this.data.markSelected;
    if (!selected || !this.data.markEditable) return false;
    return this.data.markText !== selected.text || this.data.markKind !== selected.kind;
  },

  syncUnloadAlert() {
    const dirty = this.hasUnsavedEditing();
    if (dirty && !this._unloadAlertOn) {
      this._unloadAlertOn = true;
      if (typeof wx !== 'undefined' && typeof wx.enableAlertBeforeUnload === 'function') {
        try {
          wx.enableAlertBeforeUnload({
            message: '还有未保存的卡点草稿，返回会丢弃这次编辑；已保存的卡点不受影响。'
          });
        } catch (error) {
          // 低版本基础库没有这个能力时不影响编辑本身。
        }
      }
      return;
    }
    if (!dirty) this.disableUnloadAlert();
  },

  disableUnloadAlert() {
    if (!this._unloadAlertOn) return;
    this._unloadAlertOn = false;
    if (typeof wx !== 'undefined' && typeof wx.disableAlertBeforeUnload === 'function') {
      try {
        wx.disableAlertBeforeUnload();
      } catch (error) {
        // 同上：仅是返回提示，失败不改数据。
      }
    }
  },

  /**
   * 点照片：非标记模式打开大图；标记模式下在照片上落点。
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
    this.syncUnloadAlert();
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
      this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
        this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
    this.syncUnloadAlert();
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
      this.syncUnloadAlert();
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

  // ------------------------------------------------------------ 页面数据

  /**
   * 读取本机档案并按最新数据重算展示；只读，不写盘。
   * 入口归属（档案 ID）与当前本机档案不一致时只显示原因，不展示线路也不受理写入。
   */
  loadPage() {
    const loaded = store.loadState();
    this.archive = loaded.archive;

    this._claimBlocked = Boolean(
      this._archiveIdClaim &&
        loaded.archive &&
        this._archiveIdClaim !== loaded.archive.archiveId
    );

    // 重读页面等于离开编辑：换一个模式序号，上一轮模式里发起的旧点击与旧草稿一并失效。
    this._markModeSeq += 1;
    this._markGeneration += 1;
    this.invalidateMarkLayout();
    this.setData(Object.assign(
      {
        ready: true,
        loadError: loaded.error || '',
        claimError: this._claimBlocked
          ? '这个入口属于另一份本机档案（' +
            this._archiveIdClaim +
            '），未展示任何线路内容，也不接受改动；请从当前的线路历史重新打开。'
          : '',
        notice: '',
        route: null,
        notFound: false,
        routePhoto: null,
        photoNotice: '',
        photoChangedNotice: '',
        markNotice: '',
        markSaveError: '',
        markLayoutError: '',
        markMode: false,
        marksReady: true,
        marksError: '',
        markCountText: '',
        markHiddenText: '',
        markPoints: [],
        markList: []
      },
      this.resetMarkEditing()
    ));
    this.disableUnloadAlert();

    this.refreshView();
  },

  retryLoad() {
    this.loadPage();
    this.loadRoutePhoto();
  },

  /**
   * 由当前档案重新推导展示内容；不改动任何已保存数据。
   */
  refreshView() {
    if (this.data.loadError) return;
    // 入口不属于当前档案：不读这条线的照片与标记，也不受理写入。
    if (this._claimBlocked) {
      this.setData({ route: null, notFound: false, routePhoto: null });
      return;
    }

    if (!this._routeId) {
      this.setData({ notFound: true, route: null, routePhoto: null });
      return;
    }

    const history = store.routeHistory(this.archive, this._routeId);
    if (!history.known) {
      this.setData({ notFound: true, route: null, routePhoto: null });
      return;
    }

    const route = history.route;
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
      routePhoto: this._photoUi ? this._photoUi.view(route.id) : this.data.routePhoto
    });
  },

  /**
   * 归属不符入口的出口：正常路径是系统返回；没有上一页时回到正式场内页。
   */
  backToList() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
            wx.reLaunch({ url: SESSION_URL });
          }
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
  }
});
