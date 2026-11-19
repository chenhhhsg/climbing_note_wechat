/**
 * 「本机训练场次长按删除」的两页共用交互（T053）
 *
 * 记录列表的整张场次卡与场内页「本日场次」的整个按钮共用这一份流程，页面只提供
 * 可见状态与本地刷新入口，不各自实现确认、写入或文件清理：
 *
 *   1) 菜单：只显示一项「删除场次」。取消（success 的 cancel/负索引或 fail 里明确的
 *      cancel）与原生失败分开：取消静默返回；原生不可用/抛错给可见提示，零写入。
 *   2) 范围：选菜单后调用 T052 的 inspectSessionDelete，用同一原档案 + 原场次读取
 *      权威日期、岩馆、场次、线路数、有效/已撤回把数、完攀把数与视频关联数。
 *      待保存/更正/撤回/恢复、单把删除在途或同场视频写入在途时只给可见原因。
 *   3) 确认：showModal 的标题与正文只来自这次读取；内容同时说明本场把次、备注与
 *      「只清理没有剩余引用的攀笔视频副本」。取消确认不写一个字节。
 *   4) 提交：只调用 T052 的 commitSessionDelete（内部复用 T051 的一次档案写入与
 *      journal/定向清理）。确认框打开后内容变化时本次提交返回 stale：本模块不沿用
 *      旧确认、不把目标改到接续场，只按原档案 + 原场次重新读取；原目标仍存在就显示
 *      最新范围再次确认，原目标消失或档案已切换就结束当次操作。
 *   5) 收尾：成功后重新读取本页列表与小结；记录/档案已删但视频副本待清理、或写入
 *      状态未确认时，用 T052 自己命名空间的 pendingStatus 显示可见状态，并提供
 *      只按本档案范围调的 recoverPending 重试入口。首页与统计页各自 onShow 重读
 *      档案，本模块不向它们写入任何缓存。
 *
 * 长按与短按：长按处理器先记下这次原场次，页面短按处理器用 consumeLongPressTap
 * 丢弃同一原场次在短窗口内补发的 tap；窗口之后的下一次短按照常执行。菜单与二次
 * 确认的取消都不写盘、也不改变当前场次。
 */
const sessionDelete = require('./training-session-delete.js');

// 原生 longpress 结束后，部分基础库/机型会补一个 tap。只拦同一原场次在这个窗口内
// 的补发事件；窗口外的下一次短按是用户的新意图。
const LONG_PRESS_TAP_GUARD_MS = 700;
const MENU_DELETE_LABEL = '删除场次';
const MAX_RECONFIRM = 3;

// 每个页面实例同一时间最多一个确认流程；重复长按同一原场次复用同一个 Promise。
const activePrompts = new WeakMap();

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function textOf(value) {
  return hasText(value) ? value : '';
}

function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

/** 原生错误的短码：只取 errMsg 的分类段，不把用户文案或凭据写进页面。 */
function nativeErrorCode(error) {
  const message = error && (error.errMsg || error.message);
  if (typeof message !== 'string' || !message) return '';
  const parts = message.split(':');
  return String(parts.length > 1 ? parts[1] : parts[0]).trim().slice(0, 60);
}

function isCancelNativeError(error) {
  return /cancel|canceled|cancelled|取消/i.test(errorText(error));
}

function notify(host, message, options) {
  if (!host || typeof host.notify !== 'function' || !message) return;
  host.notify(message, options || {});
}

function setBusy(host, busy) {
  if (!host || typeof host.setBusy !== 'function') return;
  host.setBusy(Boolean(busy));
}

function refresh(host) {
  if (!host || typeof host.refresh !== 'function') return;
  try {
    host.refresh();
  } catch (error) {
    // 页面刷新失败不能把已完成的删除说成没发生；可见状态已经由 notify 给出。
  }
}

function contextMatches(host, context) {
  if (!host || typeof host.contextMatches !== 'function') return true;
  try {
    return host.contextMatches(context) !== false;
  } catch (error) {
    return false;
  }
}

function setCleanupFor(host, archiveId) {
  if (!host || typeof host.setCleanup !== 'function') return;
  if (!hasText(archiveId)) {
    host.setCleanup({ pending: 0, error: '', retry: false, text: '' });
    return;
  }
  try {
    host.setCleanup(sessionDelete.pendingStatus(archiveId));
  } catch (error) {
    host.setCleanup({
      pending: 0,
      error: '读取本机场次视频副本清理状态失败：' + errorText(error),
      retry: true,
      text: '本机场次视频副本清理状态暂时读取失败；记录与视频保持不变。'
    });
  }
}

function result(fields) {
  return Object.assign(
    {
      ok: false,
      code: '',
      error: '',
      cancelled: false,
      outcome: null
    },
    fields || {}
  );
}

// ------------------------------------------------------------------ *
// 长按 / 短按守卫
// ------------------------------------------------------------------ *

/** 页面长按处理器在弹菜单前调用：记下这次原场次，供随后可能补发的 tap 识别。 */
function markLongPress(host, sessionId) {
  if (!host || !hasText(sessionId)) return;
  if (!host._sessionDeleteLongPress) {
    host._sessionDeleteLongPress = Object.create(null);
  }
  host._sessionDeleteLongPress[sessionId] = { at: Date.now(), open: true };
}

/**
 * 一次长按流程结束（确认、取消或失败）时把守卫改成「窗口从结束时刻起算」：
 * 原生菜单/确认框关掉后才补到的 release tap 也仍然被吃掉，窗口外的下一次独立短按
 * 照常执行。
 */
function settleLongPress(host, sessionId) {
  if (!host || !hasText(sessionId)) return;
  const guards = host._sessionDeleteLongPress;
  const guard = guards && guards[sessionId];
  if (!guard) return;
  guard.at = Date.now();
  guard.open = false;
}

/**
 * 页面短按处理器先调用：同一原场次在长按流程期间、或流程结束后的短窗口内补发的 tap
 * 返回 true（并消费掉守卫），页面据此不导航、不切场。窗口外或别的原场次返回 false，
 * 原短按照常。
 */
function consumeLongPressTap(host, sessionId) {
  if (!host || !hasText(sessionId)) return false;
  const guards = host._sessionDeleteLongPress;
  const guard = guards && guards[sessionId];
  if (!guard) return false;
  delete guards[sessionId];
  if (guard.open) return true;
  return Date.now() - guard.at <= LONG_PRESS_TAP_GUARD_MS;
}

// ------------------------------------------------------------------ *
// 原生菜单与确认框
// ------------------------------------------------------------------ *

/**
 * 第一步：只显示「删除场次」。
 * 返回 { chosen, reason: 'chosen'|'cancelled'|'unavailable'|'failed', error }。
 */
function askDeleteMenu() {
  return new Promise(resolve => {
    const api = typeof wx !== 'undefined' ? wx : null;
    if (!api || typeof api.showActionSheet !== 'function') {
      resolve({ chosen: false, reason: 'unavailable', error: '' });
      return;
    }
    try {
      api.showActionSheet({
        itemList: [MENU_DELETE_LABEL],
        success(res) {
          const tapIndex = res ? Number(res.tapIndex) : NaN;
          if (tapIndex === 0) {
            resolve({ chosen: true, reason: 'chosen', error: '' });
            return;
          }
          // 只有一项：负索引/undefined 或显式 cancel 都是用户取消；其他索引是原生异常。
          if ((res && res.cancel) || !Number.isFinite(tapIndex) || tapIndex < 0) {
            resolve({ chosen: false, reason: 'cancelled', error: '' });
            return;
          }
          resolve({ chosen: false, reason: 'failed', error: 'invalid-index' });
        },
        fail(error) {
          resolve({
            chosen: false,
            reason: isCancelNativeError(error) ? 'cancelled' : 'failed',
            error: nativeErrorCode(error)
          });
        }
      });
    } catch (error) {
      resolve({ chosen: false, reason: 'failed', error: nativeErrorCode(error) });
    }
  });
}

/**
 * 第二步：显示权威范围。显式区分「用户取消」与「原生失败」；调用方据此决定是否给
 * 可见反馈。返回 { confirmed, reason: 'confirmed'|'cancelled'|'unavailable'|'failed' }。
 */
function askDeleteConfirm(model) {
  return new Promise(resolve => {
    const api = typeof wx !== 'undefined' ? wx : null;
    if (!api || typeof api.showModal !== 'function') {
      resolve({ confirmed: false, reason: 'unavailable', error: '' });
      return;
    }
    try {
      api.showModal({
        title: model.title,
        content: model.content,
        confirmText: model.confirmText,
        cancelText: model.cancelText,
        success(res) {
          if (res && res.confirm) {
            resolve({ confirmed: true, reason: 'confirmed', error: '' });
            return;
          }
          if (res && res.cancel) {
            resolve({ confirmed: false, reason: 'cancelled', error: '' });
            return;
          }
          resolve({ confirmed: false, reason: 'failed', error: 'no-result' });
        },
        fail(error) {
          resolve({
            confirmed: false,
            reason: isCancelNativeError(error) ? 'cancelled' : 'failed',
            error: nativeErrorCode(error)
          });
        }
      });
    } catch (error) {
      resolve({ confirmed: false, reason: 'failed', error: nativeErrorCode(error) });
    }
  });
}

/**
 * 二次确认文案：日期、岩馆、场次与这次实际会移出的范围。线路数取本场关联数，
 * 有效/已撤回把数、完攀与视频关联数取 T052 同一份快照（视频数含已撤回把次）。
 */
function confirmModelOf(target, mediaCount) {
  const item = target || {};
  const date = textOf(item.date) || '未知日期';
  const gym = textOf(item.gymName) || '未填写岩馆';
  const label = textOf(item.label) || '这一场';
  const routeCount = countOf(item.routeCount);
  const effective = countOf(item.effectiveAttemptCount);
  const undone = countOf(item.undoneAttemptCount);
  const sendCount = countOf(item.sendCount);
  const videoCount =
    mediaCount === undefined || mediaCount === null
      ? countOf(item.videoCount)
      : countOf(mediaCount);

  const lines = ['日期：' + date, '岩馆：' + gym, '场次：' + label];
  if (routeCount === 0 && effective === 0 && undone === 0 && videoCount === 0) {
    lines.push('空场没有线路、把次或视频关联，只需确认删除这一场。');
  } else {
    lines.push(
      '删除范围：线路 ' +
        routeCount +
        ' 条 · 有效 ' +
        effective +
        ' 把' +
        (sendCount > 0 ? ' · 完攀 ' + sendCount + ' 把' : '')
    );
    if (undone > 0) {
      lines.push('已撤回 ' + undone + ' 把也在删除范围，其视频关联一并核对。');
    }
    if (videoCount > 0) {
      lines.push(
        '本场视频关联 ' +
          videoCount +
          ' 个（含已撤回把次）；删除后只清理没有剩余引用的攀笔视频副本。'
      );
    }
    lines.push('将一并移除本场把次和备注。');
  }

  return {
    title: '删除这一场训练？',
    content: lines.join('\n'),
    confirmText: '删除',
    cancelText: '取消'
  };
}

// ------------------------------------------------------------------ *
// 主流程
// ------------------------------------------------------------------ *

function sameTarget(context, inspected) {
  return Boolean(
    inspected &&
      hasText(inspected.archiveId) &&
      inspected.archiveId === context.archiveId &&
      hasText(inspected.sessionId) &&
      inspected.sessionId === context.sessionId
  );
}

/**
 * 读取确认目标。返回 { stop, result?, inspected? }：
 * - stop:true 表示不应打开/继续确认（原因已给可见反馈）；
 * - stop:false 时 inspected.canDelete 为 true，snapshot 只能用于这一轮确认。
 */
function readTarget(host, context) {
  let inspected;
  try {
    inspected = sessionDelete.inspectSessionDelete({
      archiveId: context.archiveId,
      sessionId: context.sessionId
    });
  } catch (error) {
    refresh(host);
    notify(
      host,
      '无法读取这一场的删除范围：' + errorText(error) + '；没有改动任何数据。',
      { error: true }
    );
    return { stop: true };
  }

  if (!inspected || !inspected.ok) {
    if (inspected && inspected.code === 'archive-mismatch') {
      refresh(host);
      notify(host, '这场训练属于原来的本机档案，已经换档，这次没有删除。', {
        error: true
      });
      return { stop: true };
    }
    refresh(host);
    setCleanupFor(host, context.archiveId);
    notify(
      host,
      (inspected && inspected.error) || '这一场的删除范围暂时读取失败，没有改动任何数据。',
      { error: true }
    );
    return { stop: true };
  }

  if (!sameTarget(context, inspected)) {
    // inspect 不按原请求返回同一身份：不猜、不把确认转给别的场次。
    notify(host, '这一场的归属已经变化，这次没有删除；已按最新档案刷新。', {
      error: true
    });
    refresh(host);
    return { stop: true };
  }

  if (!inspected.present) {
    refresh(host);
    setCleanupFor(host, context.archiveId);
    if (inspected.cleanupPending) {
      notify(
        host,
        '这一场已经不在本机档案里；它的视频副本还有待清理项，可在下方「重试清理」继续。',
        { error: true }
      );
    } else {
      notify(host, '这一场已经不在本机档案里，没有改动任何数据。', {});
    }
    return { stop: true };
  }

  if (!inspected.canDelete) {
    refresh(host);
    notify(
      host,
      inspected.error || '这一场还有未完成的操作，先处理后再删除；本次没有改动任何数据。',
      { error: true }
    );
    return { stop: true, result: result({ code: inspected.code || 'pending' }) };
  }

  return { stop: false, inspected };
}

function outcomeMessage(context, inspected, outcome) {
  const target = (outcome && outcome.target) || (inspected && inspected.target) || {};
  const date = textOf(target.date) || textOf(context.date) || '这一场';
  const gym = textOf(target.gymName) || textOf(context.gymName) || '';
  const label = textOf(target.label) || textOf(context.label) || '';
  const receipt = outcome && outcome.receiptLost ? '（回执丢失，已按最新档案确认）' : '';
  let message = '已删除 ' + date + (gym ? ' · ' + gym : '') + (label ? ' · ' + label : '') + receipt + '。';
  const video = (outcome && outcome.video) || {};
  if (video.status === 'pending') {
    message += '记录已移出，本机视频副本尚未清理，可在下方「重试清理」继续。';
  } else if (video.status === 'kept') {
    message += '其中共享的视频仍被其他记录使用，攀笔中的副本已按共享引用保留。';
  }
  return message;
}

function applyOutcome(host, context, inspected, outcome) {
  if (!contextMatches(host, context)) {
    // 旧确认的异步回执不再更新另一页/另一份档案的画面；只给可见说明，不重写列表。
    notify(
      host,
      '确认期间本机档案或页面已经切换，这次结果没有更新到当前画面；请按最新场次核对。',
      { error: true }
    );
    return result({
      ok: Boolean(outcome && outcome.ok && outcome.removed),
      code: 'context-changed',
      outcome
    });
  }

  // 后置状态（如场内页原小结入口指向被删场次）必须在重读前处理，重读才能直接给出
  // 接续场次/当前场的正确派生；可见提示最后写，避免页面刷新把刚写好的文字清掉。
  if (outcome && outcome.ok && outcome.removed) {
    if (typeof host.afterDelete === 'function') {
      try {
        host.afterDelete(context, outcome);
      } catch (error) {
        // 后置清理（如清掉旧的小结目标）失败不影响已经完成的删除。
      }
    }
  }
  refresh(host);
  setCleanupFor(host, context.archiveId);

  if (outcome && outcome.ok && outcome.removed) {
    const videoPending = Boolean(outcome.video && outcome.video.status === 'pending');
    notify(host, outcomeMessage(context, inspected, outcome), { error: false });
    return result({
      ok: true,
      code: videoPending ? 'removed-media-pending' : 'removed',
      outcome
    });
  }

  if (outcome && (outcome.unknown || outcome.journalPending)) {
    notify(
      host,
      (outcome.error || '这次删除的结果暂未确认。') +
        ' 重开本页或点「重试清理」会按最新档案重新核对。',
      { error: true }
    );
    return result({ ok: false, code: 'removed-unverified', outcome });
  }

  notify(
    host,
    (outcome && outcome.error) || '这次删除没有生效，已按最新档案刷新；没有改动任何数据。',
    { error: true }
  );
  return result({ ok: false, code: (outcome && outcome.code) || 'failed', outcome });
}

async function runFlow(host, context) {
  const menu = await askDeleteMenu();
  if (!menu.chosen) {
    if (menu.reason === 'unavailable') {
      notify(host, '操作菜单没有打开，这次没有删除；请再长按一次重试。', { error: true });
      return result({ code: 'menu-unavailable' });
    }
    if (menu.reason === 'failed') {
      notify(
        host,
        '操作菜单打开失败' + (menu.error ? '（' + menu.error + '）' : '') + '，这次没有删除；请再长按一次重试。',
        { error: true }
      );
      return result({ code: 'menu-failed', error: menu.error });
    }
    return result({ code: 'cancelled-menu', cancelled: true });
  }

  for (let attempt = 0; attempt < MAX_RECONFIRM; attempt += 1) {
    if (!contextMatches(host, context)) {
      notify(
        host,
        '本机档案或页面已经切换，这次删除没有继续；没有改动任何数据。',
        { error: true }
      );
      return result({ code: 'context-changed' });
    }
    const read = readTarget(host, context);
    if (read.stop) return read.result || result({ code: 'stopped' });

    const inspected = read.inspected;
    const model = confirmModelOf(inspected.target, inspected.mediaCount);
    const answer = await askDeleteConfirm(model);
    if (!answer.confirmed) {
      if (answer.reason === 'unavailable') {
        notify(host, '删除确认框没有打开，这次没有删除；请再长按一次重试。', {
          error: true
        });
        return result({ code: 'modal-unavailable' });
      }
      if (answer.reason === 'failed') {
        notify(
          host,
          '删除确认框没有正常返回' +
            (answer.error ? '（' + answer.error + '）' : '') +
            '，这次没有删除；请再长按一次重试。',
          { error: true }
        );
        return result({ code: 'modal-failed', error: answer.error });
      }
      return result({ code: 'cancelled-confirm', cancelled: true });
    }

    if (!contextMatches(host, context)) {
      notify(
        host,
        '确认期间本机档案或页面已经切换，这次删除没有提交；没有改动任何数据。',
        { error: true }
      );
      return result({ code: 'context-changed' });
    }

    let outcome;
    try {
      outcome = await sessionDelete.commitSessionDelete({
        archiveId: context.archiveId,
        sessionId: context.sessionId,
        snapshot: inspected.snapshot
      });
    } catch (error) {
      outcome = {
        ok: false,
        code: 'commit-failed',
        error: '整场删除没有完成：' + errorText(error),
        unknown: true
      };
    }

    if (outcome && outcome.code === 'stale') {
      // 只刷新原档案 + 原场次的范围；原目标仍在时用新快照再次确认，绝不改删接续场。
      if (!contextMatches(host, context)) {
        return result({ code: 'context-changed' });
      }
      continue;
    }
    return applyOutcome(host, context, inspected, outcome);
  }

  refresh(host);
  notify(
    host,
    '这一场的内容一直在变化，本次删除已停止；请按最新画面再长按一次重新确认。',
    { error: true }
  );
  return result({ code: 'stale' });
}

/**
 * 两页共用的长按入口。
 *
 * 输入 { archiveId, sessionId } 来自被长按的那个原生节点自己的 data（整卡或整个按钮），
 * 不从触点位置、显示序号或子节点推测。返回 Promise：
 * { ok, code, cancelled, outcome }。取消（菜单/确认）不写盘；原生失败给可见提示；
 * 成功已由页面 host.refresh 重读列表与小结。
 */
function requestSessionDelete(host, input) {
  const data = input || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  if (!archiveId || !sessionId) {
    notify(host, '无法删除：这一行缺少原档案或原场次身份，没有改动任何数据。', {
      error: true
    });
    return Promise.resolve(result({ code: 'incomplete-request' }));
  }

  // 每次调用页面都会新建一个 host 适配对象；确认流程的去重必须认「页面实例」，
  // 否则连续长按同一处会各自打开一个菜单。
  const owner = host && host.page ? host.page : host;
  const key = archiveId + '\u0000' + sessionId;
  const opened = activePrompts.get(owner);
  if (opened) {
    // 同一原场次的连续长按/连点只复用已经打开的那一次；不同目标不叠加第二个弹窗。
    return opened.key === key
      ? opened.promise
      : Promise.resolve(result({ code: 'busy', cancelled: true }));
  }

  const context = {
    archiveId,
    sessionId,
    date: textOf(data.date),
    gymName: textOf(data.gymName),
    label: textOf(data.label)
  };
  // 新的长按先清掉上一次的可见结果；取消本次操作不会留下旧失败文字。
  if (host && typeof host.notify === 'function') host.notify('', { error: false });
  const prompt = {};
  const promise = runFlow(host, context).then(
    answer => {
      if (activePrompts.get(owner) === prompt) activePrompts.delete(owner);
      settleLongPress(owner, sessionId);
      return answer;
    },
    error => {
      if (activePrompts.get(owner) === prompt) activePrompts.delete(owner);
      settleLongPress(owner, sessionId);
      notify(
        host,
        '这次删除没有完成：' + errorText(error) + '；记录与视频保持不变。',
        { error: true }
      );
      return result({ code: 'failed', error: errorText(error) });
    }
  );
  prompt.key = key;
  prompt.promise = promise;
  activePrompts.set(owner, prompt);
  return promise;
}

// ------------------------------------------------------------------ *
// 清理状态与重试（与冷启动同一个 T052 journal，按本档案范围）
// ------------------------------------------------------------------ *

/** 页面每次显示/刷新都可调用的只读状态：不扫目录、不写盘。 */
function refreshSessionCleanup(host) {
  const archiveId =
    host && typeof host.archiveId === 'function' ? textOf(host.archiveId()) : '';
  setCleanupFor(host, archiveId);
  return archiveId
    ? sessionDelete.pendingStatus(archiveId)
    : { pending: 0, error: '', retry: false, text: '' };
}

/**
 * 可见重试：只恢复 T052 自己 journal 里属于本档案的待清理条目，与 app.js 冷启动
 * 使用同一个入口。没有待办时不碰文件系统；失败保留证据并给出可见原因。
 */
function retrySessionCleanup(host) {
  const archiveId =
    host && typeof host.archiveId === 'function' ? textOf(host.archiveId()) : '';
  if (!archiveId) {
    notify(host, '无法重试清理：缺少当前本机档案身份，记录与视频保持不变。', {
      error: true
    });
    return Promise.resolve({ ok: false, code: 'missing-archive', processed: 0, pending: 0 });
  }
  setBusy(host, true);
  return sessionDelete
    .recoverPending({ archiveId })
    .then(recovery => {
      setCleanupFor(host, archiveId);
      refresh(host);
      if (recovery && recovery.ok && !recovery.pending) {
        notify(host, '本机场次的视频副本已清理完成。', { error: false });
      } else {
        const errors = (recovery && recovery.errors) || [];
        const detail = errors.length ? errors[errors.length - 1].error : '';
        notify(
          host,
          '场次视频副本还没有清理完' + (detail ? '：' + detail : '') + '；可稍后重试。',
          { error: true }
        );
      }
      return recovery;
    })
    .catch(error => {
      setCleanupFor(host, archiveId);
      refresh(host);
      notify(host, '重试清理没有完成：' + errorText(error) + '；证据与视频保持不变。', {
        error: true
      });
      return { ok: false, code: 'retry-failed', error: errorText(error) };
    })
    .then(answer => {
      setBusy(host, false);
      return answer;
    });
}

module.exports = {
  LONG_PRESS_TAP_GUARD_MS,
  MENU_DELETE_LABEL,
  markLongPress,
  consumeLongPressTap,
  requestSessionDelete,
  refreshSessionCleanup,
  retrySessionCleanup,
  // 离线测试直接核对确认文案；页面不另外拼一份。
  confirmModelOf
};
