/**
 * 逐把视频页 · 原生播放、更换与移除（T024）
 *
 * 从本线逐把明细或跨日线路历史进入，只针对**入口带来的那一把**：档案、原场次、
 * 长期线路与原把次四个 ID 在打开时逐项核对（utils/attempt-video.js 的同一份判定），
 * 不是这一把、已撤回、还没保存或只存在于旧汇总时只显示原因，不受理播放器与选择。
 *
 * 本页同时承接两种片源：
 * - 待确认预览：相册返回的临时路径，只在当前页面实例里，换一把或取消即丢弃；
 * - 已保存副本：视频索引里这一把的片段，按相对文件标识拼出本机路径播放。
 *
 * 播放与操作规则：
 * - 每个正在显示的片源有自己的 token（归属标识 + 序号）。原生 video 事件带节点上的
 *   token 回来，只有当前片才被采用；换片后旧节点迟到的 loadedmetadata / play /
 *   pause / error 不覆盖新片，也不改页面其他状态；
 * - 播放与暂停只向播放器发请求，界面上的播放状态以 bindplay / bindpause 回报为准；
 * - 已保存片源打不开（文件被清理或损坏）时给出可见的重选提示，原把次、备注与相册
 *   原片都保留；
 * - 更换先进入待确认预览：确认前不改关联，取消回到同一段旧片且不创建/删除文件；
 * - 保存、更换、移除都经明确操作，忙碌、失败、成功各有可见状态；成功与否以读回的
 *   本机视频索引为准（回执只是参考，回执丢了但索引已到目标状态也算成功）；
 * - 每次操作带自己的序号、归属标识与预览序号：离页、换把、换档或预览被替换之后，
 *   迟到的写入回执不采用，也不会写到别的把次上。
 *
 * 持久副本、索引提交与旧文件回收由 T026 实现（utils/attempt-video-files.js）：
 * 本页在模块加载时注册按档案创建持久层的工厂，写入只经 playback 的注入接口；
 * 页面自身不写 storage、不碰文件系统，只显示占用并提供「清理无引用副本」入口。
 */
const attemptVideo = require('../../utils/attempt-video.js');
const playback = require('../../utils/attempt-video-playback.js');
const videoFiles = require('../../utils/attempt-video-files.js');
const attemptVideoMarkers = require('../../utils/attempt-video-markers.js');
const actions = require('../../utils/training-record-actions.js');
const store = require('../../utils/training-store.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';

// T026：持久层按 request.archiveId 取对应档案的服务；换档/迟到回调不会写错档案。
playback.setVideoStoreFactory(archiveId => videoFiles.openAttemptVideoService(archiveId));

Page({
  data: {
    ready: false,
    loadError: '',
    contextError: '',

    archiveId: '',
    activeSession: null,
    selectedRoute: null,
    attempt: null,

    // 关联状态：视频索引里这一把的片段（T026 写入后生效）。
    hasSavedVideo: false,
    videoStateText: '',
    savedVideo: null,
    indexError: '',

    // 待确认预览：只有临时路径与展示信息，没有持久副本。
    hasPreview: false,
    preview: null,
    choosing: false,
    chooseError: '',
    notice: '',

    // 播放器：同时只挂一个原生 video 节点，videoInstances 随片源更换重建。
    videoInstances: [],
    playerToken: '',
    playerSrc: '',
    playerKind: '',
    playerTitle: '',
    playerFileName: '',
    playerSizeText: '',
    playerDurationText: '',
    playerDimensionText: '',
    playerReady: false,
    playerStatus: '',
    playing: false,
    playbackError: '',

    // T025：手工时间点。持久整数毫秒，列表按时间升序；实际落点只认播放器回报。
    markers: [],
    canAddMarker: false,
    markerHint: '',
    markerError: '',
    markerNotice: '',
    markerBusy: false,
    markerPendingRetry: false,
    playerDurationSeconds: null,
    playerTimeMs: null,
    playerTimeText: '',
    seekPending: false,
    seekRequestText: '',
    seekActualText: '',

    // 保存 / 更换 / 移除的状态。
    busy: false,
    opKind: '',
    opStatus: '',
    opError: '',
    confirmRemove: false,
    storeAvailable: false,
    storeHint: '',

    // T026：本档案视频占用（按实际文件字节）与可执行的无引用副本清理。
    spaceUsageText: '',
    spaceDetailText: '',
    spaceWarning: '',
    spaceError: '',
    canCleanupOrphans: false,
    cleanupBusy: false,
    cleanupNotice: ''
  },

  onLoad(query) {
    this._context = attemptVideo.parseVideoQuery(query);
    // 选择序号：每次选择、取消、换归属或离页都递增，迟到的 success/fail 据此丢弃。
    this._selectionSeq = 0;
    // 预览序号：每次预览建立、取消或采用成功都递增，写入回执据此丢弃。
    this._previewSeq = 0;
    // 操作序号：每次保存/更换/移除递增，旧回执与旧错误据此丢弃。
    this._opSeq = 0;
    // 片源序号：每次切换播放器片源递增，video 节点 token 与 domId 一起换。
    this._sourceSeq = 0;
    // 空间统计序号：换页/换档后迟到的占用读数不覆盖新页面。
    this._spaceSeq = 0;
    // 时间点序号：换片/换归属后迟到的写入回执不采用；失败重试沿用同一 markerId。
    this._markerOpSeq = 0;
    this._pendingMarker = null;
    this._playerTimeSeconds = null;
    this._seek = null;
    this._seekTimer = null;
    this._seekWaitMs = 0;
    this._videoService = null;
    this._unloaded = false;
    this._contextToken = '';
    this._previewToken = '';
    this._previewMode = '';
    this._previewBaseClip = null;
    this._savedClip = null;
    this._playerClip = null;
    // 移除确认框固定发起时的原把与片段版本（外部刷新不得把它改绑到新片）。
    this._removeTarget = null;
    this._videoContext = null;
    this._videoContextDomId = '';
    this.archive = null;
    this._session = null;
    this._route = null;
    this._attempt = null;
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从别的页面返回、或另一实例刚改了同一份档案：按最新档案与索引重新核对这一把。
    this.loadPage();
  },

  /**
   * 离开页面：本页所有迟到的选择回调、视频事件与写入回执据此丢弃，不写数据也不提示。
   */
  onUnload() {
    this._unloaded = true;
    this.clearSeekWait();
    this._selectionSeq += 1;
    this._previewSeq += 1;
    this._opSeq += 1;
    this._spaceSeq += 1;
    this._markerOpSeq += 1;
  },

  // ------------------------------------------------------------------ *
  // 读取与刷新
  // ------------------------------------------------------------------ *

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
    // 同一把刷新（返回本页 / 页面重新显示）保留预览与播放器；换了归属立刻作废旧预览与旧回调。
    const changed = Boolean(this._contextToken && this._contextToken !== token);
    if (changed) {
      this._selectionSeq += 1;
      this.invalidatePreview();
    }
    this._contextToken = token;
    this.archive = archive;
    this._session = session;
    this._route = route;
    this._attempt = attempt;

    const labels = actions.attemptLabelMap(archive, session.id, route.id);
    const read = attemptVideo.videoClipView(archive.archiveId, attempt.id, attempt);
    const storeAvailable = playback.videoStoreAvailable();
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
      hasSavedVideo: read.state === 'saved',
      videoStateText: read.stateText,
      storeAvailable,
      storeHint: storeAvailable ? '' : playback.unavailableMessage()
    };
    if (changed) {
      Object.assign(patch, this.emptyExtras());
      this._savedClip = null;
      this._playerClip = null;
      this._removeTarget = null;
      this._videoContext = null;
      this._videoContextDomId = '';
      this._pendingMarker = null;
      this._playerTimeSeconds = null;
      this.clearSeekWait();
      this._seek = null;
        this._markerOpSeq += 1;
    }
    this.setData(patch);
    this.applyClipState(read);
    this.attachVideoService(archive.archiveId);
  },

  /** 换归属或上下文失效时一起清掉的全部附加状态。 */
  emptyExtras() {
    return {
      savedVideo: null,
      indexError: '',
      hasPreview: false,
      preview: null,
      choosing: false,
      chooseError: '',
      notice: '',
      videoInstances: [],
      playerToken: '',
      playerSrc: '',
      playerKind: '',
      playerTitle: '',
      playerFileName: '',
      playerSizeText: '',
      playerDurationText: '',
      playerDimensionText: '',
      playerReady: false,
      playerStatus: '',
      playing: false,
      playbackError: '',
      markers: [],
      canAddMarker: false,
      markerHint: '',
      markerError: '',
      markerNotice: '',
      markerBusy: false,
      markerPendingRetry: false,
      playerDurationSeconds: null,
      playerTimeMs: null,
      playerTimeText: '',
      seekPending: false,
      seekRequestText: '',
      seekActualText: '',
      busy: false,
      opKind: '',
      opStatus: '',
      opError: '',
      confirmRemove: false
    };
  },

  /**
   * 按最新索引同步已保存片源与预览：
   * - 索引不可读时保留当前播放器，只提示关联暂时无法确认；
   * - 写入进行中不动播放器与预览，避免回执与刷新互相覆盖；
   * - 更换预览期间，若底下的已保存片段在本页之外变了，丢弃这条未采用的预览；
   * - 没有预览时，同一份片段不重开播放器（保持播放位置），换了片段才换节点。
   */
  applyClipState(read) {
    if (!read.ok) {
      this.setData({
        indexError:
          '本机视频索引暂时读不出来（' + (read.error || '未知原因') +
          '）；这一把的视频关联无法确认，页面上已有的片源仍可尝试播放。'
      });
      this.refreshMarkerReadiness();
      return;
    }
    // 写入进行中不动播放器、预览与时间点，避免回执与刷新互相覆盖。
    if (this.data.busy || this.data.markerBusy) return;

    const clip = read.state === 'saved' ? read.clip : null;
    this._savedClip = clip;
    this.setData({ indexError: '', savedVideo: clip ? this.savedViewOf(clip) : null });
    this.applyMarkerList(clip ? clip.markers : []);

    if (this._previewMode === 'replacement') {
      const base = this._previewBaseClip;
      if (!clip || !base || !playback.sameClipIdentity(base, clip)) {
        this.invalidatePreview();
        this.setData({
          hasPreview: false,
          preview: null,
          chooseError: '',
          notice: '已保存的视频在本页之外发生了变化，这条未采用的新片预览已经丢弃。'
        });
        this.ensureSavedPlayer(clip, { force: true });
      }
      return;
    }

    if (this._previewMode === 'initial') {
      if (clip) {
        // 这一把已经有本机副本（别处已提交），未采用的临时预览不再保留。
        this.invalidatePreview();
        this.setData({
          hasPreview: false,
          preview: null,
          notice: '这一把已经有本机副本，未采用的临时预览已经丢弃。'
        });
        this.ensureSavedPlayer(clip, { force: true });
      }
      return;
    }

    if (clip) {
      this.ensureSavedPlayer(clip);
    } else if (this.data.playerSrc) {
      this.clearPlayer();
    }
  },

  /**
   * 归属核对失败：清掉这一把的展示、播放器与预览，只留可见原因和返回出口。
   */
  applyContextFailure(context) {
    this.archive = context.archive || null;
    this._session = null;
    this._route = null;
    this._attempt = null;
    this._contextToken = '';
    this._savedClip = null;
    this._playerClip = null;
    this._removeTarget = null;
    this._videoContext = null;
    this._videoContextDomId = '';
    this._videoService = null;
    this._selectionSeq += 1;
    this.invalidatePreview();
    this._opSeq += 1;
    this._spaceSeq += 1;
    this._markerOpSeq += 1;
    this._pendingMarker = null;
    this._playerTimeSeconds = null;
    this.clearSeekWait();
    this._seek = null;
    this.setData(
      Object.assign(this.emptyExtras(), {
        ready: true,
        loadError: context.code === 'unreadable' ? context.error : '',
        contextError: context.code === 'unreadable' ? '' : context.error,
        archiveId: '',
        activeSession: null,
        selectedRoute: null,
        attempt: null,
        hasSavedVideo: false,
        videoStateText: '',
        spaceUsageText: '',
        spaceDetailText: '',
        spaceWarning: '',
        spaceError: '',
        canCleanupOrphans: false,
        cleanupBusy: false,
        cleanupNotice: ''
      })
    );
  },

  retryLoad() {
    this.loadPage();
  },

  // ------------------------------------------------------------------ *
  // 本机视频占用与无引用副本（T026）
  // ------------------------------------------------------------------ *

  /**
   * 绑定当前档案的持久层实例（同一档案共享），并刷新实际占用。
   * 打不开服务时只显示可见提示，已有视频仍按索引读取。
   */
  attachVideoService(archiveId) {
    const service = videoFiles.openAttemptVideoService(archiveId);
    this._videoService = service || null;
    if (!service) {
      this.setData({
        spaceUsageText: '',
        spaceDetailText: '',
        spaceWarning: '',
        spaceError: '当前本机档案拿不到视频保存服务，暂时无法统计本机视频占用。'
      });
      return;
    }
    this.refreshSpaceUsage();
  },

  /**
   * 读取本档案视频目录的实际字节：占用、提醒线与可用上限。
   * 只读；统计失败不阻塞播放与返回。
   */
  refreshSpaceUsage() {
    const service = this._videoService;
    if (!service || typeof service.getSpaceUsage !== 'function') return;
    const seq = this._spaceSeq + 1;
    this._spaceSeq = seq;
    Promise.resolve(service.getSpaceUsage()).then(
      result => {
        if (this._unloaded || seq !== this._spaceSeq) return;
        if (!result || !result.ok) {
          this.setData({
            spaceError:
              '暂时无法统计本机视频占用：' +
              ((result && result.error) || '未知原因') +
              '；已有视频仍可回看。'
          });
          return;
        }
        const policy = result.policy || {};
        const usableBytes =
          typeof result.usableBytes === 'number' ? result.usableBytes : policy.usableBytes;
        const over = result.overBudget === true;
        const warn = result.warn === true;
        let warning = '';
        if (over) {
          warning =
            '本机视频占用已超过可用预算（已为照片保留 ' +
            videoFiles.formatBytes(policy.photoReserveBytes) +
            '）；新的保存或更换会被阻止。可移除不用的本机视频，或清理无引用副本后重试。';
        } else if (warn) {
          warning =
            '本机视频占用接近提醒线 ' +
            videoFiles.formatBytes(policy.warnBytes) +
            '；请在需要时移除不用的本机视频或清理无引用副本。';
        }
        const detail = [];
        detail.push((result.clipCount || 0) + ' 段本机视频');
        detail.push('文件 ' + (result.fileCount || 0) + ' 个');
        // 视频预算在各档案之间共用：存在其他档案的副本时按实际字节一并说明。
        if (result.otherArchiveBytes > 0) {
          detail.push('含其他档案 ' + videoFiles.formatBytes(result.otherArchiveBytes));
        }
        if (result.orphanBytes > 0) {
          detail.push('无引用 ' + videoFiles.formatBytes(result.orphanBytes));
        }
        detail.push('已为照片保留 ' + videoFiles.formatBytes(policy.photoReserveBytes));
        this.setData({
          spaceUsageText:
            videoFiles.formatBytes(result.totalBytes) +
            ' / ' +
            videoFiles.formatBytes(usableBytes),
          spaceDetailText: detail.join(' · '),
          spaceWarning: warning,
          spaceError: '',
          canCleanupOrphans: (result.orphanBytes || 0) > 0
        });
      },
      error => {
        if (this._unloaded || seq !== this._spaceSeq) return;
        this.setData({
          spaceError:
            '暂时无法统计本机视频占用：' +
            playback.errorText(error) +
            '；已有视频仍可回看。'
        });
      }
    );
  },

  /**
   * 清理无引用副本：只删本功能创建、索引不再引用、也没有在途写入的文件。
   * 清理期间不受理其他清理；保存/更换/移除进行中时不做清理。
   */
  cleanupVideoOrphans() {
    if (this.data.cleanupBusy || this.data.busy) return;
    const service = this._videoService;
    if (!service || typeof service.cleanupOrphans !== 'function') {
      this.setData({ spaceError: '当前环境不支持清理无引用副本。' });
      return;
    }
    this.setData({ cleanupBusy: true, cleanupNotice: '', spaceError: '' });
    Promise.resolve(service.cleanupOrphans()).then(
      result => {
        if (this._unloaded) return;
        if (result && result.ok) {
          this.setData({
            cleanupBusy: false,
            cleanupNotice:
              result.deletedCount > 0
                ? '已清理 ' + result.deletedCount + ' 个无引用副本。'
                : '没有发现可清理的无引用副本。'
          });
          this.refreshSpaceUsage();
          return;
        }
        this.setData({
          cleanupBusy: false,
          spaceError:
            (result && result.error) || '无引用副本未完全清理，可以重试。'
        });
      },
      error => {
        if (this._unloaded) return;
        this.setData({
          cleanupBusy: false,
          spaceError: '清理无引用副本失败：' + playback.errorText(error)
        });
      }
    );
  },

  dismissCleanupNotice() {
    this.setData({ cleanupNotice: '' });
  },

  /** 作废当前预览：模式、基准片段、预览序号一起前进。 */
  invalidatePreview() {
    this._previewMode = '';
    this._previewBaseClip = null;
    this._previewToken = '';
    this._previewSeq += 1;
  },

  // ------------------------------------------------------------------ *
  // 选择与预览
  // ------------------------------------------------------------------ *

  /**
   * 从相册单选一段视频：没有已保存片源时是首次预览，有已保存片源时是更换预览。
   * - 连点与写入进行中都不再发第二个请求；
   * - 打开前按最新档案再核对一次归属，撤回/换档之后不再打开相册；
   * - 取消不写任何状态，失败给出可见提示，两种都能立刻再点。
   */
  choosePreview() {
    if (this.data.choosing || this.data.busy) return;

    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    // 展示也按最新档案与索引刷新：这一把若刚被撤回，会替换成只读原因。
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

    this.setData({ choosing: true, chooseError: '', notice: '', opError: '', confirmRemove: false });
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

    const resolved = playback.previewSourceFromPreview(outcome.preview);
    if (!resolved.ok) {
      this.setData({
        choosing: false,
        hasPreview: false,
        preview: null,
        chooseError: resolved.error
      });
      return;
    }

    // 已有已保存片段时，这次选择只进入「更换预览」，确认前不改动关联。
    const mode = this._savedClip ? 'replacement' : 'initial';
    this._previewMode = mode;
    this._previewBaseClip = mode === 'replacement' ? this._savedClip : null;
    this._previewToken = token;
    this._previewSeq += 1;
    const preview = Object.assign({}, outcome.preview, {
      mode,
      replacementOf: mode === 'replacement' ? this._savedClip.clipId || '' : ''
    });

    this.startSource(
      resolved.source,
      mode === 'replacement' ? '新片预览（临时文件，尚未替换）' : '待确认预览（临时文件）'
    );
    this.setData({
      choosing: false,
      chooseError: '',
      hasPreview: true,
      preview,
      notice: ''
    });
  },

  /**
   * 选择失败：取消不是错误（保留已有预览与播放器，可立刻再选）；其他失败给出可见原因。
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
   * 取消待确认预览（首次添加）：只丢掉临时路径，播放器一起收起，可立刻重选。
   */
  cancelPreview() {
    if (this.data.busy || !this.data.hasPreview) return;
    if (this._previewMode === 'replacement') {
      this.cancelReplace();
      return;
    }
    this.discardPreview('已取消预览，没有创建任何文件；可以重新选择。', false);
  },

  /**
   * 取消更换：回到同一段旧片，关联与旧副本都不动，也不创建任何文件。
   */
  cancelReplace() {
    if (this.data.busy || !this.data.hasPreview) return;
    if (this._previewMode !== 'replacement') {
      this.cancelPreview();
      return;
    }
    this.discardPreview('已取消更换，仍使用原来那段视频；没有创建或删除任何文件。', true);
  },

  discardPreview(noticeText, restoreSaved) {
    this.invalidatePreview();
    this._selectionSeq += 1;
    this.setData({
      hasPreview: false,
      preview: null,
      choosing: false,
      chooseError: '',
      notice: noticeText
    });
    if (restoreSaved) {
      this.ensureSavedPlayer(this._savedClip, { force: true });
    } else {
      this.clearPlayer();
    }
  },

  dismissChooseError() {
    this.setData({ chooseError: '' });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissOpError() {
    this.setData({ opError: '' });
  },

  // ------------------------------------------------------------------ *
  // 保存 / 更换 / 移除
  // ------------------------------------------------------------------ *

  /** 首次保存：把待确认预览提交为这一把的本机副本。 */
  commitPreview() {
    if (this.data.busy || !this.data.hasPreview) return;
    if (this._previewMode !== 'initial') return;
    this.startOperation(playback.METHOD_COMMIT, { preview: this.data.preview });
  },

  /** 确认更换：新的临时文件已预览过，这里才提交。 */
  confirmReplace() {
    if (this.data.busy || !this.data.hasPreview) return;
    if (this._previewMode !== 'replacement') return;
    this.startOperation(playback.METHOD_REPLACE, {
      preview: this.data.preview,
      beforeClip: this._previewBaseClip || this._savedClip
    });
  },

  /** 移除前先明确问一次，不直接删。 */
  askRemove() {
    if (this.data.busy) return;
    const clip = this._savedClip;
    if (!clip) {
      this.setData({ confirmRemove: false, opError: '当前没有已保存的本机副本可以移除。' });
      return;
    }
    // 固定发起时的原把与片段版本：期间另一页换了片、本页 onShow 刷新之后，
    // 这个确认框也不得改绑到新片。延迟确认继续用原片段 ID/版本，由服务拒绝过期操作。
    this._removeTarget = {
      clipId: clip.clipId || '',
      rev: clip.rev,
      fileId: clip.fileId || '',
      bytes: clip.bytes,
      archiveId: this.data.archiveId || '',
      attemptId: this.data.attempt ? this.data.attempt.id : ''
    };
    this.setData({ confirmRemove: true, opError: '', notice: '' });
  },

  cancelRemove() {
    if (this.data.busy) return;
    this._removeTarget = null;
    this.setData({ confirmRemove: false });
  },

  /** 确认移除：只回收发起确认时那一版小程序内的副本，原把次与相册原片保留。 */
  confirmRemove() {
    if (this.data.busy) return;
    const target = this._removeTarget;
    if (!target || !target.clipId) {
      this._removeTarget = null;
      this.setData({ confirmRemove: false, opError: '当前没有已保存的本机副本可以移除。' });
      return;
    }
    this.startOperation(playback.METHOD_REMOVE, { beforeClip: target });
  },

  /**
   * 发起一次写入：先把归属、序号与当前片段固定下来，再把请求交给持久层接口。
   * 写入期间页面进入忙碌态，选择、取消与其他写入都不受理。
   */
  startOperation(kind, input) {
    if (this.data.busy) return;
    if (!playback.videoStoreAvailable()) {
      this._removeTarget = null;
      this.setData({
        confirmRemove: false,
        opKind: '',
        opStatus: '',
        opError: playback.unavailableMessage()
      });
      return;
    }
    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }

    const opSeq = this._opSeq + 1;
    this._opSeq = opSeq;
    const op = {
      seq: opSeq,
      // 操作标识写进索引条目：读回时据此区分本次提交与他页刚更新的版本。
      opId: playback.makeOperationId(),
      kind,
      contextToken: this._contextToken,
      previewSeq: this._previewSeq,
      beforeClip: input.beforeClip || null,
      preview: input.preview || null
    };
    const request = playback.buildRequest(
      kind,
      {
        archiveId: context.archive.archiveId,
        sessionId: context.session.id,
        routeId: context.route.id,
        attemptId: context.attempt.id,
        attemptSeq: context.attempt.seq
      },
      op.beforeClip,
      op.preview,
      op.opId
    );

    this.setData({
      busy: true,
      opKind: kind,
      opStatus: playback.operationStatusText(kind),
      opError: '',
      notice: '',
      chooseError: '',
      confirmRemove: false
    });

    playback.callVideoStore(kind, request).then(
      receipt => this.finishOperation(op, receipt),
      error => this.finishOperation(op, { ok: false, error: playback.errorText(error) })
    );
  },

  /**
   * 写入回执到达：离页、换把、换档、预览被替换或已有更新的一次操作时一律丢弃；
   * 否则按**读回的本机索引**判定真实结果，不采信回执里的成功标记。
   */
  finishOperation(op, receipt) {
    if (this._unloaded) return;
    if (op.seq !== this._opSeq) return;
    if (this.data.opKind !== op.kind) return;
    if (this._contextToken !== op.contextToken) return;

    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    const token = attemptVideo.contextToken({
      archiveId: context.archive.archiveId,
      sessionId: context.session.id,
      routeId: context.route.id,
      attemptId: context.attempt.id
    });
    if (token !== op.contextToken) {
      this.loadPage();
      return;
    }
    // 这次写入针对的预览已被另一段片源替换：迟到回执不采用。
    if (op.kind !== playback.METHOD_REMOVE && this._previewSeq !== op.previewSeq) {
      this.setData({ busy: false, opKind: '', opStatus: '' });
      return;
    }

    const read = attemptVideo.videoClipView(context.archive.archiveId, context.attempt.id, context.attempt);
    const outcome = playback.evaluateOperation(op.kind, op.beforeClip, receipt, read, {
      opId: op.opId,
      // 实际字节以持久层写入后核对、并回执给本次 opId 的那一条为准；
      // 相册选择器给的 size 只是提示，不能当作「本次提交」的凭据。
      expectedBytes:
        op.kind === playback.METHOD_REMOVE
          ? null
          : playback.verifiedBytesOf(receipt, op.opId)
    });
    if (!outcome.ok) {
      this._removeTarget = null;
      this.setData({
        busy: false,
        opKind: '',
        opStatus: '',
        opError: outcome.error,
        confirmRemove: false
      });
      // 失败可能留下无引用副本（例如索引写失败后的清理也失败），按实际文件刷新占用；
      // 另一页已经换了片时，这里也按读回刷新展示，但不把对方的版本报成本次成功。
      this.applyClipState(read);
      this.refreshSpaceUsage();
      return;
    }
    this.applyCommittedOperation(op, outcome);
  },

  /** 读回确认成功后，按已提交的关联切换页面与播放器。 */
  applyCommittedOperation(op, outcome) {
    const clip = outcome.clip || null;
    this._removeTarget = null;
    this.invalidatePreview();
    this._selectionSeq += 1;
    const patch = {
      busy: false,
      opKind: '',
      opStatus: '',
      opError: '',
      confirmRemove: false,
      choosing: false,
      chooseError: '',
      hasPreview: false,
      preview: null,
      notice: playback.operationSuccessText(op.kind, outcome)
    };

    if (op.kind === playback.METHOD_REMOVE) {
      this._savedClip = null;
      this._playerClip = null;
      this._videoContext = null;
      this._videoContextDomId = '';
      const extras = this.emptyExtras();
      extras.notice = patch.notice;
      extras.hasSavedVideo = false;
      extras.videoStateText = '未添加视频';
      this.setData(extras);
      this.refreshSpaceUsage();
      return;
    }

    this._savedClip = clip;
    patch.hasSavedVideo = true;
    patch.videoStateText = '已添加视频';
    patch.savedVideo = this.savedViewOf(clip);
    this.setData(patch);
    this.ensureSavedPlayer(clip, { force: true });
    this.refreshSpaceUsage();
  },

  // ------------------------------------------------------------------ *
  // 播放器
  // ------------------------------------------------------------------ *

  /** 建立/切换播放器片源：新 token 与新 domId，旧节点的事件从此全部失效。 */
  startSource(source, title) {
    const seq = this._sourceSeq + 1;
    this._sourceSeq = seq;
    const token = playback.sourceToken(this._contextToken, seq);
    this._videoContext = null;
    this._videoContextDomId = '';
    this._playerClip = source.kind === playback.KIND_SAVED
      ? { clipId: source.clipId || '', rev: source.rev, fileId: source.fileId || '' }
      : null;
    // 换片/换预览：旧的播放器读数、跳转等待与失败重试身份全部作废。
    this._playerTimeSeconds = null;
    this.clearSeekWait();
    this._seek = null;
    this._pendingMarker = null;
    this._markerOpSeq += 1;
    this.setData({
      videoInstances: [{ token, domId: playback.videoDomId(seq) }],
      playerToken: token,
      playerSrc: source.src,
      playerKind: source.kind,
      playerTitle: title || playback.sourceLabel(source.kind),
      playerFileName: source.fileName || '',
      playerSizeText: source.sizeText || '',
      playerDurationText: source.durationText || '',
      playerDimensionText: source.dimensionText || '',
      playerReady: false,
      playerStatus: '点击视频或下方按钮播放',
      playing: false,
      playbackError: '',
      playerDurationSeconds: null,
      playerTimeMs: null,
      playerTimeText: '',
      seekPending: false,
      seekRequestText: '',
      seekActualText: '',
      markerBusy: false,
      markerPendingRetry: false,
      markerError: ''
    });
    this.refreshMarkerReadiness();
  },

  /** 让播放器显示这一把已保存的片段；同一份片段不重开，保持播放位置。 */
  ensureSavedPlayer(clip, options) {
    if (!clip) {
      this.clearPlayer();
      return;
    }
    const force = Boolean(options && options.force);
    const same = this._playerClip && playback.sameClipIdentity(this._playerClip, clip);
    if (!force && same && this.data.playerKind === playback.KIND_SAVED) return;

    const resolved = playback.savedSourceFromClip(clip, {});
    if (!resolved.ok) {
      // 文件位置无法定位：收起播放器，由已保存卡片上的可见原因提供重选出口。
      this.clearPlayer();
      return;
    }
    this.startSource(resolved.source, '已保存视频（本机副本）');
  },

  clearPlayer() {
    this._playerClip = null;
    this._videoContext = null;
    this._videoContextDomId = '';
    this._playerTimeSeconds = null;
    this.clearSeekWait();
    this._seek = null;
    this._pendingMarker = null;
    this._markerOpSeq += 1;
    this.setData({
      videoInstances: [],
      playerToken: '',
      playerSrc: '',
      playerKind: '',
      playerTitle: '',
      playerFileName: '',
      playerSizeText: '',
      playerDurationText: '',
      playerDimensionText: '',
      playerReady: false,
      playerStatus: '',
      playing: false,
      playbackError: '',
      playerDurationSeconds: null,
      playerTimeMs: null,
      playerTimeText: '',
      seekPending: false,
      seekRequestText: '',
      seekActualText: '',
      markerBusy: false,
      markerPendingRetry: false,
      markerError: ''
    });
    this.refreshMarkerReadiness();
  },

  savedViewOf(clip) {
    if (!clip) return null;
    const resolved = playback.savedSourceFromClip(clip, {});
    const rev = Number(clip.rev);
    return {
      clipId: clip.clipId || '',
      fileId: clip.fileId || '',
      revText: Number.isFinite(rev) ? String(rev) : '',
      sizeText: attemptVideo.formatBytes(clip.bytes),
      locatable: resolved.ok,
      unresolvedText: resolved.ok ? '' : resolved.error,
      src: resolved.ok ? resolved.source.src : ''
    };
  },

  /** videoContext 跟随当前节点：换片后为新 domId 重新创建。 */
  getVideoContext() {
    const instance = (this.data.videoInstances || [])[0];
    if (!instance) return null;
    if (typeof wx === 'undefined' || typeof wx.createVideoContext !== 'function') return null;
    if (!this._videoContext || this._videoContextDomId !== instance.domId) {
      try {
        this._videoContext = wx.createVideoContext(instance.domId, this);
        this._videoContextDomId = instance.domId;
      } catch (error) {
        this._videoContext = null;
        this._videoContextDomId = '';
      }
    }
    return this._videoContext;
  },

  /** 视频事件只接受当前节点：事件自带的 token 与当前片源一致才处理。 */
  videoEventAccepted(event) {
    if (this._unloaded) return false;
    return playback.isCurrentVideoEvent(event, this.data.playerToken);
  },

  onVideoLoadedMetadata(event) {
    if (!this.videoEventAccepted(event)) return;
    const patch = playback.metadataPatch(event && event.detail);
    patch.playbackError = '';
    this.setData(patch);
    this.refreshMarkerReadiness();
  },

  onVideoPlay(event) {
    if (!this.videoEventAccepted(event)) return;
    this.setData({ playing: true, playerStatus: '正在播放', playbackError: '' });
  },

  onVideoPause(event) {
    if (!this.videoEventAccepted(event)) return;
    this.setData({ playing: false, playerStatus: '已暂停' });
  },

  /**
   * 播放器报错：已保存副本按「可能被清理或损坏」给出重选提示，
   * 临时预览按「重新选择」处理；两种都不改动原把次与已有视频。
   */
  onVideoError(event) {
    if (!this.videoEventAccepted(event)) return;
    const errMsg = (event && event.detail && event.detail.errMsg) || '';
    this._playerTimeSeconds = null;
    this.clearSeekWait();
    this._seek = null;
    this.setData({
      playerReady: false,
      playing: false,
      playerStatus: '',
      playbackError: playback.playbackErrorMessage(errMsg, this.data.playerKind),
      playerDurationSeconds: null,
      playerTimeMs: null,
      playerTimeText: '',
      seekPending: false,
      seekRequestText: '',
      seekActualText: ''
    });
    this.refreshMarkerReadiness();
  },

  /**
   * 原生播放位置回报：这是「实际落点」的唯一来源。
   * 跳转请求本身不回填当前位置；只有回报落到目标 ±0.5 秒内，才结束等待并允许
   * 再次记点，避免把跳转前的旧画面当成跳转后的位置写进时间点。
   */
  onVideoTimeUpdate(event) {
    if (!this.videoEventAccepted(event)) return;
    const detail = (event && event.detail) || {};
    // 只接受原生回调真正给出的有限 number：null/false/''/空白/数组都不能变成 0 秒。
    // 非法读数既不改上一有效位置，也不结束跳转等待，更不允许记点。
    const current = attemptVideoMarkers.safeNativeNumber(detail.currentTime);
    const duration = attemptVideoMarkers.safeNativeNumber(detail.duration);
    const patch = {};
    if (duration !== null && duration > 0) {
      patch.playerDurationSeconds = duration;
      patch.playerDurationText = duration.toFixed(2);
      patch.playerReady = true;
    }
    if (current !== null && current >= 0) {
      this._playerTimeSeconds = current;
      patch.playerTimeMs = Math.round(current * 1000);
      patch.playerTimeText = attemptVideoMarkers.formatSecondsText(patch.playerTimeMs);
      Object.assign(patch, this.seekReportPatch(current));
    }
    if (Object.keys(patch).length) this.setData(patch);
    this.refreshMarkerReadiness();
  },

  /** 跳转等待中的位置回报：只认落在目标附近的回报为「实际落点」。 */
  seekReportPatch(currentTimeSeconds) {
    const seek = this._seek;
    if (!seek || seek.token !== this.data.playerToken) return {};
    const reported = attemptVideoMarkers.safeNativeNumber(currentTimeSeconds);
    if (reported === null || reported < 0) return {};
    const reportedText = attemptVideoMarkers.formatSecondsText(Math.round(reported * 1000));
    if (attemptVideoMarkers.isSeekConfirmed(seek.targetMs, reported)) {
      this.clearSeekWait();
      this._seek = null;
      return {
        seekPending: false,
        seekActualText: '播放器实际位置 ' + reportedText + ' 秒。',
        markerNotice:
          '已跳到 ' + reportedText + ' 秒（请求 ' +
          attemptVideoMarkers.formatSecondsText(seek.targetMs) + ' 秒）。'
      };
    }
    // 超时解除等待后，迟到的非目标回报不再把页面锁回「等待确认」；
    // 真正落到目标的回报仍会在上面确认。
    if (seek.expired) {
      return {
        seekPending: false,
        seekActualText:
          '播放器回报 ' + reportedText + ' 秒，与请求的 ' +
          attemptVideoMarkers.formatSecondsText(seek.targetMs) +
          ' 秒不一致；跳转落点仍未确认。'
      };
    }
    return {
      seekPending: true,
      seekActualText:
        '播放器回报 ' + reportedText + ' 秒，与请求的 ' +
        attemptVideoMarkers.formatSecondsText(seek.targetMs) +
        ' 秒不一致，仍在等待画面确认。'
    };
  },

  // ------------------------------------------------------------------ *
  // 手工时间点（T025）
  // ------------------------------------------------------------------ *

  expectedPlayerToken() {
    if (!this._contextToken) return '';
    return playback.sourceToken(this._contextToken, this._sourceSeq);
  },

  sameClipFileIdentity(left, right) {
    if (!left || !right) return false;
    if ((left.clipId || '') !== (right.clipId || '')) return false;
    if (Number(left.rev) !== Number(right.rev)) return false;
    return (left.fileId || '') === (right.fileId || '');
  },

  /** 当前页面是否满足「给已保存片源记点」的全部前提。 */
  markerReadiness() {
    const token = this.expectedPlayerToken();
    return attemptVideoMarkers.markReadiness({
      busy: this.data.busy,
      markerBusy: this.data.markerBusy,
      choosing: this.data.choosing,
      indexError: this.data.indexError,
      hasSavedVideo: this.data.hasSavedVideo,
      savedClip: this._savedClip,
      playerKind: this.data.playerKind,
      playerToken: this.data.playerToken,
      expectedToken: token,
      sourceCurrent: Boolean(this.data.playerToken) && this.data.playerToken === token,
      clipMatchesPlayer: this.sameClipFileIdentity(this._savedClip, this._playerClip),
      durationSeconds: this.data.playerDurationSeconds,
      currentTimeSeconds: this._playerTimeSeconds,
      seekPending: this.data.seekPending
    });
  },

  /**
   * 刷新「能否记点」与提示。存在未确认的失败记点时只保留重试，不另开新点，
   * 保证同一次动作最多新增一个时间点。
   */
  refreshMarkerReadiness() {
    if (this._unloaded) return;
    let pending = this._pendingMarker;
    if (pending) {
      const identity = {
        clipId: pending.clipId,
        rev: pending.rev,
        fileId: pending.fileId
      };
      const sourceChanged =
        Boolean(this.data.playerToken) && this.data.playerToken !== pending.token;
      if (
        this._contextToken !== pending.contextToken ||
        sourceChanged ||
        !this.sameClipFileIdentity(this._savedClip, identity)
      ) {
        this._pendingMarker = null;
        pending = null;
      }
    }
    const ready = this.markerReadiness();
    this.setData({
      canAddMarker: ready.ok && !pending,
      markerHint: ready.hint || '',
      markerPendingRetry: Boolean(pending)
    });
  },

  applyMarkerList(list) {
    this.setData({ markers: attemptVideoMarkers.markerViews(list) });
    this.refreshMarkerReadiness();
  },

  /** 严格读取当前原生读数并算出待写入的整数毫秒。 */
  markerCaptureState() {
    const ready = this.markerReadiness();
    if (!ready.ok) return ready;
    return {
      ok: true,
      code: 'ready',
      error: '',
      hint: '',
      atMs: ready.atMs,
      clip: this._savedClip,
      durationSeconds: Number(this.data.playerDurationSeconds),
      token: this.data.playerToken
    };
  },

  /**
   * 记下当前时间。操作身份在这里生成一次；失败后「重试」沿用同一个 markerId。
   */
  addMarkerAtCurrentTime() {
    if (this.data.busy || this.data.markerBusy || this.data.choosing) return;
    if (this._pendingMarker) {
      this.retryMarker();
      return;
    }
    const capture = this.markerCaptureState();
    if (!capture.ok) {
      this.setData({
        markerError: capture.hint || capture.error || '现在还不能记时间点。',
        markerNotice: ''
      });
      this.refreshMarkerReadiness();
      return;
    }
    this._pendingMarker = {
      markerId: attemptVideoMarkers.makeMarkerId(),
      atMs: capture.atMs,
      clipId: capture.clip.clipId,
      rev: Number(capture.clip.rev),
      fileId: capture.clip.fileId,
      token: capture.token,
      contextToken: this._contextToken,
      durationSeconds: capture.durationSeconds
    };
    this.runMarkerAdd(this._pendingMarker);
  },

  /** 失败重试：片段、片源与操作身份都不变，只再提交一次同一个 markerId。 */
  retryMarker() {
    const pending = this._pendingMarker;
    if (!pending || this.data.markerBusy || this.data.busy) return;
    if (this._contextToken !== pending.contextToken || this.data.playerToken !== pending.token) {
      this._pendingMarker = null;
      this.setData({
        markerError: '播放器片源已经变化，这次未确认的记点已作废；请在新画面上重新记。',
        markerPendingRetry: false
      });
      this.refreshMarkerReadiness();
      return;
    }
    if (
      !this.sameClipFileIdentity(this._savedClip, {
        clipId: pending.clipId,
        rev: pending.rev,
        fileId: pending.fileId
      })
    ) {
      this._pendingMarker = null;
      this.setData({
        markerError: '这一把的视频片段已经变化，这次未确认的记点已作废；请重新记。',
        markerPendingRetry: false
      });
      this.refreshMarkerReadiness();
      return;
    }
    this.runMarkerAdd(pending);
  },

  markerContextOf() {
    return {
      archiveId: this.archive ? this.archive.archiveId : '',
      sessionId: this._session ? this._session.id : '',
      routeId: this._route ? this._route.id : '',
      attemptId: this._attempt ? this._attempt.id : '',
      attemptSeq: this._attempt ? this._attempt.seq : null
    };
  },

  runMarkerAdd(pending) {
    if (this._unloaded) return;
    const context = this.markerContextOf();
    if (
      !context.archiveId ||
      !context.sessionId ||
      !context.routeId ||
      !context.attemptId ||
      !this._contextToken
    ) {
      this.setData({ markerError: '这一把的归属已经不可确认，没有写入时间点。' });
      return;
    }
    this._markerOpSeq += 1;
    const seq = this._markerOpSeq;
    this.setData({
      markerBusy: true,
      canAddMarker: false,
      markerError: '',
      markerNotice: '',
      markerPendingRetry: false
    });
    const request = playback.buildMarkerRequest(
      playback.METHOD_ADD_MARKER,
      context,
      { clipId: pending.clipId, rev: pending.rev, fileId: pending.fileId },
      { markerId: pending.markerId, atMs: pending.atMs },
      pending.durationSeconds
    );
    const result = playback.callMarkerStore(playback.METHOD_ADD_MARKER, request);
    Promise.resolve(result).then(
      receipt => this.finishMarkerAdd(seq, pending, receipt),
      error => this.finishMarkerAdd(seq, pending, { ok: false, error: playback.errorText(error) })
    );
  },

  finishMarkerAdd(seq, pending, receipt) {
    if (this._unloaded || seq !== this._markerOpSeq) return;
    if (this._contextToken !== pending.contextToken) {
      this._pendingMarker = null;
      this.setData({ markerBusy: false, markerPendingRetry: false });
      this.refreshMarkerReadiness();
      return;
    }
    if (this.data.playerToken !== pending.token) {
      this._pendingMarker = null;
      this.setData({
        markerBusy: false,
        markerPendingRetry: false,
        markerError: '播放器片源已经变化，这次记点回执没有采用。'
      });
      this.refreshMarkerReadiness();
      return;
    }

    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    const read = attemptVideo.videoClipView(
      context.archive.archiveId,
      context.attempt.id,
      context.attempt
    );
    if (!read.ok) {
      this._pendingMarker = pending;
      this.setData({
        markerBusy: false,
        markerPendingRetry: true,
        markerError:
          '时间点写入后读不回本机视频索引（' +
          (read.error || '未知原因') +
          '），请用同一次动作重试；已有时间点保持原样。'
      });
      this.refreshMarkerReadiness();
      return;
    }

    this._savedClip = read.clip;
    this.setData({
      indexError: '',
      savedVideo: read.clip ? this.savedViewOf(read.clip) : null
    });
    this.applyMarkerList(read.clip ? read.clip.markers : []);

    const identity = { clipId: pending.clipId, rev: pending.rev, fileId: pending.fileId };
    const same = this.sameClipFileIdentity(read.clip, identity);
    const landed =
      same && (read.clip.markers || []).some(marker => marker.id === pending.markerId);
    if (landed) {
      const marker = read.clip.markers.find(item => item.id === pending.markerId);
      this._pendingMarker = null;
      this.setData({
        markerBusy: false,
        markerPendingRetry: false,
        markerError: '',
        markerNotice:
          '已记下 ' +
          attemptVideoMarkers.formatSecondsText(marker.atMs) +
          ' 秒。' +
          (receipt && receipt.receiptLost
            ? '（写入回执不明确，已按本机索引读回确认）'
            : '')
      });
      this.refreshMarkerReadiness();
      return;
    }

    // 索引可读但没有本次标记：只有片段仍是同一个才保留同身份重试。
    this._pendingMarker = same ? pending : null;
    this.setData({
      markerBusy: false,
      markerPendingRetry: same,
      markerError: same
        ? ((receipt && receipt.error) ||
            '时间点没有写入本机索引；已有时间点保持原样。') + ' 可以用同一次动作重试。'
        : '这一把的视频关联已经变化，这次时间点没有写入；页面已按读回显示最新片段。'
    });
    this.refreshMarkerReadiness();
  },

  /** 移除单点：只按 markerId 删除当前片段里的这一条。 */
  removeMarker(event) {
    if (this.data.busy || this.data.markerBusy || this.data.choosing) return;
    if (this.data.hasPreview) {
      this.setData({ markerError: '新片还在待确认，先取消更换或确认更换后再移除原片时间点。' });
      return;
    }
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const markerId = dataset.markerId || '';
    const marker = (this.data.markers || []).find(item => item.id === markerId) || null;
    const clip = this._savedClip;
    if (!marker || !clip || !attemptVideoMarkers.isMarkerId(markerId)) {
      this.setData({ markerError: '这个时间点已经不在列表里，未改动任何数据。' });
      return;
    }
    const pending = {
      markerId,
      clipId: clip.clipId,
      rev: Number(clip.rev),
      fileId: clip.fileId,
      contextToken: this._contextToken
    };
    this._markerOpSeq += 1;
    const seq = this._markerOpSeq;
    this.setData({
      markerBusy: true,
      canAddMarker: false,
      markerError: '',
      markerNotice: ''
    });
    const request = playback.buildMarkerRequest(
      playback.METHOD_REMOVE_MARKER,
      this.markerContextOf(),
      { clipId: pending.clipId, rev: pending.rev, fileId: pending.fileId },
      { markerId, atMs: marker.atMs },
      this.data.playerDurationSeconds
    );
    const result = playback.callMarkerStore(playback.METHOD_REMOVE_MARKER, request);
    Promise.resolve(result).then(
      receipt => this.finishMarkerRemove(seq, pending, receipt),
      error =>
        this.finishMarkerRemove(seq, pending, {
          ok: false,
          error: playback.errorText(error)
        })
    );
  },

  finishMarkerRemove(seq, pending, receipt) {
    if (this._unloaded || seq !== this._markerOpSeq) return;
    if (this._contextToken !== pending.contextToken) {
      this.setData({ markerBusy: false });
      this.refreshMarkerReadiness();
      return;
    }
    const context = attemptVideo.loadVideoContext(this._context);
    if (!context.ok) {
      this.applyContextFailure(context);
      return;
    }
    const read = attemptVideo.videoClipView(
      context.archive.archiveId,
      context.attempt.id,
      context.attempt
    );
    if (!read.ok) {
      this.setData({
        markerBusy: false,
        markerError:
          '移除后读不回本机视频索引（' +
          (read.error || '未知原因') +
          '），结果未确认；请稍后重新进入本页核对。'
      });
      this.refreshMarkerReadiness();
      return;
    }
    this._savedClip = read.clip;
    this.setData({
      indexError: '',
      savedVideo: read.clip ? this.savedViewOf(read.clip) : null
    });
    this.applyMarkerList(read.clip ? read.clip.markers : []);

    const identity = { clipId: pending.clipId, rev: pending.rev, fileId: pending.fileId };
    const same = this.sameClipFileIdentity(read.clip, identity);
    const gone =
      same && (read.clip.markers || []).every(marker => marker.id !== pending.markerId);
    if (gone) {
      this.setData({
        markerBusy: false,
        markerError: '',
        markerNotice:
          '已移除这个时间点。' +
          (receipt && receipt.receiptLost
            ? '（写入回执不明确，已按本机索引读回确认）'
            : '')
      });
      this.refreshMarkerReadiness();
      return;
    }
    this.setData({
      markerBusy: false,
      markerError: same
        ? (receipt && receipt.error) || '这个时间点还没有从本机索引移除，可以重试。'
        : '这一把的视频关联已经变化，本次移除没有采用；页面已按读回显示最新片段。'
    });
    this.refreshMarkerReadiness();
  },

  /**
   * 跳到时间点：只下发秒数请求，不把请求值当成实际落点。
   * 在播放器回报落在目标 ±0.5 秒内之前，页面保持「跳转尚未确认」并暂停记点。
   */
  seekToMarker(event) {
    if (this.data.busy || this.data.markerBusy || this.data.choosing) return;
    if (this.data.hasPreview) {
      this.setData({ markerError: '新片还在待确认，先取消更换或确认更换后再跳转。' });
      return;
    }
    if (this.data.playerKind !== playback.KIND_SAVED || !this.data.playerSrc) {
      this.setData({ markerError: '当前没有可跳转的已保存视频。' });
      return;
    }
    if (!this.sameClipFileIdentity(this._savedClip, this._playerClip)) {
      this.setData({ markerError: '播放器显示的片段与时间点所属片段不一致，暂不能跳转。' });
      return;
    }
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const markerId = dataset.markerId || '';
    const marker = (this.data.markers || []).find(item => item.id === markerId) || null;
    if (!marker) {
      this.setData({ markerError: '这个时间点已经不在列表里。' });
      return;
    }
    const target = attemptVideoMarkers.seekSecondsOf(
      marker.atMs,
      this.data.playerDurationSeconds
    );
    if (!target.ok) {
      this.setData({ markerError: target.error });
      return;
    }
    const context = this.getVideoContext();
    if (!context || typeof context.seek !== 'function') {
      this.setData({ markerError: '当前环境无法控制播放器跳转，请使用视频画面自带的进度条。' });
      return;
    }
    try {
      context.seek(target.seconds);
    } catch (error) {
      this.setData({
        markerError: '跳转请求失败：' + playback.errorText(error) + '，可以重试。'
      });
      return;
    }
    this.clearSeekWait();
    this._seek = {
      token: this.data.playerToken,
      targetMs: marker.atMs,
      seconds: target.seconds,
      clipId: this._playerClip.clipId,
      rev: Number(this._playerClip.rev),
      fileId: this._playerClip.fileId,
      retried: false,
      expired: false
    };
    this.setData({
      seekPending: true,
      seekRequestText:
        '跳转请求 ' +
        attemptVideoMarkers.formatSecondsText(marker.atMs) +
        ' 秒（按秒下发，实际落点以播放器回报为准）。',
      seekActualText: '等待播放器回报实际位置…',
      markerError: '',
      markerNotice: ''
    });
    this.scheduleSeekWait(this._seek);
    this.refreshMarkerReadiness();
  },

  seekWaitMs() {
    const custom = Number(this._seekWaitMs);
    return Number.isFinite(custom) && custom > 0
      ? custom
      : attemptVideoMarkers.SEEK_REPORT_WAIT_MS;
  },

  clearSeekWait() {
    if (this._seekTimer !== null && this._seekTimer !== undefined) {
      clearTimeout(this._seekTimer);
      this._seekTimer = null;
    }
  },

  /** 跳转后等待原生 location 回报；暂停态下原生可能不发 timeupdate，不能永久锁住。 */
  scheduleSeekWait(seek) {
    this.clearSeekWait();
    const timer = setTimeout(() => {
      this._seekTimer = null;
      this.onSeekWaitElapsed(seek);
    }, this.seekWaitMs());
    // Node 测试环境会返回 Timeout 对象；小程序环境返回数字，都能被 clearTimeout 接受。
    this._seekTimer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  },

  /**
   * 短等待仍无实际位置回报：
   * 1) 先重发一次同一秒数请求，给暂停态播放器一个重新回报的机会；
   * 2) 仍无回报则解除「等待确认」，只显示未确认，绝不把请求值回填为实际落点。
   * 解除后若真实 token 的回报落到目标，仍会在 seekReportPatch 中确认。
   */
  onSeekWaitElapsed(seek) {
    if (this._unloaded || this._seek !== seek) return;
    if (this.data.playerToken !== seek.token) {
      this._seek = null;
      this.setData({ seekPending: false });
      this.refreshMarkerReadiness();
      return;
    }
    if (!seek.retried) {
      seek.retried = true;
      const context = this.getVideoContext();
      if (context && typeof context.seek === 'function') {
        try {
          context.seek(seek.seconds);
        } catch (error) {
          // 重试失败不再抛出：仍按「未确认」收敛，页面保持可操作。
        }
      }
      this.setData({
        seekActualText:
          '播放器还没有回报实际位置，正在重试跳转（请求 ' +
          attemptVideoMarkers.formatSecondsText(seek.targetMs) +
          ' 秒）…'
      });
      this.scheduleSeekWait(seek);
      return;
    }
    seek.expired = true;
    this.setData({
      seekPending: false,
      seekActualText:
        '播放器没有回报跳转后的实际位置（请求 ' +
        attemptVideoMarkers.formatSecondsText(seek.targetMs) +
        ' 秒）；落点未确认，可再次点时间点重试，或播放后再核对。',
      markerNotice: '跳转请求已下发，但没有收到原生实际位置；请求值没有当作实际落点。'
    });
    this.refreshMarkerReadiness();
  },

  dismissMarkerError() {
    this.setData({ markerError: '' });
    this.refreshMarkerReadiness();
  },

  dismissMarkerNotice() {
    this.setData({ markerNotice: '' });
  },

  /**
   * 播放/暂停只向播放器发请求；playing 仍以 bindplay / bindpause 回报为准。
   */
  togglePlay() {
    if (this._unloaded) return;
    if (!this.data.playerSrc) {
      this.setData({ playbackError: '还没有可播放的视频，请先选择原片。' });
      return;
    }
    const command = playback.toggleCommand(this.data.playing);
    const context = this.getVideoContext();
    if (!context || typeof context[command] !== 'function') {
      this.setData({ playbackError: '当前环境无法控制播放，请使用视频画面自带的播放按钮。' });
      return;
    }
    context[command]();
    this.setData({
      playerStatus: command === 'play' ? '正在请求播放…' : '正在请求暂停…'
    });
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
