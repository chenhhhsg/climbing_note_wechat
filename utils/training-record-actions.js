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
 * pages/training-record（单线记录）与 pages/training-attempts（本场逐把）共用这里的
 * 事件处理；training-route 的「改为未完成」也指向同一份实现，避免两个不一致的写实现。
 * T042：更正的可见入口按把就近——最近一把在单线页旁、较早的把次在本场逐把那一行；
 * 这里只补确认与准入判断，持久化、重试规则与线路历史的更正能力都保持原样。
 * T045：单线页现场直接列本场本线把次（最新在前，一把一框），每行只编辑所点那一把；
 * 派生在 attemptCardRows，写入口仍是本文件的同一份事件处理，不新增持久模型。
 *
 * 页面需要提供（与 T017 场内页同名）：
 *   this.archive、this.data.loadError、this.data.activeSession、this.data.selectedRoute、
 *   this.data.attempts、this.data.noteEditor、this.refreshView()，
 *   以及本实例临时状态 _lastTap / _correctedRows / _correctionFailures /
 *   _recentStatus（onLoad 时初始化）。跨页面实例要保留的「没落盘的请求」不在页面实例
 *   上，见本文件里的应用运行期失败操作缓存。
 */
const store = require('./training-store.js');

// 「同一把按钮的同一结果」在窗口内重复点击视为一次误触：真实一次攀爬不会在
// 几百毫秒内发生两次，记两把之间必然隔着一次攀爬和一次落盘。
const SAME_TAP_WINDOW_MS = 300;

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// ---------------------------------------------------------------- 应用运行期的失败操作
//
// 待处理阶段的第一笔写就失败时，档案里没有留下任何标记；页面实例一换（回列表换线、
// 再点回原来这条线）原请求与原 opId 就只剩内存里那一份。这里只在**当前应用运行期**
// 留一份最小记录，跨页面实例沿用原 opId 重试：
// - 只存 opId、归属（archiveId + sessionId + routeId）与这次意图需要的原值，不缓存
//   整份档案，也不当成持久数据：每次仍先重读最新档案，再决定能不能重试；
// - 只读打开页面不写这层，更不写档案；
// - 应用冷启（模块重新加载）时这层为空：还没写成功的那一下就是「未保存」，页面只显示
//   档案里的真实状态，不伪造「已保存」；
// - 最新档案里已经有同一 opId 的落盘结果（待保存标记或把次）、或这次意图已由别的操作
//   完成时清掉，避免旧请求在新数据上再提交一次。
const APP_OPS_LIMIT = 20;
const appOps = { saves: [], changes: [] };

function opKey() {
  return Array.prototype.join.call(arguments, '\u0000');
}

function dropAppOps(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) list.splice(index, 1);
  }
}

/** 同 key 只留最新一条；总量有上限，只丢最旧的失败记录，不影响档案。 */
function pushAppOp(list, entry) {
  dropAppOps(list, item => item.key === entry.key);
  list.push(entry);
  while (list.length > APP_OPS_LIMIT) list.shift();
}

/**
 * 记下这一把「没落盘」的保存请求（第一段写就失败，档案里没有待保存标记）。
 */
function rememberFailedSave(entry) {
  if (!entry || !hasText(entry.archiveId) || !hasText(entry.opId)) return;
  pushAppOp(appOps.saves, {
    // 同一条线在同一场次里只留一条待重试：再记一把应当先重试上一把，不并列两条。
    key: opKey(entry.archiveId, entry.sessionId || '', entry.routeId || ''),
    archiveId: entry.archiveId,
    opId: entry.opId,
    sessionId: entry.sessionId || '',
    routeId: entry.routeId || '',
    result: entry.result === 'send' ? 'send' : 'fail',
    note: typeof entry.note === 'string' ? entry.note : ''
  });
}

/** 最新档案里这条待保存已经由档案层接手（有标记或已成把次）：内存里这条是多余的。 */
function pruneFailedSaves(archive) {
  if (!archive || !hasText(archive.archiveId)) return;
  const attemptIds = new Set((archive.attempts || []).map(item => item.id));
  const pendingOpIds = new Set((archive.pendingSaves || []).map(item => item.opId));
  dropAppOps(
    appOps.saves,
    entry =>
      entry.archiveId === archive.archiveId &&
      (attemptIds.has(entry.opId) || pendingOpIds.has(entry.opId))
  );
}

function failedSaveEntries(archive) {
  if (!archive || !hasText(archive.archiveId)) return [];
  pruneFailedSaves(archive);
  return appOps.saves
    .filter(entry => entry.archiveId === archive.archiveId)
    .map(entry => ({
      archiveId: entry.archiveId,
      opId: entry.opId,
      sessionId: entry.sessionId,
      routeId: entry.routeId,
      result: entry.result,
      note: entry.note
    }));
}

function failedSaveEntry(archive, opId) {
  if (!archive || !hasText(opId)) return null;
  pruneFailedSaves(archive);
  const found = appOps.saves.find(
    entry => entry.archiveId === archive.archiveId && entry.opId === opId
  );
  return found ? Object.assign({}, found) : null;
}

function forgetFailedSave(archiveId, opId) {
  if (!hasText(archiveId) || !hasText(opId)) return;
  dropAppOps(appOps.saves, entry => entry.archiveId === archiveId && entry.opId === opId);
}

/** 这条线新记的一把已经落盘：同一条线之前那条没落盘的请求不再可重试。 */
function forgetFailedSavesOnRoute(archiveId, sessionId, routeId) {
  if (!hasText(archiveId)) return;
  dropAppOps(
    appOps.saves,
    entry =>
      entry.archiveId === archiveId &&
      entry.sessionId === sessionId &&
      entry.routeId === routeId
  );
}

/**
 * 记下这次没落盘的撤回/恢复意图（第一段写就失败，档案里没有 pendingUndos/Restores）。
 *
 * 除了这次操作自己的 opId 与归属，还要留下**发出这次请求时所依据的版本**
 * （expectedRev）与来源状态：第一段写失败没有留下任何持久凭据，重试时如果拿页面上
 * 新渲染的版本去配旧 opId，就等于把旧请求偷偷升级成了一次新版本上的新请求——这一把
 * 此后被别人撤回再恢复过（状态转回原样、版本已经前进），旧请求仍会被结清到新状态上。
 */
function rememberFailedChange(entry) {
  if (!entry || !hasText(entry.archiveId) || !hasText(entry.opId) || !hasText(entry.attemptId)) {
    return;
  }
  if (entry.action !== 'undo' && entry.action !== 'restore') return;
  pushAppOp(appOps.changes, {
    key: opKey(entry.archiveId, entry.attemptId, entry.action),
    archiveId: entry.archiveId,
    attemptId: entry.attemptId,
    action: entry.action,
    sessionId: entry.sessionId || '',
    routeId: entry.routeId || '',
    opId: entry.opId,
    // 请求发出时这一把的有效状态版本；旧调用没带确切版本时记 null，只按状态判断。
    expectedRev:
      Number.isInteger(entry.expectedRev) && entry.expectedRev >= 0 ? entry.expectedRev : null,
    // 请求发出时所依据的状态：撤回基于「有效」，恢复基于「已撤回」。
    expected: entry.action === 'undo' ? 'effective' : 'undone'
  });
}

/**
 * 最新档案里这一把已经结清这次意图、已经处在意图的目标状态、或**版本已经前进**：
 * 内存里这条不再可重试。
 *
 * 版本这一项不能省：第一段写失败没有落盘凭据，但这一把此后可能被别的写入推进过
 * （撤回→恢复走一圈，状态又变回「有效」，只看状态和原来一模一样）。那次失败请求依据
 * 的是旧版本，重试或重放它就是在改写后来的写入，所以版本一变就整条丢掉。丢掉之后页面
 * 显示普通的「撤回/恢复」，用户在**当前版本**上明确再点一次才会由档案层生成新 opId。
 */
function pruneFailedChanges(archive) {
  if (!archive || !hasText(archive.archiveId)) return;
  const attempts = archive.attempts || [];
  dropAppOps(appOps.changes, entry => {
    if (entry.archiveId !== archive.archiveId) return false;
    const attempt = attempts.find(item => item.id === entry.attemptId);
    if (!attempt) return true;
    if (store.attemptSettledOp(attempt, entry.opId)) return true;
    const undone = store.isUndoneAttempt(attempt);
    // 已经不在请求发出时的来源状态（撤回基于「有效」、恢复基于「已撤回」）：
    // 这次意图已由这次或别的写入完成，旧请求不再可重试。
    const sourceUndone = entry.expected === 'undone';
    if (undone !== sourceUndone) return true;
    // 版本已经前进过（哪怕状态又转回来源状态）：旧请求依据的版本已被取代。
    if (Number.isInteger(entry.expectedRev) && entry.expectedRev !== store.attemptRev(attempt)) {
      return true;
    }
    return false;
  });
}

function failedChangeEntry(archive, attemptId, action) {
  if (!archive || !hasText(attemptId)) return null;
  pruneFailedChanges(archive);
  const found = appOps.changes.find(
    entry =>
      entry.archiveId === archive.archiveId &&
      entry.attemptId === attemptId &&
      entry.action === action
  );
  return found ? Object.assign({}, found) : null;
}

function forgetFailedChange(archiveId, attemptId, action) {
  if (!hasText(archiveId) || !hasText(attemptId)) return;
  dropAppOps(
    appOps.changes,
    entry =>
      entry.archiveId === archiveId && entry.attemptId === attemptId && entry.action === action
  );
}

/**
 * 档案里已落盘的 pending 标记带的原 opId：标记必须属于同一把次、同一场次与同一线路，
 * 否则宁可不用——不能借别的意图的 opId 提交。
 */
function pendingChangeOpId(archive, attempt, action) {
  if (!archive || !attempt) return '';
  const markers = action === 'undo' ? archive.pendingUndos : archive.pendingRestores;
  const marker = (markers || []).find(
    item =>
      item &&
      item.attemptId === attempt.id &&
      item.sessionId === attempt.sessionId &&
      item.routeId === attempt.routeId &&
      hasText(item.opId)
  );
  return marker ? marker.opId : '';
}

/**
 * 撤回/恢复重试要沿用的原请求：档案里已落盘的 pending 标记优先（两段写只差第二段的
 * 那种），其次是本应用运行期里第一段写就失败的那一次。标记必须属于同一把次、同一场次
 * 与同一线路，否则宁可不用——不能借别的意图的 opId 提交。
 *
 * 返回 { opId, fromCache, expectedRev }：
 * - opId 为空表示没有可沿用的原请求（缓存已经过期或被清掉）：页面显示普通按钮，用户
 *   在当前版本上明确新点一次时由档案层生成新 opId；
 * - 来自内存缓存的请求带回它**发出时**的 expectedRev，提交时只按这个版本走——不能把
 *   新渲染出来的版本配给旧 opId（版本对不上的缓存已在 pruneFailedChanges 里丢掉）。
 */
function retryChangeSource(archive, attempt, action) {
  if (!archive || !attempt) return { opId: '', fromCache: false, expectedRev: null };
  const pending = pendingChangeOpId(archive, attempt, action);
  if (pending) return { opId: pending, fromCache: false, expectedRev: null };
  const failed = failedChangeEntry(archive, attempt.id, action);
  if (!failed) return { opId: '', fromCache: false, expectedRev: null };
  return {
    opId: failed.opId,
    fromCache: true,
    expectedRev: Number.isInteger(failed.expectedRev) ? failed.expectedRev : null
  };
}

function retryChangeOpId(archive, attempt, action) {
  return retryChangeSource(archive, attempt, action).opId;
}

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
 * 本场这条线仍可更正的已确认完攀：attemptId → 目标行（含原场次、原序号与说明）。
 *
 * 与线路历史页共用档案层的 routeCorrectionTargets（同一份资格边界：只认抱石、
 * 只认有效把次、只认已确认完攀），这里只收**本场次**的目标：本场逐把只展示原场原线，
 * 跨场次的候选仍在线路历史里按原把次处理。
 */
function correctionTargetsForSession(archive, sessionId, routeId) {
  const targets = new Map();
  if (!archive || !hasText(sessionId) || !hasText(routeId)) return targets;
  store.routeCorrectionTargets(archive, routeId).forEach(target => {
    if (target.sessionId === sessionId) targets.set(target.attemptId, target);
  });
  return targets;
}

/**
 * 「更正结果」在这一把上的展示状态（只读派生，不写盘）：
 * - corrected：本页实例刚把这一把改好，原位显示只读回读；
 * - retry：上一次更正没落盘（本实例记着，或档案里留着 pendingCorrections 标记），
 *   按钮改成「重试更正结果」，仍指向同一把；
 * - ready：仍可更正。
 */
function correctionStateOf(archive, page, attemptId) {
  const corrected = page && page._correctedRows ? page._correctedRows[attemptId] : null;
  if (corrected) return { state: 'corrected', statusText: corrected.statusText || '' };
  const needsRetry = Boolean(
    (page && page._correctionFailures && page._correctionFailures[attemptId]) ||
      (archive &&
        (archive.pendingCorrections || []).some(item => item.attemptId === attemptId))
  );
  return { state: needsRetry ? 'retry' : 'ready', statusText: '' };
}

/**
 * 更正前的确认：写明原把次的日期/场次/岩馆与序号、原结果，以及将要改成的结果。
 * 弹窗不可用时按取消处理，一个字节都不写。
 */
function askCorrectConfirm(target) {
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
          (target.resultText || '完攀') +
          ' → 改为：未完成\n这把还计入本场把数，完攀次数减 1。',
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
}

/**
 * 「更正结果」入口的接线（T042）：先确认，确认后仍交给同一份 correctSend。
 *
 * target 由页面按**本次点击的那一行**解析好（原把次 ID、原归属与说明）；本函数只做
 * 三件事：同一把连点只弹一次确认（不会改两次）、取消时不写盘、确认后走原动作。
 * 页面需要提供 _correctionPrompt（onLoad 初始化为 null）与 _unloaded。
 */
function confirmCorrection(target) {
  if (!target) return Promise.resolve(null);
  const pending = this._correctionPrompt;
  if (pending && pending.attemptId === target.attemptId) {
    // 连点同一把：沿用已经打开的那一次确认，不叠第二个弹窗，也不会改两次。
    return pending.promise;
  }

  const prompt = { attemptId: target.attemptId, promise: null };
  prompt.promise = askCorrectConfirm(target).then(confirmed => {
    if (this._correctionPrompt === prompt) this._correctionPrompt = null;
    if (this._unloaded || !confirmed) return null;
    return correctSend.call(this, {
      currentTarget: {
        dataset: {
          attemptId: target.attemptId,
          routeId: target.routeId,
          sessionId: target.sessionId,
          archiveId: target.archiveId
        }
      }
    });
  });
  this._correctionPrompt = prompt;
  return prompt.promise;
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
 * - archiveId 缺失：无法确认入口属于哪一份本机档案，拒绝展示/写入（同名场次/线路
 *   不能顶替）；带了 archiveId 且与当前档案不同：串档，同样拒绝；
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
  // 新入口（单线记录 / 本场逐把）必须带齐档案归属：只凭 sessionId + routeId 打开时，
  // 换了本机档案后同名 ID 可以直接指向另一份档案，页面既无法展示也无法拒绝写入。
  if (!ids.archiveId) {
    return {
      ok: false,
      code: 'missing-archive',
      error: '缺少档案参数，无法确认这条记录属于哪一份本机档案；未展示也未改动任何记录。',
      archive,
      session: null,
      route: null
    };
  }
  if (ids.archiveId !== archive.archiveId) {
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
  if (this.data.loadError || this.data.contextError) return;
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
    forgetFailedSavesOnRoute(this.archive.archiveId, active.id, routeId);
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
    this.setData({ storageError: '', notice: outcome.error });
    this.refreshView();
    return;
  }

  // 落盘失败：记下这一把的操作 ID（含两段写都没落盘的情况）与它属于哪一份档案，
  // 提示未保存，重试时沿用同一个 opId，只提交一次。第一段写就失败时档案里没有标记，
  // 这条记录留在当前应用运行期，换页（回列表再进来）也能按原 opId 重试。
  rememberFailedSave({
    archiveId: this.archive.archiveId,
    opId: outcome.opId,
    sessionId: active.id,
    routeId,
    result,
    note: ''
  });
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
  if (this.data.loadError || this.data.contextError) return;
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

  // 归属核对必须**先于**任何待保存查找（opId / pendingSaves）：事件来自 A 档页面，
  // 而盘上已经换成 B 档时，两组 ID 与 opId 可能完全复用，按 opId 在 B 档找到同 ID
  // 的待保存记录就会把 A 的这一把写进 B。入口带的档案身份与最新档案不符时整条拒绝。
  const claimArchiveId =
    (typeof dataset.archiveId === 'string' && dataset.archiveId) ||
    (this._context && this._context.archiveId) ||
    (this.data && this.data.archiveId) ||
    '';
  if (claimArchiveId && claimArchiveId !== archive.archiveId) {
    this.setData({
      storageError: '',
      notice: '这一把属于原来的本机档案，未做改动；已按当前档案刷新。'
    });
    this.refreshView();
    return;
  }

  const fromArchive = (archive.pendingSaves || []).find(op => op.opId === opId) || null;
  // 档案里没有标记时，重试的是第一段写就失败、只在当前应用运行期记着的那一条；
  // 它带着发起时的档案 ID，换档之后不往新档案里写这一把。
  const source = fromArchive || failedSaveEntry(archive, opId);
  if (!source) {
    forgetFailedSave(archive.archiveId, opId);
    this.setData({ storageError: '', notice: '这条待保存记录已不存在，正在按最新档案刷新。' });
    this.refreshView();
    return;
  }

  // 事件带下来的场次与线路也必须和这条待保存记录一致：同一份档案里换了场次/线路之后，
  // 旧「待保存」行上的迟到重试不能把这一把提交到别的场次或线路。
  const claimSessionId =
    (typeof dataset.sessionId === 'string' && dataset.sessionId) ||
    (this._context && this._context.sessionId) ||
    '';
  const claimRouteId =
    (typeof dataset.routeId === 'string' && dataset.routeId) ||
    (this._context && this._context.routeId) ||
    '';
  if (
    (claimSessionId && claimSessionId !== source.sessionId) ||
    (claimRouteId && claimRouteId !== source.routeId)
  ) {
    this.setData({
      storageError: '',
      notice: '这条待保存记录属于别的场次或线路，这次重试没有生效；已按最新档案刷新。'
    });
    this.refreshView();
    return;
  }

  // 待保存记录属于哪一份档案：档案里的「进行中」标记天然属于当前这一份；运行期记着
  // 的那一条带着发起时的档案 ID，换档之后不再往新档案里写这一把。
  const sourceArchiveId = fromArchive
    ? archive.archiveId
    : source.archiveId || archive.archiveId;
  if (sourceArchiveId !== archive.archiveId) {
    forgetFailedSave(sourceArchiveId, opId);
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
    forgetFailedSave(sourceArchiveId, opId);
    this._lastTap[source.sessionId + '\u0000' + source.routeId + '\u0000' + source.result] = Date.now();
    this.setData({ storageError: '', notice: '' });
    this.refreshView();
    return;
  }

  if (outcome.blocked) {
    forgetFailedSave(sourceArchiveId, opId);
    this.setData({ storageError: '', notice: outcome.error });
    this.refreshView();
    return;
  }

  // 仍然没落盘：保留同一个 opId 与它属于哪一份档案，可再次重试。
  rememberFailedSave({
    archiveId: sourceArchiveId,
    opId: outcome.opId || opId,
    sessionId: source.sessionId,
    routeId: source.routeId,
    result: source.result,
    note: typeof source.note === 'string' ? source.note : ''
  });
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
 *   写一句确认（只在本页显示，不落盘，重开后以档案里的撤回状态为准）；
 * - T042：符合既有更正条件的这一把旁给「更正结果」（抱石线的有效已确认完攀）。固定槽
 *   在支持更正的线路上一直占位，撤回/恢复前后本区高度不变；较早的候选在本场逐把里
 *   各自一行处理，跨场候选仍在线路历史里处理。
 *
 * 失败后换页再回来（新页面实例）时，重试文案来自档案里的 pending 标记或当前应用运行期
 * 记着的那一次失败，仍指向原 opId。
 */
function recentAttemptView(archive, activeSession, selectedRoute, pendingRows, route) {
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
  const retryOpId = retryChangeOpId(archive, attempt, offered);

  let stateText = '';
  if (retryOpId) {
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

  // 「更正结果」（T042）：只在符合既有更正条件的最近一把旁出现——抱石线、有效把次、
  // 已确认完攀，与线路历史页共用同一份资格边界。较早的合资格把次在本场逐把各自一行处理，
  // 跨场次的候选仍在线路历史里按原把次处理。
  const allCorrectionTargets = store.routeCorrectionTargets(archive, selectedRoute.id);
  const correctionTargets = new Map();
  allCorrectionTargets.forEach(target => {
    if (target.sessionId === activeSession.id) correctionTargets.set(target.attemptId, target);
  });
  const correctionTarget = correctionTargets.get(attempt.id) || null;
  const correctionState = correctionStateOf(archive, this, attempt.id);
  const correctionSupported = route
    ? store.isBoulderRoute(route)
    : selectedRoute.climbType === '抱石';
  const correctable = Boolean(correctionTarget);
  // 刚改好的那一把仍在原位置显示只读回读；写失败的保留同一把的重试按钮。
  const correctText = correctionState.state === 'retry' ? '重试更正结果' : '更正结果';
  const correctStatusText = correctable ? '' : correctionState.statusText;

  let guidanceText = '刚才那一把已计入本场；撤回只减这一把，不改其他把次。';
  if (undone) {
    guidanceText = '撤回的这把不计入本场完攀；要恢复就点右侧「恢复这一把」。';
  } else if (correctable) {
    guidanceText = '要改这一把：点上方「更正结果」；这把仍计入本场把数。';
  } else if (correctionSupported && correctionTargets.size > 0) {
    guidanceText = '要改本场的完攀：到「本场逐把」点那一把的「更正结果」。';
  } else if (correctionSupported && allCorrectionTargets.length > 0) {
    // 跨场次的完攀不拿到本场来改：仍在线路历史里按原场次那一把处理。
    guidanceText = '要改别的场次的完攀：到「线路历史」按原场次那一把更正。';
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
    isSend: attempt.result === 'send',
    // 确认弹窗里辨认目标用的原把次说明（日期/场次/岩馆 + 原序号）。
    correctLabel: '第 ' + target.number + ' 把',
    correctContextText:
      activeSession.dateText + ' ' + activeSession.label + ' · ' + activeSession.gymName,
    // 更正结果的固定槽：支持更正的线路始终占位；可更正时给按钮，刚改好/不可改时给只读文字。
    correctionSupported,
    correctable,
    correctText,
    correctStatusText,
    // 不可交互时只有撤回完攀这一种状态需要一句解释；其余情况留空槽占位，不叠加噪音。
    correctIdleText: undone ? '已撤回，暂不可改' : '',
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
    guidanceText,
    canUndo: !undone,
    undoText: retryOpId && !undone ? '重试撤回这一把' : '撤回这一把',
    canRestore: undone,
    restoreText: retryOpId && undone ? '重试恢复这一把' : '恢复这一把',
    // 这一把当前沿用原 opId 重试：现场把次行据此换成同一把的重试文案。
    retry: Boolean(retryOpId)
  };
}

/**
 * 现场「本场本线把次」的行（T045 / T048）：普通文档流里最新在前，一把一框。
 *
 * 只读派生，不写盘：
 * - 行＝这条线在本场的**有效把次**，外加「最近一把」这一行——它可能是刚撤回的那一把，
 *   恢复入口要留在原框里；已撤回的较早把次不占据现场，旧档仍由原有入口读取；
 * - T048：按原序号倒序后，第一行是最新一把（isLatest，始终完整展示）；更早的把次各占
 *   一行紧凑短行；是否展开由页面按原把次 ID 决定，本模块不保存任何展开状态；
 * - 备注「编辑」与视频入口只给有效把次：撤回后档案层拒绝改备注、视频页拒绝打开，
 *   先恢复这一把；
 * - T049：视频入口按该把的真实关联给「＋ 添加视频」或「回看视频」，只换文案不换槽位；
 *   旧行收起时是否显示小视频图标由页面按展开态决定（本模块只给出 hasVideo）；
 * - 「改成未完成」与线路历史、本场逐把同一份资格（抱石、有效、已确认完攀）；
 * - 「这把多记了」（撤回）与「恢复这一把」只给最近一把，与 changeRecentAttempt 的
 *   原边界一致；重试沿用 recentAttemptView 的同一把、同一 opId 与渲染版本；
 * - 行上的动作都带原把次 ID 与归属，只作用于所点这一把。
 *
 * videoLinks 由页面用 attemptVideo.videoLinkMap 一次读索引算出（本模块不反向依赖
 * 视频模块）；page 只用于读取本页实例的更正回读/失败重试标记。展开态不在本模块：
 * 页面按原把次 ID 决定每一行是否 expanded，这里只给出最新一把与原序号顺序。
 */
function attemptCardRows(
  archive,
  activeSession,
  selectedRoute,
  route,
  recentAttempt,
  videoLinks,
  page
) {
  if (!archive || !activeSession || !selectedRoute) return [];
  const labels = attemptLabelMap(archive, activeSession.id, selectedRoute.id);
  const correctionTargets = correctionTargetsForSession(
    archive,
    activeSession.id,
    selectedRoute.id
  );
  const correctionSupported = route
    ? store.isBoulderRoute(route)
    : selectedRoute.climbType === '抱石';
  const recent = recentAttempt || null;

  const rows = store.attemptsFor(archive, {
    sessionId: activeSession.id,
    routeId: selectedRoute.id
  });
  // 刚撤回的那一把仍留在原框里（恢复入口就在这一行）；更早的已撤回把次不在这里。
  if (recent && !rows.some(item => item.id === recent.attemptId)) {
    const undone = (archive.attempts || []).find(item => item.id === recent.attemptId);
    if (undone) rows.push(undone);
  }
  rows.sort((left, right) => (right.seq || 0) - (left.seq || 0));

  const links = videoLinks || new Map();
  return rows.map((attempt, index) => {
    const undone = store.isUndoneAttempt(attempt);
    const isRecent = Boolean(recent && recent.attemptId === attempt.id);
    // T048：原序号倒序后第一行就是最新一把，始终完整展示；更早的把次默认收成短行。
    const isLatest = index === 0;
    const link = links.get(attempt.id) || {
      hasVideo: false,
      stateText: '未添加视频',
      entryText: '添加视频 ›'
    };
    const correctable = Boolean(correctionTargets.get(attempt.id)) && !undone;
    // 这一把真实关联了本机视频（已撤回的一把不算）：入口文案与收起态图标都据此派生。
    const hasVideo = !undone && Boolean(link.hasVideo);
    const correctionState = correctionStateOf(archive, page, attempt.id);
    const canUndo = Boolean(isRecent && recent.canUndo);
    const canRestore = Boolean(isRecent && recent.canRestore);

    // 两种动作对把数的影响写在行里，不靠记忆或颜色猜。
    const hints = [];
    if (undone) {
      hints.push('已撤回：本场把数不含这一把；恢复后加回 1 把。');
    } else {
      if (correctable) hints.push('改成未完成：本场把数不变，完攀次数减 1。');
      if (canUndo) hints.push('这把多记了：撤回后本场把数减 1。');
    }

    return {
      id: attempt.id,
      attemptId: attempt.id,
      label: labels.get(attempt.id) || '',
      resultText: attemptResultText(attempt.result),
      isSend: attempt.result === 'send',
      isUndone: undone,
      // T048：最新一把完整卡；更早的把次是紧凑短行，点行按原把次 ID 展开/收起。
      isLatest,
      canToggle: !isLatest,
      timeText: timeText(attempt.createdAt),
      note: attempt.note || '',
      hasNote: Boolean(attempt.note),
      // 备注与视频只给有效把次：已撤回的一把被档案层与视频页按同一份规则拒绝。
      canEditNote: !undone,
      hasVideo,
      videoStateText: undone ? '已撤回 · 恢复后可回看' : link.stateText,
      // T049：本页视频入口按该把的真实关联给文案（无片「＋ 添加视频」、有片「回看视频」），
      // 添加与回看共用同一个槽位，页面只换文字，不另立按钮或另一处坐标。
      videoEntryText: undone ? '' : hasVideo ? '回看视频' : '＋ 添加视频',
      canOpenVideo: !undone,
      routeId: attempt.routeId,
      sessionId: attempt.sessionId,
      archiveId: archive.archiveId,
      correctionSupported,
      correctable,
      correctText: correctionState.state === 'retry' ? '重试改成未完成' : '改成未完成',
      correctStatusText: correctable ? '' : correctionState.statusText,
      correctIdleText: undone ? '已撤回，恢复后可改' : '',
      // 撤回/恢复只出现在最近一把这一行：同一行里两个并排槽，互不接管坐标。
      showChange: isRecent,
      canUndo,
      canRestore,
      undoText: canUndo
        ? recent.retry
          ? '重试这把多记了'
          : '这把多记了'
        : '',
      restoreText: canRestore ? recent.restoreText : '',
      expected: isRecent ? recent.expected : '',
      expectedRev: isRecent ? recent.expectedRev : 0,
      stateText: isRecent ? recent.stateText : '',
      actionHint: hints.join(' ')
    };
  });
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
  if (this.data.loadError || this.data.contextError) return;
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
  // **原按钮捕获的**档案 ID：写失败后重读比对「盘上这一份还是我原来那一份吗」用的
  // 就是它——不能拿已经被 outcome.archive 覆盖过的 this.archive 顶替。
  const originArchiveId = dataset.archiveId || archive.archiveId;

  // 换档之后的迟到点击：整条不落盘，也不按新档案改写任何把次。
  if (
    typeof dataset.archiveId === 'string' &&
    dataset.archiveId &&
    dataset.archiveId !== archive.archiveId
  ) {
    forgetFailedChange(originArchiveId, attemptId, action);
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
    forgetFailedChange(archive.archiveId, attemptId, action);
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
    forgetFailedChange(archive.archiveId, attemptId, action);
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
    forgetFailedChange(archive.archiveId, attemptId, action);
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

  // 重试沿用的原请求：档案里已落盘的 pending 标记优先，其次是当前应用运行期里
  // 第一段写就失败的那一次——换了页面实例也还认得同一个请求。缓存已在这之前按最新
  // 档案核对过：版本被后来的写入推进过的旧请求不再出现，此处为空即按新动作走。
  const retry = retryChangeSource(archive, target.attempt, action);
  const retryOpId = retry.opId;
  // 渲染时这一把的 rev：与最新持久版本不符时按过期事件拒绝，一个字都不写。
  const renderedRev = Number.isInteger(dataset.expectedRev) ? dataset.expectedRev : undefined;
  // 沿用的失败请求只按它**发出时**的版本提交：不拿新渲染的版本把旧 opId 升级成新请求。
  const requestRev =
    retry.fromCache && Number.isInteger(retry.expectedRev) ? retry.expectedRev : renderedRev;
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
    expectedRev: requestRev,
    opId: retryOpId
  });
  if (outcome.archive) this.archive = outcome.archive;

  if (outcome.ok) {
    forgetFailedChange(originArchiveId, attemptId, action);
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
        forgetFailedChange(originArchiveId, attemptId, action);
        this._recentStatus = { attemptId, undone: asUndo };
        this.setData({
          storageError: '',
          notice: noun + '已经落盘（回执丢失），已按最新档案确认。'
        });
        this.refreshView();
        return;
      }
      if (stateMatches) {
        forgetFailedChange(originArchiveId, attemptId, action);
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
    // 确实没落盘：保留原动作与同一个 opId 的重试入口。第一段写就失败时档案里没有
    // pending 标记，这条意图留在当前应用运行期，换页回来仍按同一个 opId 重试。
    // 同时记下这次请求**发出时**依据的版本：重试只能沿用它，不能换成后来渲染的版本。
    rememberFailedChange({
      archiveId: originArchiveId,
      attemptId,
      action,
      sessionId: sessionId || target.attempt.sessionId,
      routeId: routeId || target.attempt.routeId,
      opId: outcome.opId || retryOpId,
      expectedRev: Number.isInteger(requestRev) ? requestRev : null
    });
    this.setData({
      storageError: outcome.error,
      notice: noun + '未保存，可再点一次「重试' + noun + '这一把」。'
    });
    this.refreshView();
    return;
  }

  // 守卫拒绝、过期的点击或这一把已不存在：不动任何数据，也不沿用旧 opId。
  forgetFailedChange(originArchiveId, attemptId, action);
  this.setData({
    storageError: '',
    notice: outcome.error || '这次' + noun + '没有生效，已按最新档案刷新。'
  });
  this.refreshView();
}

// ---------------------------------------------------------------- 逐把备注

/**
 * 打开某一把的备注编辑：目标来自该行按钮带下来的原把次 ID，只在当前页面的
 * 逐把列表里找这一把；编辑记录同时记下打开时的档案 ID 与**本次编辑代次**，
 * 保存、取消与输入都按同一代次核对，旧编辑器的事件不会落到后来的草稿上。
 *
 * T045：单线页现场把次行在 attemptCards（最新在前），本场逐把页仍在 attempts；
 * 两处都按同一个原 attemptId 定位，并用该行自己的 label/resultText 填编辑抬头。
 */
function openNoteEditor(event) {
  if (this.data.contextError) return;
  const attemptId = event && event.currentTarget && event.currentTarget.dataset.attemptId;
  if (!attemptId || !this.data.selectedRoute) return;
  const pool = (this.data.attempts || []).concat(this.data.attemptCards || []);
  const attempt = pool.find(item => item.id === attemptId);
  if (!attempt) return;
  // 已撤回的那一把按原边界不允许改备注：先恢复，恢复后编辑器从同一行再打开。
  if (attempt.canEditNote === false) return;

  this._noteEditorSeq = (this._noteEditorSeq || 0) + 1;
  this.setData({
    noteEditor: {
      attemptId: attempt.id,
      // 同一把取消后重新打开、或改开另一把都会换号：之前渲染的保存/取消按钮随之失效。
      version: this._noteEditorSeq,
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

/**
 * 事件上的编辑归属：WXML 把打开这一把时的 attemptId 与编辑代次一起带回来。
 * 没带（数据层与老测试直接驱动）时不额外比对，沿用当前编辑器的行为。
 */
function noteEditorBinding(event) {
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const attemptId = typeof dataset.attemptId === 'string' ? dataset.attemptId : '';
  const hasVersion =
    dataset.editVersion !== undefined &&
    dataset.editVersion !== null &&
    dataset.editVersion !== '';
  return {
    bound: Boolean(attemptId) || hasVersion,
    attemptId,
    version: hasVersion ? String(dataset.editVersion) : ''
  };
}

function noteEditorMatches(editor, binding) {
  if (!editor) return false;
  if (!binding.bound) return true;
  if (binding.attemptId && binding.attemptId !== editor.attemptId) return false;
  if (binding.version && binding.version !== String(editor.version)) return false;
  return true;
}

function onNoteInput(event) {
  const editor = this.data.noteEditor;
  if (!editor) return;
  if (!noteEditorMatches(editor, noteEditorBinding(event))) return;
  this.setData({
    'noteEditor.text': (event && event.detail && event.detail.value) || ''
  });
}

function cancelNote(event) {
  const editor = this.data.noteEditor;
  if (!editor) return;
  // 旧编辑器上的取消晚到：不清掉后来打开的草稿（另一把或同一把重新打开）。
  if (!noteEditorMatches(editor, noteEditorBinding(event))) {
    this.setData({
      notice: '这次取消来自之前打开的备注编辑，已经失效；当前草稿保留。'
    });
    this.refreshView();
    return;
  }
  this.setData({ noteEditor: null });
}

/**
 * 只改这一把的备注：把数、结果、序号、场次与其他把次（含第一把）都不动。
 * 保存前核对这份编辑仍属于当前本机档案；换档后的迟到保存不写进新档案。
 * 事件带的是打开编辑器时的 attemptId 与代次：旧按钮不能提交后来同把/另把的新草稿。
 */
function saveNote(event) {
  if (this.data.contextError) return;
  const editor = this.data.noteEditor;
  if (!editor) return;

  // 旧编辑器上的保存晚到：不写入，也不收起后来那一份草稿。
  if (!noteEditorMatches(editor, noteEditorBinding(event))) {
    this.setData({
      notice: '这次保存来自之前打开的备注编辑，已经失效；当前草稿没有改动。'
    });
    this.refreshView();
    return;
  }

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
  correctionTargetsForSession,
  correctionStateOf,
  hasPendingOnRoute,
  parseRecordQuery,
  loadRecordContext,
  recordQueryString,
  // 页面方法（以 this 访问页面 data / 临时状态）
  recordAttempt,
  retryPendingAttempt,
  recentAttemptView,
  attemptCardRows,
  undoLatestAttempt,
  restoreLatestAttempt,
  changeRecentAttempt,
  // 更正结果的确认与接入口（写仍走 correctSend，不另建持久模型）
  askCorrectConfirm,
  confirmCorrection,
  // 当前应用运行期的失败操作（只读给待保存行与重试文案，不落盘）
  failedSaveEntries,
  failedSaveEntry,
  failedChangeEntry,
  openNoteEditor,
  onNoteInput,
  cancelNote,
  saveNote,
  correctSend
};
