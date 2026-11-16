/**
 * 单线记录、按把备注与更正共用的页面逻辑（T036）
 *
 * 本模块只做「页面事件处理」的搬运与共用，不建立第二套持久模型：
 * - 记录一把、待保存重试、撤回／恢复与按把「改为未完成」都沿用
 *   utils/training-store.js 的既有写入与持久凭据（原把次 ID + opId + 预期状态/版本）；
 * - 备注只走 store.setAttemptNote，按原 attemptId 与归属定位；
 * - 入口归属核对只读档案：archiveId + sessionId + routeId 必须对得上，缺失、串档或
 *   线路不属于这一场时返回可见原因，页面据此拒绝展示与写入。
 *
 * pages/training-record（单线记录）与 pages/training-attempts（逐把明细）共用这里的
 * 事件处理；training-route 的「改为未完成」也指向同一份实现，避免两个不一致的写实现。
 *
 * 页面需要提供（与 T017 场内页同名）：
 *   this.archive、this.data.loadError、this.data.activeSession、this.data.selectedRoute、
 *   this.data.attempts、this.data.noteEditor、this.refreshView()，
 *   以及本实例临时状态 _lastTap / _failedOps / _correctedRows / _correctionFailures /
 *   _attemptOps / _recentStatus（onLoad 时初始化）。
 */
const store = require('./training-store.js');

// 「同一把按钮的同一结果」在窗口内重复点击视为一次误触：真实一次攀爬不会在
// 几百毫秒内发生两次，记两把之间必然隔着一次攀爬和一次落盘。
const SAME_TAP_WINDOW_MS = 300;

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function attemptResultText(result) {
  return result === 'send' ? '完攀' : '未完成';
}

function timeText(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/**
 * 线路上的完攀状态文案：已确认完攀与「完攀待确认」分开显示。
 * 判定来自档案层 routeCompletion，场内页与首页、历史页共用同一份结果。
 */
function completionText(completion) {
  if (!completion || !completion.known) return '';
  if (completion.completed) return '已完攀';
  if (completion.closed) return '完攀待确认';
  return '';
}

/**
 * 「第 N 把」：同一场次同一线路内按把次序号排出的**稳定原序号**。
 * 已保存（含已撤回的那一把）与仍待确认的把次共用序号，因此重试后编号稳定，不会因为
 * 补齐而跳号；撤回一把后序号也不整体前移——撤回第 3 把之后再记的一把是第 4 把，原来
 * 的第 3 把还是第 3 把（判定只有档案层那一份 attemptOrdinalMap，不拿全局 seq 当编号）。
 */
function attemptLabelMap(archive, sessionId, routeId) {
  const ordinals = store.attemptOrdinalMap(archive, sessionId, routeId, { includePending: true });
  const labels = new Map();
  ordinals.forEach((value, key) => labels.set(key, '第 ' + value + ' 把'));
  return labels;
}

/**
 * 结果按钮下方「最近一把」的目标：当前场次、当前线路里序号最大的一把
 * **已提交**把次——连已撤回的那一把一起看，撤回后这一行留在原处，恢复入口就落在
 * 原来那一把上，不会被悄悄换成前一把。
 *
 * 返回 { attempt, number }：attempt 是原把次；number 是它的**原序号**（按序号在本场
 * 本线路里排位，含已撤回的把次），撤回前后都是同一个数。没有已提交把次时返回 null。
 * 只读派生：不看行下标、名称与当前可见行，也不把档案里「待保存」的那一条算进来。
 */
function recentAttemptTarget(archive, sessionId, routeId) {
  if (!sessionId || !routeId) return null;
  const ordered = store.attemptsFor(archive, {
    sessionId,
    routeId,
    includeUndone: true
  });
  if (!ordered.length) return null;
  const attempt = ordered[ordered.length - 1];
  const ordinals = store.attemptOrdinalMap(archive, sessionId, routeId);
  return { attempt, number: ordinals.get(attempt.id) || ordered.length };
}

/**
 * 这条线在这一场次里是否还有未落盘的把次（档案里的「进行中」标记）。
 * 有的话最近一把的撤回区先收起：待保存的一把不是已保存可撤回项。
 */
function hasPendingOnRoute(archive, sessionId, routeId) {
  if (!sessionId || !routeId) return false;
  return ((archive && archive.pendingSaves) || []).some(
    op => op.sessionId === sessionId && op.routeId === routeId
  );
}

/**
 * 入口参数：archiveId / sessionId / routeId（兼容大小写写法）。
 */
function parseRecordQuery(query) {
  const data = query || {};
  return {
    archiveId: data.archiveId || data.archiveid || '',
    sessionId: data.sessionId || data.sessionid || '',
    routeId: data.routeId || data.routeid || ''
  };
}

/**
 * 按入口渲染时的档案、场次与长期线路核对归属（只读，不写盘）。
 *
 * - 档案读不出来：返回档案层错误，页面只显示错误；
 * - 入口带了 archiveId 且与当前档案不同：串档，拒绝展示/写入，不拿同名 ID 顶替；
 * - sessionId / routeId 缺失或不在档案里：可见原因；
 * - 线路不在这一场的关联里、也没有这一场的历史把次：拒绝，避免把把次记到别的场次。
 *
 * 返回 { ok, code, error, archive, session, route }。
 */
function loadRecordContext(query) {
  const ids = parseRecordQuery(query);
  const loaded = store.loadState();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'unreadable',
      error: loaded.error,
      archive: loaded.archive || null,
      session: null,
      route: null
    };
  }
  const archive = loaded.archive;
  if (ids.archiveId && ids.archiveId !== archive.archiveId) {
    return {
      ok: false,
      code: 'archive-mismatch',
      error: '这个入口属于另一份本机档案（当前档案已更换），未展示也未改动任何记录。',
      archive,
      session: null,
      route: null
    };
  }
  if (!ids.sessionId) {
    return {
      ok: false,
      code: 'missing-session',
      error: '缺少场次参数，无法确定这一次记录属于哪一场；未改动任何记录。',
      archive,
      session: null,
      route: null
    };
  }
  const session = (archive.sessions || []).find(item => item.id === ids.sessionId) || null;
  if (!session) {
    return {
      ok: false,
      code: 'missing-session',
      error: '这一场已经不在本机档案里，未展示也未改动任何记录。',
      archive,
      session: null,
      route: null
    };
  }
  if (!ids.routeId) {
    return {
      ok: false,
      code: 'missing-route',
      error: '缺少线路参数，无法确定要记录哪一条线；未改动任何记录。',
      archive,
      session,
      route: null
    };
  }
  const route = (archive.routes || []).find(item => item.id === ids.routeId) || null;
  if (!route) {
    return {
      ok: false,
      code: 'missing-route',
      error: '这条线路已经不在本机档案里，未展示也未改动任何记录。',
      archive,
      session,
      route: null
    };
  }
  const linked = (archive.sessionRoutes || []).some(
    link => link.sessionId === session.id && link.routeId === route.id
  );
  const hasHistory = (archive.attempts || []).some(
    attempt => attempt.sessionId === session.id && attempt.routeId === route.id
  );
  if (!linked && !hasHistory) {
    return {
      ok: false,
      code: 'not-in-session',
      error: '这条线路不属于这一场训练，未展示也未改动任何记录；请从本场线路列表重新进入。',
      archive,
      session,
      route
    };
  }
  return { ok: true, code: 'ready', error: '', archive, session, route };
}

/**
 * 单线页 / 明细页共用的一段查询串：带齐档案、场次与长期线路 ID。
 */
function recordQueryString(context) {
  const parts = [];
  if (context && context.archiveId) parts.push('archiveId=' + encodeURIComponent(context.archiveId));
  if (context && context.sessionId) parts.push('sessionId=' + encodeURIComponent(context.sessionId));
  if (context && context.routeId) parts.push('routeId=' + encodeURIComponent(context.routeId));
  return parts.join('&');
}

/**
 * 记一把「未完成 / 完攀」。
 *
 * 先按最新档案判定：抱石已完攀（含待确认）时不再新增；同一场次同一线路还有
 * 未落盘的把次时先重试那一把，不生成第二把。然后交给档案层以两段写落盘：
 * 失败不报已保存，这一把留在待保存行，重试沿用同一操作 ID，只会多出一把。
 *
 * 结果按钮把渲染时在场的档案、场次与线路写进 dataset。换档、切场次或换线之后才送到
 * 的这一下（旧按钮的迟到点击）如果和当前不一致，整条拒掉——不把新的一把写进别的
 * 档案、场次或线路。没带 dataset 的调用（数据层与老测试直接驱动）按当前值处理。
 */
function recordAttempt(event) {
  if (this.data.loadError) return;
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const result = dataset.result;
  if (result !== 'fail' && result !== 'send') return;

  const active = this.data.activeSession;
  if (!active) {
    this.setData({ notice: '请先开始一场训练' });
    return;
  }

  // 换档之后的迟到点击：事件带的是渲染那一刻的档案 ID。
  const boundArchiveId = dataset.archiveId || '';
  if (boundArchiveId && this.archive && boundArchiveId !== this.archive.archiveId) {
    this.setData({
      notice: '这一下属于原来的本机档案，档案已经更换，没有记录这一把。'
    });
    this.refreshView();
    return;
  }

  // 迟到点击：按钮渲染时带的场次与当前场次不同 → 这一下属于上一场，不落到新场次。
  const boundSessionId = dataset.sessionId || '';
  if (boundSessionId && boundSessionId !== active.id) {
    this.setData({
      notice: '这一下是上一场的按钮，已经切到别的场次，没有记录这一把。'
    });
    this.refreshView();
    return;
  }

  const currentRouteId =
    (this.data.selectedRoute && this.data.selectedRoute.id) ||
    (this.archive && this.archive.activeRouteId) ||
    '';
  // 迟到点击：按钮渲染时带的线路与当前线路不同 → 这一下属于上一条线，不落到新线路。
  const boundRouteId = dataset.routeId || '';
  if (boundRouteId && boundRouteId !== currentRouteId) {
    this.setData({
      notice: '这一下是上一条线路的按钮，当前线路已经换了，没有记录这一把。'
    });
    this.refreshView();
    return;
  }

  const routeId = boundRouteId || currentRouteId;
  if (!routeId) {
    this.setData({ notice: '请先选原线或新建一条线路' });
    return;
  }

  // 快速双击保护：同一把按钮的同一结果在窗口内只算一次，避免一次攀爬记成两把。
  const tapKey = active.id + '\u0000' + routeId + '\u0000' + result;
  const now = Date.now();
  if (this._lastTap[tapKey] && now - this._lastTap[tapKey] < SAME_TAP_WINDOW_MS) {
    this.setData({ notice: '刚记过这一把，落盘确认后再点下一次结果。' });
    return;
  }

  const pending = (this.archive.pendingSaves || []).some(
    op => op.sessionId === active.id && op.routeId === routeId
  );
  if (pending) {
    this.setData({
      notice: '上一把还没保存：先在「待保存」行点「重试保存」，确认后再记下一把。'
    });
    return;
  }

  const outcome = store.saveAttempt({
    // 记下这一把属于哪一份本机档案：换档之后的迟到重试不能把这次操作写进新档案。
    archiveId: this.archive.archiveId,
    sessionId: active.id,
    routeId,
    result,
    note: ''
  });

  if (outcome.archive) this.archive = outcome.archive;

  if (outcome.ok) {
    this._lastTap[tapKey] = now;
    delete this._failedOps[active.id + '\u0000' + routeId];
    this.setData({ storageError: '', notice: '' });
    this.refreshView();
    return;
  }

  // 抱石守卫等业务拒绝：不改数据，说明原因。
  if (outcome.blocked) {
    this.setData({ notice: outcome.error, storageError: '' });
    this.refreshView();
    return;
  }

  // 换档后的迟到请求：档案层已拒绝，不留下可重试记录。
  if (outcome.code === 'archive-mismatch') {
    delete this._failedOps[active.id + '\u0000' + routeId];
    this.setData({ storageError: '', notice: outcome.error });
    this.refreshView();
    return;
  }

  // 落盘失败：记下这一把的操作 ID（含两段写都没落盘的情况）与它属于哪一份档案，
  // 提示未保存，重试时沿用同一个 opId，只提交一次。
  this._failedOps[active.id + '\u0000' + routeId] = {
    archiveId: this.archive.archiveId,
    opId: outcome.opId,
    sessionId: active.id,
    routeId,
    result,
    note: ''
  };
  this.setData({ storageError: outcome.error, notice: '这一把未保存，可在「待保存」行重试。' });
  this.refreshView();
}

/**
 * 重试保存：沿用待保存行里的操作 ID，档案层按该 ID 幂等，只多出预期的一把。
 *
 * 这次重试绑定**发起时的那一份档案**：先按最新档案读一次，待保存记录（无论来自档案
 * 里的「进行中」标记还是本实例没落盘的那一条）带的 archiveId 与当前档案不一致时
 * （换档/换了账号之后又点到旧页面），整条不落盘，也不把这一把写进新的档案。
 */
function retryPendingAttempt(event) {
  if (this.data.loadError) return;
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const opId = dataset.opId;
  if (!opId) return;

  const loaded = store.loadState();
  if (!loaded.ok) {
    this.setData({ storageError: loaded.error });
    this.refreshView();
    return;
  }
  const archive = loaded.archive;
  this.archive = archive;

  const fromArchive = (archive.pendingSaves || []).find(op => op.opId === opId) || null;
  const localKey = Object.keys(this._failedOps).find(
    key => this._failedOps[key].opId === opId
  );
  const source = fromArchive || (localKey ? this._failedOps[localKey] : null);
  if (!source) {
    this.setData({ notice: '这条待保存记录已不存在，正在按最新档案刷新。' });
    this.refreshView();
    return;
  }

  // 待保存记录属于哪一份档案：档案里的「进行中」标记天然属于当前这一份；本实例的
  // 那一条记着发起时的档案 ID，换档之后不再往新档案里写这一把。
  const sourceArchiveId = fromArchive
    ? archive.archiveId
    : source.archiveId || archive.archiveId;
  if (sourceArchiveId !== archive.archiveId) {
    if (localKey) delete this._failedOps[localKey];
    this.setData({
      storageError: '',
      notice: '这一把属于原来的本机档案，未做改动；已按当前档案刷新。'
    });
    this.refreshView();
    return;
  }

  const outcome = store.saveAttempt({
    opId,
    archiveId: archive.archiveId,
    sessionId: source.sessionId,
    routeId: source.routeId,
    result: source.result,
    note: typeof source.note === 'string' ? source.note : ''
  });
  if (outcome.archive) this.archive = outcome.archive;

  if (outcome.ok) {
    if (localKey) delete this._failedOps[localKey];
    this._lastTap[source.sessionId + '\u0000' + source.routeId + '\u0000' + source.result] = Date.now();
    this.setData({ storageError: '', notice: '' });
    this.refreshView();
    return;
  }

  if (outcome.blocked) {
    if (localKey) delete this._failedOps[localKey];
    this.setData({ storageError: '', notice: outcome.error });
    this.refreshView();
    return;
  }

  // 仍然没落盘：保留同一个 opId 与它属于哪一份档案，可再次重试。
  const keptArchiveId = localKey
    ? this._failedOps[localKey].archiveId || archive.archiveId
    : archive.archiveId;
  if (localKey) {
    this._failedOps[localKey] = Object.assign({}, this._failedOps[localKey], {
      archiveId: keptArchiveId,
      opId: outcome.opId || opId
    });
  } else if (outcome.opId) {
    this._failedOps[source.sessionId + '\u0000' + source.routeId] = {
      archiveId: keptArchiveId,
      opId: outcome.opId,
      sessionId: source.sessionId,
      routeId: source.routeId,
      result: source.result,
      note: typeof source.note === 'string' ? source.note : ''
    };
  }
  this.setData({ storageError: outcome.error, notice: '这一把仍未保存，可再次重试。' });
  this.refreshView();
}

/**
 * 结果按钮下方「最近一把」的展示（只读派生，不写盘）。
 *
 * - 没有当前场次、没有当前线路、这条线还没有已提交把次：不显示（返回 null）；
 * - 这条线还有未落盘的把次：整个操作区收起；
 * - 已撤回的那一把仍留在这一行（标题写「已撤回」，序号与结果保持原样）：左槽撤回、
 *   右槽恢复，各占一半宽度、等高；不可用的动作在自己那一槽里留非交互空位，因此两个
 *   动作的命中矩形在任何状态下都不相交；
 * - 失败（写盘失败）时保留原动作与同一个 opId 的重试文案；成功的那一次在本行下方
 *   写一句确认（只在本页显示，不落盘，重开后以档案里的撤回状态为准）。
 */
function recentAttemptView(archive, activeSession, selectedRoute, pendingRows) {
  if (!activeSession || !selectedRoute) return null;
  if (
    (pendingRows && pendingRows.length) ||
    hasPendingOnRoute(archive, activeSession.id, selectedRoute.id)
  ) {
    return null;
  }

  const target = recentAttemptTarget(archive, activeSession.id, selectedRoute.id);
  if (!target) return null;

  const attempt = target.attempt;
  const undone = store.isUndoneAttempt(attempt);
  const offered = undone ? 'restore' : 'undo';
  const offeredText = undone ? '恢复' : '撤回';
  const madeByText = undone ? '撤回' : '恢复';
  const retry = this._attemptOps[attempt.id + '\u0000' + offered] || null;

  let stateText = '';
  if (retry) {
    stateText = offeredText + '未保存 · 点「重试' + offeredText + '这一把」按同一把重试';
  } else if (
    this._recentStatus &&
    this._recentStatus.attemptId === attempt.id &&
    this._recentStatus.undone === undone
  ) {
    const counted = store.attemptsFor(archive, {
      sessionId: activeSession.id,
      routeId: selectedRoute.id
    }).length;
    stateText = '已' + madeByText + '这一把 · 本场 ' + counted + ' 把';
  }

  return {
    attemptId: attempt.id,
    routeId: attempt.routeId,
    sessionId: attempt.sessionId,
    // 渲染这一行时用的档案 ID 与这一把的有效状态版本（rev）。两者都随点击一起交回
    // 档案层：档案 ID 不一致（换档后的迟到点击）或版本不一致（ABA 式的旧事件）时
    // 一律拒绝，不落盘。
    archiveId: archive.archiveId,
    expectedRev: store.attemptRev(attempt),
    expected: undone ? 'undone' : 'effective',
    titleText:
      (undone ? '已撤回 · ' : '刚才 · ') +
      selectedRoute.name +
      ' 第 ' +
      target.number +
      ' 把 · ' +
      attemptResultText(attempt.result),
    metaText:
      '本场 ' + activeSession.label + ' · ' + activeSession.gymName + ' · ' + timeText(attempt.createdAt),
    stateText,
    canUndo: !undone,
    undoText: retry && !undone ? '重试撤回这一把' : '撤回这一把',
    canRestore: undone,
    restoreText: retry && undone ? '重试恢复这一把' : '恢复这一把'
  };
}

/**
 * 撤回最近一把：结果按钮下方那一行的「撤回这一把」。
 */
function undoLatestAttempt(event) {
  return changeRecentAttempt.call(this, event, 'undo');
}

/**
 * 恢复最近一把：撤回后同一区域下方那一行的「恢复这一把」。
 */
function restoreLatestAttempt(event) {
  return changeRecentAttempt.call(this, event, 'restore');
}

/**
 * 撤回 / 恢复共用的一段：两个入口只在动作本身不同，目标核对、预期状态与预期版本、
 * 去重凭据、失败重试与「只按已落盘状态显示」完全相同。
 *
 * 目标只从点击这一行带下来的原把次 ID 与归属取，并**先按最新档案复核**它仍是本场
 * 本线路的最近一把：晚到的点击一律不落盘，只按最新档案刷新。行下标、名称与当前
 * 可见行都不参与判定，所以去掉一行也不会改到别的把次。
 *
 * 交给档案层的这一次动作带着渲染那一刻的档案 ID、有效状态版本（rev）与预期状态。
 * 任一与最新持久状态不符都不落盘。幂等来自档案层的持久凭据（settledOps + 撤回状态
 * + rev），不是计时防抖。
 */
function changeRecentAttempt(event, action) {
  if (this.data.loadError) return;
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const attemptId = dataset.attemptId;
  if (!attemptId) return;

  const loaded = store.loadState();
  if (!loaded.ok) {
    this.setData({ storageError: loaded.error });
    this.refreshView();
    return;
  }
  const archive = loaded.archive;
  this.archive = archive;

  const asUndo = action === 'undo';
  const noun = asUndo ? '撤回' : '恢复';
  const sessionId = dataset.sessionId || '';
  const routeId = dataset.routeId || '';
  const key = attemptId + '\u0000' + action;
  // **原按钮捕获的**档案 ID：写失败后重读比对「盘上这一份还是我原来那一份吗」用的
  // 就是它——不能拿已经被 outcome.archive 覆盖过的 this.archive 顶替。
  const originArchiveId = dataset.archiveId || archive.archiveId;

  // 换档之后的迟到点击：整条不落盘，也不按新档案改写任何把次。
  if (
    typeof dataset.archiveId === 'string' &&
    dataset.archiveId &&
    dataset.archiveId !== archive.archiveId
  ) {
    delete this._attemptOps[key];
    this.setData({
      storageError: '',
      notice: '这一把属于原来的本机档案，这次' + noun + '没有生效，已按当前档案刷新。'
    });
    this.refreshView();
    return;
  }

  // 已经切到别的场次/线路：这一行渲染时的归属不再是当前画面，旧事件一律拒绝。
  // 单线记录页的上下文是入口带下来的那一场那一条线（不跟全局 activeSessionId 走），
  // 因此先看页面自己渲染的上下文；页面没提供时退回档案的当前选择。
  const pageSessionId =
    (this.data.activeSession && this.data.activeSession.id) || archive.activeSessionId;
  const pageRouteId =
    (this.data.selectedRoute && this.data.selectedRoute.id) || archive.activeRouteId;
  if (
    (sessionId && sessionId !== pageSessionId) ||
    (routeId && routeId !== pageRouteId)
  ) {
    delete this._attemptOps[key];
    this.setData({
      storageError: '',
      notice: '已经切到别的场次或线路，这次' + noun + '没有生效，已按最新档案刷新。'
    });
    this.refreshView();
    return;
  }

  if (hasPendingOnRoute(archive, sessionId, routeId)) {
    this.setData({
      storageError: '',
      notice: '这条线还有一把没保存：先在「待保存」行重试保存，再' + noun + '。'
    });
    this.refreshView();
    return;
  }

  const target = recentAttemptTarget(archive, sessionId, routeId);
  if (!target || target.attempt.id !== attemptId) {
    delete this._attemptOps[key];
    this.setData({
      storageError: '',
      notice: '最近一把已经变了，已按最新档案刷新；' + noun + '只在最近这一把上生效。'
    });
    this.refreshView();
    return;
  }

  // 已经是要的状态（撤回一个已撤回的、恢复一个有效的）：不写盘，只说明下一步。
  const undone = store.isUndoneAttempt(target.attempt);
  if (asUndo === undone) {
    delete this._attemptOps[key];
    this._recentStatus = { attemptId, undone: asUndo };
    this.setData({
      storageError: '',
      notice: asUndo
        ? '这一把已经撤回，可用下方的「恢复这一把」找回。'
        : '这一把已经在本场里了，不用再恢复。'
    });
    this.refreshView();
    return;
  }

  const previous = this._attemptOps[key];
  const outcome = (asUndo ? store.undoAttempt : store.restoreAttempt)(attemptId, {
    routeId,
    sessionId,
    // 渲染那次点击时用的档案 ID；页面上的这一行不属于当前档案时不落盘。
    archiveId: originArchiveId,
    // 预期状态就是这一次点击所依据的画面（WXML 把渲染时的状态随点击带下来）。
    expected:
      dataset.expected === 'undone' || dataset.expected === 'effective'
        ? dataset.expected
        : asUndo
          ? 'effective'
          : 'undone',
    // 渲染时这一把的 rev：与最新持久版本不符时按过期事件拒绝，一个字都不写。
    expectedRev: Number.isInteger(dataset.expectedRev) ? dataset.expectedRev : undefined,
    opId: previous ? previous.opId : ''
  });
  if (outcome.archive) this.archive = outcome.archive;

  if (outcome.ok) {
    delete this._attemptOps[key];
    this._recentStatus = { attemptId, undone: asUndo };
    this.setData({ storageError: '', notice: '' });
    this.refreshView();
    return;
  }

  if (outcome.code === 'write-failed' || outcome.code === 'unreadable') {
    // 未确认落盘：不显示乐观结果，先按**最新落盘状态**重读一次档案。
    const reloaded = store.loadState();
    if (reloaded.ok) {
      this.archive = reloaded.archive;
      const fresh = reloaded.archive.attempts.find(item => item.id === attemptId) || null;
      const stateMatches = Boolean(fresh && store.isUndoneAttempt(fresh) === asUndo);
      // 「这一次确实写进去了，只是回执没回来」要说准，三样都得对上：
      //   1) 盘上仍是**原来那一份档案**；
      //   2) 这一把确实属于这次点击带下来的场次与线路；
      //   3) 这一把上留着**这次操作自己**的落盘凭据（outcome.opId 在 settledOps 里，
      //      且意图相符）。
      const sameArchive = reloaded.archive.archiveId === originArchiveId;
      const receipt =
        sameArchive &&
        fresh &&
        (!sessionId || fresh.sessionId === sessionId) &&
        (!routeId || fresh.routeId === routeId)
          ? store.attemptSettledOp(fresh, outcome.opId)
          : null;
      const landedByThisOperation = Boolean(receipt && receipt.undone === asUndo);
      if (stateMatches && landedByThisOperation) {
        delete this._attemptOps[key];
        this._recentStatus = { attemptId, undone: asUndo };
        this.setData({
          storageError: '',
          notice: noun + '已经落盘（回执丢失），已按最新档案确认。'
        });
        this.refreshView();
        return;
      }
      if (stateMatches) {
        delete this._attemptOps[key];
        this.setData({
          storageError: '',
          notice: sameArchive
            ? '盘上这一把已经是' +
              (asUndo ? '已撤回' : '有效') +
              '状态，但不是这次' +
              noun +
              '写入的（可能由另一处写入完成）；已按最新档案显示。'
            : '盘上这一把已经是' +
              (asUndo ? '已撤回' : '有效') +
              '状态，但盘上已经换成另一份本机档案，不是这次' +
              noun +
              '写入的；已按最新档案显示。'
        });
        this.refreshView();
        return;
      }
    }
    // 确实没落盘：保留原动作与同一个 opId 的重试入口。
    this._attemptOps[key] = { opId: outcome.opId, error: outcome.error };
    this.setData({
      storageError: outcome.error,
      notice: noun + '未保存，可再点一次「重试' + noun + '这一把」。'
    });
    this.refreshView();
    return;
  }

  // 守卫拒绝、过期的点击或这一把已不存在：不动任何数据。
  delete this._attemptOps[key];
  this.setData({
    storageError: '',
    notice: outcome.error || '这次' + noun + '没有生效，已按最新档案刷新。'
  });
  this.refreshView();
}

// ---------------------------------------------------------------- 逐把备注

/**
 * 打开某一把的备注编辑：目标来自该行按钮带下来的原把次 ID，只在当前页面的
 * 逐把列表里找这一把；编辑记录同时记下打开时的档案 ID，保存时先核对档案没换。
 */
function openNoteEditor(event) {
  const attemptId = event && event.currentTarget && event.currentTarget.dataset.attemptId;
  if (!attemptId || !this.data.selectedRoute) return;
  const attempt = (this.data.attempts || []).find(item => item.id === attemptId);
  if (!attempt) return;

  this.setData({
    noteEditor: {
      attemptId: attempt.id,
      routeId: this.data.selectedRoute.id,
      sessionId: this.data.activeSession ? this.data.activeSession.id : '',
      archiveId: (this.archive && this.archive.archiveId) || '',
      routeName: this.data.selectedRoute.name,
      attemptLabel: attempt.label,
      resultText: attempt.resultText,
      text: attempt.note
    }
  });
}

function onNoteInput(event) {
  this.setData({
    'noteEditor.text': (event && event.detail && event.detail.value) || ''
  });
}

function cancelNote() {
  this.setData({ noteEditor: null });
}

/**
 * 只改这一把的备注：把数、结果、序号、场次与其他把次（含第一把）都不动。
 * 保存前核对这份编辑仍属于当前本机档案；换档后的迟到保存不写进新档案。
 */
function saveNote() {
  const editor = this.data.noteEditor;
  if (!editor) return;

  const loaded = store.loadState();
  if (!loaded.ok) {
    this.archive = loaded.archive;
    this.setData({ storageError: loaded.error, notice: '备注未保存，可重试。' });
    this.refreshView();
    return;
  }
  this.archive = loaded.archive;
  if (editor.archiveId && editor.archiveId !== loaded.archive.archiveId) {
    this.setData({
      storageError: '',
      notice: '这一把属于原来的本机档案，档案已经更换；备注未改动。'
    });
    this.refreshView();
    return;
  }

  const outcome = store.setAttemptNote(editor.attemptId, {
    note: editor.text,
    routeId: editor.routeId,
    sessionId: editor.sessionId
  });
  if (outcome.archive) this.archive = outcome.archive;

  if (!outcome.ok) {
    this.setData({ storageError: outcome.error, notice: '备注未保存，可重试。' });
    this.refreshView();
    return;
  }

  this.setData({ noteEditor: null, storageError: '', notice: '' });
  this.refreshView();
}

// ---------------------------------------------------------------- 按把更正

/**
 * 「改为未完成」：只改正渲染这一行对应的那一把已确认完攀。
 *
 * 目标来自该行按钮带下来的原把次 ID 与归属，天然与这一行一一对应：
 * 连点/双击原坐标只会重复更正同一把（第二次幂等返回 resolved），不会改到另一把；
 * 只翻这一把的 result，把数、ID、序号、场次与备注都不变；之后可以正常再记完攀。
 *
 * 行里带了渲染时的 archiveId 时先核对当前档案：换档后的迟到点击不写进新档案。
 */
function correctSend(event) {
  if (this.data.loadError || this.data.notFound) return;
  // 入口失效（缺参/串档/线路不属于这一场）时页面上没有可点的更正行；
  // 迟到的旧事件也不许绕过归属核对去改任何一把。
  if (this.data.contextError) return;
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const attemptId = dataset.attemptId;
  if (!attemptId) return;

  // 行里带了渲染时的 archiveId 时先核对**最新**档案：换档后的迟到点击不写进新档案。
  // （档案层 correctAttempt 不带 archiveId，因此这一步由页面在读最新档案后把关。）
  if (typeof dataset.archiveId === 'string' && dataset.archiveId) {
    const loaded = store.loadState();
    if (!loaded.ok) {
      this.setData({ storageError: loaded.error });
      this.refreshView();
      return;
    }
    if (loaded.archive.archiveId !== dataset.archiveId) {
      this.archive = loaded.archive;
      this.setData({
        storageError: '',
        notice: '这一把属于原来的本机档案，档案已经更换；这次更正没有生效。'
      });
      this.refreshView();
      return;
    }
    this.archive = loaded.archive;
  }

  const outcome = store.correctAttempt(attemptId, {
    routeId: dataset.routeId,
    sessionId: dataset.sessionId
  });
  if (outcome.archive) this.archive = outcome.archive;

  if (outcome.ok) {
    delete this._correctionFailures[attemptId];
    // 已改好的这一把留在原位置变成只读回读：下面的行不上移，同一坐标不会被
    // 下一把的控件接管。
    this._correctedRows[attemptId] = {
      statusText: '已改为未完成 · 本把次保留原时间、场次与备注'
    };
    this.setData({
      storageError: '',
      notice: outcome.code === 'resolved' ? '这一把已经是未完成。' : ''
    });
    this.refreshView();
    return;
  }

  if (outcome.code === 'missing') {
    delete this._correctedRows[attemptId];
    this.setData({ storageError: '', notice: outcome.error });
    this.refreshView();
    return;
  }

  // 写盘失败与归属冲突：保留可重试的控件，明确提示，不改任何数据。
  this._correctionFailures[attemptId] = outcome.code;
  this.setData({
    storageError: outcome.code === 'write-failed' ? outcome.error : '',
    notice: outcome.code === 'write-failed' ? '更正未保存，可再点一次重试。' : outcome.error
  });
  this.refreshView();
}

module.exports = {
  SAME_TAP_WINDOW_MS,
  attemptResultText,
  timeText,
  completionText,
  attemptLabelMap,
  recentAttemptTarget,
  hasPendingOnRoute,
  parseRecordQuery,
  loadRecordContext,
  recordQueryString,
  // 页面方法（以 this 访问页面 data / 临时状态）
  recordAttempt,
  retryPendingAttempt,
  recentAttemptView,
  undoLatestAttempt,
  restoreLatestAttempt,
  changeRecentAttempt,
  openNoteEditor,
  onNoteInput,
  cancelNote,
  saveNote,
  correctSend
};
