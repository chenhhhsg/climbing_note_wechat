/**
 * 整场删除协调器（T052）
 *
 * T051 的 `training-store` 只负责「一次档案写入移出原场次、本场关联与全部把次
 * （含已撤回）」，并给出原场次是否确认删除。本模块接在它前面与后面：
 *
 *   1) 确认前：按原档案 ID + 原场次 ID 读取 T051 快照，并读一次逐把视频索引，
 *      把确认框要显示的数量（线路、有效/已撤回把次、完攀、视频关联）和每一把
 *      视频的完整身份（attemptId + routeId + clipId + rev + fileId）一起冻结成
 *      确认快照。视频换片但数量不变也会改变快照，旧确认必须重新读取；
 *   2) 动档案前：先把这次删除的**完整目标把次/视频身份**写进本模块自己的持久
 *      journal（`climbingNote.training.v1.session-delete`），再调用 T051 的
 *      commitSessionDeletion；
 *   3) 档案确认删除后：只按 journal 里逐条记录的原片段身份调用已有的
 *      `removeDeletedClip`（四个原 ID + clipId/rev/fileId）。共享副本按 kept 完成，
 *      不删任何仍有引用的文件，也不扫描目录；
 *   4) 重开/重试：只处理 journal 里尚未完成的条目。原场次仍在同一份档案里时，
 *      说明档案删除没有提交，直接撤掉待办，绝不在重开时悄悄开始上一次没完成的
 *      删除；只有同一份档案能证明原场次、本场关联、全部原把次都已不在时，才继续
 *      清理视频。档案或 journal 读不出来时一律保留证据、失败关闭。
 *
 * 与单把删除的协调：
 * - 本模块的 journal 在档案写入前就把目标把次 ID 记成占用；`training-store` 保存
 *   前会同时核对单把 journal（T048–T050）与本模块的场次护栏，因此旧 opId 即使被
 *   塞进另一场在途保存也不能复活，新生成的 ID 与其他场次照常可写；
 * - 单把删除（`training-attempt-delete`）遇到本模块正在删除/已删除的场次时拒绝，
 *   不会与整场清理争同一份视频；本模块在动档案前也会拒绝命中单把 journal 的目标，
 *   两边都只把证据写进自己的命名空间，不共享队列、不互相 await，避免死锁。
 * - 同一场还有真正执行中的视频 commit/replace/remove（例如复制/删除仍在等文件 I/O）
 *   时，确认快照与最终同步提交边界都要求先完成那次视频操作。判定只用视频层按
 *   「原档案 + 原场次」登记的内存计数，同场拦截、别的场次照常，不扫描目录；等在途
 *   操作完成后，提交边界仍会重读视频索引，按最新证据再次核对。
 *
 * 媒体状态与完成口径：
 * - prepared：删除意图已落盘，档案尚未确认删除；
 * - removed：档案已确认删除，视频副本仍可能待清理；
 * - done / none / kept：单条引用已结清（kept = 同一文件仍被其他记录引用，副本保留）；
 * - 只有全部目标引用都结清后，才把整条删除收尾成持久护栏（fences），此后原把次
 *   ID 不再可写。待清理条目保留在 pending 里，页面可重复确认或重开重试。
 */
const store = require('./training-store.js');
const attemptVideo = require('./attempt-video.js');
const videoFiles = require('./attempt-video-files.js');

// 正式本机命名空间里的独立受保护键：与单把删除的 attempt-delete 分开，互不覆盖。
const SESSION_DELETE_KEY = store.NAMESPACE + 'session-delete';
const SESSION_DELETE_VERSION = 1;

const INCOMPLETE_REQUEST = '删除场次需要原档案 ID、原场次 ID 和确认快照，未做任何改动';
const JOURNAL_INCOMPLETE =
  '本机场次删除凭据不完整（容器或记录身份缺失）；无法确认这次删除的状态';
const STALE_SNAPSHOT = '这场训练或本场视频已经变化，这次删除没有生效；请按最新范围重新确认';
const PENDING_DELETE =
  '本场还有未完成的操作，先处理后再删除；本次没有改动档案、视频索引或副本';
const DELETE_ALREADY_PENDING =
  '这一场已经有一把在删除或待清理中；先完成那一把的清理，再删除整场';
const VIDEO_WRITE_PENDING =
  '这一场还有视频正在保存或移除，先等这次操作完成；本次没有改动档案、视频索引或副本';

const runtime = {
  storage: null,
  createService: null,
  readVideoIndex: null,
  now: null,
  services: new Map(),
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    }
  };
}

function storageOf(options) {
  return (options && options.storage) || runtime.storage || wxStorage();
}

function readIndex(options) {
  const source = (options && options.readVideoIndex) || runtime.readVideoIndex;
  if (typeof source === 'function') return source();
  return attemptVideo.readVideoIndex();
}

/**
 * 这一场是否还有本进程内真正执行中的视频 commit/replace/remove。
 * 只问同一档案 + 同一场次；别的场次与别的档案不受影响。查询本身不读文件系统、
 * 不读写索引。无法查询时按「有在途操作」失败关闭，避免在未知状态下先删档案。
 */
function videoMutationActive(archiveId, sessionId) {
  if (!hasText(archiveId) || !hasText(sessionId)) return false;
  if (typeof videoFiles.hasActiveSessionVideoMutation !== 'function') return true;
  try {
    return videoFiles.hasActiveSessionVideoMutation(archiveId, sessionId) === true;
  } catch (error) {
    return true;
  }
}

// ------------------------------------------------------------------ *
// 稳定快照 / 令牌
// ------------------------------------------------------------------ *

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    Object.keys(value)
      .sort()
      .forEach(key => {
        sorted[key] = stableValue(value[key]);
      });
    return sorted;
  }
  return value;
}

/** 与 T051 同口径的非密码学混合：同步回答「确认框打开时的视频身份是否一字不差」。 */
function snapshotHash(text) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  const hex = value => ('00000000' + (value >>> 0).toString(16)).slice(-8);
  return hex(first) + hex(second);
}

function revOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

// ------------------------------------------------------------------ *
// journal 形状与严格读写
// ------------------------------------------------------------------ *

function emptyJournal() {
  return { version: SESSION_DELETE_VERSION, pending: [], fences: [] };
}

function normalizeClip(raw) {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (!hasText(raw.clipId) || !hasText(raw.fileId)) return undefined;
  const rev = Number(raw.rev);
  if (!Number.isFinite(rev) || rev < 0) return undefined;
  return { clipId: raw.clipId, rev: Math.floor(rev), fileId: raw.fileId };
}

function normalizeAttempt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasText(raw.attemptId) || !hasText(raw.routeId)) return null;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const clip = normalizeClip(raw.clip);
  if (clip === undefined) return null;
  return { attemptId: raw.attemptId, routeId: raw.routeId, seq, clip };
}

function normalizeAttempts(raw) {
  if (!Array.isArray(raw)) return null;
  const rows = [];
  const seen = new Set();
  for (const item of raw) {
    const row = normalizeAttempt(item);
    if (!row || seen.has(row.attemptId)) return null;
    seen.add(row.attemptId);
    rows.push(row);
  }
  return rows;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasText(raw.archiveId) || !hasText(raw.sessionId)) return null;
  if (raw.state !== 'prepared' && raw.state !== 'removed') return null;
  if (!hasText(raw.storeToken) || !hasText(raw.mediaToken)) return null;
  const attempts = normalizeAttempts(raw.attempts);
  if (!attempts) return null;
  return {
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    date: hasText(raw.date) ? raw.date : '',
    gymId: hasText(raw.gymId) ? raw.gymId : '',
    seq: Number.isInteger(Number(raw.seq)) ? Number(raw.seq) : 0,
    storeToken: raw.storeToken,
    mediaToken: raw.mediaToken,
    attempts,
    state: raw.state,
    createdAt: hasText(raw.createdAt) ? raw.createdAt : '',
    updatedAt: hasText(raw.updatedAt) ? raw.updatedAt : '',
    lastError: hasText(raw.lastError) ? raw.lastError : ''
  };
}

function normalizeFence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasText(raw.archiveId) || !hasText(raw.sessionId)) return null;
  const attempts = normalizeAttempts(raw.attempts);
  if (!attempts) return null;
  return {
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    attempts,
    at: hasText(raw.at) ? raw.at : ''
  };
}

function incompleteJournal() {
  return {
    ok: false,
    code: 'journal-incomplete',
    error: JOURNAL_INCOMPLETE
  };
}

/**
 * 严格读取：缺键 = 没有场次删除凭据（旧数据兼容）；JSON 损坏、版本不支持、
 * 容器/条目身份不完整都返回 ok:false，调用方不得写回或做任何破坏性操作。
 * 宽松读取会静默丢掉坏条目，等于把「这一场正在删除」的证据抹掉。
 */
function readJournal(options) {
  let raw;
  try {
    raw = storageOf(options).get(SESSION_DELETE_KEY);
  } catch (error) {
    return {
      ok: false,
      code: 'journal-read-failed',
      error: '读取本机场次删除凭据失败：' + errorText(error) + '；未删除任何记录或视频'
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
        error: '本机场次删除凭据格式损坏；为保护记录与视频，没有清理任何文件'
      };
    }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== SESSION_DELETE_VERSION
  ) {
    return {
      ok: false,
      code: 'journal-unsupported',
      error: '本机场次删除凭据版本不受支持；为保护记录与视频，没有清理任何文件'
    };
  }
  if (!Array.isArray(parsed.pending) || !Array.isArray(parsed.fences)) {
    return incompleteJournal();
  }
  const journal = emptyJournal();
  for (const item of parsed.pending) {
    const entry = normalizeEntry(item);
    if (!entry) return incompleteJournal();
    journal.pending.push(entry);
  }
  for (const item of parsed.fences) {
    const fence = normalizeFence(item);
    if (!fence) return incompleteJournal();
    journal.fences.push(fence);
  }
  return { ok: true, present: true, journal };
}

function writeJournal(journal, options) {
  try {
    storageOf(options).set(SESSION_DELETE_KEY, JSON.stringify(journal));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: '保存本机场次删除凭据失败：' + errorText(error) };
  }
}

function findEntry(journal, archiveId, sessionId) {
  return (
    journal.pending.find(
      entry => entry.archiveId === archiveId && entry.sessionId === sessionId
    ) || null
  );
}

function dropEntry(journal, entry) {
  const index = journal.pending.indexOf(entry);
  if (index !== -1) journal.pending.splice(index, 1);
}

function finalizeEntry(journal, entry, options) {
  dropEntry(journal, entry);
  const exists = journal.fences.some(
    fence => fence.archiveId === entry.archiveId && fence.sessionId === entry.sessionId
  );
  if (!exists) {
    journal.fences.push({
      archiveId: entry.archiveId,
      sessionId: entry.sessionId,
      attempts: entry.attempts.map(row => ({
        attemptId: row.attemptId,
        routeId: row.routeId,
        seq: row.seq,
        clip: null
      })),
      at: nowIso(options)
    });
  }
}

// ------------------------------------------------------------------ *
// 场次护栏（供档案层与单把删除共享）
// ------------------------------------------------------------------ *

/**
 * 按本机档案读取场次删除护栏：
 * 返回 { ok, code, error, sessionState(id), attemptState(id) }。
 * - pending 条目按 state 给出 prepared / removed；其目标把次一律按 pending；
 * - 已收尾的 fences 把目标把次记成 deleted（永久，防旧 opId 复活）；
 * - 读取失败返回 ok:false，调用方必须失败关闭，不能当作「没有删除」。
 */
function sessionFenceState(archiveId, options) {
  if (!hasText(archiveId)) {
    return {
      ok: false,
      code: 'missing-archive',
      error: '缺少本机档案身份，无法核对场次删除凭据',
      sessionState() {
        return '';
      },
      attemptState() {
        return '';
      }
    };
  }
  const read = readJournal(options);
  if (!read.ok) {
    return {
      ok: false,
      code: read.code,
      error: read.error,
      sessionState() {
        return '';
      },
      attemptState() {
        return '';
      }
    };
  }
  const journal = read.journal;
  const pending = journal.pending.filter(entry => entry.archiveId === archiveId);
  const fences = journal.fences.filter(entry => entry.archiveId === archiveId);
  const sessions = new Map();
  const attempts = new Map();
  pending.forEach(entry => {
    sessions.set(entry.sessionId, entry.state === 'prepared' ? 'prepared' : 'removed');
    entry.attempts.forEach(row => attempts.set(row.attemptId, 'pending'));
  });
  fences.forEach(entry => {
    entry.attempts.forEach(row => {
      if (!attempts.has(row.attemptId)) attempts.set(row.attemptId, 'deleted');
    });
  });
  return {
    ok: true,
    present: read.present,
    journal,
    sessionState(sessionId) {
      return (hasText(sessionId) && sessions.get(sessionId)) || '';
    },
    attemptState(attemptId) {
      return (hasText(attemptId) && attempts.get(attemptId)) || '';
    }
  };
}

/**
 * 页面可见的场次清理状态（只读，不碰文件系统）。
 * prepared = 上次删除未确认；removed = 档案已删、视频副本待清理。
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
  const errors = entries.map(entry => entry.lastError).filter(hasText);
  const error = errors.length ? errors[errors.length - 1] : '';
  const text = prepared
    ? '上一次整场删除还没有确认：重开会先核对原场次是否已删除，再继续清理本机视频副本。'
    : '已删除的场次还有 ' + entries.length + ' 项的本地视频副本待清理。';
  return { pending: entries.length, error, retry: true, text };
}

// ------------------------------------------------------------------ *
// 确认证据
// ------------------------------------------------------------------ *

function attemptRowsOf(archive, sessionId) {
  return (archive.attempts || [])
    .filter(item => item.sessionId === sessionId)
    .slice()
    .sort((left, right) => (left.seq || 0) - (right.seq || 0) || (left.id < right.id ? -1 : 1));
}

function clipMatches(clip, archiveId, row) {
  return Boolean(
    clip &&
      clip.archiveId === archiveId &&
      clip.attemptId === row.id &&
      clip.sessionId === row.sessionId &&
      clip.routeId === row.routeId &&
      hasText(clip.clipId) &&
      hasText(clip.fileId) &&
      attemptVideo.isClipFileIdFor(archiveId, clip.clipId, clip.fileId)
  );
}

/**
 * 本场视频证据：每把（含已撤回）一条，取与 `attempt-video` 当前片段同口径的
 * 最大版本条目；只有四个原 ID 与文件命名空间都符合才算已关联。无法读索引时
 * 返回 ok:false，确认与删除都失败关闭。
 */
function mediaEvidence(archive, sessionId, archiveId, options) {
  const read = readIndex(options);
  if (!read || !read.ok) {
    return fail(
      'media-unreadable',
      '本机视频索引暂时读取失败，这次没有删除场次；请稍后重试'
    );
  }
  const clips = Array.isArray(read.clips) ? read.clips : [];
  const rows = attemptRowsOf(archive, sessionId).map(row => {
    let chosen = null;
    clips.forEach(clip => {
      if (!clipMatches(clip, archiveId, row)) return;
      if (!chosen || revOf(clip.rev) >= revOf(chosen.rev)) chosen = clip;
    });
    return {
      attemptId: row.id,
      routeId: row.routeId,
      seq: row.seq,
      clip: chosen
        ? { clipId: chosen.clipId, rev: revOf(chosen.rev), fileId: chosen.fileId }
        : null
    };
  });
  const token = snapshotHash(JSON.stringify(stableValue(rows)));
  return {
    ok: true,
    token,
    count: rows.filter(row => row.clip).length,
    rows
  };
}

function attemptDeleteGuard(archiveId) {
  let deletion;
  try {
    deletion = require('./training-attempt-delete.js');
  } catch (error) {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机单把删除凭据失败：' + errorText(error) + '；本次没有改动任何数据'
    };
  }
  if (!deletion || typeof deletion.attemptDeletionGuard !== 'function') {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机单把删除凭据失败：删除凭据模块不可用；本次没有改动任何数据'
    };
  }
  return deletion.attemptDeletionGuard(archiveId);
}

function blockedAttemptIds(snapshot, archiveId) {
  const guard = attemptDeleteGuard(archiveId);
  if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };
  const ids = (snapshot && snapshot.attemptIds ? snapshot.attemptIds : []).filter(id =>
    guard.has(id)
  );
  return { ok: true, ids };
}

function mediaSnapshot(inspected, media) {
  return Object.assign({}, inspected.snapshot, {
    mediaToken: media.token,
    mediaCount: media.count,
    clips: media.rows.map(row => Object.assign({}, row.clip ? row.clip : { clipId: '', rev: 0, fileId: '' }, {
      attemptId: row.attemptId,
      routeId: row.routeId
    }))
  });
}

/**
 * 读取整场删除的确认范围（只读，不写档案、不写 journal、不碰文件）。
 *
 * 输入：{ archiveId, sessionId }。
 * 返回 { ok, code, error, present, canDelete, target, snapshot, pending,
 *        media, mediaCount, deletionPending, cleanupPending }。
 *
 * - ready：可以打开二次确认；snapshot 同时冻结 T051 档案快照与逐把视频身份；
 * - pending：原场次还有待保存/更正/撤回/恢复，或目标把次正在单把删除；
 * - missing：原场次已不在档案（cleanlyAbsent 可把重复确认按已删除收尾）；
 * - media-unreadable / delete-unreadable：无法确认视频归属，失败关闭，canDelete:false。
 */
function inspectSessionDelete(input, options) {
  const data = input || {};
  const opts = options || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  const base = {
    ok: false,
    code: '',
    error: '',
    archiveId,
    sessionId,
    present: false,
    canDelete: false,
    target: null,
    snapshot: null,
    pending: null,
    media: null,
    mediaCount: 0,
    deletionPending: 0,
    videoWritePending: false,
    cleanupPending: false
  };
  if (!archiveId || !sessionId) {
    return Object.assign(base, { code: 'incomplete-request', error: INCOMPLETE_REQUEST });
  }

  const inspected = store.inspectSessionDeletion({ archiveId, sessionId });
  const result = Object.assign(base, inspected, { archiveId, sessionId });
  if (!inspected.ok) return result;

  if (!inspected.present) {
    // 已删除但还有待清理条目时，只读报告，不在这里动文件。凭据读不出来时
    // 不把「档案里没有」误当成「清理已完成」，交给页面显示可重试错误。
    const fence = sessionFenceState(archiveId);
    if (!fence.ok) {
      return Object.assign(result, {
        ok: false,
        code: fence.code,
        error: fence.error,
        canDelete: false
      });
    }
    const entry = findEntry(fence.journal, archiveId, sessionId);
    result.cleanupPending = Boolean(entry);
    return result;
  }

  const blocked = blockedAttemptIds(inspected.snapshot, archiveId);
  if (!blocked.ok) {
    return Object.assign(result, {
      ok: false,
      code: blocked.code,
      error: blocked.error,
      canDelete: false
    });
  }

  let media = mediaEvidence(inspected.archive, sessionId, archiveId, opts);
  if (!media.ok && inspected.canDelete) {
    return Object.assign(result, {
      ok: false,
      code: media.code,
      error: media.error,
      canDelete: false
    });
  }
  if (!media.ok) {
    media = { ok: false, token: '', count: 0, rows: [] };
  }

  // 本进程里这一场是否还有真正的视频 commit/replace/remove 在等文件 I/O。
  // 只查内存登记，不扫描目录；别的场次不会因此被挡住。
  const videoWritePending = videoMutationActive(archiveId, sessionId);
  const deletionPending = blocked.ids.length;
  const canDelete =
    inspected.canDelete && deletionPending === 0 && !videoWritePending;
  const code = canDelete ? 'ready' : 'pending';
  const error = videoWritePending
    ? VIDEO_WRITE_PENDING
    : deletionPending
      ? DELETE_ALREADY_PENDING
      : inspected.error || (media.ok ? '' : media.error);
  return Object.assign(result, {
    ok: true,
    code,
    error,
    canDelete,
    target: Object.assign({}, inspected.target, { videoCount: media.count }),
    snapshot: canDelete ? mediaSnapshot(inspected, media) : null,
    pending: deletionPending
      ? Object.assign({}, inspected.pending, {
          deletion: deletionPending,
          total: (inspected.pending.total || 0) + deletionPending,
          text: DELETE_ALREADY_PENDING
        })
      : inspected.pending,
    media,
    mediaCount: media.count,
    deletionPending,
    videoWritePending
  });
}

// ------------------------------------------------------------------ *
// 视频服务与定向清理
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
      // 直接建服务，不走 openAttemptVideoService 的自动 recover：本模块只处理
      // journal 里点名的文件，没有待办时一次文件系统也不碰。
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

function settledVideo(video) {
  return video.status === 'done' || video.status === 'none' || video.status === 'kept';
}

async function cleanupRow(entry, row, options) {
  if (!row.clip) return { status: 'none', error: '' };
  const service = serviceFor(entry.archiveId, options);
  if (!service || typeof service.removeDeletedClip !== 'function') {
    return { status: 'pending', error: '本机视频服务不可用，视频副本仍保留在攀笔中' };
  }
  let result;
  try {
    result = await service.removeDeletedClip({
      archiveId: entry.archiveId,
      sessionId: entry.sessionId,
      routeId: row.routeId,
      attemptId: row.attemptId,
      clipId: row.clip.clipId,
      rev: row.clip.rev,
      fileId: row.clip.fileId
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
    error: (result && result.error) || '视频副本清理失败，记录与视频已分别处理'
  };
}

async function cleanupEntry(entry, options) {
  const summary = {
    status: 'none',
    total: entry.attempts.length,
    done: 0,
    kept: 0,
    none: 0,
    pending: 0,
    errors: []
  };
  for (const row of entry.attempts.slice()) {
    const video = await cleanupRow(entry, row, options);
    if (video.status === 'done') summary.done += 1;
    else if (video.status === 'kept') summary.kept += 1;
    else if (video.status === 'none') summary.none += 1;
    else {
      summary.pending += 1;
      summary.errors.push({ attemptId: row.attemptId, error: video.error || '' });
    }
  }
  if (summary.pending) {
    summary.status = 'pending';
  } else if (summary.kept) {
    summary.status = 'kept';
  } else if (summary.done) {
    summary.status = 'done';
  } else {
    summary.status = 'none';
  }
  return summary;
}

// ------------------------------------------------------------------ *
// 提交与收尾
// ------------------------------------------------------------------ *

function sessionDeleteResult(fields) {
  return Object.assign(
    {
      ok: false,
      code: '',
      error: '',
      archive: null,
      archiveId: '',
      sessionId: '',
      written: false,
      removed: null,
      receiptLost: false,
      unknown: false,
      duplicate: false,
      removedAttemptIds: [],
      removedRouteIds: [],
      activeSessionId: '',
      activeRouteId: '',
      successor: null,
      target: null,
      snapshot: null,
      pending: null,
      mediaCount: 0,
      videoWritePending: false,
      video: { status: 'none', total: 0, done: 0, kept: 0, none: 0, pending: 0, errors: [] },
      journalPending: false,
      retryable: false,
      journalWriteFailed: false
    },
    fields || {}
  );
}

function decorateReconfirm(result, archiveId, sessionId, options) {
  const inspected = inspectSessionDelete({ archiveId, sessionId }, options);
  if (inspected.ok && inspected.present) {
    result.snapshot = inspected.snapshot;
    result.target = inspected.target;
    result.pending = inspected.pending;
    result.mediaCount = inspected.mediaCount;
  }
  return result;
}

/**
 * 档案删除已确认（本次写入、回执丢失或读取确认早已移出）后，按 journal 的完整
 * 身份逐条清理目标视频引用。单条失败只留在 pending，不伪造成功。
 */
async function finishRemoved(journal, entry, options, removal) {
  entry.state = 'removed';
  entry.lastError = '';
  entry.updatedAt = nowIso(options);
  // 尽力先把「档案已删」落盘；写失败也不影响重开按档案核对。
  writeJournal(journal, options);

  const video = await cleanupEntry(entry, options);
  const removedAttemptIds =
    removal.removedAttemptIds && removal.removedAttemptIds.length
      ? removal.removedAttemptIds
      : entry.attempts.map(row => row.attemptId);
  if (settledVideo(video)) {
    finalizeEntry(journal, entry, options);
    const written = writeJournal(journal, options);
    return sessionDeleteResult({
      ok: true,
      code: removal.code === 'already-removed' ? 'already-removed' : 'removed',
      archive: removal.archive,
      archiveId: entry.archiveId,
      sessionId: entry.sessionId,
      written: Boolean(removal.written),
      removed: true,
      receiptLost: Boolean(removal.receiptLost),
      duplicate: removal.code === 'already-removed',
      removedAttemptIds,
      removedRouteIds: removal.removedRouteIds || [],
      activeSessionId: removal.activeSessionId || '',
      activeRouteId: removal.activeRouteId || '',
      successor: removal.successor || null,
      target: removal.target || null,
      snapshot: removal.snapshot || null,
      pending: removal.pending || null,
      video,
      mediaCount: entry.attempts.filter(row => row.clip).length,
      journalPending: false,
      journalWriteFailed: !written.ok
    });
  }

  entry.lastError = video.errors.length
    ? video.errors[video.errors.length - 1].error
    : '视频副本尚未清理完成';
  entry.updatedAt = nowIso(options);
  const written = writeJournal(journal, options);
  return sessionDeleteResult({
    ok: true,
    code: 'removed-media-pending',
    error: entry.lastError,
    archive: removal.archive,
    archiveId: entry.archiveId,
    sessionId: entry.sessionId,
    written: Boolean(removal.written),
    removed: true,
    receiptLost: Boolean(removal.receiptLost),
    duplicate: removal.code === 'already-removed',
    removedAttemptIds,
    removedRouteIds: removal.removedRouteIds || [],
    activeSessionId: removal.activeSessionId || '',
    activeRouteId: removal.activeRouteId || '',
    successor: removal.successor || null,
    target: removal.target || null,
    snapshot: removal.snapshot || null,
    pending: removal.pending || null,
    video,
    mediaCount: entry.attempts.filter(row => row.clip).length,
    journalPending: true,
    retryable: true,
    journalWriteFailed: !written.ok
  });
}

function entryFrom(inspected, media, options) {
  return {
    archiveId: inspected.snapshot.archiveId,
    sessionId: inspected.snapshot.sessionId,
    date: inspected.snapshot.date || '',
    gymId: inspected.snapshot.gymId || '',
    seq: inspected.snapshot.seq || 0,
    storeToken: inspected.snapshot.token,
    mediaToken: media.token,
    attempts: media.rows.map(row => ({
      attemptId: row.attemptId,
      routeId: row.routeId,
      seq: row.seq,
      clip: row.clip ? Object.assign({}, row.clip) : null
    })),
    state: 'prepared',
    createdAt: nowIso(options),
    updatedAt: nowIso(options),
    lastError: ''
  };
}

async function runCommit(data, options) {
  const archiveId = data.archiveId;
  const sessionId = data.sessionId;
  const snapshot = data.snapshot;
  const journalRead = readJournal(options);
  if (!journalRead.ok) {
    return sessionDeleteResult({
      code: journalRead.code,
      error: journalRead.error,
      archiveId,
      sessionId,
      unknown: true
    });
  }
  const journal = journalRead.journal;
  let entry = findEntry(journal, archiveId, sessionId);

  // 档案层的重新读取：确认框打开后原场次、归属、把次或备注/结果有变化都按 stale。
  const inspected = store.inspectSessionDeletion({ archiveId, sessionId });
  if (!inspected.ok) {
    return sessionDeleteResult({
      code: inspected.code || 'unreadable',
      error: inspected.error,
      archive: inspected.archive,
      archiveId,
      sessionId,
      target: inspected.target,
      snapshot: null,
      pending: inspected.pending,
      unknown: true,
      journalPending: Boolean(entry)
    });
  }

  if (!inspected.present) {
    // 目标已不在档案：只有 T051 能证明本场关联、把次与待办也全部干净时，才按
    // 「已删除」继续清理；否则保留/撤掉证据并报未确认，绝不删别的场次。
    if (!inspected.cleanlyAbsent) {
      return sessionDeleteResult({
        code: 'missing',
        error: '原场次已不在档案里，但还有本场归属记录残留；未清理任何视频',
        archive: inspected.archive,
        archiveId,
        sessionId,
        target: inspected.target,
        unknown: true,
        journalPending: Boolean(entry)
      });
    }
    if (!entry) {
      // 没有本模块的持久证据：可能早已完成清理，只回读结果，不按猜测动文件。
      return sessionDeleteResult({
        ok: true,
        code: 'already-removed',
        archive: inspected.archive,
        archiveId,
        sessionId,
        removed: true,
        duplicate: true,
        activeSessionId: inspected.archive.activeSessionId,
        activeRouteId: inspected.archive.activeRouteId
      });
    }
    // 原把次 ID 不能已经被挪到别的场次：归属不清时不按旧证据清理。
    const entryIds = new Set(entry.attempts.map(row => row.attemptId));
    if ((inspected.archive.attempts || []).some(item => entryIds.has(item.id))) {
      return sessionDeleteResult({
        code: 'missing',
        error: '原场次已不在，但原把次还被别的场次引用；未清理任何视频',
        archive: inspected.archive,
        archiveId,
        sessionId,
        target: inspected.target,
        unknown: true,
        journalPending: true
      });
    }
    const removal = {
      code: 'already-removed',
      archive: inspected.archive,
      written: false,
      removed: true,
      receiptLost: false,
      removedAttemptIds: entry.attempts.map(row => row.attemptId),
      removedRouteIds: [],
      activeSessionId: inspected.archive.activeSessionId,
      activeRouteId: inspected.archive.activeRouteId,
      successor: null,
      target: inspected.target,
      snapshot: inspected.snapshot,
      pending: inspected.pending
    };
    return finishRemoved(journal, entry, options, removal);
  }

  // 快照必须与 T051 的当前范围一致（同一场、同一批把次、结果/备注/撤回未变）。
  if (inspected.snapshot.token !== snapshot.token) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return decorateReconfirm(
        sessionDeleteResult({
          code: 'stale',
          error: STALE_SNAPSHOT,
          archive: inspected.archive,
          archiveId,
          sessionId,
          target: inspected.target,
          snapshot: inspected.snapshot,
          pending: inspected.pending,
          removed: false,
          unknown: false
        }),
      archiveId,
      sessionId,
      options
    );
  }

  // 持久待办、单把删除在途：动档案前就拒绝，什么都不写。
  if (inspected.pending && inspected.pending.total > 0) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return decorateReconfirm(
      sessionDeleteResult({
        code: 'pending',
        error: inspected.pending.text || PENDING_DELETE,
        archive: inspected.archive,
        archiveId,
        sessionId,
        target: inspected.target,
        snapshot: inspected.snapshot,
        pending: inspected.pending
      }),
      archiveId,
      sessionId,
      options
    );
  }
  const blocked = blockedAttemptIds(inspected.snapshot, archiveId);
  if (!blocked.ok) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return sessionDeleteResult({
      code: blocked.code,
      error: blocked.error,
      archive: inspected.archive,
      archiveId,
      sessionId,
      target: inspected.target,
      removed: false,
      unknown: false
    });
  }
  if (blocked.ids.length) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return decorateReconfirm(
      sessionDeleteResult({
        code: 'pending',
        error: DELETE_ALREADY_PENDING,
        archive: inspected.archive,
        archiveId,
        sessionId,
        target: inspected.target,
        snapshot: inspected.snapshot,
        pending: inspected.pending
      }),
      archiveId,
      sessionId,
      options
    );
  }

  // 提交边界再读一次视频索引：确认框打开后换片、移除附件或同数量换版本，都必须
  // 重新确认。这里在同步写档案之前完成，异步视频回调无法插进这段窗口。
  const media = mediaEvidence(inspected.archive, sessionId, archiveId, options);
  if (!media.ok) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return sessionDeleteResult({
      code: media.code,
      error: media.error,
      archive: inspected.archive,
      archiveId,
      sessionId,
      target: inspected.target,
      snapshot: inspected.snapshot,
      removed: false,
      unknown: false
    });
  }
  if (media.token !== snapshot.mediaToken) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return Object.assign(
      decorateReconfirm(
        sessionDeleteResult({
          code: 'stale',
          error: STALE_SNAPSHOT,
          archive: inspected.archive,
          archiveId,
          sessionId,
          target: inspected.target,
          snapshot: inspected.snapshot,
          pending: inspected.pending,
          removed: false,
          unknown: false
        }),
        archiveId,
        sessionId,
        options
      ),
      { mediaCount: media.count }
    );
  }

  // 最终同步边界：档案删除前再查一次这一场是否有真正在途的视频变更。从这里到
  // commitSessionDeletion 之间没有 await，异步视频回调无法插进这段窗口；若仍在途，
  // 先要求完成本次视频操作，旧 prepared 凭据随本次未提交一并撤掉（档案未动）。
  if (videoMutationActive(archiveId, sessionId)) {
    if (entry) {
      dropEntry(journal, entry);
      writeJournal(journal, options);
    }
    return decorateReconfirm(
      sessionDeleteResult({
        code: 'pending',
        error: VIDEO_WRITE_PENDING,
        archive: inspected.archive,
        archiveId,
        sessionId,
        target: inspected.target,
        snapshot: inspected.snapshot,
        pending: inspected.pending,
        removed: false,
        unknown: false,
        videoWritePending: true
      }),
      archiveId,
      sessionId,
      options
    );
  }

  if (entry) {
    // 上一次没写成（或回执未确认）但原场次仍在：按这次重新核对过的证据继续。
    entry.storeToken = inspected.snapshot.token;
    entry.mediaToken = media.token;
    entry.attempts = entryFrom(inspected, media, options).attempts;
    entry.state = 'prepared';
    entry.updatedAt = nowIso(options);
    entry.lastError = '';
  } else {
    entry = entryFrom(inspected, media, options);
    journal.pending.push(entry);
  }
  // 删除意图 + 完整目标身份必须先落盘，再动档案。
  const staged = writeJournal(journal, options);
  if (!staged.ok) {
    // 凭据没落盘就不动档案；内存里的新条目随本次返回丢弃，盘上保持原样。
    return sessionDeleteResult({
      code: 'journal-write-failed',
      error: '场次删除凭据保存失败，未删除记录或视频；请重试',
      archive: inspected.archive,
      archiveId,
      sessionId,
      target: inspected.target,
      snapshot: inspected.snapshot,
      pending: inspected.pending
    });
  }

  const removal = store.commitSessionDeletion({
    archiveId,
    sessionId,
    snapshot: inspected.snapshot
  });

  if (removal.ok && removal.removed) {
    return finishRemoved(journal, entry, options, removal);
  }

  if (removal.code === 'stale' || removal.code === 'pending') {
    // 明确没有写入：撤掉凭据，附件与档案保持原值。
    dropEntry(journal, entry);
    writeJournal(journal, options);
    return decorateReconfirm(
      sessionDeleteResult({
        code: removal.code,
        error: removal.error,
        archive: removal.archive,
        archiveId,
        sessionId,
        target: removal.target,
        snapshot: removal.snapshot,
        pending: removal.pending,
        removed: false,
        unknown: false
      }),
      archiveId,
      sessionId,
      options
    );
  }

  if (removal.code === 'write-failed') {
    // 写前失败、重读仍能看到原场次：记录与视频都不动。
    dropEntry(journal, entry);
    writeJournal(journal, options);
    return sessionDeleteResult({
      code: 'write-failed',
      error: removal.error,
      archive: removal.archive,
      archiveId,
      sessionId,
      target: removal.target,
      snapshot: removal.snapshot,
      pending: removal.pending,
      removed: false,
      unknown: false
    });
  }

  // 回执/读取不明确：保留 prepared 证据，重开时按同一份档案重新核对；本次不报成功。
  entry.lastError = removal.error || '场次删除状态暂未确认';
  entry.updatedAt = nowIso(options);
  writeJournal(journal, options);
  return sessionDeleteResult({
    code: removal.code || 'write-failed-unverified',
    error: (removal.error || '场次删除状态暂未确认') + '；记录是否已删除暂未确认，重开或重试时会重新核对',
    archive: removal.archive,
    archiveId,
    sessionId,
    target: removal.target,
    snapshot: removal.snapshot,
    pending: removal.pending,
    unknown: true,
    journalPending: true
  });
}

/**
 * 提交整场删除（两处入口共用）。
 *
 * 输入：{ archiveId, sessionId, snapshot }，snapshot 必须来自同一原档案、原场次的
 * inspectSessionDelete。返回：
 * - ok:true、removed:true：档案已确认删除；video.status 为 none/done/kept 表示副本
 *   已结清，pending 表示记录已删但视频副本待重试；
 * - code stale / pending：明确没有写档案，snapshot 是刷新后的最新范围；
 * - code write-failed：写前失败，档案与附件保持原值；
 * - unknown:true：状态未能确认，journalPending:true，重开时会重新核对。
 */
function commitSessionDelete(input, options) {
  const data = input || {};
  const opts = options || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  const snapshot =
    data.snapshot && typeof data.snapshot === 'object' && !Array.isArray(data.snapshot)
      ? data.snapshot
      : null;
  if (!archiveId || !sessionId || !snapshot) {
    return Promise.resolve(
      sessionDeleteResult({
        code: 'incomplete-request',
        error: INCOMPLETE_REQUEST,
        archiveId,
        sessionId
      })
    );
  }
  if (
    !hasText(snapshot.token) ||
    !hasText(snapshot.mediaToken) ||
    (hasText(snapshot.archiveId) && snapshot.archiveId !== archiveId) ||
    (hasText(snapshot.sessionId) && snapshot.sessionId !== sessionId)
  ) {
    return Promise.resolve(
      sessionDeleteResult({
        code:
          hasText(snapshot.archiveId) && snapshot.archiveId !== archiveId
            ? 'archive-mismatch'
            : !hasText(snapshot.token) || !hasText(snapshot.mediaToken)
              ? 'incomplete-request'
              : 'stale',
        error:
          hasText(snapshot.archiveId) && snapshot.archiveId !== archiveId
            ? '这场训练属于原来的本机档案，未做改动'
            : !hasText(snapshot.token) || !hasText(snapshot.mediaToken)
              ? INCOMPLETE_REQUEST
              : STALE_SNAPSHOT,
        archiveId,
        sessionId,
        unknown:
          hasText(snapshot.archiveId) && snapshot.archiveId !== archiveId ? true : false
      })
    );
  }

  return enqueue(() => runCommit(data, opts)).then(
    result => result,
    error =>
      sessionDeleteResult({
        code: 'delete-failed',
        error: '整场删除没有完成：' + errorText(error),
        archiveId,
        sessionId,
        unknown: true
      })
  );
}

// ------------------------------------------------------------------ *
// 重开恢复
// ------------------------------------------------------------------ *

function sessionAbsentElsewhere(archive, entry) {
  if ((archive.sessions || []).some(item => item.id === entry.sessionId)) return false;
  if ((archive.sessionRoutes || []).some(item => item.sessionId === entry.sessionId)) {
    return false;
  }
  if ((archive.attempts || []).some(item => item.sessionId === entry.sessionId)) return false;
  if ((archive.pendingSaves || []).some(item => item.sessionId === entry.sessionId)) {
    return false;
  }
  if ((archive.pendingCorrections || []).some(item => item.sessionId === entry.sessionId)) {
    return false;
  }
  if ((archive.pendingUndos || []).some(item => item.sessionId === entry.sessionId)) {
    return false;
  }
  if ((archive.pendingRestores || []).some(item => item.sessionId === entry.sessionId)) {
    return false;
  }
  // 原把次 ID 也不允许被挪到别的场次：归属不清时不清理。
  const ids = new Set(entry.attempts.map(row => row.attemptId));
  return !(archive.attempts || []).some(item => ids.has(item.id));
}

/**
 * 冷启动/可见重试：只处理 journal 的 pending。
 * - 没有待办：立刻返回，不读视频目录、不创建视频服务；
 * - journal 读不出来：整轮不执行、不写回；
 * - 原场次仍在同一档案：说明档案删除从未提交，撤掉 prepared 条目，视频与附件不动；
 * - 原场次已不在且同一档案证明本场关联/把次/待办全部不在：继续按身份清理；
 * - 读档案失败、换档、仍有归属残留或视频索引读不出来：保留证据，失败关闭。
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
        sessionId: entry.sessionId,
        error: '本机档案已经更换，属于旧档案的场次与视频副本没有清理'
      });
      continue;
    }
    const sessionPresent = (archive.sessions || []).some(item => item.id === entry.sessionId);
    if (sessionPresent) {
      // 原场次还在：删除没有提交。绝不能因为重开就把上一次未完成的删除接着做完。
      dropEntry(journal, entry);
      processed += 1;
      continue;
    }
    if (!sessionAbsentElsewhere(archive, entry)) {
      errors.push({
        sessionId: entry.sessionId,
        error: '原场次虽已不在，但还有本场归属记录残留；未清理任何视频'
      });
      continue;
    }

    // 只有同一份档案证明原场次、关联与全部原把次都不在时，才允许动视频。
    const video = await cleanupEntry(entry, opts);
    if (settledVideo(video)) {
      finalizeEntry(journal, entry, opts);
      processed += 1;
    } else {
      entry.state = 'removed';
      entry.lastError = video.errors.length
        ? video.errors[video.errors.length - 1].error
        : '视频副本尚未清理完成';
      entry.updatedAt = nowIso(opts);
      errors.push({ sessionId: entry.sessionId, error: entry.lastError });
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

function enqueue(task) {
  const previous = runtime.queue || Promise.resolve();
  const run = previous.then(task, task);
  runtime.queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 重开/手动重试；与提交共用同一条队列，避免并发回写整份 journal。 */
function recoverPending(options) {
  const opts = options || {};
  return enqueue(() => runRecovery(opts)).then(
    result => result,
    error => ({
      ok: false,
      code: 'recovery-failed',
      error: '场次删除恢复没有完成：' + errorText(error),
      processed: 0,
      pending: 0,
      errors: [{ error: errorText(error) }]
    })
  );
}

/** 离线测试/换档后重置服务缓存与注入项；不删除任何凭据、索引或文件。 */
function resetRuntime() {
  runtime.storage = null;
  runtime.createService = null;
  runtime.readVideoIndex = null;
  runtime.now = null;
  runtime.services.clear();
  runtime.queue = Promise.resolve();
}

/** 离线测试注入存储、服务工厂、视频索引读取与时钟（生产不调用）。 */
function configure(options) {
  const config = options || {};
  if (Object.prototype.hasOwnProperty.call(config, 'storage')) runtime.storage = config.storage;
  if (Object.prototype.hasOwnProperty.call(config, 'createService')) {
    runtime.createService = config.createService;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'readVideoIndex')) {
    runtime.readVideoIndex = config.readVideoIndex;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'now')) runtime.now = config.now;
}

module.exports = {
  SESSION_DELETE_KEY,
  SESSION_DELETE_VERSION,
  inspectSessionDelete,
  commitSessionDelete,
  recoverPending,
  pendingStatus,
  sessionFenceState,
  configure,
  resetRuntime
};
