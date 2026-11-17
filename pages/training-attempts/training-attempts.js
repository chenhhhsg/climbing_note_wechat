/**
 * 本场逐把页（T036 / T042）
 *
 * 从单线记录页进入，只列**所选场次 + 所选长期线路**的已提交把次：按原序号、结果、
 * 备注对齐，并可给指定把次补/改备注。照片、卡点、跨天历史不在这里（线路资料页），
 * 撤回与恢复也不在这里（单线记录页的「最近一把」）。
 *
 * T042：较早的合资格完攀在**自己那一行**给「更正结果」：确认弹窗写明原把次的序号、
 * 日期/场次/岩馆与原结果，确认后仍走共用 correctSend，只翻这一把的结果。本页只列原场
 * 原线的把次，跨场次候选仍在线路历史的原把次处理，不会被拿到这里。
 *
 * 归属核对：archiveId + sessionId + routeId 与单线页同一份校验（training-record-actions
 * 的 loadRecordContext）。缺参、串档、场次/线路不存在或线路不属于这一场时只显示原因，
 * 不列别场别线的把次，也不接受写入。
 *
 * 备注写入口只认原 attemptId 与归属：保存、取消、失败重试都只影响这一把；保存前
 * 先核对档案没换，换档后的迟到保存不写进新档案。
 *
 * T023 在每一行加视频关联状态与文字入口：点的是哪一行，就只带那一把的原 attemptId
 * 与档案、场次、线路进入视频页；视频入口独立于整行补备注（catchtap），选片与预览
 * 都在视频页，本页不读写任何视频文件或索引。
 *
 * T046 从原场小结进入：小结里的线路带 archiveId + sessionId + routeId + from=summary
 * 打开本页，先看这一场这一条线的原把次。本页的返回文案按入口写成「返回原场小结」，
 * 且真的回到原场小结（正常路径是系统返回；没有可返回的页面时按原档案与原场次重建
 * 小结页连接）。跨场历史改由本页主动点「线路历史」进入，带同一个原档案 ID 与长期
 * 线路 ID，照片、卡点与跨场记录都在那一页。打开本页与点「线路历史」都不写任何数据。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const attemptVideo = require('../../utils/attempt-video.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';
const ATTEMPT_VIDEO_URL = '/pages/attempt-video/attempt-video';
const ROUTE_URL = '/pages/training-route/training-route';
const SUMMARY_URL = '/pages/training-summary/training-summary';

Page({
  data: {
    ready: false,
    loadError: '',
    contextError: '',
    storageError: '',
    notice: '',

    archiveId: '',
    activeSession: null,
    selectedRoute: null,

    // T046：按入口写返回文案——从原场小结进来就写「返回原场小结」，真的回到那一页；
    // 其它来源（旧链接/单线记录）保持原来的返回本场文案。
    fromSummary: false,
    backLabel: '返回单线记录',
    contextErrorHint: '没有改动任何数据；请从单线记录页重新进入。',
    emptyStateText: '这一场这一条线还没有已提交把次。回到单线记录页记第一把。',

    attempts: [],
    hasAttempts: false,
    noteEditor: null
  },

  onLoad(query) {
    // 本实例的临时状态（与单线记录页同名，便于沿用共用事件处理）：
    // _correctedRows / _correctionFailures 是按把更正的只读回读与失败重试标记，
    // _correctionPrompt 是已打开、还没回应的更正确认，_unloaded 拦迟到的确认回调。
    this._correctedRows = {};
    this._correctionFailures = {};
    this._correctionPrompt = null;
    this._unloaded = false;
    this._context = actions.parseRecordQuery(query);
    // T046 入口来源：只影响本页的返回文案与回退落点，不参与把次归属。
    this._fromSummary = Boolean(query && (query.from === 'summary' || query.source === 'summary'));
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从资料页返回或重新显示：按最新档案重算这一场这一条线的逐把。
    this.loadPage();
  },

  onUnload() {
    this._unloaded = true;
    this._correctionPrompt = null;
  },

  /**
   * 入口相关的展示文案（T046）：返回标签、错误提示与空态只按入口决定，并且与实际
   * 返回的落点一一对应——从原场小结进来就写「返回原场小结」，别处进来仍写单线记录。
   */
  entryCopy() {
    if (!this._fromSummary) {
      return {
        fromSummary: false,
        backLabel: '返回单线记录',
        contextErrorHint: '没有改动任何数据；请从单线记录页重新进入。',
        emptyStateText: '这一场这一条线还没有已提交把次。回到单线记录页记第一把。'
      };
    }
    return {
      fromSummary: true,
      backLabel: '返回原场小结',
      contextErrorHint: '没有改动任何数据；请从原场小结重新进入。',
      emptyStateText: '这一场这一条线还没有已提交把次；回原场小结看这一场的其它线路。'
    };
  },

  loadPage() {
    // 返回文案先按入口定下来：下面各个分支只改内容，不改「返回哪里」。
    this.setData(this.entryCopy());
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
        attempts: [],
        hasAttempts: false,
        noteEditor: null
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
    const selectedRoute = {
      id: route.id,
      name: route.name,
      climbType: climbTypeOf(route),
      grade: route.grade,
      colorName: route.colorName || '',
      colorHex: route.colorHex || '#dee2e6'
    };

    const labels = actions.attemptLabelMap(archive, session.id, route.id);
    const rows = store.attemptsFor(archive, { sessionId: session.id, routeId: route.id });
    // 关联状态只读视频索引（T023 只显示状态与文字入口，选片在视频页）。
    const links = attemptVideo.videoLinkMap(archive.archiveId, rows);
    // 本场仍可更正的完攀（T042）：与线路历史同一份资格边界，只留本场次。
    const correctionTargets = actions.correctionTargetsForSession(
      archive,
      session.id,
      route.id
    );
    const attempts = rows.map(attempt => {
      const link = links.get(attempt.id) || {
        hasVideo: false,
        stateText: '未添加视频',
        entryText: '添加视频 ›'
      };
      const correctionTarget = correctionTargets.get(attempt.id) || null;
      const correctionState = actions.correctionStateOf(archive, this, attempt.id);
      const correctable = Boolean(correctionTarget);
      return {
        id: attempt.id,
        label: labels.get(attempt.id) || '',
        resultText: actions.attemptResultText(attempt.result),
        isSend: attempt.result === 'send',
        timeText: actions.timeText(attempt.createdAt),
        note: attempt.note || '',
        hasNote: Boolean(attempt.note),
        hasVideo: link.hasVideo,
        videoStateText: link.stateText,
        videoEntryText: link.entryText,
        // 这一行自己那一把的更正入口；刚改好或不可改时只留只读文字。
        correctable,
        correctText: correctionState.state === 'retry' ? '重试更正结果' : '更正结果',
        correctStatusText: correctable ? '' : correctionState.statusText
      };
    });

    // 编辑中的这一把若已不在有效列表里（被撤回或换档），收起编辑器而不是把输入写到别处。
    let noteEditor = this.data.noteEditor;
    if (noteEditor && !attempts.some(item => item.id === noteEditor.attemptId)) {
      noteEditor = null;
    }

    this.setData({
      archiveId: archive.archiveId,
      activeSession,
      selectedRoute,
      attempts,
      hasAttempts: attempts.length > 0,
      noteEditor
    });
  },

  /**
   * 返回入口（T046）：正常路径是系统返回上一页；从原场小结进来就真的回到那一页。
   *
   * 没有可返回的页面时（例如直接进入本页），按同一入口重建落点：小结入口用原档案
   * 与原场次重新打开小结页，其它来源仍回到正式场内页。只做页面跳转，不写任何数据。
   */
  backFallbackUrl() {
    if (!this._fromSummary) return SESSION_URL;
    const archiveId = this._context.archiveId || '';
    const sessionId = this._context.sessionId || '';
    if (!archiveId || !sessionId) return SESSION_URL;
    return (
      SUMMARY_URL +
      '?archiveId=' +
      encodeURIComponent(archiveId) +
      '&sessionId=' +
      encodeURIComponent(sessionId)
    );
  },

  /**
   * 返回：有上一页就退回去（小结 → 逐把 → 线路历史逐级都是同一份页面栈），
   * 没有可返回的页面时按入口落到原场小结或场内页。
   */
  backToList() {
    const fallback = this.backFallbackUrl();
    const canBack = typeof wx !== 'undefined' && typeof wx.navigateBack === 'function';
    if (canBack) {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (typeof wx.redirectTo === 'function') wx.redirectTo({ url: fallback });
        }
      });
      return;
    }
    if (typeof wx !== 'undefined' && typeof wx.redirectTo === 'function') {
      wx.redirectTo({ url: fallback });
    }
  },

  /**
   * 线路历史（T046）：从本场逐把主动进入这一条长期线路的跨场历史（照片、卡点、跨日
   * 记录）。带原档案 ID 与长期线路 ID，线路页按同一份归属核对；打开本身不写档案、
   * 不改当前场次与当前线路，也不改原把次。
   *
   * 打开前按最新档案再核对一次这一次入口的归属：场次/线路失效或已换档时只给原因并
   * 刷新本页，不拿别的场次或同名线路顶替；这一下若指向另一条线/另一份档案（旧渲染
   * 的迟到点击），同样只刷新、不打开。
   */
  openRouteHistory(event) {
    if (this.data.loadError || this.data.contextError) return;
    const context = actions.loadRecordContext(this._context);
    if (!context.ok) {
      this.loadPage();
      this.setData({ notice: context.error });
      return;
    }
    const archiveId = (context.archive && context.archive.archiveId) || '';
    const routeId = (context.route && context.route.id) || '';
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const stale =
      (dataset.archiveId && dataset.archiveId !== archiveId) ||
      (dataset.routeId && dataset.routeId !== routeId);
    if (stale) {
      this.loadPage();
      this.setData({ notice: '这一下不属于本页这一条线，未打开线路历史。' });
      return;
    }
    if (!archiveId || !routeId) {
      this.setData({ notice: '无法定位这条线路的原归属，暂不打开线路历史。' });
      return;
    }
    wx.navigateTo({
      url:
        ROUTE_URL +
        '?archiveId=' +
        encodeURIComponent(archiveId) +
        '&routeId=' +
        encodeURIComponent(routeId),
      fail: () => {
        this.setData({ notice: '线路历史没有打开，请再点一次。' });
      }
    });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  },

  /**
   * 打开某一把的备注编辑器（T037：编辑器就展开在那一行里，长列表也立刻看得见）。
   *
   * 写入语义仍完全走共用的 actions.openNoteEditor：目标只认这一行的原 attemptId 与
   * 归属。本页只补两件展示上的事——标题写明「补备注」还是「改备注」，以及**原地**：
   * 编辑器紧挨刚点过的那一行出现，不滚动、不挪走刚才点过的坐标；再点同一行不重置
   * 已经输入的内容（第一次点击的目标没变）。
   */
  openNoteEditor(event) {
    const attemptId = event && event.currentTarget && event.currentTarget.dataset.attemptId;
    const current = this.data.noteEditor;
    if (current && attemptId && current.attemptId === attemptId) return;

    const outcome = actions.openNoteEditor.call(this, event);
    const editor = this.data.noteEditor;
    if (editor && !editor.hasNote) {
      this.setData({ 'noteEditor.hasNote': Boolean(editor.text) });
    }
    return outcome;
  },

  /**
   * 视频入口（T023）：只把这一行渲染时的原把次与归属带到视频页。
   * 打开前按最新档案再核对一次：这一把被撤回、换了档案、还没保存或只存在于旧汇总时
   * 不打开；视频页会用同一组四个 ID 再核对一次。
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

  // ---------------------------------------------------------------- 更正结果（T042）

  /**
   * 这一行旁的「更正结果」：先核对这一下仍指向本页这一行可更正的完攀，再确认。
   *
   * 确认弹窗写明原把次的日期/场次/岩馆、原序号与原结果（完攀 → 未完成）；取消时一个
   * 字节都不写。确认后仍走共用 correctSend，只翻这一把的结果，备注、视频关联、原序号
   * 与把数都不变。连点同一把只弹一次确认；这一下若已不属于本场这一条线，只刷新不写盘。
   */
  confirmCorrectRow(event) {
    if (this.data.loadError || this.data.contextError) return Promise.resolve(null);
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const attemptId = dataset.attemptId || '';
    const row = (this.data.attempts || []).find(item => item.id === attemptId) || null;
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
    return actions.confirmCorrection.call(this, {
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
    });
  },

  // 共用事件：目标只认原 attemptId 与归属，保存/取消/失败重试都只影响这一把。
  onNoteInput: actions.onNoteInput,
  cancelNote: actions.cancelNote,
  saveNote: actions.saveNote,
  // 更正写入口仍是同一份实现；界面入口统一经 confirmCorrectRow 确认后调用。
  correctSend: actions.correctSend
});
