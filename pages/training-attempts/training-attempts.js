/**
 * 本线逐把明细页（T036）
 *
 * 从单线记录页进入，只列**所选场次 + 所选长期线路**的已提交把次：按原序号、结果、
 * 备注对齐，并可给指定把次补/改备注。照片、卡点、跨天历史不在这里（线路资料页），
 * 撤回与恢复也不在这里（单线记录页的「最近一把」）。
 *
 * 归属核对：archiveId + sessionId + routeId 与单线页同一份校验（training-record-actions
 * 的 loadRecordContext）。缺参、串档、场次/线路不存在或线路不属于这一场时只显示原因，
 * 不列别场别线的把次，也不接受写入。
 *
 * 备注写入口只认原 attemptId 与归属：保存、取消、失败重试都只影响这一把；保存前
 * 先核对档案没换，换档后的迟到保存不写进新档案。
 */
const store = require('../../utils/training-store.js');
const actions = require('../../utils/training-record-actions.js');
const { climbTypeOf } = require('../../utils/training-rules.js');

const SESSION_URL = '/pages/training-session/training-session';

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

    attempts: [],
    hasAttempts: false,
    noteEditor: null
  },

  onLoad(query) {
    this._context = actions.parseRecordQuery(query);
    this.loadPage();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从资料页返回或重新显示：按最新档案重算这一场这一条线的逐把。
    this.loadPage();
  },

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
    const attempts = store
      .attemptsFor(archive, { sessionId: session.id, routeId: route.id })
      .map(attempt => ({
        id: attempt.id,
        label: labels.get(attempt.id) || '',
        resultText: actions.attemptResultText(attempt.result),
        isSend: attempt.result === 'send',
        timeText: actions.timeText(attempt.createdAt),
        note: attempt.note || '',
        hasNote: Boolean(attempt.note)
      }));

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
   * 返回单线记录：正常路径是系统返回；缺参/失效时给一个可点的出口。
   */
  backToList() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: SESSION_URL });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  },

  // 共用事件：目标只认原 attemptId 与归属，保存/取消/失败重试都只影响这一把。
  openNoteEditor: actions.openNoteEditor,
  onNoteInput: actions.onNoteInput,
  cancelNote: actions.cancelNote,
  saveNote: actions.saveNote
});
