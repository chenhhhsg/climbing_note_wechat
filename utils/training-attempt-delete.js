/**
 * 长按删除把次与视频 · 三阶段协调（T048–T050 追加返工）
 *
 * 一条已保存的有效把次被删除时，要同时处理三样东西：
 *   1) 本机训练档案里的把次记录（结果、备注、序号与 ID 一并移出）；
 *   2) 逐把视频索引里这一把的引用；
 *   3) 小程序本机视频副本文件（系统相册原片永远不动）。
 *
 * 档案层（utils/training-store.js）只负责第 1 步；视频服务
 * （utils/attempt-video-files.js）的 remove() 默认会核对「这一把仍在档案里且有效」，
 * 记录被移出后它必然拒绝。因此这里先写一份**持久删除凭据**（journal，正式本机命名空间
 * 内的受保护键），记录这次删除的四个原 ID、片段身份与精确版本；档案写成功后由这份
 * 凭据授权视频服务做定向回收。重开时（app.js 的 onLaunch 与单线页 onShow）只处理
 * journal 里尚未完成的条目：没有 journal 或没有 pending 条目时一次文件系统也不碰。
 *
 * 写入顺序与故障语义：
 *   - 先校验最新档案（档案/场次/线路/把次、rev、备注与结果）和视频索引里的当前片段
 *     （clipId + rev + fileId）；任何一项与确认时的画面不同都整条拒绝；
 *   - 写 journal（pending）→ 写档案（移出这一把）→ 清视频索引/文件；
 *   - 档案写前失败：回滚 journal 条目，记录与视频都不动；
 *   - 档案写成功但回执丢失：读回档案确认已移出后按成功继续清理；首次读回也失败时保留
 *     journal，返回「未确认」，重开时按档案重新核对（记录在就撤掉条目，记录不在就继续清）；
 *   - 视频索引写失败：保留副本，journal 留在 pending，页面可手动重试；
 *   - 文件删除失败：视频服务把所有权记录写回索引，journal 同样留在 pending；
 *   - 同一把重试/重复确认只产生一次删除结果（同一个完整操作按四 ID 去重；档案写与
 *     索引清理都幂等）。
 *
 * 并发：删除、自动恢复与手动重试共用同一条操作队列。journal 是整键读写，任何一段在
 * await 视频服务后拿旧快照回写都会覆盖另一把刚落盘的 pending/墓碑/门槛；排队后每一段
 * 都基于自己读到的完整实态写入。不同把次（哪怕是同一个 archive 下的两条线）不共享
 * Promise，只有四个原 ID 完全相同的重复请求才复用同一次操作。
 *
 * journal 的记录只保留定位与版本，不复制结果/备注正文等用户内容。删除完成后在 journal
 * 里留下最小墓碑（attemptId / 原 seq / 归属），用于：
 *   - 删除最新一把后不再把撤回入口补给上一把（详见 deletedSeqBarrier）；
 *   - 认出新一把没有被删把次的 ID 复用（新保存本来也由档案层生成新 ID）。
 */

const store = require('./training-store.js');
const attemptVideo = require('./attempt-video.js');
const videoFiles = require('./attempt-video-files.js');

// 正式本机命名空间里的受保护键：不在可重建前缀里，普通清缓存不会删除。
const DELETE_KEY = store.NAMESPACE + 'attempt-delete';
const DELETE_VERSION = 1;
// 墓碑只用于拦回撤销与识别重复确认；保留最近若干条即可，不影响任何旧数据读取。
const DELETED_KEEP = 200;
// 撤销门槛读取失败时的保守值：大于任何真实内部 seq，宁可不给撤销，也不凭坏读数错撤。
const BARRIER_BLOCKED = Number.MAX_SAFE_INTEGER;

const runtime = {
  storage: null,
  createService: null,
  now: null,
  services: new Map(),
  inFlight: new Map(),
  // 删除与恢复共用的单一操作队列：journal 是整键读写，异步清理期间不能让另一段
  // 删除/恢复拿着旧快照回写，把对方刚落盘的凭据、墓碑或门槛覆盖掉。
  queue: Promise.resolve()
};

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function fail(code, error) {
  return { ok: false, code, error };
}

function barrierKey(archiveId, sessionId, routeId) {
  return [archiveId || '', sessionId || '', routeId || ''].join('/');
}

function nowIso(options) {
  const source = (options && options.now) || runtime.now;
  if (typeof source === 'function') {
    const value = source();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === 'string' && value) return value;
  }
  return new Date().toISOString();
}

/** 默认存储：正式本机命名空间里的一个独立受保护键。 */
function wxStorage() {
  const api = typeof wx !== 'undefined' ? wx : null;
  return {
    get(key) {
      if (!api || typeof api.getStorageSync !== 'function') throw new Error('微信存储不可用');
      return api.getStorageSync(key);
    },
    set(key, value) {
      if (!api || typeof api.setStorageSync !== 'function') throw new Error('微信存储不可用');
      api.setStorageSync(key, value);
    },
    remove(key) {
      if (!api || typeof api.removeStorageSync !== 'function') throw new Error('微信存储不可用');
      api.removeStorageSync(key);
    }
  };
}

function storageOf(options) {
  return (options && options.storage) || runtime.storage || wxStorage();
}

function emptyJournal() {
  return { version: DELETE_VERSION, pending: [], deleted: [], barriers: {} };
}

function normalizeClip(value) {
  if (!value || typeof value !== 'object') return null;
  if (!hasText(value.clipId) || !hasText(value.fileId)) return null;
  const rev = Number(value.rev);
  if (!Number.isFinite(rev) || rev < 0) return null;
  return { clipId: value.clipId, rev: Math.floor(rev), fileId: value.fileId };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasText(raw.attemptId) || !hasText(raw.archiveId)) return null;
  if (!hasText(raw.sessionId) || !hasText(raw.routeId)) return null;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const state = raw.state === 'removed' ? 'removed' : 'prepared';
  // clip 缺省/null 都表示「确认时这一把没有视频」。
  if (raw.clip !== null && raw.clip !== undefined && !normalizeClip(raw.clip)) return null;
  return {
    attemptId: raw.attemptId,
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    routeId: raw.routeId,
    seq,
    clip: raw.clip === null || raw.clip === undefined ? null : normalizeClip(raw.clip),
    state,
    createdAt: hasText(raw.createdAt) ? raw.createdAt : '',
    updatedAt: hasText(raw.updatedAt) ? raw.updatedAt : '',
    lastError: hasText(raw.lastError) ? raw.lastError : ''
  };
}

function normalizeDeleted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasText(raw.attemptId) || !hasText(raw.archiveId)) return null;
  if (!hasText(raw.sessionId) || !hasText(raw.routeId)) return null;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return {
    attemptId: raw.attemptId,
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    routeId: raw.routeId,
    seq,
    at: hasText(raw.at) ? raw.at : ''
  };
}

/**
 * 读取 journal。键不存在是正常的「没有待处理删除」；版本不支持或 JSON 损坏时返回
 * ok:false，调用方据此不删任何文件（宁可保留副本，也不凭坏数据删东西）。
 */
function readJournal(options) {
  let raw;
  try {
    raw = storageOf(options).get(DELETE_KEY);
  } catch (error) {
    return {
      ok: false,
      code: 'journal-read-failed',
      error: '读取本机删除凭据失败：' + errorText(error) + '；未删除任何记录或视频'
    };
  }
  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, present: false, journal: emptyJournal() };
  }
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        code: 'journal-broken',
        error: '本机删除凭据格式损坏；为保护记录与视频，没有自动清理任何文件'
      };
    }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== DELETE_VERSION) {
    return {
      ok: false,
      code: 'journal-unsupported',
      error: '本机删除凭据版本不受支持；为保护记录与视频，没有自动清理任何文件'
    };
  }
  const journal = emptyJournal();
  for (const entry of Array.isArray(parsed.pending) ? parsed.pending : []) {
    const normalized = normalizeEntry(entry);
    if (normalized) journal.pending.push(normalized);
  }
  for (const item of Array.isArray(parsed.deleted) ? parsed.deleted : []) {
    const normalized = normalizeDeleted(item);
    if (normalized) journal.deleted.push(normalized);
  }
  const barriers = parsed.barriers && typeof parsed.barriers === 'object' ? parsed.barriers : {};
  Object.keys(barriers).forEach(key => {
    const value = Number(barriers[key]);
    if (Number.isInteger(value) && value > 0) journal.barriers[key] = value;
  });
  return { ok: true, present: true, journal };
}

function writeJournal(journal, options) {
  try {
    storageOf(options).set(DELETE_KEY, JSON.stringify(journal));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: '保存本机删除凭据失败：' + errorText(error) };
  }
}

function findEntry(journal, archiveId, attemptId) {
  return (
    journal.pending.find(
      entry => entry.archiveId === archiveId && entry.attemptId === attemptId
    ) || null
  );
}

function dropEntry(journal, entry) {
  const index = journal.pending.indexOf(entry);
  if (index !== -1) journal.pending.splice(index, 1);
}

function finalizeEntry(journal, entry) {
  dropEntry(journal, entry);
  const already = journal.deleted.some(
    item => item.archiveId === entry.archiveId && item.attemptId === entry.attemptId
  );
  if (!already) {
    journal.deleted.push({
      attemptId: entry.attemptId,
      archiveId: entry.archiveId,
      sessionId: entry.sessionId,
      routeId: entry.routeId,
      seq: entry.seq,
      at: nowIso()
    });
    while (journal.deleted.length > DELETED_KEEP) journal.deleted.shift();
  }
  const key = barrierKey(entry.archiveId, entry.sessionId, entry.routeId);
  const previous = journal.barriers[key] || 0;
  if (entry.seq > previous) journal.barriers[key] = entry.seq;
}

/**
 * 删除把次后「撤回入口」的持久门槛（只读）。
 *
 * 返回这条线被删除过的最大内部 seq（没有删除过时为 0）。页面把它传给最近一把视图：
 * 只有当最近一把的 seq 大于这个门槛时，才把「撤销」补给这一把。于是：
 * - 长按删除较早的一把（seq 5，最新仍是 7）：门槛 5，原最新一把 7 仍可撤销；
 * - 长按删除最新一把（seq 7，剩下的是 6）：门槛 7，前一把不新增撤销入口；
 * - 之后再成功记一把（新 seq 8）：门槛仍是 7，新一把重新可撤销；
 * - 冷开/换页后门槛来自 journal，不依赖页面内存。
 *
 * 门槛不只看已经收尾的墓碑：档案已确认移出、但本机视频副本还在 pending 的删除，
 * 同样要让前一把停止补位撤销，否则「文件待清理」的窗口里会错误出现撤销入口。
 * 这里按当前档案的实态核对：原把次 ID 仍在档案里（删除没有提交）的 pending 条目
 * 不计入门槛，未删的原把按实际状态保留。journal 或档案读不出来时返回保守的
 * BARRIER_BLOCKED（大于任何真实 seq），宁可暂时不给撤销，也不凭不明读数错撤。
 *
 * 只影响「有效把次的撤销」；已撤回那一把的「恢复」仍按原批准逻辑显示。
 */
function deletedSeqBarrier(archiveId, sessionId, routeId, options) {
  if (!hasText(archiveId) || !hasText(sessionId) || !hasText(routeId)) return 0;
  const read = readJournal(options);
  // 读不出来时不能把门槛当成 0：那会让补位前一把错误拿到撤销。
  if (!read.ok) return BARRIER_BLOCKED;
  const key = barrierKey(archiveId, sessionId, routeId);
  let barrier = read.journal.barriers[key] || 0;
  const pending = read.journal.pending.filter(
    entry =>
      entry.archiveId === archiveId &&
      entry.sessionId === sessionId &&
      entry.routeId === routeId
  );
  if (!pending.length) return barrier;

  // 只有能从当前档案确认原 ID 已经移出的条目才算「已提交的删除」。
  const loaded = store.loadState();
  if (!loaded.ok || !loaded.archive || loaded.archive.archiveId !== archiveId) {
    return BARRIER_BLOCKED;
  }
  const present = new Set((loaded.archive.attempts || []).map(item => item.id));
  pending.forEach(entry => {
    if (!present.has(entry.attemptId) && entry.seq > barrier) barrier = entry.seq;
  });
  return barrier;
}

/**
 * 页面可见的清理状态（只读，不碰文件系统）：
 * { pending, error, text, retry }。pending 是这份本机档案里还没有完成清理的条目数。
 */
function pendingStatus(archiveId, options) {
  const read = readJournal(options);
  if (!read.ok) {
    return { pending: 0, error: read.error, retry: true, text: read.error };
  }
  const entries = read.journal.pending.filter(
    entry => !hasText(archiveId) || entry.archiveId === archiveId
  );
  if (!entries.length) return { pending: 0, error: '', retry: false, text: '' };
  const prepared = entries.filter(entry => entry.state === 'prepared').length;
  const errors = entries
    .map(entry => entry.lastError)
    .filter(text => hasText(text));
  const error = errors.length ? errors[errors.length - 1] : '';
  const text = prepared
    ? '上一次删除未能确认：重开会核对记录是否已删除，再继续清理本机视频副本。'
    : '已删除的记录还有 ' + entries.length + ' 项本机视频副本待清理。';
  return { pending: entries.length, error, retry: true, text };
}

// ------------------------------------------------------------------ *
// 目标与媒体核对
// ------------------------------------------------------------------ *

function validateTarget(archive, data, attempt) {
  if (attempt.sessionId !== data.sessionId || attempt.routeId !== data.routeId) {
    return fail('scope-mismatch', '这一把不属于这一场这一条线，未做删除');
  }
  if (!store.isEffectiveAttempt(attempt)) {
    return fail('undone', '这一把已撤回，不在有效记录里，未做删除；如需移除请先恢复再操作');
  }
  if (
    Number.isInteger(data.expectedRev) &&
    data.expectedRev >= 0 &&
    data.expectedRev !== store.attemptRev(attempt)
  ) {
    return fail('stale', '这一把的状态已经变化，这次删除没有生效；请按最新画面重新长按确认');
  }
  if (
    typeof data.expectedNote === 'string' &&
    data.expectedNote !== (attempt.note || '')
  ) {
    return fail('stale', '这一把的备注已经变化，这次删除没有生效；请按最新内容重新确认');
  }
  if (hasText(data.expectedResult) && data.expectedResult !== attempt.result) {
    return fail('stale', '这一把的结果已经变化，这次删除没有生效；请按最新内容重新确认');
  }
  const pendingOnRoute = (archive.pendingSaves || []).some(
    item => item.sessionId === attempt.sessionId && item.routeId === attempt.routeId
  );
  const pendingOnAttempt = [
    ...(archive.pendingUndos || []),
    ...(archive.pendingRestores || []),
    ...(archive.pendingCorrections || [])
  ].some(item => item.attemptId === attempt.id);
  if (pendingOnRoute || pendingOnAttempt) {
    return fail(
      'pending',
      pendingOnAttempt
        ? '这一把还有未完成的操作，先重试或完成它，再删除这把'
        : '这条线还有一把没保存：先在「待保存」行重试保存，再删除'
    );
  }
  return { ok: true };
}

/**
 * 媒体身份/精确版本核对：确认时看到的片段必须仍是当前片段（clipId + rev + fileId）。
 * 索引读不出来时整条拒绝：宁可让人稍后重试，也不凭猜出来的「有没有视频」删记录。
 */
function mediaEvidence(archiveId, attempt, expected) {
  const view = attemptVideo.videoClipView(archiveId, attempt.id, {
    sessionId: attempt.sessionId,
    routeId: attempt.routeId
  });
  if (!view || !view.ok) {
    return fail('media-unreadable', '本机视频关联暂时读取失败，这次没有删除记录；请稍后重试');
  }
  const current = view.clip || null;
  if (!expected) {
    if (current) {
      return fail('media-changed', '这一把已经有视频，确认内容已过期；请重新长按确认');
    }
    return { ok: true, clip: null };
  }
  if (!current) {
    return fail('media-changed', '这一把的视频已经变化，这次删除没有生效；请重新长按确认');
  }
  const rev = Number(expected.rev);
  const currentRev = Number(current.rev);
  if (
    current.clipId !== expected.clipId ||
    current.fileId !== expected.fileId ||
    !Number.isFinite(rev) ||
    currentRev !== rev
  ) {
    return fail('media-changed', '这一把的视频已经换过版本，这次删除没有生效；请重新长按确认');
  }
  return { ok: true, clip: { clipId: current.clipId, rev: currentRev, fileId: current.fileId } };
}

// ------------------------------------------------------------------ *
// 视频服务与清理
// ------------------------------------------------------------------ *

function serviceFor(archiveId, options) {
  const factory = (options && options.createService) || runtime.createService;
  if (typeof factory === 'function') {
    try {
      return factory(archiveId) || null;
    } catch (error) {
      return null;
    }
  }
  let service = runtime.services.get(archiveId);
  if (!service) {
    try {
      // 直接建服务（不走 openAttemptVideoService 的自动 recover）：恢复只由本模块在
      // journal 有 pending 时触发，避免「每次打开都扫一遍视频目录」。
      service = videoFiles.createAttemptVideoStore({
        archiveId,
        files: videoFiles.createWxAttemptVideoFiles({ archiveId })
      });
    } catch (error) {
      service = null;
    }
    if (service) runtime.services.set(archiveId, service);
  }
  return service;
}

/**
 * 用持久凭据清理一条 journal 记录对应的视频副本。
 * 返回 { status: 'none' | 'done' | 'kept' | 'pending', error, reason }。
 * 索引写成功但文件删除失败（cleanupError）也算 pending：记录已删，但副本还在。
 * kept 表示索引已分离，但同一文件仍被其他记录合法引用，副本按设计保留。
 */
async function cleanupEntry(entry, options) {
  if (!entry.clip) return { status: 'none', error: '' };
  const service = serviceFor(entry.archiveId, options);
  if (!service || typeof service.removeDeletedClip !== 'function') {
    return { status: 'pending', error: '本机视频服务不可用，视频副本仍保留在攀笔中' };
  }
  let result;
  try {
    result = await service.removeDeletedClip({
      archiveId: entry.archiveId,
      sessionId: entry.sessionId,
      routeId: entry.routeId,
      attemptId: entry.attemptId,
      clipId: entry.clip.clipId,
      rev: entry.clip.rev,
      fileId: entry.clip.fileId
    });
  } catch (error) {
    return { status: 'pending', error: '视频副本清理失败：' + errorText(error) };
  }
  if (result && result.ok && result.kept && !result.cleanupError) {
    return { status: 'kept', error: '', reason: result.reason || 'shared' };
  }
  if (result && result.ok && !result.cleanupError) return { status: 'done', error: '' };
  if (result && result.ok) {
    return { status: 'pending', error: result.cleanupError || '视频副本文件未完全清理' };
  }
  return {
    status: 'pending',
    error: (result && result.error) || '视频副本清理失败，原视频与记录已分别处理'
  };
}

// ------------------------------------------------------------------ *
// 删除主流程
// ------------------------------------------------------------------ *

async function finishRemovedRecord(journal, entry, options) {
  // 档案里已经没有这一把：删除已提交（或上次已提交但回执丢失），继续清理视频副本。
  entry.state = 'removed';
  entry.updatedAt = nowIso(options);
  const video = await cleanupEntry(entry, options);
  if (video.status === 'done' || video.status === 'none' || video.status === 'kept') {
    finalizeEntry(journal, entry);
    const written = writeJournal(journal, options);
    return {
      ok: true,
      duplicate: false,
      recordDeleted: true,
      receiptLost: false,
      video: { status: video.status, reason: video.reason || '' },
      journalWriteFailed: !written.ok
    };
  }
  entry.lastError = video.error || '';
  writeJournal(journal, options);
  return {
    ok: true,
    duplicate: false,
    recordDeleted: true,
    receiptLost: false,
    video: { status: 'pending', error: video.error || '视频副本未清理' }
  };
}

async function runDelete(data, options) {
  const journalRead = readJournal(options);
  if (!journalRead.ok) {
    return fail('journal-read-failed', journalRead.error);
  }
  const journal = journalRead.journal;
  let entry = findEntry(journal, data.archiveId, data.attemptId);
  // 持久凭据必须与这次请求指向同一场同一条线；不认识的条目宁可拒绝，也不借它去清理别处。
  if (entry && (entry.sessionId !== data.sessionId || entry.routeId !== data.routeId)) {
    return fail('journal-mismatch', '删除凭据与这一把的场次或线路不一致，这次没有执行');
  }

  const loaded = store.loadState();
  if (!loaded.ok) {
    return fail('unreadable', loaded.error);
  }
  const archive = loaded.archive;
  if (archive.archiveId !== data.archiveId) {
    return fail('archive-mismatch', '本机档案已经更换，这次删除没有生效');
  }

  const attempt = archive.attempts.find(item => item.id === data.attemptId) || null;

  // 记录已经不在档案里：不写档案，只按持久凭据完成（或重复确认）视频清理。
  if (!attempt) {
    if (!entry) {
      const previouslyDeleted = journal.deleted.some(
        item =>
          item.archiveId === data.archiveId &&
          item.attemptId === data.attemptId &&
          item.sessionId === data.sessionId &&
          item.routeId === data.routeId
      );
      return {
        ok: true,
        duplicate: true,
        recordDeleted: true,
        previouslyDeleted,
        receiptLost: false,
        video: { status: 'none' },
        archive
      };
    }
    return finishRemovedRecord(journal, entry, options);
  }

  const target = validateTarget(archive, data, attempt);
  if (!target.ok) {
    // 这一把还在：确认已过期或不该删。清掉可能残留的 prepared 条目，避免重开后误清视频。
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return target;
  }

  const media = mediaEvidence(data.archiveId, attempt, data.clip);
  if (!media.ok) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return media;
  }

  if (!entry) {
    entry = {
      attemptId: data.attemptId,
      archiveId: data.archiveId,
      sessionId: attempt.sessionId,
      routeId: attempt.routeId,
      seq: attempt.seq,
      clip: media.clip,
      state: 'prepared',
      createdAt: nowIso(options),
      updatedAt: nowIso(options),
      lastError: ''
    };
    journal.pending.push(entry);
    const written = writeJournal(journal, options);
    if (!written.ok) {
      dropEntry(journal, entry);
      return fail('journal-write-failed', '删除凭据保存失败，未删除记录或视频；请重试');
    }
  } else {
    // 上一次没写成功（或回执未确认）但记录仍在：按这次重新核对过的证据继续。
    entry.sessionId = attempt.sessionId;
    entry.routeId = attempt.routeId;
    entry.seq = attempt.seq;
    entry.clip = media.clip;
    entry.state = 'prepared';
    entry.updatedAt = nowIso(options);
    entry.lastError = '';
    const written = writeJournal(journal, options);
    if (!written.ok) {
      return fail('journal-write-failed', '删除凭据保存失败，未删除记录或视频；请重试');
    }
  }

  const removal = store.deleteAttempt(data.attemptId, {
    archiveId: data.archiveId,
    sessionId: attempt.sessionId,
    routeId: attempt.routeId,
    expectedRev: data.expectedRev,
    expectedNote: data.expectedNote,
    expectedResult: data.expectedResult
  });

  if (!removal.ok) {
    if (removal.code === 'write-failed-unverified') {
      // 记录可能已经删掉：保留凭据与证据，重开时按档案重新核对；这次不报「已删除」。
      entry.lastError = removal.error;
      entry.updatedAt = nowIso(options);
      writeJournal(journal, options);
      return Object.assign(fail('archive-unverified', removal.error), {
        archive: removal.archive,
        recordDeleted: false,
        journalPending: true
      });
    }
    // 档案没写成（明确读回仍在这一把）：回滚凭据，记录与视频都不动。
    dropEntry(journal, entry);
    writeJournal(journal, options);
    return fail(
      removal.code === 'write-failed' ? 'archive-write-failed' : removal.code,
      removal.error
    );
  }

  entry.state = 'removed';
  entry.lastError = '';
  entry.updatedAt = nowIso(options);
  // 尽力落一次状态；写失败也不影响：重开时按「档案里没有这一把」继续。
  writeJournal(journal, options);

  const video = await cleanupEntry(entry, options);
  if (video.status === 'done' || video.status === 'none' || video.status === 'kept') {
    finalizeEntry(journal, entry);
    const written = writeJournal(journal, options);
    return {
      ok: true,
      duplicate: false,
      recordDeleted: true,
      receiptLost: Boolean(removal.receiptLost),
      video: { status: video.status, reason: video.reason || '' },
      journalWriteFailed: !written.ok
    };
  }

  entry.lastError = video.error || '';
  entry.updatedAt = nowIso(options);
  writeJournal(journal, options);
  return {
    ok: true,
    duplicate: false,
    recordDeleted: true,
    receiptLost: Boolean(removal.receiptLost),
    video: { status: 'pending', error: video.error || '视频副本未清理' }
  };
}

/**
 * 串行执行 journal 的读改写。删除、自动恢复与手动重试共用同一个队列：
 * journal 是整份读写，任何一段在 await 视频服务后拿旧快照回写，都会覆盖另一把
 * 刚落盘的 pending/墓碑/门槛。排队后每次写入都基于自己读到的完整实态。
 */
function enqueue(task) {
  const previous = runtime.queue || Promise.resolve();
  const run = previous.then(task, task);
  runtime.queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 删除一把已保存的有效把次（页面长按确认后调用）。
 *
 * 输入：
 *   { archiveId, sessionId, routeId, attemptId,
 *     expectedRev, expectedNote, expectedResult,
 *     clip: null | { clipId, rev, fileId } }
 * 返回（记录层）：
 *   ok:true  ⇒ recordDeleted:true，video.status 为 none / done / kept / pending；
 *   ok:false ⇒ code 为 stale / media-changed / pending / archive-write-failed /
 *              archive-unverified / journal-* 等，记录与视频按错误语义保持或分别处理。
 *
 * 同一份操作（四个原 ID 全部相同）的并发调用复用同一个 Promise，不会产生两次删除；
 * 四个 ID 有任何一项不同就是另一把/另一条线，必须各走各的操作，不能按 attemptId
 * 单键去重。
 */
function deleteAttempt(input, options) {
  const data = input || {};
  const opts = options || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  const routeId = hasText(data.routeId) ? data.routeId : '';
  const attemptId = hasText(data.attemptId) ? data.attemptId : '';
  if (!archiveId || !sessionId || !routeId || !attemptId) {
    return Promise.resolve(fail('incomplete-request', '删除请求缺少档案、场次、线路或把次，未做任何改动'));
  }
  const key = [archiveId, sessionId, routeId, attemptId].join('\u0000');
  const running = runtime.inFlight.get(key);
  if (running) return running;

  const task = enqueue(() =>
    runDelete(
      {
        archiveId,
        sessionId,
        routeId,
        attemptId,
        expectedRev: Number.isInteger(data.expectedRev) ? data.expectedRev : null,
        expectedNote: typeof data.expectedNote === 'string' ? data.expectedNote : null,
        expectedResult: hasText(data.expectedResult) ? data.expectedResult : '',
        clip: data.clip
          ? {
              clipId: data.clip.clipId,
              rev: Number(data.clip.rev),
              fileId: data.clip.fileId
            }
          : null
      },
      opts
    )
  ).then(
    result => {
      runtime.inFlight.delete(key);
      return result;
    },
    error => {
      runtime.inFlight.delete(key);
      return fail('delete-failed', '删除没有完成：' + errorText(error));
    }
  );
  runtime.inFlight.set(key, task);
  return task;
}

// ------------------------------------------------------------------ *
// 重开恢复
// ------------------------------------------------------------------ *

/**
 * 重开/手动重试：只处理 journal 里 pending 的条目。
 * - 没有 journal 或没有 pending：立即返回，不读目录、不创建视频服务；
 * - 记录仍在档案里：这是「档案写失败」留下的 prepared 条目，撤掉它，不动视频；
 * - 记录已不在：按持久证据继续清理索引与文件；
 * - 本机档案已经换成另一份：旧档案条目保留（不能凭旧凭据动新档案目录），可见待重试。
 */
async function runRecovery(options) {
  const opts = options || {};
  const read = readJournal(opts);
  if (!read.ok) {
    return { ok: false, code: read.code, error: read.error, processed: 0, pending: 0, errors: [] };
  }
  const journal = read.journal;
  if (!journal.pending.length) {
    return { ok: true, processed: 0, pending: 0, skipped: true, errors: [] };
  }

  const archiveIdFilter = hasText(opts.archiveId) ? opts.archiveId : '';
  const targets = journal.pending.filter(
    entry => !archiveIdFilter || entry.archiveId === archiveIdFilter
  );
  if (!targets.length) {
    return { ok: true, processed: 0, pending: 0, skipped: true, errors: [] };
  }

  const loaded = store.loadState();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'unreadable',
      error: loaded.error,
      processed: 0,
      pending: targets.length,
      errors: [{ error: loaded.error }]
    };
  }
  const archive = loaded.archive;
  const errors = [];
  let processed = 0;

  for (const entry of targets.slice()) {
    if (entry.archiveId !== archive.archiveId) {
      errors.push({
        attemptId: entry.attemptId,
        error: '本机档案已经更换，属于旧档案的视频副本没有清理'
      });
      continue;
    }
    const attempt = archive.attempts.find(item => item.id === entry.attemptId) || null;
    if (attempt) {
      // 记录还在：这次删除没有提交。撤掉 prepared 条目，视频与记录都不动。
      dropEntry(journal, entry);
      processed += 1;
      continue;
    }
    const video = await cleanupEntry(entry, opts);
    if (video.status === 'done' || video.status === 'none') {
      finalizeEntry(journal, entry);
      processed += 1;
    } else {
      entry.state = 'removed';
      entry.lastError = video.error || '';
      entry.updatedAt = nowIso(opts);
      errors.push({ attemptId: entry.attemptId, error: entry.lastError });
    }
  }

  const written = writeJournal(journal, opts);
  const pending = journal.pending.filter(
    entry => !archiveIdFilter || entry.archiveId === archiveIdFilter
  ).length;
  return {
    ok: errors.length === 0 && written.ok,
    processed,
    pending,
    errors,
    journalWriteFailed: !written.ok
  };
}

/**
 * 串行执行恢复，与删除共用同一个队列：app 启动、页面 onShow 与手动重试不会在
 * 另一把删除的异步清理窗口里拿旧 journal 回写。没有 pending 时不碰文件系统。
 */
function recoverPending(options) {
  const opts = options || {};
  return enqueue(() => runRecovery(opts)).then(
    result => result,
    error => ({
      ok: false,
      code: 'recovery-failed',
      error: '重开恢复没有完成：' + errorText(error),
      processed: 0,
      pending: 0,
      errors: [{ error: errorText(error) }]
    })
  );
}

/** 离线测试 / 换档后重置服务缓存与注入项；不删除任何凭据、文件或索引。 */
function resetRuntime() {
  runtime.storage = null;
  runtime.createService = null;
  runtime.now = null;
  runtime.services.clear();
  runtime.inFlight.clear();
  runtime.queue = Promise.resolve();
}

/** 离线测试注入存储、服务工厂与时钟（生产不调用）。 */
function configure(options) {
  const config = options || {};
  if (Object.prototype.hasOwnProperty.call(config, 'storage')) runtime.storage = config.storage;
  if (Object.prototype.hasOwnProperty.call(config, 'createService')) {
    runtime.createService = config.createService;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'now')) runtime.now = config.now;
}

/** 这一把是否已经被删除（journal 墓碑；只读，不碰视频）。 */
function isDeletedAttemptId(archiveId, attemptId, options) {
  if (!hasText(archiveId) || !hasText(attemptId)) return false;
  const read = readJournal(options);
  if (!read.ok) return false;
  return read.journal.deleted.some(
    item => item.archiveId === archiveId && item.attemptId === attemptId
  );
}

module.exports = {
  DELETE_KEY,
  DELETE_VERSION,
  DELETED_KEEP,
  BARRIER_BLOCKED,
  deletedSeqBarrier,
  pendingStatus,
  deleteAttempt,
  recoverPending,
  isDeletedAttemptId,
  configure,
  resetRuntime
};
