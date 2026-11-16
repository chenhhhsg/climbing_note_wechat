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
 * 失败与恢复：
 * - 写文件失败、索引写失败都返回 `ok:false`，并尽量撤销这次新写下的无引用文件；
 *   旧索引与旧副本保持原样；
 * - 提交回执是否明确由页面按读回的索引判断（见 attempt-video-playback.js），本模块
 *   只保证「索引已经落盘才返回成功」；
 * - 冷启动恢复 / 打开页面时的 recover() 只清理**能确认由本功能创建**（clip-* 命名）、
 *   不被当前索引引用、也没有在途写入的文件；索引不可读时一个文件也不删。
 *
 * 空间：
 * - 按目录里的实际文件字节计量，包含失败操作留下的无引用文件；
 * - 单片、视频总量与更换期间新旧副本并存的峰值都要通过预检；视频预算之外另有
 *   照片保留量，避免把共用设备空间吃满；
 * - 真实配额失败（复制时系统报空间不足）同样按空间不足返回可见原因，并保留旧片。
 *
 * 本模块不发起任何上传、云调用或数据迁移。
 */
const attemptVideo = require('./attempt-video.js');
const { isSpaceError } = require('./training-photo-space.js');

const VIDEO_FILES_VERSION = 1;
const VIDEO_ROOT_DIRNAME = 'attempt-video';
const VIDEO_INDEX_KEY = attemptVideo.VIDEO_INDEX_KEY;
const INDEX_VERSION = 1;

// 档案 ID 会成为目录名，只接受本机档案层生成的字符集合。
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CLIP_ID_PATTERN = /^clip-[A-Za-z0-9_-]+$/;
// 只接手本功能自己创建的片段文件；其他文件既不计入视频占用，也绝不删除。
const CLIP_FILE_PATTERN = /^(clip-[A-Za-z0-9_-]+)\.([A-Za-z0-9]{1,5})$/i;

const MIB = 1024 * 1024;

/**
 * 视频预算（应用自设上限，不是微信或设备可用空间的保证）：
 * - budgetBytes：本机逐把视频的总预算；
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
 * 模块一起消失，因此旧运行期留下的半成品可以被安全回收。
 */
const RUNTIME_WRITES = new Set();
const RUNTIME_WRITE_BYTES = new Map();

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

/**
 * 索引里的文件标识必须是本机用户目录内的相对路径：不接受协议前缀、盘符、
 * 根路径与 `..`，避免删除或播放指到视频目录之外。
 */
function isSafeVideoFileId(value) {
  if (!hasText(value)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const text = value.replace(/\\/g, '/');
  if (text.charAt(0) === '/') return false;
  return text.split('/').every(part => part !== '' && part !== '.' && part !== '..');
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
 * - 当前实际占用 + 本次新增 + 更换余量不得超过视频可用总量。
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
        '（当前占用 ' +
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
  return { version: INDEX_VERSION, nextClipSeq: 1, clips: [] };
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
 * 只接受结构完整的索引条目。缺档案、场次、线路、把次、片段或文件标识的条目
 * 会让整份索引按损坏处理：宁可拒绝写入，也不把已保存视频的归属猜错。
 */
function normalizeClip(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSafeArchiveId(raw.archiveId)) return null;
  if (!hasText(raw.sessionId) || !hasText(raw.routeId) || !hasText(raw.attemptId)) return null;
  if (!isSafeClipId(raw.clipId)) return null;
  if (!isSafeVideoFileId(raw.fileId)) return null;
  const bytes = safeNumber(raw.bytes);
  if (bytes !== null && bytes < 0) return null;
  const durationSeconds = optionalNumber(raw.durationSeconds);
  const width = optionalNumber(raw.width);
  const height = optionalNumber(raw.height);
  return {
    clipId: raw.clipId,
    archiveId: raw.archiveId,
    sessionId: raw.sessionId,
    routeId: raw.routeId,
    attemptId: raw.attemptId,
    attemptSeq: safeNumber(raw.attemptSeq),
    rev: revOf(raw),
    fileId: raw.fileId,
    bytes: bytes === null ? 0 : Math.floor(bytes),
    durationSeconds: durationSeconds !== null && durationSeconds >= 0 ? durationSeconds : null,
    width: width !== null && width > 0 ? Math.floor(width) : null,
    height: height !== null && height > 0 ? Math.floor(height) : null,
    fileName: hasText(raw.fileName) ? raw.fileName : '',
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

  const requested = safeNumber(raw.nextClipSeq);
  const nextClipSeq =
    requested !== null && Number.isInteger(requested) && requested > maxSeq
      ? requested
      : maxSeq + 1;
  return { version: INDEX_VERSION, nextClipSeq, clips };
}

function clipsFor(index, archiveId, attemptId) {
  if (!index || !Array.isArray(index.clips)) return [];
  return index.clips.filter(
    clip => clip.archiveId === archiveId && clip.attemptId === attemptId
  );
}

/**
 * 这一把当前有效的片段：同一把只应有一条；若历史数据里残留多条，取版本号
 * 最大的一条（版本相同取后写入的），与列表上的「看视频」判定一致。
 */
function currentClipFor(index, archiveId, attemptId) {
  const matches = clipsFor(index, archiveId, attemptId);
  if (!matches.length) return null;
  let chosen = matches[0];
  for (const clip of matches) {
    if (clip.rev >= chosen.rev) chosen = clip;
  }
  return chosen;
}

function cloneClip(clip) {
  return Object.assign({}, clip);
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

  async function remove(filePath) {
    if (!hasText(filePath)) return { ok: true, existed: false };
    const invalid = requireRoot();
    if (invalid) return invalid;
    const result = await unlink(filePath);
    if (result.ok) return { ok: true, existed: true };
    if (isMissingPathError(result.error)) return { ok: true, existed: false };
    return { ok: false, error: '删除视频文件失败：' + result.error };
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

  /** 索引里的相对文件标识：相对小程序用户目录，播放器用 USER_DATA_PATH 拼回。 */
  function fileIdOf(clipId, ext) {
    const target = videoPath(clipId, ext);
    if (!hasText(target) || !hasText(userDataPath)) return '';
    const base = normalizePath(userDataPath) + '/';
    if (target.indexOf(base) !== 0) return '';
    return target.slice(base.length);
  }

  /** 只接受落在本档案视频目录里的相对文件标识，其他位置一律拒绝。 */
  function pathForFileId(fileId) {
    if (!isSafeVideoFileId(fileId) || !hasText(rootDir) || !hasText(userDataPath)) return '';
    const full = joinPath(userDataPath, fileId);
    const prefix = normalizePath(rootDir) + '/';
    if (full.indexOf(prefix) !== 0) return '';
    if (!CLIP_FILE_PATTERN.test(fileNameOf(full))) return '';
    return full;
  }

  async function readDir() {
    const invalid = requireRoot();
    if (invalid) return invalid;
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'readdir', { dirPath: rootDir });
    if (!result.ok) {
      if (isMissingPathError(result.error)) return { ok: true, files: [] };
      return { ok: false, error: '读取视频目录失败：' + result.error };
    }
    const names = Array.isArray(result.result.files) ? result.result.files : [];
    const files = [];
    const base = hasText(userDataPath) ? normalizePath(userDataPath) + '/' : '';
    for (const name of names) {
      const match = CLIP_FILE_PATTERN.exec(name);
      if (!match) continue;
      const full = joinPath(rootDir, name);
      files.push({
        name,
        path: full,
        clipId: match[1],
        fileId:
          hasText(base) && full.indexOf(base) === 0 ? full.slice(base.length) : ''
      });
    }
    return { ok: true, files };
  }

  return {
    version: VIDEO_FILES_VERSION,
    archiveId,
    userDataPath,
    rootDir,
    videoPath,
    fileIdOf,
    pathForFileId,
    ensureReady,
    stat,
    access,
    copyFile,
    remove,
    listClips: readDir
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

function saveIndex(storage, index) {
  try {
    storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
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
    typeof config.verifyArchive === 'function' ? config.verifyArchive : null;
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

  /**
   * 逐项统计本档案视频目录里的受管文件实际字节（含无引用文件）。
   * index 可选：传入时同时给出哪些文件仍被索引引用。
   */
  async function measure(index) {
    if (!files) {
      return { ok: false, code: 'space-measure-failed', error: '缺少视频文件适配器，无法统计视频占用' };
    }
    const listed = await files.listClips();
    if (!listed.ok) {
      return {
        ok: false,
        code: 'space-measure-failed',
        error: '读取视频文件清单失败：' + (listed.error || '未知错误')
      };
    }
    const referenced = new Set(
      index && Array.isArray(index.clips) ? index.clips.map(clip => clip.fileId) : []
    );
    const entries = [];
    let totalBytes = 0;
    let orphanBytes = 0;
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
      if (!isReferenced) orphanBytes += statResult.bytes;
      totalBytes += statResult.bytes;
      entries.push({
        name: file.name,
        fileId: file.fileId,
        clipId: file.clipId,
        path: file.path,
        bytes: statResult.bytes,
        referenced: isReferenced
      });
    }
    const usableBytes = usableBytesOf(policy);
    return {
      ok: true,
      totalBytes,
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
   * 写新副本并核对：目录就绪、目标可写、复制成功、目标存在且字节真实有效、
   * 与来源字节一致（来源能读到大小时）。返回的 bytes 就是索引要记录的实际字节。
   */
  async function writeCopy(targetPath, sourcePath, expectedBytes) {
    const ready = await files.ensureReady();
    if (!ready.ok) return { ok: false, code: 'file-write-failed', error: ready.error };

    const existing = await files.stat(targetPath);
    if (!existing.ok) {
      return { ok: false, code: 'file-write-failed', error: existing.error };
    }
    if (existing.exists) {
      // 同序号目标只可能是上次崩溃留下的无引用半成品；有在途写入时宁可失败。
      if (RUNTIME_WRITES.has(targetPath)) {
        return {
          ok: false,
          code: 'operation-in-progress',
          error: '同一位置的视频副本正在写入，请稍后重试'
        };
      }
      const removed = await files.remove(targetPath);
      if (!removed.ok) {
        return { ok: false, code: 'file-write-failed', error: removed.error };
      }
    }

    const copied = await files.copyFile(sourcePath, targetPath);
    if (!copied.ok) {
      await files.remove(targetPath);
      return {
        ok: false,
        code: isSpaceError(copied.error) ? 'space-insufficient' : 'file-write-failed',
        error: isSpaceError(copied.error)
          ? '本机空间不足（' + copied.error + '）；没有提交这段视频，原视频和记录都还在'
          : '视频文件写入失败：' + copied.error + '；原视频与记录未改动，可以重试'
      };
    }

    const statResult = await files.stat(targetPath);
    if (!statResult.ok || !statResult.exists || !(statResult.bytes > 0)) {
      await files.remove(targetPath);
      return {
        ok: false,
        code: isSpaceError(statResult.error) ? 'space-insufficient' : 'file-write-failed',
        error:
          '视频文件写入后核对失败：' +
          (statResult.ok ? '文件为空或不存在' : statResult.error) +
          '；原视频与记录未改动'
      };
    }
    if (expectedBytes > 0 && statResult.bytes !== expectedBytes) {
      await files.remove(targetPath);
      return {
        ok: false,
        code: 'file-write-failed',
        error:
          '视频文件写入后的实际大小（' +
          statResult.bytes +
          ' B）与来源（' +
          expectedBytes +
          ' B）不一致，已撤销这次写入；原视频与记录未改动'
      };
    }
    const readable = await files.access(targetPath);
    if (!readable.ok) {
      await files.remove(targetPath);
      return {
        ok: false,
        code: 'file-write-failed',
        error: readable.error + '；已撤销这次写入，原视频与记录未改动'
      };
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
   * 首次保存。重复确认（同一次操作的重试、另一个页面的迟到点击）不会产生
   * 第二份副本：这一把已经有片段时直接按已有片段返回，不写文件、不改索引。
   */
  async function commit(request) {
    const input = request || {};
    const invalid = validateBase(input) || validateSource(input);
    if (invalid) return invalid;

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const existing = currentClipFor(loaded.index, archiveId, input.attemptId);
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

    const seq = loaded.index.nextClipSeq;
    const clipId = makeClipId(seq);
    const ext = extensionOf(input.tempFilePath);
    const targetPath = files.videoPath(clipId, ext);
    if (!hasText(targetPath)) {
      return fail('file-write-failed', '无法定位本档案的视频目录，未写入任何文件');
    }
    if (!claimWrite(targetPath, source.bytes)) {
      return fail(
        'operation-in-progress',
        '同一段视频正在保存，请稍候再试；没有产生第二份副本'
      );
    }
    try {
      const used = await measure(loaded.index);
      if (!used.ok) return used;
      const spaceCheck = checkClipSpace(
        used.totalBytes + reservedBytesExcept(targetPath),
        source.bytes,
        policy
      );
      if (!spaceCheck.ok) return spaceFailure(spaceCheck);

      const written = await writeCopy(targetPath, input.tempFilePath, source.bytes);
      if (!written.ok) return written;

      // 提交前重读索引：等待期间这一把可能被另一个页面写入，或索引被改坏。
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        await files.remove(targetPath);
        return fresh;
      }
      const won = currentClipFor(fresh.index, archiveId, input.attemptId);
      if (won) {
        await files.remove(targetPath);
        return {
          ok: true,
          duplicate: true,
          clip: cloneClip(won),
          cleanupError: ''
        };
      }

      const clip = {
        clipId,
        archiveId,
        sessionId: input.sessionId,
        routeId: input.routeId,
        attemptId: input.attemptId,
        attemptSeq: safeNumber(input.attemptSeq),
        rev: 1,
        fileId: files.fileIdOf(clipId, ext),
        bytes: written.bytes,
        durationSeconds: safeNumber(input.durationSeconds),
        width: safeNumber(input.width),
        height: safeNumber(input.height),
        fileName: hasText(input.fileName) ? input.fileName : fileNameOf(input.tempFilePath),
        createdAt: now()
      };
      if (!hasText(clip.fileId)) {
        await files.remove(targetPath);
        return fail('file-write-failed', '视频文件位置不在小程序用户目录内，未提交索引');
      }
      fresh.index.clips.push(clip);
      // 等待写入期间另一个页面可能已经用掉更大的序号：向上取整，绝不把计数写小。
      fresh.index.nextClipSeq = Math.max(fresh.index.nextClipSeq, seq + 1);
      const saved = saveIndex(storage, fresh.index);
      if (!saved.ok) {
        // 索引没写成：这次写下的副本不能留在目录里冒充已保存。
        const cleaned = await files.remove(targetPath);
        return Object.assign({}, saved, {
          cleanupError: cleaned.ok ? '' : cleaned.error || '新副本清理失败'
        });
      }
      return {
        ok: true,
        duplicate: false,
        clip: cloneClip(clip),
        cleanupError: ''
      };
    } finally {
      releaseWrite(targetPath);
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

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId);
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

    const seq = loaded.index.nextClipSeq;
    const clipId = makeClipId(seq);
    const ext = extensionOf(input.tempFilePath);
    const targetPath = files.videoPath(clipId, ext);
    if (!hasText(targetPath)) {
      return fail('file-write-failed', '无法定位本档案的视频目录，未写入任何文件');
    }
    if (!claimWrite(targetPath, source.bytes)) {
      return fail(
        'operation-in-progress',
        '同一段视频正在写入，请稍候再试；原视频仍可用'
      );
    }
    try {
      const used = await measure(loaded.index);
      if (!used.ok) return used;
      const spaceCheck = checkClipSpace(
        used.totalBytes + reservedBytesExcept(targetPath),
        source.bytes,
        policy
      );
      if (!spaceCheck.ok) return spaceFailure(spaceCheck);

      const written = await writeCopy(targetPath, input.tempFilePath, source.bytes);
      if (!written.ok) return written;

      const fresh = readIndex(storage);
      if (!fresh.ok) {
        await files.remove(targetPath);
        return fresh;
      }
      const stillCurrent = currentClipFor(fresh.index, archiveId, input.attemptId);
      if (!sameClipIdentity(stillCurrent, input) || stillCurrent.clipId !== current.clipId) {
        await files.remove(targetPath);
        return fail(
          'stale-operation',
          '提交前发现这一把的视频关联已经变化，这次更换没有提交；原视频仍可用'
        );
      }

      const previous = clipsFor(fresh.index, archiveId, input.attemptId);
      const clip = {
        clipId,
        archiveId,
        sessionId: input.sessionId,
        routeId: input.routeId,
        attemptId: input.attemptId,
        attemptSeq: safeNumber(input.attemptSeq),
        rev: revOf(current) + 1,
        fileId: files.fileIdOf(clipId, ext),
        bytes: written.bytes,
        durationSeconds: safeNumber(input.durationSeconds),
        width: safeNumber(input.width),
        height: safeNumber(input.height),
        fileName: hasText(input.fileName) ? input.fileName : fileNameOf(input.tempFilePath),
        createdAt: now()
      };
      if (!hasText(clip.fileId)) {
        await files.remove(targetPath);
        return fail('file-write-failed', '视频文件位置不在小程序用户目录内，未提交索引');
      }
      fresh.index.clips = fresh.index.clips.filter(
        entry => !(entry.archiveId === archiveId && entry.attemptId === input.attemptId)
      );
      fresh.index.clips.push(clip);
      // 等待写入期间另一个页面可能已经用掉更大的序号：向上取整，绝不把计数写小。
      fresh.index.nextClipSeq = Math.max(fresh.index.nextClipSeq, seq + 1);
      const saved = saveIndex(storage, fresh.index);
      if (!saved.ok) {
        const cleaned = await files.remove(targetPath);
        return Object.assign({}, saved, {
          cleanupError: cleaned.ok ? '' : cleaned.error || '新副本清理失败'
        });
      }

      // 提交完成之后才回收旧副本：只删本档案视频目录里、索引已不再引用的片段文件。
      let cleanupError = '';
      const keptFileIds = new Set(fresh.index.clips.map(entry => entry.fileId));
      for (const entry of previous) {
        if (!hasText(entry.fileId) || keptFileIds.has(entry.fileId)) continue;
        const oldPath = files.pathForFileId(entry.fileId);
        if (!hasText(oldPath)) {
          cleanupError = '旧副本位置不在本档案视频目录，未删除';
          continue;
        }
        const removed = await files.remove(oldPath);
        if (!removed.ok) cleanupError = removed.error;
      }
      return {
        ok: true,
        duplicate: false,
        clip: cloneClip(clip),
        cleanupError
      };
    } finally {
      releaseWrite(targetPath);
    }
  }

  /**
   * 移除：核对当前片段版本 → 先解除索引关联 → 再回收小程序内副本。
   * 索引写失败时关联与文件都保持原样；文件删除失败时关联已移除，返回 cleanupError。
   */
  async function remove(request) {
    const input = request || {};
    const invalid = validateBase(input);
    if (invalid) return invalid;

    const loaded = readIndex(storage);
    if (!loaded.ok) return loaded;
    const current = currentClipFor(loaded.index, archiveId, input.attemptId);
    if (!current) {
      return { ok: true, removed: true, duplicate: true, clip: null, cleanupError: '' };
    }
    if (!sameClipIdentity(current, input) || (hasText(input.fileId) && input.fileId !== current.fileId)) {
      return fail(
        'stale-operation',
        '这一把的视频关联已经变化，这次移除没有执行；请刷新后再试，原视频仍可用'
      );
    }

    const previous = clipsFor(loaded.index, archiveId, input.attemptId);
    loaded.index.clips = loaded.index.clips.filter(
      entry => !(entry.archiveId === archiveId && entry.attemptId === input.attemptId)
    );
    const saved = saveIndex(storage, loaded.index);
    if (!saved.ok) return saved;

    let cleanupError = '';
    const referenced = new Set(loaded.index.clips.map(entry => entry.fileId));
    for (const entry of previous) {
      if (!hasText(entry.fileId) || referenced.has(entry.fileId)) continue;
      const targetPath = files.pathForFileId(entry.fileId);
      if (!hasText(targetPath)) {
        cleanupError = '副本位置不在本档案视频目录，未删除';
        continue;
      }
      const removed = await files.remove(targetPath);
      if (!removed.ok) cleanupError = removed.error;
    }
    return { ok: true, removed: true, duplicate: false, clip: null, cleanupError };
  }

  /**
   * 无引用副本清理：只处理本档案视频目录里 `clip-*` 命名、当前索引不再引用、
   * 也没有在途写入的文件。每次删除前重读索引，异步窗口内新提交的视频不会被删。
   */
  async function cleanupOrphans() {
    const loaded = readIndex(storage);
    if (!loaded.ok) {
      return Object.assign({}, loaded, { deleted: [] });
    }
    const listed = await files.listClips();
    if (!listed.ok) {
      return fail('cleanup-failed', '读取视频目录失败，未删除任何文件：' + listed.error);
    }

    const deleted = [];
    const errors = [];
    for (const file of listed.files) {
      if (RUNTIME_WRITES.has(file.path)) continue;
      const fresh = readIndex(storage);
      if (!fresh.ok) {
        errors.push(fresh.error);
        break;
      }
      if (fresh.index.clips.some(entry => entry.fileId === file.fileId)) continue;
      if (RUNTIME_WRITES.has(file.path)) continue;
      const removed = await files.remove(file.path);
      if (removed.ok) {
        if (removed.existed) deleted.push(file.path);
      } else {
        errors.push(removed.error);
      }
    }
    if (errors.length) {
      return {
        ok: false,
        code: 'cleanup-failed',
        error: '无引用副本未完全清理：' + errors.join('；'),
        deleted,
        deletedCount: deleted.length
      };
    }
    return { ok: true, deleted, deletedCount: deleted.length };
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
        missing: []
      };
    }
    const cleanup = await cleanupOrphans();
    if (!cleanup.ok) {
      return {
        ok: false,
        code: cleanup.code,
        error: cleanup.error,
        deleted: cleanup.deleted || [],
        missing: []
      };
    }
    const missing = [];
    if (files) {
      for (const clip of loaded.index.clips) {
        if (clip.archiveId !== archiveId) continue;
        const targetPath = files.pathForFileId(clip.fileId);
        const statResult = targetPath ? await files.stat(targetPath) : { ok: false, exists: false };
        if (!statResult.ok || !statResult.exists || !(statResult.bytes > 0)) {
          missing.push({ clipId: clip.clipId, attemptId: clip.attemptId, fileId: clip.fileId });
        }
      }
    }
    return { ok: true, deleted: cleanup.deleted || [], missing, deletedCount: cleanup.deletedCount || 0 };
  }

  /** 本档案视频占用：按实际文件字节，含无引用副本。 */
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
      indexOk: loaded.ok,
      indexError: loaded.ok ? '' : loaded.error
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
 * 按档案取得共享视频服务（每份档案一个实例）。第一次打开时执行一次 recover()：
 * 清理上次崩溃留下的无引用副本，失败不影响页面继续读取已保存视频。
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
      verifyArchive: config.verifyArchive || defaultVerifyArchive,
      files:
        config.files ||
        createWxAttemptVideoFiles({
          archiveId,
          wxApi: config.wxApi,
          userDataPath: config.userDataPath,
          rootDir: config.rootDir
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
  resolveVideoSpacePolicy,
  checkClipSpace,
  normalizeIndex,
  normalizeClip,
  createEmptyIndex,
  currentClipFor,
  sameClipIdentity,
  isSafeArchiveId,
  isSafeClipId,
  isSafeVideoFileId,
  formatBytes,
  errorText
};
