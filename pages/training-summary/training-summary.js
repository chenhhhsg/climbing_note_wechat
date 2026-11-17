/**
 * 本次小结独立页（T034）
 *
 * 从场内页的小结入口进入，按入口传下来的 archiveId 与 sessionId 只读这一次训练：
 * 这一场爬了哪些线、共几把、哪些完攀，未完成的线可就地勾进本馆「下次想爬」。
 * 数据层沿用 T029 的 utils/training-session-summary.js（buildSessionSummary）与
 * T027 的 utils/training-wishlist.js（wishlistMembership / addWishlist / removeWishlist），
 * 口径与底部统计、场内页、清单完全一致，不在这里另算一份。
 *
 * 归属核对（T034）：
 * - 入口传下来的 archiveId 是渲染那一页所用的本机档案。打开本页时若本机档案已经换成
 *   另一份（档案被重置、换了账号，或另一份档案里恰好有同名 sessionId），一律不展示任何
 *   场次，只给可见状态——绝不拿当前档案里同名的场次顶替；
 * - sessionId 在本机档案里找不到时不拿「0 条线 · 0 把」冒充空场，而是显示可见错误，
 *   空场（确实存在、只是还没有已提交把次）与「找不到这场」是两种不同的状态。
 *
 * 只读回看：默认看入口指定的那一场；页面里的只读选择器可以换看本机档案里别的场次
 * （日期 · 岩馆 · 第 N 场），也可以直接回到当前场次小结。换看只改本页展示，不改当前
 * 场次、不建场次、不写训练；打开、返回、重开会按最新档案重算同一份结果，单纯回看
 * 不落盘、不改清单，档案字节不变。
 *
 * 唯一的写入口是勾选「下次想爬」：只走 T027 的清单接口，按 archiveId + 长期线路 ID 定位，
 * 只改清单里的这一条，线路、照片、把次、备注、场次与其他收藏一律不动。写失败不报已保存，
 * 勾选框显示的实际保存状态取自落盘后的重读，可原地再点一次重试。
 *
 * T046 点线先看原场逐把：小结里的每一条线带**原档案 ID + 所看这一场的场次 ID + 长期线路
 * ID** 进入现有「本场逐把」页，先核对这一条线在这一场里的原把次，不直接跳到跨场历史；
 * 跨场历史改由逐把页主动点「线路历史」进入。这里只做导航，不写任何数据；缺归属（没有
 * 档案 ID 或没有所看场次）时只给可见原因，不拿当前场次或同名线路顶替。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');
const { buildSessionSummary } = require('../../utils/training-session-summary.js');

const SESSION_URL = '/pages/training-session/training-session';
const ATTEMPTS_URL = '/pages/training-attempts/training-attempts';

Page({
  data: {
    ready: false,
    loadError: '',      // 本机档案损坏/版本不支持/读取失败的可见报错
    storageError: '',   // 本次写操作未落盘（不报已保存）
    notice: '',         // 说明性提示（写失败、幂等、回看范围），不改数据

    // 本次小结（只读）：按传入的 sessionId 从档案派生已提交把次、去重线路与完攀线路。
    summaryRows: [],
    summaryReady: false,
    summaryError: '',
    summarySessionId: '',
    summaryGymId: '',
    summaryGymName: '',
    summaryDate: '',
    summaryLabel: '',
    summaryViewingOther: false,
    summaryCountText: '',
    summarySendText: '',
    summaryPendingText: '',
    summaryWishlistError: '',
    summaryHintText: '',
    summaryEmpty: true,
    hasSummaryRows: false,

    // 只读回看入口：日期 · 岩馆 · 场次序号；选择只换所看的小结，不写任何数据。
    summarySessionOptions: [],
    summarySessionPickerVisible: false,
    summarySessionIndex: -1,
    summarySessionValue: '',

    // 当前场次（用于「回到本场小结」与「正在回看另一场」的说明）
    activeSessionId: '',
    activeSessionLabel: ''
  },

  onLoad(query) {
    const data = query || {};
    // 入口带下来的原归属：档案 ID 用于核对这份小结还属于不是同一份档案；
    // sessionId 是本页默认要看的场次（只读目标，页面内换看只改它）。
    this._archiveIdClaim = data.archiveId || '';
    this._viewSessionId = data.sessionId || data.sessionid || '';
    this.loadSummary();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从线路详情返回本页（或重新进入）都按最新档案重算，所看场次不变。
    this.loadSummary();
  },

  /**
   * 从本机档案重新装载并重算这一份小结（首次进入、返回本页、重试读取都走这里）。
   * 只读：不写档案、不写清单、不结束也不新建场次。
   */
  loadSummary() {
    const loaded = store.loadState();
    this.archive = loaded.archive || null;

    if (!loaded.ok) {
      this.setData({
        ready: true,
        loadError: loaded.error,
        storageError: '',
        notice: '',
        summaryRows: [],
        summaryReady: false,
        summaryError: '',
        summarySessionId: '',
        summaryGymId: '',
        summaryGymName: '',
        summaryDate: '',
        summaryLabel: '',
        summaryViewingOther: false,
        summaryCountText: '',
        summarySendText: '',
        summaryPendingText: '',
        summaryWishlistError: '',
        summaryHintText: '',
        summaryEmpty: true,
        hasSummaryRows: false,
        summarySessionOptions: [],
        summarySessionPickerVisible: false,
        summarySessionIndex: -1,
        summarySessionValue: '',
        activeSessionId: '',
        activeSessionLabel: ''
      });
      return;
    }

    // 入口归属缺项（T037）：小结必须带明示的 archiveId 与 sessionId 才能核对这是哪一份
    // 档案里的哪一场。缺任一项都只显示原因与返回入口，**不拿当前活动场次顶替**——否则
    // 会把另一场的内容当成本次要看的小结，也无法判断这一份属于哪一份档案。
    if (!this._archiveIdClaim || !this._viewSessionId) {
      this.setData({
        ready: true,
        loadError: '',
        storageError: '',
        notice: '',
        summaryRows: [],
        summaryReady: false,
        summaryError: this._archiveIdClaim
          ? '这个入口没有带要看哪一场（sessionId），不拿当前场次顶替；请从本场线路页的小结入口打开。'
          : '这个入口没有带本机档案归属（archiveId），无法核对这份小结属于哪一份档案；请从本场线路页的小结入口打开。',
        summarySessionId: '',
        summaryGymId: '',
        summaryGymName: '',
        summaryDate: '',
        summaryLabel: '',
        summaryViewingOther: false,
        summaryCountText: '',
        summarySendText: '',
        summaryPendingText: '',
        summaryWishlistError: '',
        summaryHintText: '',
        summaryEmpty: true,
        hasSummaryRows: false,
        summarySessionOptions: [],
        summarySessionPickerVisible: false,
        summarySessionIndex: -1,
        summarySessionValue: '',
        activeSessionId: loaded.archive.activeSessionId || '',
        activeSessionLabel: ''
      });
      return;
    }

    // 串档：入口记下的档案 ID 与本机现在这一份不同 → 不展示任何场次，也不受理勾选。
    if (this._archiveIdClaim !== loaded.archive.archiveId) {
      this.setData({
        ready: true,
        loadError: '',
        storageError: '',
        notice: '',
        summaryRows: [],
        summaryReady: false,
        summaryError: '这份小结属于另一份本机档案，未展示任何场次；请从当前的场内页重新打开小结。',
        summarySessionId: '',
        summaryGymId: '',
        summaryGymName: '',
        summaryDate: '',
        summaryLabel: '',
        summaryViewingOther: false,
        summaryCountText: '',
        summarySendText: '',
        summaryPendingText: '',
        summaryWishlistError: '',
        summaryHintText: '',
        summaryEmpty: true,
        hasSummaryRows: false,
        summarySessionOptions: [],
        summarySessionPickerVisible: false,
        summarySessionIndex: -1,
        summarySessionValue: '',
        activeSessionId: loaded.archive.activeSessionId || '',
        activeSessionLabel: ''
      });
      return;
    }

    this.setData({ ready: true, loadError: '', notice: '' });
    this.refreshSummary();
  },

  /**
   * 小结内的只读回看选择项：列出「可以回看哪几场」供用户直接点选。
   *
   * 只列本机档案里已经有**有效**把次的场次（只剩撤回把次的场次没有内容可看，与小计口径
   * 一致），外加当前正在记录的场次与本次要看的场次（哪怕它还是空场，也总能选回当前场、
   * 并让选择器如实显示正在看哪一场）；按本地日期新在前、同日序号大在前排序，
   * 每项写明 日期 · 岩馆 · 第 N 场。选择项本身不写任何数据。
   */
  summarySessionChoice(archive) {
    const activeId = (archive && archive.activeSessionId) || '';
    const wanted = this._viewSessionId || activeId;
    const withAttempts = new Set(
      store
        .effectiveAttempts((archive && archive.attempts) || [])
        .map(attempt => attempt.sessionId)
    );
    const options = ((archive && archive.sessions) || [])
      .filter(
        session =>
          withAttempts.has(session.id) || session.id === activeId || session.id === wanted
      )
      .sort((left, right) => right.date.localeCompare(left.date) || right.seq - left.seq)
      .map(session => ({
        id: session.id,
        label:
          session.date +
          ' · ' +
          (store.gymName(archive, session.gymId) || '未知岩馆') +
          ' · ' +
          store.sessionLabel(archive, session),
        isActive: session.id === activeId
      }));

    const index = options.findIndex(option => option.id === wanted);
    return {
      summarySessionOptions: options,
      summarySessionPickerVisible: options.length > 1,
      summarySessionIndex: index,
      summarySessionValue: index === -1 ? '选择要回看的场次' : options[index].label
    };
  },

  /**
   * 本次小结（只读）：按原 sessionId 从档案派生本场已提交把次、去重线路与完攀线路，
   * 并把每行与「下次想爬」清单的勾选状态合成到展示。
   *
   * - 没有入口场次时看当前场次；场次不存在时显示可见错误（不拿 0 冒充空场）；
   * - 勾选状态一律来自清单的实际存储，写失败或清单损坏时显示实际状态并收回写入口。
   */
  refreshSummary() {
    const archive = this.archive;
    const activeId = (archive && archive.activeSessionId) || '';
    // 只看入口点名的那一场：没有入口场次时上面已经给出可见原因，这里不再回落到当前场次。
    const requested = this._viewSessionId;
    const summary = buildSessionSummary(archive, requested);
    const choice = this.summarySessionChoice(archive);
    const activeSession = ((archive && archive.sessions) || []).find(
      session => session.id === activeId
    );
    const activeView = {
      activeSessionId: activeId,
      activeSessionLabel: activeSession
        ? activeSession.date +
          ' · ' +
          (store.gymName(archive, activeSession.gymId) || '未知岩馆') +
          ' · ' +
          store.sessionLabel(archive, activeSession)
        : ''
    };

    if (!summary.known) {
      this.setData(
        Object.assign(choice, activeView, {
          summaryRows: [],
          summaryReady: false,
          summaryError: requested
            ? '找不到这场训练（' + requested + '），可能本机档案已重置或这场不属于当前档案；不展示其他场次。'
            : '没有指定要看哪一场小结，请从本场线路页的小结入口打开。',
          summarySessionId: '',
          summaryGymId: '',
          summaryGymName: '',
          summaryDate: '',
          summaryLabel: '',
          summaryViewingOther: false,
          summaryCountText: '',
          summarySendText: '',
          summaryPendingText: '',
          summaryWishlistError: '',
          summaryHintText: '',
          summaryEmpty: true,
          hasSummaryRows: false
        })
      );
      return;
    }

    // 一次读盘拿到这批线路的清单状态；清单读不出来时按实际错误显示并收回写入口。
    const membership = wishlist.wishlistMembership(
      archive,
      summary.routes.map(row => row.routeId)
    );
    const rows = summary.routes.map(row => {
      const entry = membership.ok ? membership.entries.get(row.routeId) || null : null;
      const archived = Boolean(entry && entry.archived);
      const checked = Boolean(entry) && !archived;
      return Object.assign({}, row, {
        // canPick 只表示「现在能不能点」：未完成 + 清单可读；pickable 是本场状态。
        canPick: row.pickable && membership.ok,
        checked,
        inList: Boolean(entry),
        wishlistStateText: !entry
          ? ''
          : archived
            ? '已归档（岩馆拆线）'
            : entry.completed
              ? '已完成 · 在清单里'
              : '已在下次想爬',
        pickText: checked
          ? '✓ 已加入下次想爬'
          : archived
            ? '重新加入下次想爬'
            : '加入下次想爬'
      });
    });

    this._summaryRows = rows;
    this.setData(
      Object.assign(choice, activeView, {
        summaryRows: rows,
        summaryReady: true,
        summaryError: '',
        summarySessionId: summary.sessionId,
        summaryGymId: summary.gymId,
        summaryGymName: summary.gymName,
        summaryDate: summary.date,
        summaryLabel: summary.label,
        // 回看另一场时明确写出来，避免用户以为当前场次被改了。
        summaryViewingOther: Boolean(activeId) && summary.sessionId !== activeId,
        summaryCountText: summary.summaryText,
        summarySendText: summary.sendCountText,
        summaryPendingText: summary.pendingCountText,
        summaryWishlistError: membership.ok ? '' : membership.error,
        summaryHintText: rows.some(row => row.pickable)
          ? '没爬完的线可以直接勾上：下次进这家岩馆就能从「下次想爬」按原线路 ID 续记。'
          : '',
        summaryEmpty: summary.isEmpty,
        hasSummaryRows: rows.length > 0
      })
    );
  },

  /**
   * 选择要回看哪一场小结（只读）：只换所看的小结，不选场次、不建场次、不写训练，
   * 因此正在记录的当前场次与线路都不变。返回本页后仍停留在所选场次上。
   */
  onSummarySessionChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.summarySessionOptions || [];
    const option = options[index];
    if (!option) return;
    this._viewSessionId = option.id;
    this.refreshSummary();
  },

  /**
   * 回到当前场次小结（只读）：只把所看场次换回正在记录的那一场，不改当前场次。
   */
  returnToActiveSession() {
    const activeId = this.data.activeSessionId;
    if (!activeId) return;
    this._viewSessionId = activeId;
    this.refreshSummary();
  },

  /**
   * 返回本场记录：本页通常由场内页的小结入口打开，正常返回上一页即可；
   * 没有可返回的页面时（例如直接进入本页）显式回到正式场内页。
   */
  goBackToSession() {
    if (typeof wx.navigateBack === 'function') {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (typeof wx.reLaunch === 'function') wx.reLaunch({ url: SESSION_URL });
        }
      });
      return;
    }
    if (typeof wx.reLaunch === 'function') wx.reLaunch({ url: SESSION_URL });
  },

  /**
   * 清单写入口的原归属：本页渲染时用的档案 ID。数据层据此核对这条操作是不是还落在
   * 同一份档案上——换档之后的迟到点击会被拒绝。
   */
  wishlistOwnership() {
    const archiveId = this.archive && this.archive.archiveId;
    return archiveId ? { archiveId: archiveId } : undefined;
  },

  /**
   * 小结里勾选 / 取消「下次想爬」：只走 T027 的清单接口，只改清单里的这一条，
   * 线路、照片、把次、备注、场次与其他收藏一律不动；同一线路最多一条，重复点击幂等。
   *
   * 写失败不报已保存：提示未保存并立刻重读，勾选框显示的是实际保存状态，可以原地
   * 再点一次重试；内容冲突、线路已不存在等拒绝也按数据层给的原因原样显示。
   */
  toggleSummaryPick(event) {
    if (this.data.loadError || !this.data.summaryReady) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId;
    if (!routeId) return;

    const row = (this.data.summaryRows || []).find(item => item.routeId === routeId);
    if (!row) return;
    // 事件原意：按钮带下来的是「加入」还是「撤下」。带原意就照原意执行，同一事件重放或
    // 延迟送达只会把同一个动作再做一次（数据层按 archiveId + routeId 幂等：已加入再说
    // 加入只回读，不会因为界面上的勾选态被反着执行而把已保存的状态逆转）。
    const action = dataset.action === 'add' || dataset.action === 'remove' ? dataset.action : '';
    // 已完攀的线不在小结里勾选（按 T027 语义归到「已完成」），点它不产生任何写入。
    if (!row.pickable) return;
    // 清单读不出来（损坏、版本不支持、读取失败）：说明原因并收回写入口，不落盘。
    if (!row.canPick) {
      this.setData({
        notice: this.data.summaryWishlistError || '下次想爬清单当前不可用，稍后可再试。'
      });
      return;
    }

    // 没有带原意的旧事件（编译时直开本页、旧渲染）才按这一行当前的勾选态推一次。
    const intent = action || (row.checked ? 'remove' : 'add');
    const outcome =
      intent === 'remove'
        ? wishlist.removeWishlist(routeId, this.wishlistOwnership())
        : wishlist.addWishlist(routeId, this.wishlistOwnership());

    if (!outcome.ok) {
      const writeFailed = outcome.code === 'write-failed';
      this.setData({
        storageError: writeFailed ? outcome.error : '',
        notice: writeFailed ? '勾选未保存，可再点一次重试。' : outcome.error
      });
      this.refreshSummary();
      return;
    }

    this.setData({ storageError: '', notice: this.summaryPickNotice(outcome) });
    this.refreshSummary();
  },

  /**
   * 勾选结果文案：按数据层实际落盘的结果说明这条线现在的状态（含幂等与「本来就没有」）。
   */
  summaryPickNotice(outcome) {
    switch (outcome.code) {
      case 'added':
        return '已加入下次想爬；下次进这家岩馆就能从清单里按原线路 ID 续记。';
      case 'reactivated':
        return '这条线已重新加入下次想爬；照片、把次与历史都保留。';
      case 'duplicate':
        return '这条线路已经在下次想爬清单里。';
      case 'removed':
        return '已撤下这条线的收藏；其他收藏、照片与把次都不变。';
      case 'absent':
        return '这条线路本来就不在下次想爬清单里。';
      default:
        return '';
    }
  },

  /**
   * 从小结看原场逐把（T046）：带上**这一页正在看的那一场**的原档案 ID、场次 ID 与长期
   * 线路 ID，进入现有「本场逐把」页先看这一场这一条线的原把次、原备注与原把视频；
   * 跨场历史由逐把页主动点「线路历史」进入，这里不再直接跳跨场历史。
   *
   * 只读打开：不新建场次、不改当前线路，也不写任何键。缺档案归属或缺所看场次时只给
   * 可见原因——不拿当前活动场次、也不拿同名线路顶替，避免看到别场别的把次。
   */
  openSummaryRoute(event) {
    if (this.data.loadError || !this.data.summaryReady) return;
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const routeId = dataset.routeId;
    if (!routeId) return;
    const archiveId = (this.archive && this.archive.archiveId) || '';
    const sessionId = this.data.summarySessionId || this._viewSessionId || '';
    if (!archiveId || !sessionId) {
      this.setData({ notice: '这份小结没有可用的档案或场次归属，暂不打开本场逐把。' });
      return;
    }
    // 归属一起带过去：逐把页按同一组 archiveId + sessionId + routeId 再核对一次。
    // from=summary 让逐把页把返回落点写成「原场小结」，与实际返回的上一页一致。
    wx.navigateTo({
      url:
        ATTEMPTS_URL +
        '?archiveId=' +
        encodeURIComponent(archiveId) +
        '&sessionId=' +
        encodeURIComponent(sessionId) +
        '&routeId=' +
        encodeURIComponent(routeId) +
        '&from=summary'
    });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  }
});
