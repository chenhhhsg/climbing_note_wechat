/**
 * 逐把视频页 · 待确认预览（T023）
 *
 * 从本线逐把明细或跨日线路历史进入，只针对**入口带来的那一把**：档案、原场次、
 * 长期线路与原把次四个 ID 在打开时逐项核对（utils/attempt-video.js 的同一份判定），
 * 不是这一把、已撤回、还没保存或只存在于旧汇总时只显示原因，不受理选择。
 *
 * 本单只做相册单选与待确认预览：
 * - wx.chooseMedia 用一个选项对象调用，count 1、只允许视频、只允许相册；
 * - 选中的临时路径只留在当前页面实例里，不复制文件、不写索引、不上传；
 * - 相册取消不是错误，取消预览也不创建副本，两者都能立刻重选；
 * - 每次选择带自己的序号与归属标识：离页、连点或换了一把之后，迟到的回调不采用，
 *   也不会写到别的把次上。
 *
 * 播放、替换与移除在 T024；确认保存与持久副本在 T026。
 */
const attemptVideo = require('../../utils/attempt-video.js');
const actions = require('../../utils/training-record-actions.js');
const store = require('../../utils/training-store.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';

Page({
  data: {
    ready: false,
    loadError: '',
    contextError: '',

    archiveId: '',
    activeSession: null,
    selectedRoute: null,
    attempt: null,

    // 关联状态：本单视频索引为空，显示「未添加视频」；索引不可读时单独说明。
    hasSavedVideo: false,
    videoStateText: '',

    // 待确认预览：只有临时路径与展示信息，没有持久副本。
    hasPreview: false,
    preview: null,
    choosing: false,
    chooseError: '',
    notice: ''
  },

  onLoad(query) {
    this._context = attemptVideo.parseVideoQuery(query);
    // 选择序号：每次选择、取消、换归属或离页都递增，迟到的 success/fail 据此丢弃。
    this._selectionSeq = 0;
    this._unloaded = false;
    this._contextToken = '';
    this._previewToken = '';
    this.archive = null;
    this._session = null;
    this._route = null;
    this._attempt = null;
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从别的页面返回、或另一实例刚改了同一份档案：按最新档案重新核对这一把的归属。
    this.loadPage();
  },

  /**
   * 离开页面：本页所有迟到的选择回调据此丢弃，不写数据也不提示。
   */
  onUnload() {
    this._unloaded = true;
    this._selectionSeq += 1;
  },

  loadPage() {
    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }

    const archive = context.archive;
    const session = context.session;
    const route = context.route;
    const attempt = context.attempt;
    const token = attemptVideo.contextToken({
      archiveId: archive.archiveId,
      sessionId: session.id,
      routeId: route.id,
      attemptId: attempt.id
    });
    // 同一把刷新（返回本页 / 页面重新显示）保留预览；换了归属立刻作废旧预览与旧回调。
    const changed = Boolean(this._contextToken && this._contextToken !== token);
    if (changed) {
      this._selectionSeq += 1;
      this._previewToken = '';
    }
    this._contextToken = token;
    this.archive = archive;
    this._session = session;
    this._route = route;
    this._attempt = attempt;

    const labels = actions.attemptLabelMap(archive, session.id, route.id);
    const link = attemptVideo.videoLinkView(archive.archiveId, attempt.id);
    const patch = {
      ready: true,
      loadError: '',
      contextError: '',
      archiveId: archive.archiveId,
      activeSession: {
        id: session.id,
        gymId: session.gymId,
        gymName: store.gymName(archive, session.gymId),
        dateText: session.date,
        label: store.sessionLabel(archive, session)
      },
      selectedRoute: {
        id: route.id,
        name: route.name,
        climbType: climbTypeOf(route),
        grade: route.grade,
        colorName: route.colorName || '',
        colorHex: route.colorHex || '#dee2e6'
      },
      attempt: {
        id: attempt.id,
        label: labels.get(attempt.id) || '',
        resultText: actions.attemptResultText(attempt.result),
        isSend: attempt.result === 'send',
        timeText: actions.timeText(attempt.createdAt),
        note: attempt.note || '',
        hasNote: Boolean(attempt.note)
      },
      hasSavedVideo: link.hasVideo,
      videoStateText: link.stateText
    };
    if (changed) {
      patch.hasPreview = false;
      patch.preview = null;
      patch.choosing = false;
      patch.chooseError = '';
      patch.notice = '';
    }
    this.setData(patch);
  },

  /**
   * 归属核对失败：清掉这一把的展示与预览，只留可见原因和返回出口。
   */
  applyContextFailure(context) {
    this.archive = context.archive || null;
    this._session = null;
    this._route = null;
    this._attempt = null;
    this._contextToken = '';
    this._previewToken = '';
    this._selectionSeq += 1;
    this.setData({
      ready: true,
      loadError: context.code === 'unreadable' ? context.error : '',
      contextError: context.code === 'unreadable' ? '' : context.error,
      archiveId: '',
      activeSession: null,
      selectedRoute: null,
      attempt: null,
      hasSavedVideo: false,
      videoStateText: '',
      hasPreview: false,
      preview: null,
      choosing: false,
      chooseError: '',
      notice: ''
    });
  },

  retryLoad() {
    this.loadPage();
  },

  /**
   * 从相册单选一段视频，只进入待确认预览。
   * - 连点：选择器已经打开时不再发第二个请求；
   * - 打开前按最新档案再核对一次归属，撤回/换档之后不再打开相册；
   * - 取消不写任何状态，失败给出可见提示，两种都能立刻再点。
   */
  choosePreview() {
    if (this.data.choosing) return;

    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    // 展示也按最新档案刷新：这一把若刚被撤回，refreshView 会替换成只读原因。
    this.loadPage();
    if (this.data.contextError || this.data.loadError) return;

    const token = attemptVideo.contextToken({
      archiveId: context.archive.archiveId,
      sessionId: context.session.id,
      routeId: context.route.id,
      attemptId: context.attempt.id
    });
    const seq = this._selectionSeq + 1;
    this._selectionSeq = seq;
    this._previewToken = token;

    if (typeof wx === 'undefined' || typeof wx.chooseMedia !== 'function') {
      this.setData({ choosing: false, chooseError: '当前环境不支持从相册选择视频。' });
      return;
    }

    const options = attemptVideo.chooseMediaOptions();
    options.success = res => this.handleChooseSuccess(seq, token, res);
    options.fail = error => this.handleChooseFail(seq, token, error);

    this.setData({ choosing: true, chooseError: '', notice: '' });
    wx.chooseMedia(options);
  },

  /**
   * 选到文件：序号或归属对不上（离页、连点后的旧回调、换了一把）一律丢弃；
   * 采用前再读一次最新档案，撤回或换档之后不把临时路径挂到这一把上。
   */
  handleChooseSuccess(seq, token, res) {
    if (this._unloaded || seq !== this._selectionSeq) return;

    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    const currentToken = attemptVideo.contextToken({
      archiveId: context.archive.archiveId,
      sessionId: context.session.id,
      routeId: context.route.id,
      attemptId: context.attempt.id
    });
    if (currentToken !== token) {
      this.loadPage();
      this.setData({
        choosing: false,
        hasPreview: false,
        preview: null,
        chooseError: '这一把的归属已经变化，这次选择没有采用；请重新选择。'
      });
      return;
    }

    const outcome = attemptVideo.previewFromChoice(res);
    if (!outcome.ok) {
      this.setData({
        choosing: false,
        hasPreview: false,
        preview: null,
        chooseError: outcome.error
      });
      return;
    }

    this._previewToken = token;
    this.setData({
      choosing: false,
      chooseError: '',
      hasPreview: true,
      preview: outcome.preview,
      notice: ''
    });
  },

  /**
   * 选择失败：取消不是错误（保留已有预览，可立刻再选）；其他失败给出可见原因。
   */
  handleChooseFail(seq, token, error) {
    if (this._unloaded || seq !== this._selectionSeq) return;
    this.setData({ choosing: false });
    if (attemptVideo.isCancelError(error)) {
      this.setData({ chooseError: '' });
      return;
    }
    const message = (error && error.errMsg) || '未知错误';
    this.setData({ chooseError: '选择视频失败：' + message + '，可以重新选择。' });
  },

  /**
   * 取消待确认预览：只丢掉临时路径，不删任何文件（本单也没有创建副本），可立刻重选。
   */
  cancelPreview() {
    this._previewToken = '';
    this._selectionSeq += 1;
    this.setData({
      hasPreview: false,
      preview: null,
      choosing: false,
      chooseError: '',
      notice: '已取消预览，没有创建任何文件；可以重新选择。'
    });
  },

  dismissChooseError() {
    this.setData({ chooseError: '' });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  /**
   * 归属不符时的出口：正常路径就是系统返回；没有上一页时回到场内记录页。
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
  }
});
