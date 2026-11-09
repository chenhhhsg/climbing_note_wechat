/**
 * 正式本机训练档案（T016）
 *
 * 负责人确定首个交付版本「先存本机」。本文件是正式小程序的唯一本机档案层：
 * 用微信本地持久存储保存实际岩馆、场次、线路、场内线路关联、逐把结果与备注，
 * 并为档案、场次、线路、把次与每一次操作生成稳定 ID。所有读写只落在正式命名
 * 空间 `climbingNote.training.v1.` 下，不读也不写独立试用工程的键，不接云环境。
 *
 * 存储键（正式本机命名空间）：
 *   climbingNote.training.v1.archive   本机档案（岩馆/场次/线路/关联/把次）——受保护
 *   climbingNote.training.v1.photos    线路主照片索引（T019 使用）——受保护
 *   climbingNote.training.v1.photoCoordination.* 照片并发协调数据（T019 使用）——受保护，
 *                                      由照片服务自己的 recover() 回收，不在清缓存范围内
 *   climbingNote.training.v1.cache.*   可重建的派生缓存——普通清缓存可清
 *   climbingNote.training.v1.thumbs.*  可重建的缩略图元数据——普通清缓存可清
 * 除明确列出的可重建前缀外，命名空间内一律按受保护处理；命名空间外的键不属于本层，
 * 清缓存也一律不动。见 clearRebuildableStorage。
 *
 * 一次训练就是「档案 → 岩馆 → 场次 → 线路 → 场内关联 → 逐把」。写操作都是
 * 「先读最新档案，再增量追加」：任何页面都不会把过时快照整体写回，因此两个页面
 * 的迟到操作、重复提交不会覆盖新数据；同一操作以操作 ID（opId）幂等，重试只会
 * 复用同一把次。把次 ID 即操作 ID（沿用 v0.3 语义），新一次真实尝试由页面换新 opId。
 *
 * 落盘失败不报「已保存」：写操作分两段——先把这次操作记为「进行中」并落盘，再提交
 * 结果并清掉标记。任一段失败都返回 ok:false；已落盘的「进行中」标记让同一 opId 的
 * 重试复用原 ID，不产生第二把、也不覆盖后来的新数据。
 *
 * 读取只发生在档案键上：无键是正常的首次进入，返回空档案；键存在但损坏、或版本
 * 不被支持时返回可见错误且**保留原数据**（读写入口都不会覆盖它）。
 *
 * 抱石沿用 v0.3 语义：已确认完攀后不再新增把次，只能按原把次显式「改为未完成」——
 * 只翻那一把的 result，把数、ID、序号、场次与备注都不变；顶绳和先锋可重复完攀。
 *
 * T018 在本层加的是「回看」与「今天再记」两件事，都不新增数据模型：
 *   routeHistory / routesWithHistory   跨日按本地日期与场次分组的只读回看；
 *   resumeRouteToday / chooseRouteSession  用户明确点按「再记」时才改当前场次与线路
 *   （同日多场先让用户显式选一场，原归属不动）。打开历史本身只读，不建场次、不改数据，
 *   旧云记录与旧 climbing_sessions 汇总一律不进入本机统计。
 */
const rules = require('./training-rules.js');

const NAMESPACE = 'climbingNote.training.v1.';
const ARCHIVE_KEY = NAMESPACE + 'archive';
const PHOTO_INDEX_KEY = NAMESPACE + 'photos';
// 可重建的派生缓存：普通清缓存只清这些前缀。
const REBUILDABLE_PREFIXES = [NAMESPACE + 'cache.', NAMESPACE + 'thumbs.'];
const STATE_VERSION = 1;

// 可见错误文案：损坏与版本不支持要和「首次为空」区分开，页面据此提示并保留原数据。
const ARCHIVE_BROKEN = '本机训练档案格式损坏，请重置本地档案后再试';
const ARCHIVE_UNSUPPORTED = '本机训练档案版本不受支持，请升级小程序或重置本地档案';
const ARCHIVE_READ_FAILED = '读取本机训练档案失败：';
const ARCHIVE_WRITE_FAILED = '保存本机训练档案失败：';

// 「进行中」标记与把次一起占用序号：重试不能重新分配 ID。
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSeq(value) {
  return Number.isInteger(value) && value > 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatLocalDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function todayLocalDate(now) {
  return formatLocalDate(now instanceof Date ? now : new Date());
}

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * 时间戳：调用方可以传入固定的 Date 或 ISO 字符串，便于离线测试注入本地日期；
 * 缺省取当前时间。只用于 createdAt，不参与分组（分组只按本地日期）。
 */
function timestamp(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (hasText(now)) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

let opSeq = 0;

/**
 * 新一次真实操作的操作 ID（也就是这次把次的稳定 ID）。
 * 页面为每一把生成一次并记在自己的实例里：重试传同一个 opId，新一把换新的 opId。
 */
function newOperationId() {
  opSeq += 1;
  return 'op-' + Date.now().toString(36) + '-' + opSeq + '-' + Math.random().toString(36).slice(2, 8);
}

let archiveSeq = 0;

/**
 * 首次落盘时生成的档案 ID；一经写入就随档案持久化，重开保持一致。
 */
function newArchiveId() {
  archiveSeq += 1;
  return 'archive-' + Date.now().toString(36) + '-' + archiveSeq + '-' + Math.random().toString(36).slice(2, 8);
}

function createEmptyArchive(archiveId) {
  return {
    version: STATE_VERSION,
    archiveId: hasText(archiveId) ? archiveId : newArchiveId(),
    nextGymSeq: 1,
    nextSessionSeq: 1,
    nextRouteSeq: 1,
    nextAttemptSeq: 1,
    gyms: [],
    sessions: [],
    routes: [],
    // 场内线路关联：某条线路在哪些场次里被记过（跨日复用原线时新增一条关联）。
    sessionRoutes: [],
    attempts: [],
    // 已经点了结果、但提交结果这一步还没落盘的操作（保护正在进行的操作）。
    pendingSaves: [],
    // 已经点了「改为未完成」、但原位改正还没落盘的操作。
    pendingCorrections: [],
    activeSessionId: '',
    activeRouteId: ''
  };
}

function readSeq(entry) {
  return entry ? entry.seq : 0;
}

function normalizeCounter(value, items) {
  const max = items.reduce((acc, item) => {
    const seq = readSeq(item);
    return isSeq(seq) ? Math.max(acc, seq) : acc;
  }, 0);
  return isSeq(value) && value > max ? value : max + 1;
}

/**
 * 只接受当前版本、结构完整的档案；损坏或版本不支持时返回 null，由调用方报错并保留原数据。
 */
function normalizeArchive(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== STATE_VERSION) return null;
  if (!hasText(raw.archiveId)) return null;
  if (
    !Array.isArray(raw.gyms) ||
    !Array.isArray(raw.sessions) ||
    !Array.isArray(raw.routes) ||
    !Array.isArray(raw.attempts)
  ) {
    return null;
  }

  // 后加的列表：旧档案没有它们时按空数组兼容读取，不判损坏。
  const sessionRoutesRaw = raw.sessionRoutes === undefined ? [] : raw.sessionRoutes;
  const pendingRaw = raw.pendingSaves === undefined ? [] : raw.pendingSaves;
  const correctionsRaw =
    raw.pendingCorrections === undefined ? [] : raw.pendingCorrections;
  if (
    !Array.isArray(sessionRoutesRaw) ||
    !Array.isArray(pendingRaw) ||
    !Array.isArray(correctionsRaw)
  ) {
    return null;
  }

  const gymsOk = raw.gyms.every(item => item && hasText(item.id) && hasText(item.name));
  const sessionsOk = raw.sessions.every(
    item =>
      item &&
      hasText(item.id) &&
      isSeq(item.seq) &&
      hasText(item.gymId) &&
      isDateString(item.date) &&
      hasText(item.createdAt)
  );
  // 线路必须带稳定 ID 与场次归属，类型/等级取值在本层容错只读（缺失类型按抱石读取）。
  const routesOk = raw.routes.every(
    item =>
      item &&
      hasText(item.id) &&
      isSeq(item.seq) &&
      hasText(item.gymId) &&
      hasText(item.name) &&
      hasText(item.grade)
  );
  const sessionRoutesOk = sessionRoutesRaw.every(
    item => item && hasText(item.sessionId) && hasText(item.routeId)
  );
  const attemptsOk = raw.attempts.every(
    item =>
      item &&
      hasText(item.id) &&
      isSeq(item.seq) &&
      hasText(item.sessionId) &&
      hasText(item.routeId) &&
      (item.result === 'fail' || item.result === 'send') &&
      typeof item.note === 'string' &&
      hasText(item.createdAt)
  );
  const pendingOk = pendingRaw.every(
    item =>
      item &&
      hasText(item.opId) &&
      isSeq(item.seq) &&
      hasText(item.sessionId) &&
      hasText(item.routeId) &&
      (item.result === 'fail' || item.result === 'send') &&
      typeof item.note === 'string' &&
      hasText(item.createdAt)
  );
  const correctionsOk = correctionsRaw.every(
    item => item && hasText(item.attemptId) && hasText(item.sessionId) && hasText(item.routeId)
  );
  if (!gymsOk || !sessionsOk || !routesOk || !sessionRoutesOk || !attemptsOk || !pendingOk || !correctionsOk) {
    return null;
  }

  const uniqueIds = items => new Set(items.map(item => item.id)).size === items.length;
  const uniqueOpIds = new Set(pendingRaw.map(item => item.opId)).size === pendingRaw.length;
  const uniqueCorrectionIds =
    new Set(correctionsRaw.map(item => item.attemptId)).size === correctionsRaw.length;
  const attemptIds = new Set(raw.attempts.map(item => item.id));
  const linkKey = item => item.sessionId + '\u0000' + item.routeId;
  const uniqueLinks =
    new Set(sessionRoutesRaw.map(linkKey)).size === sessionRoutesRaw.length;
  if (
    !uniqueIds(raw.gyms) ||
    !uniqueIds(raw.sessions) ||
    !uniqueIds(raw.routes) ||
    !uniqueIds(raw.attempts) ||
    !uniqueOpIds ||
    !uniqueCorrectionIds ||
    !uniqueLinks ||
    // 进行中的操作不能与已落盘把次共用 ID。
    pendingRaw.some(item => attemptIds.has(item.opId))
  ) {
    return null;
  }

  // 更正中的操作只能作用在仍存在、且仍是同一场次同一线路的完攀把次上：
  // 原把次已被重置或已改成未完成时，这条待更正不可能再应用，读取时丢掉待更正本身
  // 即可——不改动任何已保存把次，也不影响其他线路。
  const attemptById = new Map(raw.attempts.map(item => [item.id, item]));
  const pendingCorrections = correctionsRaw.filter(item => {
    const attempt = attemptById.get(item.attemptId);
    return Boolean(
      attempt &&
        attempt.result === 'send' &&
        attempt.sessionId === item.sessionId &&
        attempt.routeId === item.routeId
    );
  });

  return {
    version: STATE_VERSION,
    archiveId: raw.archiveId,
    nextGymSeq: normalizeCounter(raw.nextGymSeq, raw.gyms),
    nextSessionSeq: normalizeCounter(raw.nextSessionSeq, raw.sessions),
    nextRouteSeq: normalizeCounter(raw.nextRouteSeq, raw.routes),
    // 进行中的操作已经占用了序号，重试不能重新分配 ID。
    nextAttemptSeq: normalizeCounter(
      raw.nextAttemptSeq,
      raw.attempts.concat(pendingRaw.map(item => ({ seq: item.seq })))
    ),
    gyms: raw.gyms,
    sessions: raw.sessions,
    routes: raw.routes,
    sessionRoutes: sessionRoutesRaw,
    attempts: raw.attempts,
    pendingSaves: pendingRaw,
    pendingCorrections,
    activeSessionId: hasText(raw.activeSessionId) ? raw.activeSessionId : '',
    activeRouteId: hasText(raw.activeRouteId) ? raw.activeRouteId : ''
  };
}

/**
 * 读取本机档案。返回 { archive, error, ok, present, corrupt }：
 * - 无键（首次进入）：ok:true、present:false、空档案，不报错；
 * - 解析或结构损坏：ok:false、corrupt:true、可见错误；原数据保持不动；
 * - 版本不受支持：ok:false、可见错误；原数据保持不动；
 * - 读取本身失败（getStorageSync 抛出）：ok:false、可见错误。
 * archive 始终可用于只读展示（损坏时为空档案），但写入口在 ok:false 时一律拒绝落盘。
 */
function loadState() {
  let raw;
  try {
    raw = wx.getStorageSync(ARCHIVE_KEY);
  } catch (error) {
    return {
      archive: createEmptyArchive(),
      error: ARCHIVE_READ_FAILED + errorText(error),
      ok: false,
      present: false,
      corrupt: false
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { archive: createEmptyArchive(), error: '', ok: true, present: false, corrupt: false };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { archive: createEmptyArchive(), error: ARCHIVE_BROKEN, ok: false, present: true, corrupt: true };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version !== undefined && parsed.version !== STATE_VERSION) {
    return { archive: createEmptyArchive(), error: ARCHIVE_UNSUPPORTED, ok: false, present: true, corrupt: true };
  }

  const archive = normalizeArchive(parsed);
  if (!archive) {
    return { archive: createEmptyArchive(), error: ARCHIVE_BROKEN, ok: false, present: true, corrupt: true };
  }
  return { archive, error: '', ok: true, present: true, corrupt: false };
}

/**
 * 界面只读入口：拿当前档案，损坏时附带可见错误与是否为损坏态。
 */
function loadArchive() {
  return loadState();
}

function hasArchive() {
  const loaded = loadState();
  return loaded.ok && loaded.present;
}

/**
 * 落盘档案。失败只返回错误，不抛出、不重试其他写入。
 */
function saveArchive(archive) {
  try {
    wx.setStorageSync(ARCHIVE_KEY, JSON.stringify(archive));
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: ARCHIVE_WRITE_FAILED + errorText(error) };
  }
}

/**
 * 是否属于明确的可重建前缀（普通清缓存可清）。
 */
function isRebuildableKey(key) {
  return (
    typeof key === 'string' &&
    REBUILDABLE_PREFIXES.some(prefix => key.indexOf(prefix) === 0)
  );
}

/**
 * 是否属于正式本机命名空间里受保护的键：档案、照片索引、正在进行的操作，
 * 以及未来加入的正式键。可重建前缀不算受保护。
 */
function isProtectedKey(key) {
  return (
    typeof key === 'string' &&
    key.indexOf(NAMESPACE) === 0 &&
    !isRebuildableKey(key)
  );
}

/**
 * 普通清缓存：只清明确列出的可重建前缀。
 *
 * 不做整片清空微信本地存储，也不按目录整片清理——本机档案、照片索引、正在进行的
 * 操作以及命名空间外的其他键（例如旧试用工程与旧云缓存）都保持原样；原图是本地
 * 文件，不在这里处理。返回实际清掉的键，便于页面提示与测试逐项核对。
 */
function clearRebuildableStorage() {
  let info;
  try {
    info = wx.getStorageInfoSync();
  } catch (error) {
    return { ok: false, error: '读取本机缓存目录失败：' + errorText(error), removed: [] };
  }

  const keys = (info && Array.isArray(info.keys) ? info.keys : []).slice();
  const removed = [];
  for (const key of keys) {
    if (!isRebuildableKey(key)) continue;
    try {
      wx.removeStorageSync(key);
      removed.push(key);
    } catch (error) {
      return { ok: false, error: '清除本机缓存失败：' + errorText(error), removed };
    }
  }
  return { ok: true, error: '', removed };
}

function findById(items, id) {
  if (!Array.isArray(items) || !hasText(id)) return null;
  return items.find(item => item.id === id) || null;
}

function gymName(archive, gymId) {
  const gym = archive && findById(archive.gyms, gymId);
  return gym ? gym.name : '';
}

/**
 * 「第 N 场」：同一天内按序号排出的场次序号，跨日不会串。
 */
function sessionLabel(archive, session) {
  if (!archive || !session) return '';
  const sameDay = (archive.sessions || [])
    .filter(item => item.date === session.date)
    .sort((left, right) => left.seq - right.seq);
  return '第 ' + (sameDay.findIndex(item => item.id === session.id) + 1) + ' 场';
}

function sessionsOnDate(archive, date) {
  const all = (archive && archive.sessions) || [];
  return all
    .filter(item => item.date === date)
    .sort((left, right) => left.seq - right.seq)
    .map(clone);
}

function routesForGym(archive, gymId) {
  const all = (archive && archive.routes) || [];
  return all.filter(item => item.gymId === gymId).map(clone);
}

function routesForSession(archive, sessionId) {
  if (!archive) return [];
  const ids = (archive.sessionRoutes || [])
    .filter(link => link.sessionId === sessionId)
    .map(link => link.routeId);
  return (archive.routes || []).filter(item => ids.indexOf(item.id) !== -1).map(clone);
}

function attemptsFor(archive, filter) {
  const all = (archive && archive.attempts) || [];
  const match = filter || {};
  return all
    .filter(
      item =>
        (match.sessionId === undefined || item.sessionId === match.sessionId) &&
        (match.routeId === undefined || item.routeId === match.routeId)
    )
    .sort((left, right) => left.seq - right.seq)
    .map(clone);
}

/**
 * 一条线路的完攀状态，供首页、场内页与详情页共用（T017 直接复用）。
 * 与 v0.3 语义一致：抱石（含缺 climbType 的旧 V 级线路）首次完攀后不再新增，
 * 顶绳和先锋可重复；误点完攀可按原把次「改为未完成」。
 * 只读计算，不写档案、不迁移旧数据、不生成逐把明细。
 */
function routeCompletion(archive, routeId) {
  const unknown = {
    known: false,
    routeId: routeId || '',
    isBoulder: false,
    repeatable: true,
    sendCount: 0,
    pendingSendCount: 0,
    pendingCorrectionCount: 0,
    hasSend: false,
    hasPendingSend: false,
    completed: false,
    closed: false,
    canRecord: true,
    latestSendId: '',
    correcting: false,
    canCorrect: false
  };

  const route = archive && findById(archive.routes, routeId);
  if (!route) return unknown;

  const isBoulder = rules.isBoulderRoute(route);
  const attempts = (archive.attempts || []).filter(item => item.routeId === route.id);
  const sends = attempts.filter(item => item.result === 'send');
  const pendingSends = (archive.pendingSaves || []).filter(
    item => item.routeId === route.id && item.result === 'send'
  );
  const corrections = (archive.pendingCorrections || []).filter(
    item => item.routeId === route.id
  );
  const hasSend = sends.length > 0;
  const hasPendingSend = pendingSends.length > 0;
  const closed = isBoulder && (hasSend || hasPendingSend);
  const target = rules.latestSendAttempt(attempts, route.id);
  const correcting = isBoulder && corrections.length > 0;

  return {
    known: true,
    routeId: route.id,
    isBoulder,
    repeatable: !isBoulder,
    sendCount: sends.length,
    pendingSendCount: pendingSends.length,
    pendingCorrectionCount: corrections.length,
    hasSend,
    hasPendingSend,
    completed: isBoulder && hasSend,
    closed,
    canRecord: !closed,
    latestSendId: target ? target.id : '',
    correcting,
    // 已有待更正时不再重复发起；更正失败后复用同一条待更正重试。
    canCorrect: isBoulder && hasSend && !correcting
  };
}

/**
 * 「改为未完成」的行体：原把次 ID、归属与说明（日期/场次/第几把）。
 */
function correctionRow(archive, attempt) {
  const session = findById(archive.sessions, attempt.sessionId);
  const ordered = (archive.attempts || [])
    .filter(
      item =>
        item.sessionId === attempt.sessionId &&
        item.routeId === attempt.routeId
    )
    .sort((left, right) => left.seq - right.seq);
  const index = ordered.findIndex(item => item.id === attempt.id);
  return {
    attemptId: attempt.id,
    routeId: attempt.routeId,
    sessionId: attempt.sessionId,
    seq: attempt.seq || 0,
    label: '第 ' + (index + 1) + ' 把',
    contextText: session
      ? session.date + ' ' + sessionLabel(archive, session) + ' · ' + gymName(archive, session.gymId)
      : ''
  };
}

/**
 * 这条抱石线里符合 accept 的把次，「序号大的在前、同序号后加入的在前」。
 */
function correctionEntries(archive, route, accept) {
  return (archive.attempts || [])
    .map((item, index) => ({ item, index }))
    .filter(entry => entry.item.routeId === route.id && accept(entry.item))
    .sort((left, right) => {
      const seqDiff = (right.item.seq || 0) - (left.item.seq || 0);
      return seqDiff !== 0 ? seqDiff : right.index - left.index;
    });
}

/**
 * 「改为未完成」的逐个目标：这条抱石线所有仍可更正的已确认完攀，最近的在先。
 * 每条都带自己的原把次 ID 与原把次说明（日期/场次/第几把），页面为每一把单独渲染
 * 一个控件——控件与目标一一对应，连点原坐标也只会改到所示的那一把。
 * 非抱石线路（绳攀可重复）返回空数组；只读计算，不写档案。
 */
function routeCorrectionTargets(archive, routeId) {
  if (!archive || !hasText(routeId)) return [];
  const route = findById(archive.routes, routeId);
  if (!route || !rules.isBoulderRoute(route)) return [];

  return correctionEntries(archive, route, item => item.result === 'send').map(entry =>
    correctionRow(archive, entry.item)
  );
}

/**
 * 「改为未完成」的逐行展示（T018 跨日详情用）。
 *
 * 与 routeCorrectionTargets 同一份行体与顺序，但把本实例刚改好的那一把（correctedIds）
 * 也留在原位置，标成只读回读行（state 'corrected'）。于是改完一把后下面的行不上移，
 * 同一个坐标不会被另一把的控件接手——改另一把必须再点它自己那一行。
 * 只读计算，不写档案。
 */
function routeCorrectionRows(archive, routeId, correctedIds) {
  if (!archive || !hasText(routeId)) return [];
  const route = findById(archive.routes, routeId);
  if (!route || !rules.isBoulderRoute(route)) return [];

  const corrected = new Set(Array.isArray(correctedIds) ? correctedIds : []);
  return correctionEntries(
    archive,
    route,
    item => item.result === 'send' || corrected.has(item.id)
  ).map(entry =>
    Object.assign(correctionRow(archive, entry.item), {
      state: entry.item.result === 'send' ? 'ready' : 'corrected'
    })
  );
}

/**
 * 一条长期线路的跨日历史（T018，只读）。
 *
 * 按本地日期与场次分组：场次「日期新在前、同日序号大在前」，组内把次按序号从小到大
 * 排列并标出「第 N 把」。只读计算：不改档案、不迁移旧数据、不新建场次、不生成逐把
 * 明细，也不把别的线路或别的场次的把次并到一起。把次的归属场次已不存在时跳过，
 * 不猜、不补一个新归属。
 *
 * 返回 { known, routeId, route, groups, dayCount, sessionCount, attemptCount,
 *        sendCount, completion }；线路不存在时 known:false、groups 为空。
 */
function routeHistory(archive, routeId) {
  const id = hasText(routeId) ? routeId : '';
  const completion = routeCompletion(archive, id);
  const route = archive ? findById(archive.routes, id) : null;
  if (!route) {
    return {
      known: false,
      routeId: id,
      route: null,
      groups: [],
      dayCount: 0,
      sessionCount: 0,
      attemptCount: 0,
      sendCount: 0,
      completion
    };
  }

  const bySession = new Map();
  (archive.attempts || []).forEach(attempt => {
    if (attempt.routeId !== route.id) return;
    const session = findById(archive.sessions, attempt.sessionId);
    if (!session) return;
    if (!bySession.has(session.id)) bySession.set(session.id, { session, attempts: [] });
    bySession.get(session.id).attempts.push(attempt);
  });

  const groups = [...bySession.values()]
    .sort(
      (left, right) =>
        right.session.date.localeCompare(left.session.date) ||
        right.session.seq - left.session.seq
    )
    .map(entry => {
      const ordered = entry.attempts
        .slice()
        .sort((left, right) => (left.seq || 0) - (right.seq || 0));
      return {
        sessionId: entry.session.id,
        date: entry.session.date,
        seq: entry.session.seq,
        sessionLabel: sessionLabel(archive, entry.session),
        gymId: entry.session.gymId,
        gymName: gymName(archive, entry.session.gymId),
        countText: ordered.length + ' 把',
        attempts: ordered.map((attempt, index) => ({
          id: attempt.id,
          seq: attempt.seq || 0,
          label: '第 ' + (index + 1) + ' 把',
          result: attempt.result,
          resultText: attempt.result === 'send' ? '完攀' : '未完成',
          note: attempt.note || '',
          createdAt: attempt.createdAt
        }))
      };
    });

  const attemptCount = groups.reduce((sum, group) => sum + group.attempts.length, 0);
  const sendCount = groups.reduce(
    (sum, group) => sum + group.attempts.filter(item => item.result === 'send').length,
    0
  );

  return {
    known: true,
    routeId: route.id,
    route: clone(route),
    groups,
    dayCount: new Set(groups.map(group => group.date)).size,
    sessionCount: groups.length,
    attemptCount,
    sendCount,
    completion
  };
}

/**
 * 记录 tab 的本机训练历史（T018，只读）：有逐把记录的长期线路各一条，带最近一次训练
 * 的本地日期/场次与本机「几天 / 几场 / 几把」统计，最近训练的在前。
 *
 * 只统计本机档案里的把次：旧云汇总、旧 climbing_sessions 数据与别的线路都不参与，
 * 也不按名称、颜色或难度归并。线路或场次档案缺失时跳过，不猜。
 */
function routesWithHistory(archive) {
  if (!archive) return [];

  const stats = new Map();
  (archive.attempts || []).forEach(attempt => {
    const session = findById(archive.sessions, attempt.sessionId);
    if (!session) return;
    const entry = stats.get(attempt.routeId) || {
      routeId: attempt.routeId,
      attempts: [],
      sessions: new Map(),
      days: new Set()
    };
    entry.attempts.push(attempt);
    entry.sessions.set(session.id, session);
    entry.days.add(session.date);
    stats.set(attempt.routeId, entry);
  });

  const rows = [];
  stats.forEach(entry => {
    const route = findById(archive.routes, entry.routeId);
    if (!route) return;
    const sessions = [...entry.sessions.values()].sort(
      (left, right) => right.date.localeCompare(left.date) || right.seq - left.seq
    );
    const latest = sessions[0];
    rows.push({
      id: route.id,
      seq: route.seq,
      name: route.name,
      climbType: route.climbType,
      grade: route.grade,
      colorName: route.colorName || '',
      colorHex: route.colorHex || '',
      gymName: gymName(archive, route.gymId),
      lastDate: latest.date,
      lastSessionLabel: sessionLabel(archive, latest),
      dayCount: entry.days.size,
      sessionCount: sessions.length,
      attemptCount: entry.attempts.length,
      sendCount: entry.attempts.filter(item => item.result === 'send').length
    });
  });

  return rows.sort(
    (left, right) =>
      right.lastDate.localeCompare(left.lastDate) || (right.seq || 0) - (left.seq || 0)
  );
}

/**
 * 「再记」（T018）：把当前场次与线路指到这条长期线路所在岩馆的本地当日场次，
 * 供长期线路详情页在用户明确点按时调用。
 *
 * 打开历史本身不调用它，也不建场次、不改当前选择。返回：
 * - code 'ready'：当日恰好一场（复用）或当日还没有场次（新建一场）后已选中；
 * - code 'choose-session'：同一岩馆当日有多场，返回 sessions 让用户明确选一场，
 *   此时不写盘、不改当前选择，原归属保持不动；
 * - code 'closed'：抱石已确认完攀（含待确认），不新增把次，只提示按把更正；
 * - code 'missing' / 'bad-date' / 'unreadable' / 'write-failed'：不写盘。
 *
 * 只改当前场次与当前线路，必要时新建一场；不动任何已有把次、备注与场次归属。
 */
function resumeRouteToday(routeId, options) {
  const data = options || {};
  const loaded = loadState();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'unreadable',
      error: loaded.error,
      archive: loaded.archive,
      session: null,
      sessions: [],
      date: ''
    };
  }

  const next = clone(loaded.archive);
  const route = findById(next.routes, hasText(routeId) ? routeId : '');
  if (!route) {
    return {
      ok: false,
      code: 'missing',
      error: '找不到这条线路，请返回历史重新打开',
      archive: next,
      session: null,
      sessions: [],
      date: ''
    };
  }

  const date = hasText(data.date) ? data.date : todayLocalDate(data.now);
  if (!isDateString(date)) {
    return {
      ok: false,
      code: 'bad-date',
      error: '训练日期无效，请使用本地日期（YYYY-MM-DD）',
      archive: next,
      session: null,
      sessions: [],
      date: ''
    };
  }

  const completion = routeCompletion(next, route.id);
  if (completion.closed) {
    return {
      ok: false,
      code: 'closed',
      error: completion.hasSend
        ? '这条抱石线路已完攀，不能再新增把次；点错了可在原把次上「改为未完成」更正。'
        : '这条抱石线路的完攀还在提交中，请稍候再记。',
      archive: next,
      session: null,
      sessions: [],
      date
    };
  }

  const sameGymToday = next.sessions
    .filter(item => item.date === date && item.gymId === route.gymId)
    .sort((left, right) => left.seq - right.seq);

  if (sameGymToday.length > 1) {
    return {
      ok: false,
      code: 'choose-session',
      error: '',
      archive: next,
      session: null,
      sessions: sameGymToday.map(clone),
      date
    };
  }

  let session = sameGymToday[0] || null;
  const reused = Boolean(session);
  if (!session) {
    const seq = next.nextSessionSeq;
    session = {
      id: 'session-' + seq,
      seq: seq,
      gymId: route.gymId,
      date: date,
      createdAt: timestamp(data.now)
    };
    next.sessions.push(session);
    next.nextSessionSeq = seq + 1;
  }
  // 用户明确点的是「这条线当天再记」：把这条线与当日场次关联并选中（关联幂等），
  // 场内页因此直接显示这条线而不是空选线路。重复关联不新增条目。
  if (
    !next.sessionRoutes.some(
      link => link.sessionId === session.id && link.routeId === route.id
    )
  ) {
    next.sessionRoutes.push({
      sessionId: session.id,
      routeId: route.id,
      addedAt: timestamp(data.now)
    });
  }
  next.activeSessionId = session.id;
  next.activeRouteId = route.id;

  const saved = saveArchive(next);
  if (!saved.ok) {
    return {
      ok: false,
      code: 'write-failed',
      error: saved.error,
      archive: loaded.archive,
      session: null,
      sessions: [],
      date
    };
  }

  return {
    ok: true,
    code: 'ready',
    error: '',
    archive: next,
    session: clone(session),
    sessions: [],
    date,
    reused
  };
}

/**
 * 同一岩馆当日多场时，用户明确选中一场（T018）：只改当前场次与线路。
 * 场次必须属于这条线路的岩馆与指定本地日期（缺省今天），否则拒绝，不写盘。
 */
function chooseRouteSession(routeId, sessionId, options) {
  const data = options || {};
  const loaded = loadState();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'unreadable',
      error: loaded.error,
      archive: loaded.archive,
      session: null
    };
  }

  const next = clone(loaded.archive);
  const route = findById(next.routes, hasText(routeId) ? routeId : '');
  if (!route) {
    return {
      ok: false,
      code: 'missing',
      error: '找不到这条线路，请返回历史重新打开',
      archive: next,
      session: null
    };
  }

  const date = hasText(data.date) ? data.date : todayLocalDate(data.now);
  const session = findById(next.sessions, hasText(sessionId) ? sessionId : '');
  if (!session || session.gymId !== route.gymId || session.date !== date) {
    return {
      ok: false,
      code: 'missing-session',
      error: '这场训练不属于该岩馆当日，请重新选择',
      archive: next,
      session: null
    };
  }

  next.activeSessionId = session.id;
  next.activeRouteId = route.id;

  // 与 resumeRouteToday 一致：明确选定的这条线在同场次里保留关联（幂等）。
  if (
    !next.sessionRoutes.some(
      link => link.sessionId === session.id && link.routeId === route.id
    )
  ) {
    next.sessionRoutes.push({
      sessionId: session.id,
      routeId: route.id,
      addedAt: timestamp(data.now)
    });
  }

  const saved = saveArchive(next);
  if (!saved.ok) {
    return {
      ok: false,
      code: 'write-failed',
      error: saved.error,
      archive: loaded.archive,
      session: null
    };
  }
  return { ok: true, code: 'ready', error: '', archive: next, session: clone(session) };
}

/**
 * 开始（或主动另开）一场训练：写入自己输入的岩馆与本机本地日期。
 * 同名岩馆复用原岩馆 ID；每一场都生成独立的场次 ID（同日多场各自保留）。
 * 首场会把档案（含稳定 archiveId）一并落盘。
 */
function startSession(input) {
  const data = input || {};
  const name = hasText(data.gymName) ? data.gymName.trim() : '';
  if (!name) {
    return { ok: false, error: '请填写岩馆名称', archive: null, session: null };
  }
  const date = hasText(data.date) ? data.date : todayLocalDate(data.now);
  if (!isDateString(date)) {
    return { ok: false, error: '训练日期无效，请使用本地日期（YYYY-MM-DD）', archive: null, session: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, archive: loaded.archive, session: null };
  }

  const next = clone(loaded.archive);
  const createdAt = timestamp(data.now);
  let gym = next.gyms.find(item => item.name === name) || null;
  if (!gym) {
    gym = { id: 'gym-' + next.nextGymSeq, name: name, createdAt: createdAt };
    next.gyms.push(gym);
    next.nextGymSeq += 1;
  }

  const seq = next.nextSessionSeq;
  const session = {
    id: 'session-' + seq,
    seq: seq,
    gymId: gym.id,
    date: date,
    createdAt: createdAt
  };
  next.sessions.push(session);
  next.nextSessionSeq += 1;
  next.activeSessionId = session.id;
  next.activeRouteId = '';

  const saved = saveArchive(next);
  if (!saved.ok) {
    return { ok: false, error: saved.error, archive: loaded.archive, session: null };
  }
  return { ok: true, error: '', archive: next, session: session };
}

/**
 * 在（默认当前）场次新建一条线路，并建立场内线路关联。
 * 类型与等级必须是适用组合，错误组合不能落盘（见 utils/training-rules.js）。
 */
function createRoute(input) {
  const data = input || {};
  const name = hasText(data.name) ? data.name.trim() : '';
  if (!name) return { ok: false, error: '请填写线路名称', archive: null, route: null };

  const climbType = data.climbType;
  if (!rules.isClimbType(climbType)) {
    return { ok: false, error: '请选择攀岩类型（抱石/顶绳/先锋）', archive: null, route: null };
  }
  if (!rules.isGradeForType(climbType, data.grade)) {
    return { ok: false, error: '请选择适用于该类型的等级', archive: null, route: null };
  }

  const loaded = loadState();
  if (!loaded.ok) return { ok: false, error: loaded.error, archive: loaded.archive, route: null };

  const next = clone(loaded.archive);
  const session = findById(next.sessions, hasText(data.sessionId) ? data.sessionId : next.activeSessionId);
  const gymId = hasText(data.gymId) ? data.gymId : session ? session.gymId : '';
  if (!gymId || !findById(next.gyms, gymId)) {
    return { ok: false, error: '请先开始一场训练', archive: next, route: null };
  }

  const createdAt = timestamp(data.now);
  const seq = next.nextRouteSeq;
  const route = {
    id: 'route-' + seq,
    seq: seq,
    gymId: gymId,
    name: name,
    climbType: climbType,
    grade: data.grade,
    colorName: hasText(data.colorName) ? data.colorName : '',
    colorHex: hasText(data.colorHex) ? data.colorHex : '',
    createdAt: createdAt
  };
  next.routes.push(route);
  next.nextRouteSeq += 1;
  if (session) {
    next.sessionRoutes.push({ sessionId: session.id, routeId: route.id, addedAt: createdAt });
  }
  next.activeRouteId = route.id;

  const saved = saveArchive(next);
  if (!saved.ok) return { ok: false, error: saved.error, archive: loaded.archive, route: null };
  return { ok: true, error: '', archive: next, route: route };
}

/**
 * 把已有线路关联到某场次（跨日复用原线时使用）：重复关联幂等。
 */
function linkRouteToSession(sessionId, routeId) {
  const loaded = loadState();
  if (!loaded.ok) return { ok: false, error: loaded.error, archive: loaded.archive };
  const next = clone(loaded.archive);
  if (!findById(next.sessions, sessionId)) {
    return { ok: false, error: '找不到这场训练', archive: next };
  }
  if (!findById(next.routes, routeId)) {
    return { ok: false, error: '找不到这条线路', archive: next };
  }
  if (next.sessionRoutes.some(link => link.sessionId === sessionId && link.routeId === routeId)) {
    return { ok: true, error: '', archive: next, duplicate: true };
  }
  next.sessionRoutes.push({
    sessionId: sessionId,
    routeId: routeId,
    addedAt: new Date().toISOString()
  });
  const saved = saveArchive(next);
  if (!saved.ok) return { ok: false, error: saved.error, archive: loaded.archive };
  return { ok: true, error: '', archive: next, duplicate: false };
}

/**
 * 记录当前选择的场次/线路（首页「继续本场」据此恢复）。只改选择，不动其他数据。
 */
function selectSession(sessionId) {
  const loaded = loadState();
  if (!loaded.ok) return { ok: false, error: loaded.error, archive: loaded.archive };
  const next = clone(loaded.archive);
  if (!findById(next.sessions, sessionId)) {
    return { ok: false, error: '找不到这场训练', archive: next };
  }
  next.activeSessionId = sessionId;
  next.activeRouteId = '';
  const saved = saveArchive(next);
  if (!saved.ok) return { ok: false, error: saved.error, archive: loaded.archive };
  return { ok: true, error: '', archive: next };
}

function selectRoute(routeId) {
  const loaded = loadState();
  if (!loaded.ok) return { ok: false, error: loaded.error, archive: loaded.archive };
  const next = clone(loaded.archive);
  if (!findById(next.routes, routeId)) {
    return { ok: false, error: '找不到这条线路', archive: next };
  }
  next.activeRouteId = routeId;
  const saved = saveArchive(next);
  if (!saved.ok) return { ok: false, error: saved.error, archive: loaded.archive };
  return { ok: true, error: '', archive: next };
}

/**
 * 保存一把结果与备注。
 *
 * 输入：{ opId?, sessionId?, routeId, result: 'fail'|'send', note?, now? }
 * 返回：{ ok, error, archive, attempt, opId, duplicate, blocked }
 *
 * - 同一 opId 重复提交/迟到回调：复用已落盘的把次，只提交一次；
 * - 新一次真实尝试：页面换新 opId，得到新的把次 ID；
 * - 抱石已确认（或已在提交中）完攀：不再新增，blocked，需先「改为未完成」；
 * - 落盘失败：ok:false，不报已保存；先落盘的「进行中」标记让同 opId 重试复用同一把。
 */
function saveAttempt(input) {
  const data = input || {};
  const result = data.result;
  if (result !== 'fail' && result !== 'send') {
    return { ok: false, blocked: false, error: '把次结果无效（只能是 fail 或 send）', archive: null, opId: '' };
  }
  const routeId = hasText(data.routeId) ? data.routeId : '';
  if (!routeId) {
    return { ok: false, blocked: false, error: '缺少线路归属', archive: null, opId: '' };
  }
  const note = typeof data.note === 'string' ? data.note : '';
  const opId = hasText(data.opId) ? data.opId : newOperationId();

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, blocked: false, error: loaded.error, archive: loaded.archive, opId: opId };
  }
  const current = loaded.archive;

  // 同一操作重复提交或迟到回调：复用原把次，不新增、不覆盖。
  const existing = current.attempts.find(item => item.id === opId);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      blocked: false,
      error: '',
      archive: current,
      attempt: clone(existing),
      opId: opId
    };
  }

  const sessionId = hasText(data.sessionId) ? data.sessionId : current.activeSessionId;
  const session = findById(current.sessions, sessionId);
  if (!session) {
    return { ok: false, blocked: false, error: '找不到这场训练，请先开始一场', archive: current, opId: opId };
  }
  const route = findById(current.routes, routeId);
  if (!route) {
    return { ok: false, blocked: false, error: '找不到这条线路', archive: current, opId: opId };
  }

  // 抱石首次完攀守卫：已确认或仍在提交中的完攀都关闭新增入口。
  const completion = routeCompletion(current, route.id);
  if (completion.closed) {
    return {
      ok: false,
      blocked: true,
      alreadySent: completion.hasSend,
      error: completion.hasSend
        ? '该抱石线路已完攀，不能重复记录；如需改正请用「改为未完成」'
        : '该抱石线路的完攀还在提交中，请稍候',
      archive: current,
      opId: opId
    };
  }

  // 重试用同一个 opId：复用「进行中」标记里的序号与时间，不重新分配 ID。
  const pendingExisting = current.pendingSaves.find(item => item.opId === opId) || null;
  const seq = pendingExisting ? pendingExisting.seq : current.nextAttemptSeq;
  const createdAt = pendingExisting ? pendingExisting.createdAt : timestamp(data.now);
  const attempt = {
    id: opId,
    seq: seq,
    sessionId: session.id,
    routeId: route.id,
    result: result,
    note: note,
    createdAt: createdAt
  };
  const pending = {
    opId: opId,
    seq: seq,
    sessionId: session.id,
    routeId: route.id,
    result: result,
    note: note,
    createdAt: createdAt
  };

  // 第一段：先落盘「进行中」标记，保护正在进行的操作。
  const staging = clone(current);
  staging.pendingSaves = staging.pendingSaves
    .filter(item => item.opId !== opId)
    .concat([pending]);
  const staged = saveArchive(staging);
  if (!staged.ok) {
    return { ok: false, blocked: false, error: staged.error, archive: current, opId: opId };
  }

  // 第二段：提交把次并清掉「进行中」标记；失败时标记仍在，重试复用同一把。
  const committed = clone(staging);
  committed.attempts.push(attempt);
  committed.pendingSaves = committed.pendingSaves.filter(item => item.opId !== opId);
  committed.nextAttemptSeq = Math.max(committed.nextAttemptSeq, seq + 1);
  if (
    !committed.sessionRoutes.some(
      link => link.sessionId === session.id && link.routeId === route.id
    )
  ) {
    committed.sessionRoutes.push({
      sessionId: session.id,
      routeId: route.id,
      addedAt: createdAt
    });
  }
  const saved = saveArchive(committed);
  if (!saved.ok) {
    return { ok: false, blocked: false, error: saved.error, archive: staging, opId: opId };
  }
  return {
    ok: true,
    duplicate: false,
    blocked: false,
    error: '',
    archive: committed,
    attempt: clone(attempt),
    opId: opId
  };
}

/**
 * 补改某一把的备注（T017）。
 *
 * 输入：{ note, routeId?, sessionId? }，把次由第一个参数的稳定 ID 指定。
 * 返回：{ ok, code, error, archive, attempt }
 * code：saved / missing / conflict / unreadable / write-failed。
 *
 * 与「改为未完成」一样是原位改正：只改这一把的 note，把数、ID、序号、结果、
 * 场次、时间与其他把次一律不动。传了 routeId/sessionId 时先核对归属，不属于
 * 当前上下文的更正一律拒绝（conflict），避免同名或同色线路之间串备注。
 * 每次都先读最新档案再改，因此两个页面的迟到操作不会互相覆盖。
 */
function setAttemptNote(attemptId, input) {
  const data = input || {};
  if (!hasText(attemptId)) {
    return { ok: false, code: 'missing', error: '缺少要补备注的把次 ID', archive: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, archive: loaded.archive };
  }
  const current = loaded.archive;
  const attempt = current.attempts.find(item => item.id === attemptId) || null;
  if (!attempt) {
    return { ok: false, code: 'missing', error: '找不到这一把，可能已被重置', archive: current };
  }
  if (hasText(data.routeId) && data.routeId !== attempt.routeId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前线路，未改备注', archive: current };
  }
  if (hasText(data.sessionId) && data.sessionId !== attempt.sessionId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前场次，未改备注', archive: current };
  }

  const note = typeof data.note === 'string' ? data.note.trim() : '';
  // 备注没变（重复提交、连点同一条）：不写盘，直接复用现有记录。
  if (note === attempt.note) {
    return {
      ok: true,
      code: 'saved',
      duplicate: true,
      error: '',
      archive: current,
      attempt: clone(attempt)
    };
  }

  const next = clone(current);
  const target = next.attempts.find(item => item.id === attemptId);
  target.note = note;
  const saved = saveArchive(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, archive: current };
  }
  return {
    ok: true,
    code: 'saved',
    duplicate: false,
    error: '',
    archive: next,
    attempt: clone(target)
  };
}

/**
 * 「改为未完成」：把指定原把次从「完攀」原位改成「未完成」。
 *
 * 输入：{ attemptId, routeId?, sessionId?, generation? }
 * 返回：{ ok, code, error, archive, attempt }
 * code：corrected / resolved（已经是未完成，幂等）/ missing / conflict / stale /
 *       unsupported（非抱石）/ unreadable / write-failed。
 *
 * 只翻这一把的 result：把数、ID、序号、场次、备注与其他把次（含后来新记的完攀）
 * 一律不动。两段写让同一把的更正失败后可重试。
 */
function correctAttempt(attemptId, input) {
  const data = input || {};
  if (!hasText(attemptId)) {
    return { ok: false, code: 'missing', error: '缺少要改正的把次 ID', archive: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, archive: loaded.archive };
  }
  const current = loaded.archive;
  const attempt = current.attempts.find(item => item.id === attemptId) || null;
  if (!attempt) {
    return { ok: false, code: 'missing', error: '找不到这一把，可能已被重置', archive: current };
  }
  if (hasText(data.routeId) && data.routeId !== attempt.routeId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前线路，未做更正', archive: current };
  }
  if (hasText(data.sessionId) && data.sessionId !== attempt.sessionId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前场次，未做更正', archive: current };
  }

  const route = findById(current.routes, attempt.routeId);
  if (!route || !rules.isBoulderRoute(route)) {
    return { ok: false, code: 'unsupported', error: '只有抱石的已完攀把次能改成未完成', archive: current };
  }
  if (!findById(current.sessions, attempt.sessionId)) {
    return { ok: false, code: 'missing', error: '原场次已不存在，未做更正', archive: current };
  }
  // 已经是未完成：重复提交、连点或迟到的旧更正都只复用结果，不改任何记录。
  if (attempt.result !== 'send') {
    return { ok: true, code: 'resolved', duplicate: true, error: '', archive: current, attempt: clone(attempt) };
  }

  // 第一段：落盘「更正进行中」标记。
  const staging = clone(current);
  staging.pendingCorrections = staging.pendingCorrections
    .filter(item => item.attemptId !== attemptId)
    .concat([
      {
        attemptId: attemptId,
        sessionId: attempt.sessionId,
        routeId: attempt.routeId,
        createdAt: timestamp(data.now)
      }
    ]);
  const staged = saveArchive(staging);
  if (!staged.ok) {
    return { ok: false, code: 'write-failed', error: staged.error, archive: current };
  }

  // 第二段：原位翻结果并清掉标记；只改这一把，其他一律不动。
  const committed = clone(staging);
  const target = committed.attempts.find(item => item.id === attemptId);
  target.result = 'fail';
  committed.pendingCorrections = committed.pendingCorrections.filter(
    item => item.attemptId !== attemptId
  );
  const saved = saveArchive(committed);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, archive: staging };
  }
  return { ok: true, code: 'corrected', duplicate: false, error: '', archive: committed, attempt: clone(target) };
}

module.exports = {
  NAMESPACE,
  ARCHIVE_KEY,
  PHOTO_INDEX_KEY,
  REBUILDABLE_PREFIXES,
  STATE_VERSION,
  ARCHIVE_BROKEN,
  ARCHIVE_UNSUPPORTED,
  clone,
  formatLocalDate,
  todayLocalDate,
  isDateString,
  createEmptyArchive,
  normalizeArchive,
  loadState,
  loadArchive,
  hasArchive,
  saveArchive,
  isRebuildableKey,
  isProtectedKey,
  clearRebuildableStorage,
  gymName,
  sessionLabel,
  sessionsOnDate,
  routesForGym,
  routesForSession,
  attemptsFor,
  newOperationId,
  routeHistory,
  routesWithHistory,
  resumeRouteToday,
  chooseRouteSession,
  startSession,
  createRoute,
  linkRouteToSession,
  selectSession,
  selectRoute,
  saveAttempt,
  routeCompletion,
  routeCorrectionTargets,
  routeCorrectionRows,
  setAttemptNote,
  correctAttempt,
  // 转出线路规则，页面与档案层共用同一份判定。
  CLIMB_TYPES: rules.CLIMB_TYPES,
  GRADES_BY_TYPE: rules.GRADES_BY_TYPE,
  DEFAULT_CLIMB_TYPE: rules.DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE: rules.DEFAULT_GRADE,
  isBoulderRoute: rules.isBoulderRoute,
  isGradeForType: rules.isGradeForType,
  resolveGradeForType: rules.resolveGradeForType
};
