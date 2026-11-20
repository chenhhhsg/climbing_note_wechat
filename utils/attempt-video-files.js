/**
 * 逐把视频 · 本机持久副本、独立索引与空间计量（T026）
 *
 * 与 T023/T024 的分工：T023 只做入口归属与相册单选预览，T024 只做原生播放与
 * 更换/移除交互。本模块是视频页背后的**持久层**：
 * - 文件只写在 `<USER_DATA_PATH>/attempt-video/v1/<archiveId>/` 这个档案专属目录里，
 *   目录名取自本机档案 ID，档案无效时一个文件也不读、不写、不删；
 * - 独立索引键 `climbingNote.training.v1.attempt-video` 保存档案、原场次、线路、
 *   原把次、片段标识/版本、相对文件标识与实际字节。索引属于受保护的本机资料：
 *   普通清缓存只清 `cache.*` / `thumbs.*`，不会清掉它，也不会删这里的文件；
 * - 预览的临时路径永远不是持久位置：确认保存时先写新副本并核对可读与真实字节，
 *   再提交索引；提交后才清理已无引用的旧副本；
 * - 移除先核对当前片段版本，再解除关联，最后回收小程序内的副本。原把次、备注与
 *   系统相册里的原片都不在本模块的处理范围内。
 *
 * 所有权证据（QA 返工）：
 * - 目录里出现 `clip-*` 命名本身**不算**所有权证据。真正写文件之前，先在索引里
 *   持久一条「本功能正在创建这个相对文件标识」的待清理记录（pending）；只有被
 *   索引引用、或出现在待清理记录里的文件才会被本模块删除或覆盖；
 * - 索引里出现过的片段（clips）同样是可证实的所有权来源：更换/移除后回收旧副本
 *   属于本功能自己写下的文件；
 * - 未知的、仅名字合法的 `clip-*` 文件一律保留，只计入实际占用，不自动清理；
 * - 冷启动 recover() 只清理：索引可读、有本功能待清理/索引记录、当前无引用、
 *   也没有在途写入的文件。目录读取或索引读取失败时不做破坏性操作。
 *
 * 回执与重启恢复（QA 返工）：
 * - 索引写入抛错不等于没有落盘：先读回索引判断。读回显示本次片段/本次解除关联
 *   已经生效时按成功处理（receiptLost）；明确显示没有引用本次新文件时才删除它；
 *   读回失败时保留存疑的新旧副本与待清理记录，等后续可证实处置；
 * - 文件服务最后一次异步等待之后、同步写索引之前，按四个原 ID 与当前有效把次
 *   再核对一次归属；已经离页/换档/撤回的操作不提交。提交后才离页的保留成功结果，
 *   只回收本次操作创建且可证明无引用的临时副本；
 * - 每次操作带操作标识（opId）并写入索引条目，页面据此区分「本次提交」与
 *   「另一页刚更新的版本」。
 *
 * 失败副本的清理凭据（T057）：
 * - 写后核对或撤销副本失败时，pending 只有在 unlink 成功、或失败后复核确认文件
 *   已缺失时才结清；回执不明/删除失败时凭据必须保留，供 cleanupOrphans/recover 继续回收；
 * - 目录快照里没有目标不等于文件不存在：先检查同运行期在途写入，再 stat 复核；
 *   快照后才发布、在途写入或状态未知的副本都保留凭据；
 * - 清理结果如实区分实际删除（deleted）、确认缺失后结清（settled）与保留待重试
 *   （preserved），页面按 pendingCount 给出实际提示。
 *
 * 空间：
 * - 按各档案视频目录里的实际文件字节计量（包含失败操作留下的无引用文件与
 *   其他档案的副本），总视频预算在小程序内各档案之间共用；
 * - 单片、视频总量与更换期间新旧副本并存的峰值都要通过预检；视频预算之外另有
 *   照片保留量，避免把共用设备空间吃满；
 * - 真实配额失败（复制时系统报空间不足）同样按空间不足返回可见原因，并保留旧片。
 *
 * 同场在途查询（T052）：
 * - public commit/replace/remove 在同步校验通过后按「档案 ID + 原场次 ID」登记一个
 *   内存计数，并在 try/finally 里释放；整场删除协调器在确认快照与同步提交边界都
 *   查询这个计数，有在途写入时先要求完成，不会在文件 I/O 尚未返回时开始删档案；
 * - 计数只覆盖同一场，别的场次照常保存/清理；它不读写文件系统，也不改变本模块的
 *   所有权、回执或提交语义。
 *
 * 本模块不发起任何上传、云调用或数据迁移。
 */
const attemptVideo = require('./attempt-video.js');
const attemptVideoMarkers = require('./attempt-video-markers.js');
const { isSpaceError } = require('./training-photo-space.js');

const VIDEO_FILES_VERSION = 1;
const VIDEO_ROOT_DIRNAME = 'attempt-video';
const VIDEO_INDEX_KEY = attemptVideo.VIDEO_INDEX_KEY;
const INDEX_VERSION = 1;

// 档案 ID 会成为目录名，只接受本机档案层生成的字符集合。
const ARCHIVE_ID_PATTERN = attemptVideo.ARCHIVE_ID_PATTERN;
const CLIP_ID_PATTERN = attemptVideo.CLIP_ID_PATTERN;
// 只接手本功能自己创建的片段文件；其他文件既不计入视频占用，也绝不删除。
const CLIP_FILE_PATTERN = attemptVideo.CLIP_FILE_PATTERN;

const MIB = 1024 * 1024;

/**
 * 视频预算（应用自设上限，不是微信或设备可用空间的保证）：
 * - budgetBytes：本机逐把视频的总预算（各档案共用）；
 * - photoReserveBytes：从总预算里留给线路照片共用空间的余量，视频实际可用
 *   usableBytes = budgetBytes - photoReserveBytes；
 * - reserveBytes：更换时新旧副本并存的峰值余量；
 * - maxClipBytes：单段视频上限。最终产品阈值以手机样片的大小、质量与耗时再定。
 */
const VIDEO_SPACE_POLICY = Object.freeze({
  budgetBytes: 200 * MIB,
  warnBytes: 150 * MIB,
  photoReserveBytes: 40 * MIB,
  reserveBytes: 8 * MIB,
  maxClipBytes: 80 * MIB
});

/**
 * 同一 JS 运行期内真实执行中的写入/删除路径（仅内存）。
 * recover()/cleanupOrphans() 在删除前据此跳过正在写的文件；小程序重启后登记随
 * 模块一起消失，因此旧运行期留下的半成品可以由持久待清理记录安全回收。
 */
const RUNTIME_WRITES = new Set();
const RUNTIME_WRITE_BYTES = new Map();

/**
 * 同一 JS 运行期内、各场次真正执行中的视频变更（仅内存）。
 *
 * 键 = 本机档案 ID + 原场次 ID，值 = 该键下仍在执行的 public commit/replace/remove
 * 数量。整场删除协调器据此在「读快照」与「同步提交边界」判断这一场是否还有视频
 * 正在保存或移除；它只回答同一场，别的场次与别的档案照常可操作，不是全局视频锁。
 *
 * 登记与释放在每个操作自己的 try/finally 里完成（同步抛错也会释放），运行期结束随
 * 模块消失，因此不会留下永久状态。它是内存判定：不扫描目录、不读索引、不写存储。
 */
const RUNTIME_SESSION_MUTATIONS = new Map();

function sessionMutationKey(archiveId, sessionId) {
  if (!isSafeArchiveId(archiveId) || !hasText(sessionId)) return '';
  return archiveId + '\n' + sessionId;
}

function beginSessionMutation(archiveId, sessionId) {
  const key = sessionMutationKey(archiveId, sessionId);
  if (!key) return null;
  RUNTIME_SESSION_MUTATIONS.set(key, (RUNTIME_SESSION_MUTATIONS.get(key) || 0) + 1);
  return key;
}

function endSessionMutation(key) {
  if (!key) return;
  const count = RUNTIME_SESSION_MUTATIONS.get(key) || 0;
  if (count <= 1) {
    RUNTIME_SESSION_MUTATIONS.delete(key);
    return;
  }
  RUNTIME_SESSION_MUTATIONS.set(key, count - 1);
}

/**
 * 这一场当前是否有真正执行中的视频写入/移除。只用于协调器判断「先完成在途操作」，
 * 不参与视频自身的所有权或提交判定。身份不完整时返回 false（不登记、也不误挡）。
 */
function hasActiveSessionVideoMutation(archiveId, sessionId) {
  const key = sessionMutationKey(archiveId, sessionId);
  return Boolean(key && (RUNTIME_SESSION_MUTATIONS.get(key) || 0) > 0);
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInt(value) {
  const number = safeNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function isSafeArchiveId(value) {
  return typeof value === 'string' && ARCHIVE_ID_PATTERN.test(value);
}

function isSafeClipId(value) {
  return typeof value === 'string' && CLIP_ID_PATTERN.test(value);
}

function isSafeVideoFileId(value) {
  return attemptVideo.isSafeVideoFileId(value);
}

function normalizePath(value) {
  if (!hasText(value)) return '';
  const text = value.replace(/\\/g, '/');
  // 微信用户目录是 http://usr（开发者工具）或 wxfile://usr（真机），
  // 协议后的双斜线不能被折叠，否则会变成 http:/usr。
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/.exec(text);
  const scheme = match ? match[1] : '';
  const rest = match ? match[2] : text;
  return scheme + rest.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function joinPath() {
  const parts = Array.prototype.slice
    .call(arguments)
    .filter(part => hasText(part));
  if (!parts.length) return '';
  return normalizePath(parts.join('/'));
}

function fileNameOf(value) {
  const text = hasText(value) ? value.replace(/\\/g, '/') : '';
  const parts = text.split('/');
  return parts[parts.length - 1] || '';
}

function isMissingPathError(text) {
  return /no such file|not exist|ENOENT|cannot find/i.test(text || '');
}

function formatBytes(bytes) {
  const value = safeNumber(bytes);
  if (value === null || value < 0) return '未知大小';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

// ------------------------------------------------------------------ *
// 空间策略与预检
// ------------------------------------------------------------------ *

function toPositiveInteger(value) {
  const number = safeNumber(value);
  if (number === null || number <= 0) return 0;
  return Math.floor(number);
}

function toNonNegativeInteger(value) {
  const number = safeNumber(value);
  if (number === null || number < 0) return 0;
  return Math.floor(number);
}

/**
 * 只接受正数预算；提醒线不超过预算，照片保留量与更换余量都不超过预算。
 * 测试可以注入小数值复现容量边界，页面不提供放宽入口。
 */
function resolveVideoSpacePolicy(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const budgetBytes = toPositiveInteger(raw.budgetBytes) || VIDEO_SPACE_POLICY.budgetBytes;
  // 默认值按预算比例收敛：注入一个小预算做边界测试时，提醒线、照片余量与更换余量
  // 必须一起变小，否则默认值本身就会把可用总量吃光。
  const warnDefault = Math.min(
    VIDEO_SPACE_POLICY.warnBytes,
    Math.floor(budgetBytes * 0.75)
  );
  const photoReserveDefault = Math.min(
    VIDEO_SPACE_POLICY.photoReserveBytes,
    Math.floor(budgetBytes / 5)
  );
  const reserveDefault = Math.min(
    VIDEO_SPACE_POLICY.reserveBytes,
    Math.floor(budgetBytes / 10)
  );
  const warnRaw = toPositiveInteger(raw.warnBytes) || warnDefault;
  const photoReserveRaw =
    raw.photoReserveBytes === undefined
      ? photoReserveDefault
      : toNonNegativeInteger(raw.photoReserveBytes);
  const reserveRaw =
    raw.reserveBytes === undefined
      ? reserveDefault
      : toNonNegativeInteger(raw.reserveBytes);
  const maxClipRaw =
    raw.maxClipBytes === undefined
      ? Math.min(VIDEO_SPACE_POLICY.maxClipBytes, budgetBytes)
      : toNonNegativeInteger(raw.maxClipBytes);
  const photoReserveBytes = Math.min(photoReserveRaw, budgetBytes);
  return {
    version: 1,
    budgetBytes,
    warnBytes: Math.min(warnRaw, budgetBytes),
    photoReserveBytes,
    reserveBytes: Math.min(reserveRaw, budgetBytes),
    // 视频实际可用的总量：总预算里先扣掉给照片留的余量。
    usableBytes: Math.max(0, budgetBytes - photoReserveBytes),
    maxClipBytes: Math.max(1, Math.min(maxClipRaw || budgetBytes, budgetBytes))
  };
}

function usableBytesOf(policy) {
  const resolved = policy || VIDEO_SPACE_POLICY;
  if (typeof resolved.usableBytes === 'number') return resolved.usableBytes;
  return Math.max(0, nonNegativeInt(resolved.budgetBytes) - nonNegativeInt(resolved.photoReserveBytes));
}

/**
 * 单片、总量与峰值的唯一判定：
 * - 新片本身不得超过单片上限；
 * - 各档案当前实际占用 + 本次新增 + 更换余量不得超过视频可用总量。
 * 更换时旧副本尚未删除，占用天然包含新旧并存，不提前删旧片制造空间。
 */
function checkClipSpace(usedBytes, newBytes, policy) {
  const resolved = policy || resolveVideoSpacePolicy({});
  const used = nonNegativeInt(usedBytes);
  const adding = nonNegativeInt(newBytes);
  const usableBytes = usableBytesOf(resolved);
  const peakBytes = used + adding + resolved.reserveBytes;

  if (adding > resolved.maxClipBytes) {
    return {
      ok: false,
      reason: 'clip-too-large',
      totalBytes: used,
      newBytes: adding,
      peakBytes,
      policy: resolved,
      usableBytes,
      remainingAfterPeakBytes: 0,
      message:
        '这段视频 ' +
        formatBytes(adding) +
        ' 超过单段上限 ' +
        formatBytes(resolved.maxClipBytes) +
        '；没有写入任何文件，原视频与记录都还在。请换一段更短的视频。'
    };
  }

  if (peakBytes > usableBytes) {
    return {
      ok: false,
      reason: 'budget',
      totalBytes: used,
      newBytes: adding,
      peakBytes,
      policy: resolved,
      usableBytes,
      remainingAfterPeakBytes: 0,
      message:
        '预计峰值 ' +
        formatBytes(peakBytes) +
        '（各档案当前占用 ' +
        formatBytes(used) +
        ' + 新视频 ' +
        formatBytes(adding) +
        ' + 更换余量 ' +
        formatBytes(resolved.reserveBytes) +
        '）超过本机视频可用预算 ' +
        formatBytes(usableBytes) +
        '（总预算 ' +
        formatBytes(resolved.budgetBytes) +
        ' 中已为照片保留 ' +
        formatBytes(resolved.photoReserveBytes) +
        '）；没有写入任何文件，原视频与记录都还在。可移除不用的本机视频或清理无引用副本后重试。'
    };
  }

  return {
    ok: true,
    reason: '',
    totalBytes: used,
    newBytes: adding,
    peakBytes,
    policy: resolved,
    usableBytes,
    remainingAfterPeakBytes: Math.max(0, usableBytes - peakBytes),
    message: ''
  };
}

// ------------------------------------------------------------------ *
// 索引形状
// ------------------------------------------------------------------ *

function createEmptyIndex() {
  return { version: INDEX_VERSION, nextClipSeq: 1, clips: [], pending: [] };
}

function clipSeqOf(clipId) {
  const match = /^clip-(\d+)/.exec(typeof clipId === 'string' ? clipId : '');
  return match ? Number(match[1]) : 0;
}

/**
 * 片段标识 = 序号 + 随机后缀。序号让索引计数与「第几个片段」可读，随机后缀保证
 * 两个页面即使读到同一个 nextClipSeq 也不会写同一个文件：后到者的目标路径不同，
 * 提交前的「这一把已有片段」检查负责丢弃多余副本，而不是覆盖先到者的文件。
 */
function makeClipId(seq) {
  return 'clip-' + seq + '-' + Math.random().toString(36).slice(2, 8);
}

function revOf(clip) {
  const number = safeNumber(clip && clip.rev);
  return number === null || number < 0 ? 0 : Math.floor(number);
}

function optionalNumber(value) {
  return value === undefined || value === null ? null : safeNumber(value);
}

/**
 * 索引条目至少要带齐档案、场次、线路、把次、片段与文件标识；缺任何一个都让整份
 * 索引按损坏处理：宁可拒绝写入，也不把已保存视频的归属猜错。
 *
 * 文件标识本身**不在这里**做命名空间强制：损坏索引里的普通相对路径、旧绝对路径
 * 或别的档案目录会保留在索引里（不丢用户数据），但所有播放、更换与回收都经
 * attemptVideo.isClipFileIdFor / pathForClip 严格解析，不会指向目录之外。
 */
function normalizeClip(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSafeArchiveId(raw.archiveId)) return null;
  if (!hasText(raw.sessionId) || !hasText(raw.routeId) || !hasText(raw.attemptId)) return null;
  if (!isSafeClipId(raw.clipId)) return null;
  if (!hasText(raw.fileId)) return null;
  const bytes = safeNumber(raw.bytes);
  if (bytes !== null && bytes < 0) return null;
  const durationSeconds = optionalNumber(raw.durationSeconds);
  const width = optionalNumber(raw.width);
  const height = optionalNumber(raw.height);
  const rev = revOf(raw);
  return {
    clipId: raw.clipId,
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    routeId: raw.routeId,
    attemptId: raw.attemptId,
    attemptSeq: safeNumber(raw.attemptSeq),
    rev,
    fileId: raw.fileId,
    bytes: bytes === null ? 0 : Math.floor(bytes),
    durationSeconds: durationSeconds !== null && durationSeconds >= 0 ? durationSeconds : null,
    width: width !== null && width > 0 ? Math.floor(width) : null,
    height: height !== null && height > 0 ? Math.floor(height) : null,
    fileName: hasText(raw.fileName) ? raw.fileName : '',
    opId: hasText(raw.opId) ? raw.opId : '',
    createdAt: hasText(raw.createdAt) ? raw.createdAt : '',
    // T025：手工时间点是片段条目的可选增量字段。旧索引没有这个字段 → 空列表；
    // 单条坏标记被丢弃，不把整份索引判坏，也不影响视频引用本身。
    markers: attemptVideoMarkers.normalizeMarkers(raw.markers, {
      clipId: raw.clipId,
      rev
    })
  };
}

/**
 * 待清理记录：本功能某次操作**创建**了这个相对文件标识，但还没有提交为引用。
 * 只有这里记录过（或索引曾经引用过）的文件才算可证实的所有权；记录本身写不进
 * 索引时不写文件，因此重启后不会把未知的合法命名文件当成自己的副本。
 */
function normalizePending(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSafeArchiveId(raw.archiveId)) return null;
  if (!isSafeClipId(raw.clipId)) return null;
  if (!attemptVideo.isClipFileIdFor(raw.archiveId, raw.clipId, raw.fileId)) return null;
  return {
    archiveId: raw.archiveId,
    clipId: raw.clipId,
    fileId: raw.fileId,
    opId: hasText(raw.opId) ? raw.opId : '',
    createdAt: hasText(raw.createdAt) ? raw.createdAt : ''
  };
}

function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== INDEX_VERSION) return null;
  if (!Array.isArray(raw.clips)) return null;

  const clips = [];
  let maxSeq = 0;
  for (const entry of raw.clips) {
    const clip = normalizeClip(entry);
    if (!clip) return null;
    clips.push(clip);
    maxSeq = Math.max(maxSeq, clipSeqOf(clip.clipId));
  }

  const pending = [];
  const seenPending = new Set();
  for (const entry of Array.isArray(raw.pending) ? raw.pending : []) {
    const record = normalizePending(entry);
    if (!record || seenPending.has(record.fileId)) continue;
    seenPending.add(record.fileId);
    pending.push(record);
  }

  const requested = safeNumber(raw.nextClipSeq);
  const nextClipSeq =
    requested !== null && Number.isInteger(requested) && requested > maxSeq
      ? requested
      : maxSeq + 1;
  return { version: INDEX_VERSION, nextClipSeq, clips, pending };
}

/** 可播放/可回收的条目：文件标识严格落在当前档案视频目录且是同一片段文件。 */
function usableClip(clip) {
  return Boolean(
    clip &&
      attemptVideo.isClipFileIdFor(clip.archiveId, clip.clipId, clip.fileId)
  );
}

/**
 * 条目是否就是这一把的视频：四个原 ID（档案、场次、线路、把次）逐项对上。
 * 损坏索引里的条目即使 path/档案合法，只要场次或线路不是这一把的真实归属，
 * 就不算这一把的视频——不播放、不更换、不移除，也不会被当作待清理旧副本。
 * reference 必须是加载到的真实把次（持久层请求带齐四项；缺任何一项都不匹配）。
 */
function clipMatchesAttempt(clip, archiveId, attemptId, reference) {
  if (!clip || clip.archiveId !== archiveId || clip.attemptId !== attemptId) return false;
  const real = reference || {};
  if (!hasText(real.sessionId) || !hasText(real.routeId)) return false;
  return clip.sessionId === real.sessionId && clip.routeId === real.routeId;
}

/** 索引条目是否属于这一次操作的那一把（四个原 ID 全部对上）。 */
function sameAttemptEntry(entry, archiveId, identity) {
  const real = identity || {};
  return Boolean(
    entry &&
      entry.archiveId === archiveId &&
      hasText(real.attemptId) &&
      hasText(real.sessionId) &&
      hasText(real.routeId) &&
      entry.attemptId === real.attemptId &&
      entry.sessionId === real.sessionId &&
      entry.routeId === real.routeId
  );
}

function clipsFor(index, archiveId, attemptId, reference) {
  if (!index || !Array.isArray(index.clips)) return [];
  return index.clips.filter(
    clip =>
      clipMatchesAttempt(clip, archiveId, attemptId, reference) &&
      usableClip(clip)
  );
}

/**
 * 这一把当前有效的片段：同一把只应有一条；若历史数据里残留多条，取版本号
 * 最大的一条（版本相同取后写入的），与列表上的「看视频」判定一致。
 * 文件标识不符合当前档案视频命名空间的条目不算当前片段，避免把损坏索引里的
 * 普通相对路径或旧绝对路径传给播放器。
 */
function currentClipFor(index, archiveId, attemptId, reference) {
  const matches = clipsFor(index, archiveId, attemptId, reference);
  if (!matches.length) return null;
  let chosen = matches[0];
  for (const clip of matches) {
    if (clip.rev >= chosen.rev) chosen = clip;
  }
  return chosen;
}

function cloneClip(clip) {
  // markers 一并复制，避免调用方改到索引读回对象里的数组（回执与页面共享同一层）。
  return Object.assign({}, clip, {
    markers: (clip && Array.isArray(clip.markers) ? clip.markers : []).map(marker =>
      Object.assign({}, marker)
    )
  });
}

/** 请求里的片段版本：没有可比较的版本时返回 null。 */
function requestedRev(value) {
  const number = safeNumber(value);
  return number === null || number < 0 ? null : Math.floor(number);
}

function sameClipIdentity(current, request) {
  if (!current || !request) return false;
  if (current.clipId !== request.clipId) return false;
  const wanted = requestedRev(request.rev);
  // 旧条目可能没有版本号：请求也没带版本时按同一片段处理；带了不一致的版本一律拒绝。
  if (wanted === null) return revOf(current) === 0;
  return revOf(current) === wanted;
}

/**
 * 时间点写入的目标片段：片段 ID、版本与文件标识必须同时对上当前片段。
 * 只认当前归属下读回的片段，不按请求里的值另造关联。
 */
function markerTargetError(current, request) {
  const input = request || {};
  if (!current) {
    return fail(
      'stale-operation',
      '这一把当前没有已保存的视频，不能记录时间点；未改动任何数据'
    );
  }
  if (
    !sameClipIdentity(current, input) ||
    (hasText(input.fileId) && input.fileId !== current.fileId)
  ) {
    return fail(
      'stale-operation',
      '这一把的视频关联已经变化，这次时间点操作没有采用；请刷新后再试，原视频仍可用'
    );
  }
  return null;
}

function cloneMarker(marker) {
  return Object.assign({}, marker);
}

// ------------------------------------------------------------------ *
// 微信文件系统适配器：档案专属目录
// ------------------------------------------------------------------ *

function toPromiseApi(api, method, options) {
  return new Promise(resolve => {
    if (!api || typeof api[method] !== 'function') {
      resolve({ ok: false, error: '当前环境不支持 ' + method });
      return;
    }
    try {
      api[method](
        Object.assign({}, options, {
          success(result) {
            resolve({ ok: true, result: result || {} });
          },
          fail(error) {
            resolve({ ok: false, error: errorText(error) });
          }
        })
      );
    } catch (error) {
      resolve({ ok: false, error: errorText(error) });
    }
  });
}

function createWxAttemptVideoFiles(options) {
  const config = options || {};
  const api = config.wxApi || (typeof wx !== 'undefined' ? wx : null);
  const userDataPath =
    normalizePath(config.userDataPath) ||
    normalizePath(api && api.env && api.env.USER_DATA_PATH) ||
    '';
  const archiveId = hasText(config.archiveId) ? config.archiveId : '';
  const safeArchiveId = isSafeArchiveId(archiveId);
  const rootDir =
    normalizePath(config.rootDir) ||
    (safeArchiveId && hasText(userDataPath)
      ? joinPath(userDataPath, VIDEO_ROOT_DIRNAME, 'v' + VIDEO_FILES_VERSION, archiveId)
      : '');
  // 各档案共用的视频根目录（只用于只读统计与跨档案副本识别）。
  const rootBaseDir =
    normalizePath(config.rootBaseDir) ||
    (hasText(rootDir) && safeArchiveId &&
    rootDir.slice(-(archiveId.length + 1)) === '/' + archiveId
      ? rootDir.slice(0, -(archiveId.length + 1))
      : '');

  let readyPromise = null;

  function fileSystem() {
    if (!api || typeof api.getFileSystemManager !== 'function') return null;
    try {
      return api.getFileSystemManager();
    } catch (error) {
      return null;
    }
  }

  /** 每个会动到文件的入口都先确认绑定了一个合法档案目录。 */
  function requireRoot() {
    if (safeArchiveId && hasText(rootDir)) return null;
    return {
      ok: false,
      code: 'missing-archive',
      error: '缺少有效的本机档案标识，不能读写逐把视频文件'
    };
  }

  async function mkdirp(dirPath) {
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'mkdir', { dirPath, recursive: true });
    if (result.ok) return { ok: true };
    if (/already exist|file exists|EEXIST/i.test(result.error)) return { ok: true };
    return { ok: false, error: '创建视频目录失败：' + result.error };
  }

  function ensureReady() {
    const invalid = requireRoot();
    if (invalid) return Promise.resolve(invalid);
    if (!readyPromise) {
      readyPromise = mkdirp(rootDir).then(result => {
        if (!result.ok) readyPromise = null;
        return result;
      });
    }
    return readyPromise;
  }

  async function stat(filePath) {
    if (!hasText(filePath)) return { ok: false, error: '缺少文件路径' };
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'stat', { path: filePath });
    if (!result.ok) {
      if (isMissingPathError(result.error)) {
        return { ok: true, exists: false, bytes: 0 };
      }
      return { ok: false, error: '读取视频文件状态失败：' + result.error };
    }
    let stats = result.result.stats;
    if (Array.isArray(stats)) stats = stats[0];
    if (!stats || typeof stats.size !== 'number') {
      return { ok: false, error: '读取视频文件状态失败：返回结构无效' };
    }
    return { ok: true, exists: true, bytes: stats.size };
  }

  async function copyFile(srcPath, destPath) {
    const fs = fileSystem();
    if (!fs) return Promise.resolve({ ok: false, error: '文件系统不可用' });
    return toPromiseApi(fs, 'copyFile', { srcPath, destPath });
  }

  async function unlink(filePath) {
    const fs = fileSystem();
    if (!fs) return Promise.resolve({ ok: false, error: '文件系统不可用' });
    return toPromiseApi(fs, 'unlink', { filePath });
  }

  /**
   * 删除一个文件，并把结果收敛成**可证实**的三种状态：
   * - ok + existed=true：删除成功；
   * - ok + existed=false：文件本来就不存在（含 unlink 成功但回执丢失后复核缺失）；
   * - ok=false：回执不明且复核仍看到文件/无法复核，exists 给 true 或 null。
   * 回执丢失不能直接算成功，也不能把已经删掉的文件永久留成待清理：失败后重新
   * stat 一次，只有确认缺失才按已完成返回。
   */
  async function remove(filePath) {
    if (!hasText(filePath)) return { ok: true, existed: false };
    const invalid = requireRoot();
    if (invalid) return invalid;
    const result = await unlink(filePath);
    if (result.ok) return { ok: true, existed: true };
    if (isMissingPathError(result.error)) return { ok: true, existed: false };
    const checked = await stat(filePath);
    if (checked.ok && !checked.exists) {
      return { ok: true, existed: false, unconfirmed: true };
    }
    return {
      ok: false,
      error: '删除视频文件失败：' + result.error,
      exists: checked.ok ? checked.exists : null
    };
  }

  /**
   * 核对文件可读。部分基础库没有 access：此时以 stat 成功且字节大于 0 为准，
   * 不把「环境没有这个接口」当成文件损坏。
   */
  async function access(filePath) {
    const fs = fileSystem();
    if (!fs || typeof fs.access !== 'function') {
      const fallback = await stat(filePath);
      return fallback.ok && fallback.exists && fallback.bytes > 0
        ? { ok: true, supported: false }
        : { ok: false, error: fallback.error || '视频文件不存在或为空' };
    }
    const result = await toPromiseApi(fs, 'access', { path: filePath });
    if (!result.ok) return { ok: false, error: '视频文件不可读：' + result.error };
    return { ok: true, supported: true };
  }

  function videoPath(clipId, ext) {
    if (!isSafeClipId(clipId)) return '';
    const suffix = hasText(ext) ? ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 5) : 'mp4';
    if (!hasText(rootDir) || !hasText(suffix)) return '';
    return joinPath(rootDir, clipId + '.' + suffix);
  }

  /**
   * 索引里的相对文件标识：必须是本功能的标准命名空间位置
   *   attempt-video/v1/<本档案>/<clipId>.<ext>
   * 否则返回空（不写索引、不播放、不删除）。以实际写入路径反推，避免自定义
   * 文件根与索引里的位置不一致。
   */
  function fileIdOf(clipId, ext) {
    const target = videoPath(clipId, ext);
    if (!hasText(target) || !hasText(userDataPath)) return '';
    const base = normalizePath(userDataPath) + '/';
    if (target.indexOf(base) !== 0) return '';
    const fileId = target.slice(base.length);
    return attemptVideo.isClipFileIdFor(archiveId, clipId, fileId) ? fileId : '';
  }

  /**
   * 把索引条目严格解析成当前档案视频目录里的真实路径：
   * - 档案必须是本适配器的档案；
   * - 文件标识必须是本档案里的同一片段文件；
   * - 最终路径由本档案 rootDir + 片段文件名拼出，不接受 fileId 里的其他目录。
   */
  function pathForClip(clip) {
    if (!clip || clip.archiveId !== archiveId) return '';
    if (!attemptVideo.isClipFileIdFor(archiveId, clip.clipId, clip.fileId)) return '';
    const parsed = attemptVideo.parseVideoFileId(clip.fileId);
    if (!parsed) return '';
    return videoPath(clip.clipId, parsed.ext);
  }

  /** 只接受本档案标准命名空间里的相对文件标识。 */
  function pathForFileId(fileId) {
    const parsed = attemptVideo.parseVideoFileId(fileId);
    if (!parsed || parsed.archiveId !== archiveId) return '';
    return videoPath(parsed.clipId, parsed.ext);
  }

  /**
   * 读一个目录里的受管片段文件。fileId 一律按目标档案 + 片段 + 扩展名重新生成，
   * 不信任目录里已有的路径文本。
   */
  async function readClipDir(dirPath, targetArchiveId) {
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    if (!hasText(dirPath)) return { ok: true, files: [] };
    const result = await toPromiseApi(fs, 'readdir', { dirPath });
    if (!result.ok) {
      if (isMissingPathError(result.error)) return { ok: true, files: [] };
      return { ok: false, error: '读取视频目录失败：' + result.error };
    }
    const names = Array.isArray(result.result.files) ? result.result.files : [];
    const files = [];
    for (const name of names) {
      const match = CLIP_FILE_PATTERN.exec(name);
      if (!match) continue;
      const clipId = match[1];
      const ext = match[2];
      const fileId = attemptVideo.clipFileIdOf(targetArchiveId, clipId, ext);
      if (!fileId) continue;
      files.push({
        name,
        path: joinPath(dirPath, name),
        clipId,
        fileId
      });
    }
    return { ok: true, files };
  }

  /** 本档案视频目录里的受管文件（回收/占用统计用）。 */
  function listClips() {
    const invalid = requireRoot();
    if (invalid) return Promise.resolve(invalid);
    return readClipDir(rootDir, archiveId);
  }

  /** 共用视频根目录下实际存在的档案目录名（只读；读不到时返回空列表）。 */
  async function listArchives() {
    if (!hasText(rootBaseDir)) return { ok: true, archives: [] };
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'readdir', { dirPath: rootBaseDir });
    if (!result.ok) {
      if (isMissingPathError(result.error)) return { ok: true, archives: [] };
      return { ok: false, error: '读取视频根目录失败：' + result.error };
    }
    const names = Array.isArray(result.result.files) ? result.result.files : [];
    return {
      ok: true,
      archives: names.filter(name => isSafeArchiveId(name))
    };
  }

  /** 任意档案目录里的受管文件（只读；用于总占用统计，绝不据此删除别的档案）。 */
  async function listArchiveClips(targetArchiveId) {
    if (!isSafeArchiveId(targetArchiveId)) {
      return { ok: false, error: '缺少有效的本机档案标识，无法统计视频文件' };
    }
    if (targetArchiveId === archiveId) return listClips();
    if (!hasText(rootBaseDir)) return { ok: true, files: [] };
    return readClipDir(joinPath(rootBaseDir, targetArchiveId), targetArchiveId);
  }

  return {
    version: VIDEO_FILES_VERSION,
    archiveId,
    userDataPath,
    rootDir,
    rootBaseDir,
    videoPath,
    fileIdOf,
    pathForClip,
    pathForFileId,
    ensureReady,
    stat,
    access,
    copyFile,
    remove,
    listClips,
    listArchives,
    listArchiveClips
  };
}

// ------------------------------------------------------------------ *
// 索引读写
// ------------------------------------------------------------------ *

function createWxStorage(wxApi) {
  const api = wxApi || (typeof wx !== 'undefined' ? wx : null);
  return {
    get(key) {
      if (!api) throw new Error('微信存储不可用');
      return api.getStorageSync(key);
    },
    set(key, value) {
      if (!api) throw new Error('微信存储不可用');
      return api.setStorageSync(key, value);
    },
    remove(key) {
      if (!api || typeof api.removeStorageSync !== 'function') {
        throw new Error('微信存储不可用');
      }
      return api.removeStorageSync(key);
    }
  };
}

function readIndex(storage) {
  let raw;
  try {
    raw = storage.get(VIDEO_INDEX_KEY);
  } catch (error) {
    return {
      ok: false,
      code: 'index-read-failed',
      error: '读取本机视频索引失败：' + errorText(error) + '；未改动任何视频文件'
    };
  }
  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, index: createEmptyIndex() };
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return {
      ok: false,
      code: 'index-broken',
      error: '本机视频索引格式损坏；为保护已保存视频，没有写入或删除任何文件'
    };
  }
  const index = normalizeIndex(parsed);
  if (!index) {
    return {
      ok: false,
      code: 'index-broken',
      error: '本机视频索引结构不受支持；为保护已保存视频，没有写入或删除任何文件'
    };
  }
  return { ok: true, index };
}

/**
 * 落盘形状：`markers` 是 T025 的可选增量字段。没有时间点的片段**不写这个字段**，
 * 使未使用新功能的索引与旧版本逐字节一致；只有真的记过时间点时才出现 markers。
 * 旧版本读取时会忽略不认识的字段，因此新索引仍可被旧代码安全读取。
 */
function serializedIndex(index) {
  return Object.assign({}, index, {
    clips: (index && Array.isArray(index.clips) ? index.clips : []).map(clip => {
      const copy = Object.assign({}, clip);
      if (!Array.isArray(copy.markers) || copy.markers.length === 0) {
        delete copy.markers;
      }
      return copy;
    })
  });
}

function saveIndex(storage, index) {
  try {
    storage.set(VIDEO_INDEX_KEY, JSON.stringify(serializedIndex(index)));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: 'index-write-failed',
      error: '本机视频索引写入失败：' + errorText(error)
    };
  }
}

// ------------------------------------------------------------------ *
// 持久层服务
// ------------------------------------------------------------------ *

function fail(code, detail) {
  return {
    ok: false,
    code,
    error: detail || '视频操作失败，可以重试；原视频与记录都没有改动。'
  };
}

/**
 * 生产默认核对：当前本机档案必须还是请求带来的那一份。
 * 换档之后的迟到写入在这里被拒绝，不写文件、不改索引。
 */
function defaultVerifyArchive(archiveId) {
  try {
    const store = require('./training-store.js');
    const loaded = store.loadState();
    return Boolean(loaded.ok && loaded.archive.archiveId === archiveId);
  } catch (error) {
    return false;
  }
}

/**
 * 生产默认归属核对：四个原 ID 仍指向当前档案里的同一场、同一线、同一把，
 * 并且这一把仍然有效（未撤回）。文件服务最后一次异步等待之后、同步写索引之前
 * 调用，迟到的复制不会提交到已退出/无效的上下文。
 */
function defaultVerifyContext(request) {
  const input = request || {};
  let store;
  let loaded;
  try {
    store = require('./training-store.js');
    loaded = store.loadState();
  } catch (error) {
    return fail('archive-mismatch', '读取本机训练档案失败，这次视频操作没有提交；原视频仍可用');
  }
  if (!loaded.ok) {
    return fail('context-invalid', '本机训练档案暂时读不出来，这次视频操作没有提交；原视频仍可用');
  }
  const archive = loaded.archive;
  if (archive.archiveId !== input.archiveId) {
    return fail(
      'archive-mismatch',
      '本机档案已经更换，这次迟到的视频操作没有提交；请重新打开这一把再试'
    );
  }
  const session = (archive.sessions || []).find(item => item.id === input.sessionId);
  const route = (archive.routes || []).find(item => item.id === input.routeId);
  const attempt = (archive.attempts || []).find(item => item.id === input.attemptId);
  if (!session || !route || !attempt) {
    return fail(
      'context-invalid',
      '这一把已经不在本机档案里，这次视频操作没有提交；原视频仍可用'
    );
  }
  if (attempt.sessionId !== session.id || attempt.routeId !== route.id) {
    return fail(
      'context-invalid',
      '这一把的归属已经变化，这次视频操作没有提交；原视频仍可用'
    );
  }
  if (!store.isEffectiveAttempt(attempt)) {
    return fail(
      'context-invalid',
      '这一把已经撤回，这次视频操作没有提交；恢复之后可以重新选择原片'
    );
  }
  return null;
}

function createAttemptVideoStore(options) {
  const config = options || {};
  const archiveId = isSafeArchiveId(config.archiveId) ? config.archiveId : '';
  const files = config.files;
  const storage = config.storage || createWxStorage(config.wxApi);
  const now =
    typeof config.now === 'function' ? config.now : () => new Date().toISOString();
  const policy = resolveVideoSpacePolicy(config.space);
  // 可选的本机档案核对：换档之后到达的写入在这里被挡住，一个字节都不写。
  const verifyArchive =
    typeof config.verifyArchive === 'function' ? config.verifyArchive : defaultVerifyArchive;
  const verifyContext =
    config.verifyContext === null
      ? null
      : typeof config.verifyContext === 'function'
        ? config.verifyContext
        : defaultVerifyContext;
  const instanceId =
    'video-svc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  function archiveIsCurrent() {
    if (!verifyArchive) return true;
    try {
      return verifyArchive(archiveId) === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 当前归属与有效把次核对。返回 null 表示通过，否则是一个可展示的失败结果。
   * 这是同步的（storage 读），文件服务最后一次异步等待之后、写索引之前调用。
   */
  function verifyOwnership(request) {
    if (!archiveIsCurrent()) {
      return fail(
        'archive-mismatch',
        '本机档案已经更换，这次迟到的视频操作没有提交；请重新打开这一把再试'
      );
    }
    if (!verifyContext) return null;
    let result;
    try {
      result = verifyContext(request);
    } catch (error) {
      return fail(
        'context-invalid',
        '无法核对这一把的归属，这次视频操作没有提交；原视频仍可用'
      );
    }
    if (!result || result === true || result.ok === true) return null;
    if (typeof result === 'object' && result.ok === false) return result;
    return fail('context-invalid', '这一把的归属已经变化，这次视频操作没有提交；原视频仍可用');
  }

  function validateBase(request) {
    if (!archiveId || !files) {
      return fail('missing-archive', '缺少有效的本机档案或视频文件适配器，不能保存视频');
    }
    if (!request || typeof request !== 'object') {
      return fail('incomplete-request', '视频操作请求不完整，未做任何改动');
    }
    if (request.archiveId !== archiveId) {
      return fail(
        'archive-mismatch',
        '这次视频操作属于另一份本机档案，未改动任何文件或索引'
      );
    }
    if (!archiveIsCurrent()) {
      return fail(
        'archive-mismatch',
        '本机档案已经更换，这次迟到的视频操作没有写入；请重新打开这一把再试'
      );
    }
    if (!hasText(request.sessionId) || !hasText(request.routeId) || !hasText(request.attemptId)) {
      return fail('incomplete-request', '缺少原场次、线路或把次归属，未改动任何文件或索引');
    }
    return null;
  }

  function validateSource(request) {
    if (!hasText(request.tempFilePath)) {
      return fail('missing-source', '没有可写入的视频临时文件，请重新选择原片');
    }
    return null;
  }

  // ---------------------------------------------------------------- *
  // 待清理记录
  // ---------------------------------------------------------------- *

  function pendingOf(index, fileId) {
    if (!index || !Array.isArray(index.pending)) return null;
    return index.pending.find(entry => entry.fileId === fileId) || null;
  }

  /** 一条待清理记录是否仍是「本档案 + 本片段 + 本文件」这同一份所有权证据。 */
  function pendingIdentityMatches(entry, clipId, fileId) {
    return Boolean(
      entry &&
        entry.archiveId === archiveId &&
        entry.clipId === clipId &&
        entry.fileId === fileId
    );
  }

  function pendingEntryFor(index, clipId, fileId) {
    if (!index || !Array.isArray(index.pending)) return null;
    return index.pending.find(entry => pendingIdentityMatches(entry, clipId, fileId)) || null;
  }

  function pendingRecord(clipId, fileId, opId, createdAt) {
    return {
      archiveId,
      clipId,
      fileId,
      opId: hasText(opId) ? opId : '',
      createdAt: createdAt || now()
    };
  }

  /** 写真实文件前先落一条所有权记录；写不进去就不写文件。 */
  function rememberPending(record) {
    const fresh = readIndex(storage);
    if (!fresh.ok) return fresh;
    fresh.index.pending = (fresh.index.pending || []).filter(
      entry => entry.fileId !== record.fileId
    );
    fresh.index.pending.push(record);
    const saved = saveIndex(storage, fresh.index);
    if (!saved.ok) return saved;
    return { ok: true };
  }

  /**
   * 清掉一条待清理记录；只有「本档案 + 本片段 + 本文件」完全同身份的那一条会被
   * 移除，同名文件的其他记录不动。清不掉时记录留在索引里，后续恢复可继续处理。
   */
  function forgetPending(clipId, fileId) {
    const fresh = readIndex(storage);
    if (!fresh.ok) return fresh;
    if (!pendingEntryFor(fresh.index, clipId, fileId)) return { ok: true };
    fresh.index.pending = fresh.index.pending.filter(
      entry => !pendingIdentityMatches(entry, clipId, fileId)
    );
    // 失败后回到完全没有视频资料的状态时不留下空索引键（等价于从未创建）。
    if (
      fresh.index.clips.length === 0 &&
      fresh.index.pending.length === 0 &&
      typeof storage.remove === 'function'
    ) {
      try {
        storage.remove(VIDEO_INDEX_KEY);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: 'index-write-failed',
          error: '本机视频索引清理失败：' + errorText(error)
        };
      }
    }
    return saveIndex(storage, fresh.index);
  }

  /**
   * 结清与这份删除凭据**完全同身份**（档案 + 片段 + 文件）的那一条待清理标记。
   * 文件已经确认不存在（unlink 成功但回执丢失、或重开后已不见）时，陈旧的标记
   * 不能再留给后续恢复；只按这三层身份匹配，同 fileId 的其他片段/档案记录不动。
   */
  function settleDeletedPending(clipId, fileId) {
    const fresh = readIndex(storage);
    if (!fresh.ok) return fresh;
    const before = fresh.index.pending.length;
    fresh.index.pending = (fresh.index.pending || []).filter(
      entry =>
        !(
          entry.archiveId === archiveId &&
          entry.clipId === clipId &&
          entry.fileId === fileId
        )
    );
    if (fresh.index.pending.length === before) return { ok: true };
    return saveIndex(storage, fresh.index);
  }

  /** 删除失败后把清理记录写回索引；写不进去时文件与失败原因都保留给页面。 */
  function rememberCleanup(records) {
    if (!records || !records.length) return { ok: true };
    const fresh = readIndex(storage);
    if (!fresh.ok) return fresh;
    let changed = false;
    for (const record of records) {
      if (pendingOf(fresh.index, record.fileId)) continue;
      fresh.index.pending.push(record);
      changed = true;
    }
    if (!changed) return { ok: true };
    return saveIndex(storage, fresh.index);
  }

  /**
   * 即将退役的旧副本：属于这一把、归属与路径可验证、并且在切换后的索引里已经
   * 没有任何引用的文件。记录会与引用切换写在同一次索引写入里，作为持久清理意图；
   * 不属于这一把（例如场次或线路对不上的损坏条目）一律不进入退役范围。
   */
  function retirementRecords(index, previous) {
    const referenced = new Set(
      index && Array.isArray(index.clips) ? index.clips.map(entry => entry.fileId) : []
    );
    const known = new Set(
      index && Array.isArray(index.pending) ? index.pending.map(entry => entry.fileId) : []
    );
    const records = [];
    for (const entry of previous || []) {
      if (!entry || entry.archiveId !== archiveId) continue;
      if (!hasText(entry.fileId) || referenced.has(entry.fileId) || known.has(entry.fileId)) {
        continue;
      }
      if (!usableClip(entry) || !hasText(files.pathForClip(entry))) continue;
      records.push(pendingRecord(entry.clipId, entry.fileId, 'cleanup', now()));
      known.add(entry.fileId);
    }
    return records;
  }

  /**
   * 清掉已成功回收的待清理记录。这里保留索引键（即使最后一段视频刚被移除），
   * 与「提交过就有一个可读索引」的既有语义一致。
   */
  function forgetPendingRecords(records) {
    if (!records || !records.length) return { ok: true };
    const keyOf = entry =>
      [entry.archiveId, entry.clipId, entry.fileId].join('|');
    const wanted = new Set(records.map(keyOf));
    const fresh = readIndex(storage);
    if (!fresh.ok) return fresh;
    const before = fresh.index.pending.length;
    fresh.index.pending = fresh.index.pending.filter(
      entry => !wanted.has(keyOf(entry))
    );
    if (fresh.index.pending.length === before) return { ok: true };
    return saveIndex(storage, fresh.index);
  }

  // ---------------------------------------------------------------- *
  // 占用统计（含各档案副本）
  // ---------------------------------------------------------------- *

  /**
   * 统计本小程序内可保留的视频副本实际字节：当前档案 + 索引/待清理记录里出现过的
   * 其他档案 + 共用视频根目录里实际存在的档案目录。只读，绝不删除别的档案。
   */
  async function measure(index) {
    if (!files) {
      return { ok: false, code: 'space-measure-failed', error: '缺少视频文件适配器，无法统计视频占用' };
    }
    const archiveIds = new Set();
    if (archiveId) archiveIds.add(archiveId);
    if (index && Array.isArray(index.clips)) {
      index.clips.forEach(clip => {
        if (isSafeArchiveId(clip.archiveId)) archiveIds.add(clip.archiveId);
      });
    }
    if (index && Array.isArray(index.pending)) {
      index.pending.forEach(entry => {
        if (isSafeArchiveId(entry.archiveId)) archiveIds.add(entry.archiveId);
      });
    }
    if (typeof files.listArchives === 'function') {
      const known = await files.listArchives();
      if (!known.ok) {
        return {
          ok: false,
          code: 'space-measure-failed',
          error: '读取视频根目录失败：' + (known.error || '未知错误')
        };
      }
      (known.archives || []).forEach(id => archiveIds.add(id));
    }

    const referenced = new Set(
      index && Array.isArray(index.clips) ? index.clips.map(clip => clip.fileId) : []
    );
    const owned = new Set(
      index && Array.isArray(index.pending) ? index.pending.map(entry => entry.fileId) : []
    );

    const entries = [];
    let totalBytes = 0;
    let archiveBytes = 0;
    let orphanBytes = 0;
    for (const targetArchiveId of archiveIds) {
      const listed =
        typeof files.listArchiveClips === 'function'
          ? await files.listArchiveClips(targetArchiveId)
          : targetArchiveId === archiveId
            ? await files.listClips()
            : { ok: true, files: [] };
      if (!listed.ok) {
        return {
          ok: false,
          code: 'space-measure-failed',
          error: '读取视频文件清单失败：' + (listed.error || '未知错误')
        };
      }
      for (const file of listed.files) {
        const statResult = await files.stat(file.path);
        if (!statResult.ok) {
          return {
            ok: false,
            code: 'space-measure-failed',
            error: '读取视频文件大小失败：' + (statResult.error || '未知错误')
          };
        }
        if (!statResult.exists || !(statResult.bytes > 0)) continue;
        const isReferenced = referenced.has(file.fileId);
        const isOwned = owned.has(file.fileId);
        if (!isReferenced && isOwned) orphanBytes += statResult.bytes;
        totalBytes += statResult.bytes;
        if (targetArchiveId === archiveId) archiveBytes += statResult.bytes;
        entries.push({
          archiveId: targetArchiveId,
          name: file.name,
          fileId: file.fileId,
          clipId: file.clipId,
          path: file.path,
          bytes: statResult.bytes,
          referenced: isReferenced,
          pending: isOwned
        });
      }
    }
    const usableBytes = usableBytesOf(policy);
    return {
      ok: true,
      totalBytes,
      archiveBytes,
      otherArchiveBytes: Math.max(0, totalBytes - archiveBytes),
      orphanBytes,
      entries,
      fileCount: entries.length,
      policy,
      usableBytes,
      warn: totalBytes >= policy.warnBytes,
      overBudget: totalBytes > usableBytes,
      percent: usableBytes > 0 ? Math.min(100, Math.round((totalBytes / usableBytes) * 100)) : 100,
      remainingBytes: Math.max(0, usableBytes - totalBytes)
    };
  }

  function reservedBytesExcept(path) {
    let total = 0;
    RUNTIME_WRITE_BYTES.forEach((bytes, key) => {
      if (key !== path) total += bytes;
    });
    return total;
  }

  function claimWrite(path, bytes) {
    // 同一目标路径只允许一个在途写入：两个页面同时保存同一把时，后到者安全失败，
    // 不会覆盖先到者的文件，也不会在提交前把自己的副本当成别人的引用。
    if (RUNTIME_WRITES.has(path)) return false;
    RUNTIME_WRITES.add(path);
    RUNTIME_WRITE_BYTES.set(path, nonNegativeInt(bytes));
    return true;
  }

  function releaseWrite(path) {
    RUNTIME_WRITES.delete(path);
    RUNTIME_WRITE_BYTES.delete(path);
  }

  function extensionOf(sourcePath) {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileNameOf(sourcePath));
    return match ? match[1].toLowerCase() : 'mp4';
  }

  /**
   * 选一个当前目录里不存在的目标位置。随机后缀冲突时换一个后缀，绝不删除/覆盖
   * 目录里已有的文件（那个文件没有本次操作的所有权记录）。
   */
  async function chooseTarget(seq, ext) {
    let lastError = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clipId = makeClipId(seq);
      const targetPath = files.videoPath(clipId, ext);
      const fileId = files.fileIdOf(clipId, ext);
      if (!hasText(targetPath) || !hasText(fileId)) {
        return fail('file-write-failed', '无法定位本档案的视频目录，未写入任何文件');
      }
      const existing = await files.stat(targetPath);
      if (!existing.ok) {
        return fail('file-write-failed', existing.error);
      }
      if (!existing.exists) {
        return { ok: true, clipId, seq, ext, path: targetPath, fileId };
      }
      lastError = '目标位置已有其他文件';
    }
    return fail(
      'file-write-failed',
      '没有找到可用的视频文件名（' + lastError + '），未写入任何文件；可以重试'
    );
  }

  /**
   * 本次复制失败后撤销自己写下的副本，并如实区分：
   * - copyRemoved=true：已确认删除或本来就不存在，调用方可以结清待清理凭据；
   * - copyRemoved=false：回执不明/删除失败，文件可能还在，凭据必须保留。
   */
  async function discardFailedCopy(targetPath) {
    const removed = await files.remove(targetPath);
    if (removed.ok) return { copyRemoved: true, cleanupError: '' };
    return {
      copyRemoved: false,
      keptCopy: true,
      cleanupError: removed.error || '本次副本清理失败',
      copyExists: removed.exists === undefined ? null : removed.exists
    };
  }

  function keptCopySuffix(cleanup, removedText) {
    if (cleanup.copyRemoved !== false) return removedText;
    return '；本次副本暂时保留，已保留待清理凭据，稍后可重试清理';
  }

  /**
   * 写新副本并核对：目录就绪、复制成功、目标存在且字节真实有效、与来源字节一致
   * （来源能读到大小时）。返回的 bytes 就是索引要记录的实际字节。
   * 目标位置只由 chooseTarget 选出的空位置；失败时只撤销本次复制写下的文件。
   * 撤销本身失败时保留待清理凭据，绝不因为「没删掉」而丢掉所有权证据。
   */
  async function writeCopy(targetPath, sourcePath, expectedBytes) {
    const ready = await files.ensureReady();
    if (!ready.ok) {
      return { ok: false, code: 'file-write-failed', error: ready.error, copyRemoved: true };
    }

    const copied = await files.copyFile(sourcePath, targetPath);
    if (!copied.ok) {
      const cleanup = await discardFailedCopy(targetPath);
      return Object.assign(
        {
          ok: false,
          code: isSpaceError(copied.error) ? 'space-insufficient' : 'file-write-failed',
          error: isSpaceError(copied.error)
            ? '本机空间不足（' +
              copied.error +
              '）；没有提交这段视频，原视频和记录都还在' +
              keptCopySuffix(cleanup, '')
            : '视频文件写入失败：' +
              copied.error +
              '；原视频与记录未改动，可以重试' +
              keptCopySuffix(cleanup, '')
        },
        cleanup
      );
    }

    const statResult = await files.stat(targetPath);
    if (!statResult.ok || !statResult.exists || !(statResult.bytes > 0)) {
      const cleanup = await discardFailedCopy(targetPath);
      return Object.assign(
        {
          ok: false,
          code: isSpaceError(statResult.error) ? 'space-insufficient' : 'file-write-failed',
          error:
            '视频文件写入后核对失败：' +
            (statResult.ok ? '文件为空或不存在' : statResult.error) +
            keptCopySuffix(cleanup, '；已撤销这次写入') +
            '；原视频与记录未改动'
        },
        cleanup
      );
    }
    if (expectedBytes > 0 && statResult.bytes !== expectedBytes) {
      const cleanup = await discardFailedCopy(targetPath);
      return Object.assign(
        {
          ok: false,
          code: 'file-write-failed',
          error:
            '视频文件写入后的实际大小（' +
            statResult.bytes +
            ' B）与来源（' +
            expectedBytes +
            ' B）不一致' +
            keptCopySuffix(cleanup, '，已撤销这次写入') +
            '；原视频与记录未改动'
        },
        cleanup
      );
    }
    const readable = await files.access(targetPath);
    if (!readable.ok) {
      const cleanup = await discardFailedCopy(targetPath);
      return Object.assign(
        {
          ok: false,
          code: 'file-write-failed',
          error:
            readable.error +
            keptCopySuffix(cleanup, '；已撤销这次写入') +
            '；原视频与记录未改动'
        },
        cleanup
      );
    }
    return { ok: true, bytes: statResult.bytes };
  }

  async function sourceBytesOf(request) {
    const statResult = await files.stat(request.tempFilePath);
    if (statResult.ok && statResult.exists && statResult.bytes > 0) {
      return { ok: true, bytes: statResult.bytes };
    }
    const hinted = safeNumber(request.sizeBytes);
    if (hinted !== null && hinted > 0) {
      return { ok: true, bytes: Math.floor(hinted) };
    }
    return {
      ok: false,
      code: 'source-unreadable',
      error: '读取待保存视频的大小失败，请重新从相册选择原片'
    };
  }

  function spaceFailure(spaceCheck) {
    return {
      ok: false,
      code: 'space-insufficient',
      error: spaceCheck.message,
      space: {
        reason: spaceCheck.reason,
        policy: spaceCheck.policy,
        totalBytes: spaceCheck.totalBytes,
        newBytes: spaceCheck.newBytes,
        peakBytes: spaceCheck.peakBytes,
        usableBytes: spaceCheck.usableBytes,
        budgetBytes: spaceCheck.policy.budgetBytes,
        warnBytes: spaceCheck.policy.warnBytes,
        photoReserveBytes: spaceCheck.policy.photoReserveBytes,
        reserveBytes: spaceCheck.policy.reserveBytes,
        maxClipBytes: spaceCheck.policy.maxClipBytes
      }
    };
  }

  /**
   * 删除本次操作自己写下、且读回索引确认没有任何引用的新副本。
   * 读回失败时**不删**：保留文件与已有的待清理记录，等后续可证实处置。
   */
  async function discardOwnCopy(index, target) {
    if (!index || !Array.isArray(index.clips)) {
      return { ok: false, error: '无法读回索引确认无引用，已保留本次新副本' };
    }
    if (index.clips.some(entry => entry.fileId === target.fileId)) {
      return { ok: false, error: '索引仍引用本次文件，未删除' };
    }
    const removed = await files.remove(target.path);
    if (!removed.ok) {
      return {
        ok: false,
        error: removed.error || '本次新副本清理失败',
        keptCopy: true
      };
    }
    await forgetPending(target.clipId, target.fileId);
    return { ok: true };
  }

  /** 索引写抛错后读回：返回 null（读回失败）或 {index, clip(本次条目或 null)}。 */
  function readbackFor(clip) {
    const read = readIndex(storage);
    if (!read.ok) return null;
    const match = read.index.clips.find(
      entry =>
        entry.archiveId === clip.archiveId &&
        entry.attemptId === clip.attemptId &&
        entry.sessionId === clip.sessionId &&
        entry.routeId === clip.routeId &&
        entry.clipId === clip.clipId &&
        entry.fileId === clip.fileId
    );
    return { index: read.index, clip: match || null };
  }

  /**
   * 提交成功后回收旧副本：只回收索引曾经引用过、现在已无引用的文件。
   * 退役记录的清理意图已在本次引用切换的同一个索引写里落盘；这里**先删除、后结清**
   * 记录：只有删除成功或复核确认文件已不存在时，才按同一身份移除 pending。
   * 删除失败/回执不明时记录继续留在索引里，重启后由 recover 继续安全回收。
   */
  async function reclaimCopies(index, previous) {
    const referenced = new Set(
      index && Array.isArray(index.clips) ? index.clips.map(entry => entry.fileId) : []
    );
    const candidates = [];
    let cleanupError = '';
    for (const entry of previous || []) {
      if (!hasText(entry.fileId) || referenced.has(entry.fileId)) continue;
      const targetPath = files.pathForClip(entry);
      if (!hasText(targetPath)) {
        cleanupError = '旧副本位置不属于本档案视频目录，未删除';
        continue;
      }
      candidates.push({ entry, targetPath });
    }
    if (!candidates.length) return cleanupError;

    const settled = [];
    const failed = [];
    for (const item of candidates) {
      const removed = await files.remove(item.targetPath);
      if (removed.ok) {
        // 删除成功或复核确认已缺失：这是唯一可以结清凭据的时机。
        settled.push(item.entry);
        continue;
      }
      cleanupError = removed.error;
      failed.push(
        pendingRecord(item.entry.clipId, item.entry.fileId, 'cleanup', now())
      );
    }
    if (settled.length) {
      const cleared = forgetPendingRecords(settled);
      if (!cleared.ok && !cleanupError) cleanupError = cleared.error;
    }
    if (failed.length) {
      const remembered = rememberCleanup(failed);
      if (!remembered.ok && !cleanupError) cleanupError = remembered.error;
    }
    return cleanupError;
  }

  /**
   * 首次保存。重复确认（同一次操作的重试、另一个页面的迟到点击）不会产生
   * 第二份副本：这一把已经有片段时直接按已有片段返回，不写文件、不改索引。
   *
   * 写文件前先落待清理记录；提交前读回索引并重新核对四个 ID 与有效把次。
   * 索引写抛错时按读回判断：本次条目已经落盘算成功（receiptLost），明确没有
   * 引用本次文件才撤销副本，读不回来则保留存疑副本与记录。
   */
  async function commit(request) {
    const input = request || {};
    const invalid = validateBase(input) || validateSource(input);
    if (invalid) return invalid;

    // 从校验通过到 finally 之间，这一场都算「有视频变更在途」：整场删除协调器
    // 会据此要求在途操作先结束。键只含档案 + 场次，其他场次不受影响。
    const mutationKey = beginSessionMutation(archiveId, input.sessionId);
    try {
      return await runCommit(input);
    } finally {
      endSessionMutation(mutationKey);
    }
  }

  async function runCommit(input) {
    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const existing = currentClipFor(loaded.index, archiveId, input.attemptId, input);
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        clip: cloneClip(existing),
        cleanupError: ''
      };
    }

    const source = await sourceBytesOf(input);
    if (!source.ok) return source;

    const target = await chooseTarget(loaded.index.nextClipSeq, extensionOf(input.tempFilePath));
    if (!target.ok) return target;
    if (!claimWrite(target.path, source.bytes)) {
      return fail(
        'operation-in-progress',
        '同一段视频正在保存，请稍候再试；没有产生第二份副本'
      );
    }
    try {
      const used = await measure(loaded.index);
      if (!used.ok) return used;
      const spaceCheck = checkClipSpace(
        used.totalBytes + reservedBytesExcept(target.path),
        source.bytes,
        policy
      );
      if (!spaceCheck.ok) return spaceFailure(spaceCheck);

      const claimed = rememberPending(
        pendingRecord(target.clipId, target.fileId, input.opId, now())
      );
      if (!claimed.ok) return claimed;

      const written = await writeCopy(target.path, input.tempFilePath, source.bytes);
      if (!written.ok) {
        // 只有确认本次副本已经删除/不存在时才清掉所有权记录；撤销失败时凭据
        // 必须留着，后续 cleanupOrphans / recover 才能继续回收这个失败副本。
        if (written.copyRemoved !== false) {
          await forgetPending(target.clipId, target.fileId);
        }
        return written;
      }

      // 提交前重读索引：等待期间这一把可能被另一个页面写入，或索引被改坏。
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        return Object.assign({}, fresh, { keptCopy: true, cleanupError: '' });
      }
      const won = currentClipFor(fresh.index, archiveId, input.attemptId, input);
      if (won) {
        const discarded = await discardOwnCopy(fresh.index, target);
        return {
          ok: true,
          duplicate: true,
          clip: cloneClip(won),
          cleanupError: discarded.ok ? '' : discarded.error || ''
        };
      }

      // 文件服务最后一次异步等待之后、同步写索引之前：按四个原 ID 与有效把次再核对。
      const lost = verifyOwnership(input);
      if (lost) {
        const discarded = await discardOwnCopy(fresh.index, target);
        return Object.assign({}, lost, {
          cleanupError: discarded.ok ? '' : discarded.error || ''
        });
      }

      const clip = {
        clipId: target.clipId,
        archiveId,
        sessionId: input.sessionId,
        routeId: input.routeId,
        attemptId: input.attemptId,
        attemptSeq: safeNumber(input.attemptSeq),
        rev: 1,
        fileId: target.fileId,
        bytes: written.bytes,
        durationSeconds: safeNumber(input.durationSeconds),
        width: safeNumber(input.width),
        height: safeNumber(input.height),
        fileName: hasText(input.fileName) ? input.fileName : fileNameOf(input.tempFilePath),
        opId: hasText(input.opId) ? input.opId : '',
        createdAt: now()
      };
      fresh.index.pending = (fresh.index.pending || []).filter(
        entry => entry.fileId !== target.fileId
      );
      fresh.index.clips.push(clip);
      // 等待写入期间另一个页面可能已经用掉更大的序号：向上取整，绝不把计数写小。
      fresh.index.nextClipSeq = Math.max(fresh.index.nextClipSeq, target.seq + 1);
      const saved = saveIndex(storage, fresh.index);
      if (saved.ok) {
        return {
          ok: true,
          duplicate: false,
          clip: cloneClip(clip),
          cleanupError: ''
        };
      }

      // 索引写入抛错：回执不明确，先读回再决定。
      const readback = readbackFor(clip);
      if (!readback) {
        return Object.assign({}, saved, { keptCopy: true, cleanupError: '' });
      }
      if (readback.clip) {
        return {
          ok: true,
          duplicate: false,
          receiptLost: true,
          clip: cloneClip(readback.clip),
          cleanupError: ''
        };
      }
      const discarded = await discardOwnCopy(readback.index, target);
      return Object.assign({}, saved, {
        cleanupError: discarded.ok ? '' : discarded.error || ''
      });
    } finally {
      releaseWrite(target.path);
    }
  }

  /**
   * 更换。必须按当前归属与版本提交；新副本先写、核对、再提交索引，提交完成后
   * 才回收无引用的旧副本。取消发生在页面，本方法根本不会被调用。
   */
  async function replace(request) {
    const input = request || {};
    const invalid = validateBase(input) || validateSource(input);
    if (invalid) return invalid;

    const mutationKey = beginSessionMutation(archiveId, input.sessionId);
    try {
      return await runReplace(input);
    } finally {
      endSessionMutation(mutationKey);
    }
  }

  async function runReplace(input) {
    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId, input);
    if (!current) {
      return fail(
        'stale-operation',
        '这一把当前没有已保存的视频，请重新选择原片后再更换；未改动任何文件或索引'
      );
    }
    if (!sameClipIdentity(current, input) || (hasText(input.fileId) && input.fileId !== current.fileId)) {
      return fail(
        'stale-operation',
        '这一把的视频关联已经变化，这次更换没有采用；请刷新后再试，原视频仍可用'
      );
    }

    const source = await sourceBytesOf(input);
    if (!source.ok) return source;

    const target = await chooseTarget(loaded.index.nextClipSeq, extensionOf(input.tempFilePath));
    if (!target.ok) return target;
    if (!claimWrite(target.path, source.bytes)) {
      return fail(
        'operation-in-progress',
        '同一段视频正在写入，请稍候再试；原视频仍可用'
      );
    }
    try {
      const used = await measure(loaded.index);
      if (!used.ok) return used;
      const spaceCheck = checkClipSpace(
        used.totalBytes + reservedBytesExcept(target.path),
        source.bytes,
        policy
      );
      if (!spaceCheck.ok) return spaceFailure(spaceCheck);

      const claimed = rememberPending(
        pendingRecord(target.clipId, target.fileId, input.opId, now())
      );
      if (!claimed.ok) return claimed;

      const written = await writeCopy(target.path, input.tempFilePath, source.bytes);
      if (!written.ok) {
        if (written.copyRemoved !== false) {
          await forgetPending(target.clipId, target.fileId);
        }
        return written;
      }

      const fresh = readIndex(storage);
      if (!fresh.ok) {
        return Object.assign({}, fresh, { keptCopy: true, cleanupError: '' });
      }
      const stillCurrent = currentClipFor(fresh.index, archiveId, input.attemptId, input);
      if (!sameClipIdentity(stillCurrent, input) || stillCurrent.clipId !== current.clipId) {
        const discarded = await discardOwnCopy(fresh.index, target);
        return Object.assign(
          fail(
            'stale-operation',
            '提交前发现这一把的视频关联已经变化，这次更换没有提交；原视频仍可用'
          ),
          { cleanupError: discarded.ok ? '' : discarded.error || '' }
        );
      }

      // 文件服务最后一次异步等待之后、同步写索引之前：按四个原 ID 与有效把次再核对。
      const lost = verifyOwnership(input);
      if (lost) {
        const discarded = await discardOwnCopy(fresh.index, target);
        return Object.assign({}, lost, {
          cleanupError: discarded.ok ? '' : discarded.error || ''
        });
      }

      const previous = clipsFor(fresh.index, archiveId, input.attemptId, input);
      const clip = {
        clipId: target.clipId,
        archiveId,
        sessionId: input.sessionId,
        routeId: input.routeId,
        attemptId: input.attemptId,
        attemptSeq: safeNumber(input.attemptSeq),
        rev: revOf(current) + 1,
        fileId: target.fileId,
        bytes: written.bytes,
        durationSeconds: safeNumber(input.durationSeconds),
        width: safeNumber(input.width),
        height: safeNumber(input.height),
        fileName: hasText(input.fileName) ? input.fileName : fileNameOf(input.tempFilePath),
        opId: hasText(input.opId) ? input.opId : '',
        createdAt: now()
      };
      fresh.index.pending = (fresh.index.pending || []).filter(
        entry => entry.fileId !== target.fileId
      );
      // 只撤销这一把（四个原 ID 全部对上）的旧引用；损坏索引里场次或线路不符的
      // 条目保留原样，它的文件也不在这把的退役范围内。
      fresh.index.clips = fresh.index.clips.filter(
        entry => !sameAttemptEntry(entry, archiveId, input)
      );
      fresh.index.clips.push(clip);
      // 退役旧副本的清理意图与本次新引用写在同一次索引写里：即使这次写入抛错、
      // 服务与页面的读回都暂时失败，重启后 recover 仍能凭持久记录回收旧副本，
      // 并保留索引里的当前片。
      fresh.index.pending.push.apply(
        fresh.index.pending,
        retirementRecords(fresh.index, previous)
      );
      // 等待写入期间另一个页面可能已经用掉更大的序号：向上取整，绝不把计数写小。
      fresh.index.nextClipSeq = Math.max(fresh.index.nextClipSeq, target.seq + 1);
      const saved = saveIndex(storage, fresh.index);
      if (saved.ok) {
        const cleanupError = await reclaimCopies(fresh.index, previous);
        return {
          ok: true,
          duplicate: false,
          clip: cloneClip(clip),
          cleanupError
        };
      }

      // 索引写入抛错：只有读回确认本次片段已落盘才按成功处理，并继续按读回索引
      // 回收无引用旧副本；读不回来时保留存疑的新旧副本。
      const readback = readbackFor(clip);
      if (!readback) {
        return Object.assign({}, saved, { keptCopy: true, cleanupError: '' });
      }
      if (readback.clip) {
        const cleanupError = await reclaimCopies(readback.index, previous);
        return {
          ok: true,
          duplicate: false,
          receiptLost: true,
          clip: cloneClip(readback.clip),
          cleanupError
        };
      }
      const discarded = await discardOwnCopy(readback.index, target);
      return Object.assign({}, saved, {
        cleanupError: discarded.ok ? '' : discarded.error || ''
      });
    } finally {
      releaseWrite(target.path);
    }
  }

  /**
   * 移除：核对当前片段版本 → 先解除索引关联 → 再回收小程序内副本。
   * 索引写失败时关联与文件都保持原样；只有读回明确显示指定版本已解除关联时
   * 才回收副本。文件删除失败时关联已移除，返回 cleanupError 并留下待清理记录。
   */
  async function remove(request) {
    const input = request || {};
    const invalid = validateBase(input);
    if (invalid) return invalid;

    const mutationKey = beginSessionMutation(archiveId, input.sessionId);
    try {
      return await runRemove(input);
    } finally {
      endSessionMutation(mutationKey);
    }
  }

  async function runRemove(input) {
    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId, input);
    if (!current) {
      return { ok: true, removed: true, duplicate: true, clip: null, cleanupError: '' };
    }
    if (!sameClipIdentity(current, input) || (hasText(input.fileId) && input.fileId !== current.fileId)) {
      return fail(
        'stale-operation',
        '这一把的视频关联已经变化，这次移除没有执行；请刷新后再试，原视频仍可用'
      );
    }

    // 这里是同步路径，没有异步等待；仍然在同一位置核对一次归属，防止旧页面迟到。
    const lost = verifyOwnership(input);
    if (lost) return lost;

    const previous = clipsFor(loaded.index, archiveId, input.attemptId, input);
    // 只解除这一把（四个原 ID 全部对上）的关联；丢失归属的损坏条目保持原样。
    loaded.index.clips = loaded.index.clips.filter(
      entry => !sameAttemptEntry(entry, archiveId, input)
    );
    // 退役副本的清理意图与本次解除关联写在同一次索引写里：写入抛错且读回暂时
    // 失败时文件全部保留，重启后 recover 再凭持久记录回收。
    loaded.index.pending.push.apply(
      loaded.index.pending,
      retirementRecords(loaded.index, previous)
    );
    const saved = saveIndex(storage, loaded.index);
    if (saved.ok) {
      const cleanupError = await reclaimCopies(loaded.index, previous);
      return { ok: true, removed: true, duplicate: false, clip: null, cleanupError };
    }

    // 索引写入抛错：读回判断指定版本是否已经明确解除关联。
    const read = readIndex(storage);
    if (!read.ok) {
      return Object.assign({}, saved, {
        cleanupError: '无法读回本机视频索引，未删除任何文件；请稍后重新进入本页核对'
      });
    }
    const after = currentClipFor(read.index, archiveId, input.attemptId, input);
    if (!after) {
      // 解除关联已经落盘：只回收不再被引用的指定版本副本。
      const cleanupError = await reclaimCopies(read.index, previous);
      return {
        ok: true,
        removed: true,
        duplicate: false,
        receiptLost: true,
        clip: null,
        cleanupError
      };
    }
    if (sameClipIdentity(after, input)) {
      return saved;
    }
    return Object.assign({}, saved, {
      cleanupError: '这一把的视频关联已经变化，未删除任何文件'
    });
  }

  // ---------------------------------------------------------------- *
  // 手工时间点（T025）：同步读改写同一个索引
  // ---------------------------------------------------------------- *

  /**
   * 记下一个时间点。
   *
   * 与文件操作不同，这里**没有异步等待**：读索引、核对当前归属与片段版本、
   * 改这一条片段的 markers、写回，都在同一次同步调用里完成，窗口内不会被另一段
   * 异步清理拿旧快照覆盖。只写索引里的可选字段，不创建、不删除任何媒体文件。
   *
   * - 只接受当前归属（四个原 ID）下、当前片段同一 clipId/rev/fileId 的请求；
   * - atMs 必须是整数毫秒且不超过可用时长（0 秒合法）；时长同时参考本次原生回报
   *   与当前片段已知时长，两处都没有有效时长时拒绝，过期/伪造的更长时长不能越界；
   * - 同一个 markerId 重复提交（失败重试、回执丢失后的重试）只保留一个点；
   * - 索引写抛错时读回判断：本次标记已落盘按成功（receiptLost），读不回则保留
   *   现有时间点并返回失败，页面用同一 markerId 重试。
   */
  function addMarker(request) {
    const input = request || {};
    const invalid = validateBase(input);
    if (invalid) return invalid;
    if (!hasText(input.clipId) || !hasText(input.fileId) || requestedRev(input.rev) === null) {
      return fail('incomplete-request', '时间点请求缺少片段身份，未改动任何数据');
    }
    if (!attemptVideoMarkers.isMarkerId(input.markerId)) {
      return fail('incomplete-request', '时间点请求缺少操作身份，未改动任何数据');
    }
    const atMs = attemptVideoMarkers.normalizeAtMs(input.atMs);
    if (atMs === null) {
      return fail('invalid-time', '时间点不是有效的整数毫秒，未改动任何数据');
    }

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId, input);
    const stale = markerTargetError(current, input);
    if (stale) return stale;

    // 复核时长：请求里的原生读数与索引里的已知时长互为补充。
    // 旧索引没有 durationSeconds 时接受有效原生回报；两处都没有则拒绝写点。
    const durationLimit = attemptVideoMarkers.markerDurationLimit(
      input.durationSeconds,
      current.durationSeconds
    );
    if (!durationLimit.ok) {
      return fail(durationLimit.code, durationLimit.error);
    }
    if (atMs > durationLimit.limitMs) {
      return fail('invalid-time', '时间点超出视频时长，未写入任何时间点');
    }

    // 落盘前（包括幂等重试的读回）再核对一次当前归属与有效把次；
    // 同步路径没有 await，仍在同一窗口。
    const lost = verifyOwnership(input);
    if (lost) return lost;

    const existing = (current.markers || []).find(marker => marker.id === input.markerId);
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        receiptLost: false,
        marker: cloneMarker(existing),
        clip: cloneClip(current)
      };
    }

    const marker = {
      id: input.markerId,
      atMs,
      clipId: current.clipId,
      rev: revOf(current),
      createdAt: now()
    };
    current.markers = attemptVideoMarkers.normalizeMarkers(
      (current.markers || []).concat(marker),
      current
    );
    const saved = saveIndex(storage, loaded.index);
    if (saved.ok) {
      return {
        ok: true,
        duplicate: false,
        receiptLost: false,
        marker: cloneMarker(marker),
        clip: cloneClip(current)
      };
    }

    // 索引写抛错：读回判断是「写前失败」还是「已落盘但回执丢失」。
    const readback = readIndex(storage);
    if (!readback.ok) {
      return Object.assign({}, saved, {
        markerUnconfirmed: true,
        error: saved.error + '；也无法读回索引确认本次时间点，请用同一次动作重试'
      });
    }
    const after = currentClipFor(readback.index, archiveId, input.attemptId, input);
    const afterStale = markerTargetError(after, input);
    if (afterStale) return afterStale;
    const landed = (after.markers || []).find(item => item.id === input.markerId);
    if (landed) {
      return {
        ok: true,
        duplicate: false,
        receiptLost: true,
        marker: cloneMarker(landed),
        clip: cloneClip(after)
      };
    }
    return Object.assign({}, saved, {
      clip: cloneClip(after),
      markers: (after.markers || []).map(cloneMarker)
    });
  }

  /**
   * 移除一个时间点。只按 markerId 删除当前片段里的那一条；其他点、其他片段、
   * 其他把次都不动。markerId 不存在时按「已移除」返回（重试幂等）。
   * 同样在同步读改写里完成，并在索引写抛错时读回判断。
   */
  function removeMarker(request) {
    const input = request || {};
    const invalid = validateBase(input);
    if (invalid) return invalid;
    if (!hasText(input.clipId) || !hasText(input.fileId) || requestedRev(input.rev) === null) {
      return fail('incomplete-request', '时间点请求缺少片段身份，未改动任何数据');
    }
    if (!attemptVideoMarkers.isMarkerId(input.markerId)) {
      return fail('incomplete-request', '时间点请求缺少操作身份，未改动任何数据');
    }

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId, input);
    const stale = markerTargetError(current, input);
    if (stale) return stale;

    const lost = verifyOwnership(input);
    if (lost) return lost;

    const markers = current.markers || [];
    if (!markers.some(marker => marker.id === input.markerId)) {
      return {
        ok: true,
        removed: true,
        duplicate: true,
        receiptLost: false,
        clip: cloneClip(current)
      };
    }

    current.markers = markers
      .filter(marker => marker.id !== input.markerId)
      .map(marker => Object.assign({}, marker));
    const saved = saveIndex(storage, loaded.index);
    if (saved.ok) {
      return {
        ok: true,
        removed: true,
        duplicate: false,
        receiptLost: false,
        clip: cloneClip(current)
      };
    }

    const readback = readIndex(storage);
    if (!readback.ok) {
      return Object.assign({}, saved, {
        markerUnconfirmed: true,
        error: saved.error + '；也无法读回索引确认本次移除，请重试'
      });
    }
    const after = currentClipFor(readback.index, archiveId, input.attemptId, input);
    const afterStale = markerTargetError(after, input);
    if (afterStale) return afterStale;
    if ((after.markers || []).every(marker => marker.id !== input.markerId)) {
      return {
        ok: true,
        removed: true,
        duplicate: false,
        receiptLost: true,
        clip: cloneClip(after)
      };
    }
    return Object.assign({}, saved, {
      clip: cloneClip(after)
    });
  }

  /**
   * 无引用副本清理：只处理本档案视频目录里、当前索引不再引用、并且能证实由本功能
   * 创建的文件——即出现在持久待清理记录（pending）里的相对文件标识。
   * 仅仅命名合法但没有所有权记录的 clip-* 文件保留不动，只计入实际占用。
   *
   * T057：目录快照只是开始时的观察，不是「文件不存在」的证据。目标不在快照里时，
   * 先看同运行期是否有在途写入，再 stat 复核；只有确认缺失（或 unlink 成功）才
   * 结清 pending。快照之后才发布、状态未知或在途写入的副本都保留凭据，并如实
   * 返回 deleted / settled / preserved 与实际 pendingCount。
   */
  async function cleanupOrphans() {
    const loaded = readIndex(storage);
    if (!loaded.ok) {
      return Object.assign({}, loaded, {
        deleted: [],
        deletedCount: 0,
        settled: [],
        settledCount: 0,
        preserved: [],
        preservedCount: 0,
        pendingCount: 0
      });
    }
    const listed = await files.listClips();
    if (!listed.ok) {
      return Object.assign(
        fail('cleanup-failed', '读取视频目录失败，未删除任何文件：' + listed.error),
        {
          deleted: [],
          deletedCount: 0,
          settled: [],
          settledCount: 0,
          preserved: [],
          preservedCount: 0,
          pendingCount: (loaded.index.pending || []).filter(
            entry => entry.archiveId === archiveId
          ).length
        }
      );
    }

    const present = new Set(listed.files.map(file => file.fileId));
    const deleted = [];
    const settled = [];
    const preserved = [];
    const errors = [];

    function preserve(fileId, path, exists, reason) {
      preserved.push({ fileId, path, exists, reason });
    }

    // 快照里没有本档案的待清理目标：不能直接清记录。复核在途写入与实际存在性。
    const stalePending = (loaded.index.pending || []).filter(
      entry => entry.archiveId === archiveId && !present.has(entry.fileId)
    );
    for (const entry of stalePending) {
      const targetPath = files.pathForFileId(entry.fileId);
      if (!hasText(targetPath)) {
        preserve(entry.fileId, '', null, 'foreign-path');
        continue;
      }
      if (RUNTIME_WRITES.has(targetPath)) {
        preserve(entry.fileId, targetPath, null, 'in-flight');
        continue;
      }
      const checked = await files.stat(targetPath);
      if (!checked.ok) {
        preserve(entry.fileId, targetPath, null, 'check-failed');
        errors.push(checked.error);
        continue;
      }
      if (checked.exists) {
        // 目录快照拍完之后才发布出来的副本：凭据必须留着等下一轮清理。
        preserve(entry.fileId, targetPath, true, 'published-after-snapshot');
        continue;
      }
      // 确认缺失后再按同一身份核对一次索引与在途登记，然后才结清记录。
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        preserve(entry.fileId, targetPath, false, 'index-read-failed');
        errors.push(fresh.error);
        continue;
      }
      if (RUNTIME_WRITES.has(targetPath)) {
        preserve(entry.fileId, targetPath, false, 'in-flight');
        continue;
      }
      if (fresh.index.clips.some(item => item.fileId === entry.fileId)) {
        // 文件已缺失但索引刚引用它：交给缺失副本展示，不在这里删记录。
        continue;
      }
      if (!pendingEntryFor(fresh.index, entry.clipId, entry.fileId)) continue;
      fresh.index.pending = fresh.index.pending.filter(
        item => !pendingIdentityMatches(item, entry.clipId, entry.fileId)
      );
      const saved = saveIndex(storage, fresh.index);
      if (!saved.ok) {
        errors.push(saved.error);
        preserve(entry.fileId, targetPath, false, 'settle-failed');
      } else {
        settled.push(entry.fileId);
      }
    }

    for (const file of listed.files) {
      if (RUNTIME_WRITES.has(file.path)) continue;
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        errors.push(fresh.error);
        break;
      }
      if (fresh.index.clips.some(entry => entry.fileId === file.fileId)) continue;
      // 只认「本档案 + 本片段 + 本文件」完全同身份的所有权记录。
      if (!pendingEntryFor(fresh.index, file.clipId, file.fileId)) continue;
      const removed = await files.remove(file.path);
      if (!removed.ok) {
        errors.push(removed.error);
        preserve(
          file.fileId,
          file.path,
          removed.exists === undefined ? null : removed.exists,
          'unlink-failed'
        );
        continue;
      }
      if (removed.existed) deleted.push(file.path);
      else settled.push(file.fileId);
      const after = readIndex(storage);
      if (!after.ok) {
        errors.push(after.error);
        continue;
      }
      // 等待删除期间同一文件可能被重新登记：只结清仍同身份的那一条。
      if (!pendingEntryFor(after.index, file.clipId, file.fileId)) continue;
      after.index.pending = after.index.pending.filter(
        entry => !pendingIdentityMatches(entry, file.clipId, file.fileId)
      );
      const saved = saveIndex(storage, after.index);
      if (!saved.ok) errors.push(saved.error);
    }

    const finalIndex = readIndex(storage);
    const pendingCount = (
      finalIndex.ok ? finalIndex.index : loaded.index
    ).pending.filter(entry => entry.archiveId === archiveId).length;
    const result = {
      deleted,
      deletedCount: deleted.length,
      settled,
      settledCount: settled.length,
      preserved,
      preservedCount: preserved.length,
      pendingCount
    };
    if (errors.length) {
      return Object.assign(
        {
          ok: false,
          code: 'cleanup-failed',
          error: '无引用副本未完全清理：' + errors.join('；')
        },
        result
      );
    }
    return Object.assign({ ok: true }, result);
  }

  /**
   * 打开页面 / 冷启动恢复：索引不可读时一个文件也不删；索引可读时只清理
   * 能确认由本功能创建且无引用的文件，并报告索引里缺失的副本（不删索引条目，
   * 缺文件的把次仍可看记录并重新选择）。
   */
  async function recover() {
    const loaded = readIndex(storage);
    if (!loaded.ok) {
      return {
        ok: false,
        code: loaded.code,
        error: loaded.error,
        deleted: [],
        deletedCount: 0,
        settled: [],
        settledCount: 0,
        preserved: [],
        preservedCount: 0,
        pendingCount: 0,
        missing: []
      };
    }
    const cleanup = await cleanupOrphans();
    if (!cleanup.ok) {
      return Object.assign({}, cleanup, { missing: [] });
    }
    const fresh = readIndex(storage);
    const index = fresh.ok ? fresh.index : loaded.index;
    const missing = [];
    if (files) {
      for (const clip of index.clips) {
        if (clip.archiveId !== archiveId) continue;
        const targetPath = files.pathForClip(clip);
        const statResult = targetPath ? await files.stat(targetPath) : { ok: false, exists: false };
        if (!statResult.ok || !statResult.exists || !(statResult.bytes > 0)) {
          missing.push({ clipId: clip.clipId, attemptId: clip.attemptId, fileId: clip.fileId });
        }
      }
    }
    return {
      ok: true,
      deleted: cleanup.deleted || [],
      deletedCount: cleanup.deletedCount || 0,
      settled: cleanup.settled || [],
      settledCount: cleanup.settledCount || 0,
      preserved: cleanup.preserved || [],
      preservedCount: cleanup.preservedCount || 0,
      pendingCount: cleanup.pendingCount || 0,
      missing
    };
  }

  /** 本档案视频占用：按实际文件字节，含各档案副本与无引用副本。 */
  async function getSpaceUsage() {
    const loaded = readIndex(storage);
    const measured = await measure(loaded.ok ? loaded.index : null);
    if (!measured.ok) return measured;
    const clips = loaded.ok
      ? loaded.index.clips.filter(clip => clip.archiveId === archiveId)
      : [];
    return Object.assign({}, measured, {
      // 索引不可读时无法判断哪些文件无引用：不把全部文件报成可清理，避免误导。
      orphanBytes: loaded.ok ? measured.orphanBytes : 0,
      clipCount: clips.length,
      otherArchiveClips: loaded.ok
        ? loaded.index.clips.filter(clip => clip.archiveId !== archiveId).length
        : 0,
      indexOk: loaded.ok,
      indexError: loaded.ok ? '' : loaded.error
    });
  }

  /**
   * 删除把次记录后的定向回收（T048–T050 追加返工）。
   *
   * 记录已经从档案里物理移出，默认的 verifyContext 会因为「找不到这一把」而拒绝；这里
   * 改用**持久删除凭据**作为授权（调用方只应传入重开后可复核的 journal 证据）。凭据必须
   * 带齐档案、场次、线路、把次四个原 ID 与片段的 clipId/rev/fileId，且文件标识严格落在
   * 本档案视频目录、是同一片段文件。只移除与凭据完全一致的那一条引用：
   * - 索引里同一把已经换成别的片段（换版）时整条拒绝，不删任何文件；
   * - 文件仍被任何条目引用（共享引用）时保留，并以 kept/shared 作为完成态返回；
   * - 索引写失败按读回判断，读回也失败时保留文件与索引，交给持久待清理/重试；
   * - 文件删除失败时把所有权记录写回索引，后续 cleanupOrphans / 重试继续回收；
   * - 文件已确认不存在（例如 unlink 成功但回执丢失）或本次重新删除成功后，只结清
   *   与凭据同档案 + 同 clipId + 同 fileId 的那一条陈旧待清理标记。
   */
  async function removeDeletedClip(evidence) {
    const ev = evidence || {};
    const invalid = validateBase({
      archiveId: ev.archiveId,
      sessionId: ev.sessionId,
      routeId: ev.routeId,
      attemptId: ev.attemptId
    });
    if (invalid) return invalid;
    if (!hasText(ev.clipId) || !isSafeClipId(ev.clipId) || !hasText(ev.fileId)) {
      return fail('incomplete-evidence', '删除凭据缺少片段身份，未删除任何视频文件');
    }
    if (!attemptVideo.isClipFileIdFor(archiveId, ev.clipId, ev.fileId)) {
      return fail('foreign-file', '删除凭据指向的文件不属于本档案视频目录，未删除任何文件');
    }
    const wantedRev = requestedRev(ev.rev);
    if (wantedRev === null) {
      return fail('incomplete-evidence', '删除凭据缺少片段版本，未删除任何视频文件');
    }

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, ev.attemptId, ev);

    // 索引里已经没有这一把的引用：只在能证明文件属于本档案同一片段、且当前没有任何
    // 条目再引用它时，才回收凭据指出的那个文件（例如上次已解除关联但文件删除失败）。
    if (!current) {
      if (loaded.index.clips.some(entry => entry.fileId === ev.fileId)) {
        // 同一文件仍被别的记录合法引用：索引已分离，副本按设计保留（不是待清理失败）。
        const settled = settleDeletedPending(ev.clipId, ev.fileId);
        return {
          ok: true,
          removed: true,
          duplicate: false,
          kept: true,
          reason: 'shared',
          clip: null,
          cleanupError: settled.ok ? '' : settled.error
        };
      }
      if (loaded.index.clips.some(entry => sameAttemptEntry(entry, archiveId, ev))) {
        return fail('stale-operation', '这一把的视频关联已经变化，未删除任何文件；请按当前状态重试');
      }
      const targetPath = files.pathForFileId(ev.fileId);
      if (!hasText(targetPath)) {
        return fail('foreign-file', '删除凭据指向的文件不属于本档案视频目录，未删除任何文件');
      }
      const existing = await files.stat(targetPath);
      if (!existing.ok) return fail('file-cleanup-failed', existing.error);
      if (!existing.exists) {
        // 文件其实已经不在了（常见于 unlink 成功但回执丢失）：先按精确身份结清
        // 索引里的陈旧待清理标记，外层 journal 才会在本次返回后收尾。
        const settled = settleDeletedPending(ev.clipId, ev.fileId);
        return {
          ok: true,
          removed: true,
          duplicate: true,
          clip: null,
          cleanupError: settled.ok ? '' : settled.error
        };
      }
      // stat 等待期间可能有新的引用写入：删前再按最新索引确认一次。
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        return Object.assign({}, fresh, {
          cleanupError: '无法读回本机视频索引，未删除任何文件；请稍后重试'
        });
      }
      if (fresh.index.clips.some(entry => entry.fileId === ev.fileId)) {
        const settled = settleDeletedPending(ev.clipId, ev.fileId);
        return {
          ok: true,
          removed: true,
          duplicate: false,
          kept: true,
          reason: 'shared',
          clip: null,
          cleanupError: settled.ok ? '' : settled.error
        };
      }
      if (fresh.index.clips.some(entry => sameAttemptEntry(entry, archiveId, ev))) {
        return fail('stale-operation', '这一把的视频关联已经变化，未删除任何文件；请按当前状态重试');
      }
      const removed = await files.remove(targetPath);
      if (!removed.ok) {
        rememberCleanup([pendingRecord(ev.clipId, ev.fileId, 'cleanup', now())]);
        return Object.assign(
          fail('file-cleanup-failed', '视频副本删除失败，已保留为待清理：' + removed.error),
          { cleanupError: removed.error }
        );
      }
      // 成功回收（或确认已被回收）后，同身份的陈旧待清理标记不再需要。
      const settled = settleDeletedPending(ev.clipId, ev.fileId);
      return {
        ok: true,
        removed: true,
        duplicate: !removed.existed,
        clip: null,
        cleanupError: settled.ok ? '' : settled.error
      };
    }

    // 有引用：必须与凭据是同一片段、同一文件、同一版本；换过版就整条拒绝。
    if (
      current.clipId !== ev.clipId ||
      current.fileId !== ev.fileId ||
      revOf(current) !== wantedRev
    ) {
      return fail(
        'stale-operation',
        '这一把的视频关联已经变化，这次删除没有清理视频副本；原视频仍可用'
      );
    }

    const previous = clipsFor(loaded.index, archiveId, ev.attemptId, ev);
    const retiring = previous.filter(
      entry => entry.clipId === ev.clipId && entry.fileId === ev.fileId
    );
    // 只移除与凭据完全一致的那一条引用；同一把若有别的残留条目，保持原样（不当作本次授权）。
    loaded.index.clips = loaded.index.clips.filter(
      entry =>
        !(
          sameAttemptEntry(entry, archiveId, ev) &&
          entry.clipId === ev.clipId &&
          entry.fileId === ev.fileId
        )
    );
    loaded.index.pending.push.apply(
      loaded.index.pending,
      retirementRecords(loaded.index, retiring)
    );
    const saved = saveIndex(storage, loaded.index);
    if (saved.ok) {
      // 同一文件若仍被别的记录引用，索引已分离但副本必须保留；把这一点作为完成
      // 状态返回，而不是留成永远清不掉的待清理。
      const shared = loaded.index.clips.some(entry => entry.fileId === ev.fileId);
      const cleanupError = await reclaimCopies(loaded.index, retiring);
      return {
        ok: true,
        removed: true,
        duplicate: false,
        kept: shared,
        reason: shared ? 'shared' : '',
        clip: null,
        cleanupError
      };
    }

    // 索引写抛错：读回判断凭据指定的引用是否已经解除。
    const read = readIndex(storage);
    if (!read.ok) {
      return Object.assign({}, saved, {
        cleanupError: '无法读回本机视频索引，未删除任何文件；请稍后重试'
      });
    }
    const after = currentClipFor(read.index, archiveId, ev.attemptId, ev);
    if (!after) {
      const shared = read.index.clips.some(entry => entry.fileId === ev.fileId);
      const cleanupError = await reclaimCopies(read.index, retiring);
      return {
        ok: true,
        removed: true,
        duplicate: false,
        receiptLost: true,
        kept: shared,
        reason: shared ? 'shared' : '',
        clip: null,
        cleanupError
      };
    }
    if (after.clipId === ev.clipId && after.fileId === ev.fileId && revOf(after) === wantedRev) {
      return saved;
    }
    return Object.assign({}, saved, {
      cleanupError: '这一把的视频关联已经变化，未删除任何文件'
    });
  }

  return {
    archiveId,
    instanceId,
    spacePolicy: policy,
    keys: { index: VIDEO_INDEX_KEY },
    commit,
    replace,
    remove,
    // T025：手工时间点嵌在片段条目的可选 markers 字段里，不新增文件或索引键。
    addMarker,
    removeMarker,
    // T048–T050 追加返工：把次记录删除后，凭持久删除凭据定向回收本机视频副本。
    removeDeletedClip,
    recover,
    cleanupOrphans,
    getSpaceUsage
  };
}

// ------------------------------------------------------------------ *
// 页面共享实例
// ------------------------------------------------------------------ *

const services = new Map();

/**
 * 按档案取得共享视频服务（每份档案一个实例）。第一次打开时执行一次 recover()：
 * 清理上次崩溃留下的、有所有权记录的无引用副本，失败不影响页面继续读取已保存视频。
 * options 只在首次创建时生效（测试可注入隔离文件根、存储与预算）。
 */
function openAttemptVideoService(archiveId, options) {
  if (!isSafeArchiveId(archiveId)) return null;
  const config = options || {};
  let entry = services.get(archiveId);
  if (!entry) {
    const service = createAttemptVideoStore({
      archiveId,
      wxApi: config.wxApi,
      userDataPath: config.userDataPath,
      rootDir: config.rootDir,
      storage: config.storage,
      now: config.now,
      space: config.space,
      verifyArchive: config.verifyArchive,
      verifyContext: config.verifyContext,
      files:
        config.files ||
        createWxAttemptVideoFiles({
          archiveId,
          wxApi: config.wxApi,
          userDataPath: config.userDataPath,
          rootDir: config.rootDir,
          rootBaseDir: config.rootBaseDir
        })
    });
    entry = { service, ready: null };
    services.set(archiveId, entry);
  }
  if (!entry.ready) {
    entry.ready = Promise.resolve(entry.service.recover()).then(
      result => result,
      error => ({
        ok: false,
        code: 'recover-failed',
        error: '视频本机副本恢复检查失败：' + errorText(error)
      })
    );
  }
  return entry.service;
}

/** 释放共享实例（重置本机档案或离线测试之间调用）；不删除任何文件或索引。 */
function resetAttemptVideoServices() {
  services.clear();
  // 仅清空内存里的在途登记；正在执行的操作仍由各自的 finally 收尾。
  RUNTIME_SESSION_MUTATIONS.clear();
}

module.exports = {
  VIDEO_FILES_VERSION,
  VIDEO_ROOT_DIRNAME,
  VIDEO_INDEX_KEY,
  INDEX_VERSION,
  VIDEO_SPACE_POLICY,
  CLIP_ID_PATTERN,
  CLIP_FILE_PATTERN,
  ARCHIVE_ID_PATTERN,
  createWxAttemptVideoFiles,
  createAttemptVideoStore,
  openAttemptVideoService,
  resetAttemptVideoServices,
  hasActiveSessionVideoMutation,
  resolveVideoSpacePolicy,
  checkClipSpace,
  normalizeIndex,
  normalizeClip,
  normalizePending,
  createEmptyIndex,
  currentClipFor,
  sameClipIdentity,
  isSafeArchiveId,
  isSafeClipId,
  isSafeVideoFileId,
  formatBytes,
  errorText
};
