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
 * 重试复用原 ID，不产生第二把、也不覆盖后来的新数据。这条标记重开之后依然可恢复：
 * 同一 opId 带原场次、原线路、原结果与原备注重试就能补齐那一把（含抱石首个完攀——
 * 恢复自己的在途完攀不被它自己封锁），别的操作不能借用别人的 opId 绕过封锁或改写它。
 *
 * 档案内容读取只发生在当前代际的档案键上（没有文本恢复时就是 archive 键）：无键是正常
 * 的首次进入，返回空档案；键存在但损坏、或版本不被支持时返回可见错误且**保留原数据**
 * （读写入口都不会覆盖它）。文本恢复过之后 active 档案键缺失按损坏处理，不当成首次进入。
 *
 * 抱石沿用 v0.3 语义：已确认完攀后不再新增把次，只能按原把次显式「改为未完成」——
 * 只翻那一把的 result，把数、ID、序号、场次与备注都不变；顶绳和先锋可重复完攀。
 *
 * T018 在本层加的是「回看」与「今天再记」两件事，都不新增数据模型：
 *   routeHistory / routesWithHistory   跨日按本地日期与场次分组的只读回看；
 *   resumeRouteToday / chooseRouteSession  用户明确点按「再记」时才改当前场次与线路
 *   （同日多场先让用户显式选一场，原归属不动）。打开历史本身只读，不建场次、不改数据，
 *   旧云记录与旧 climbing_sessions 汇总一律不进入本机统计。
 *
 * T032 在本层加的是「同一把次的撤回与恢复」：
 *   undoAttempt / restoreAttempt  给一把已提交把次标上或清掉撤回时间；
 *   isEffectiveAttempt / attemptsFor({ includeUndone })  各读数端共用的有效集合口径。
 * 撤回不是删除、也不是把结果改成相反值：把次本身（ID、序号、场次、线路、结果、备注与
 * 创建时间）逐项保留，只多一个 undoneAt 标记；恢复就是清掉这个标记，因此恢复后拿回的
 * 是同一次操作的原 ID、原序号、原结果与原备注。每次撤回/恢复落盘后还会把这次操作的
 * opId 记在原把次的 settledOps 里：同一操作的迟到回调、回执丢失后的重试据此认出「早已
 * 结清」，只回读当前状态而不写盘，因此延迟到达的撤回不会撤销后来成功的恢复（反之亦然）。
 * 撤回、恢复各分两段写（先落「进行中」标记，再提交标记本身），任一段失败都返回 ok:false
 * 并留下可重试的记录；重开后一律按持久状态收敛，不产生第二把、不串线。
 * 每次撤回/恢复落盘还会把这一把的 rev（有效状态变更版本）加一：页面渲染控件时把 rev
 * 随点击带回（expectedRev），落盘前与持久版本比对，过期事件一律拒绝、不写一个字，
 * 这样「3→2→3 之后重放旧撤回」的 ABA 无法得逞（见 attemptRev / expectedRevMismatch）。
 * 旧档案没有 undoneAt / settledOps / rev 字段时，全部已提交把次按有效读取、版本按 0 读，
 * 只读打开不迁移、不改原字节。
 *
 * T051 在本层加的是「整场删除」的一次提交：inspectSessionDeletion 按原档案 ID + 原场次
 * ID 返回本场快照（原日期、岩馆、场次、场内关联与全部把次，含已撤回），commitSessionDeletion
 * 必须带同一份快照；内容有任何变化（包括把数不变但结果/备注/原把被替换）都按 stale 拒绝。
 * 一次档案写入只移出目标场次、它的场内关联与全部把次，其他场次、原 ID、内部 seq 与单调
 * 计数器保持原值；删当前场时接续同日同馆剩余最近一场，没有可接续场则清空当前选择。
 * 媒体归属与清理不在本层，由 T052 的协调器在档案确认删除后按持久凭据处理。
 *
 * T067 在本层加的是「文本恢复后的档案代际选择」，不改数据模型，也不迁移旧档：
 *   climbingNote.training.v1.backup.commit    很小的提交记录（指向当前代际的两把键）
 *   climbingNote.training.v1.backup.pending   很小的预演/提交计划（不含原文）
 *   climbingNote.training.v1.backup.stage.<g>.archive   新一代档案原文（单独一把键）
 *   climbingNote.training.v1.backup.stage.<g>.wishlist  新一代清单原文（单独一把键）
 * 没有提交记录时，档案与清单仍读写原来的 archive / wishlist 键，行为与旧版完全一致。
 * 恢复确认先把两份原文分别写入新一代的 stage 键并逐一读回核对，最后才写 commit 键；
 * commit 键是唯一的提交点，所以训练与清单两个读取入口不会看到一半新一半旧。wx 的多把
 * 写入不假设原子：commit 之前的任何失败都只留下不可见的 stage/pending，旧档继续可读。
 * 之后普通写入跟随 commit 指向的键，旧键原样保留（不删除、不改写），清缓存仍只清
 * cache./thumbs. 前缀。提交记录损坏时不回退到旧键（避免把旧代际当成当前状态），
 * 读取返回可见错误，写入口拒绝落盘。
 */
const rules = require('./training-rules.js');

const NAMESPACE = 'climbingNote.training.v1.';
const ARCHIVE_KEY = NAMESPACE + 'archive';
const WISHLIST_KEY = NAMESPACE + 'wishlist';
const PHOTO_INDEX_KEY = NAMESPACE + 'photos';
// T067：文本恢复的代际提交点与预演记录。两把都只存元数据，不放大段原文。
const BACKUP_COMMIT_KEY = NAMESPACE + 'backup.commit';
const BACKUP_PENDING_KEY = NAMESPACE + 'backup.pending';
const BACKUP_STAGE_PREFIX = NAMESPACE + 'backup.stage.';
const LAYOUT_VERSION = 1;
const LAYOUT_GENERATION_PATTERN = /^[A-Za-z0-9_-]{6,90}$/;
const LAYOUT_READ_FAILED = '读取本机文本恢复状态失败：';
const LAYOUT_BROKEN = '本机文本恢复提交记录损坏，为避免把旧档案当成当前状态，已停止读取；请先导出诊断';
// 可重建的派生缓存：普通清缓存只清这些前缀。
const REBUILDABLE_PREFIXES = [NAMESPACE + 'cache.', NAMESPACE + 'thumbs.'];
const STATE_VERSION = 1;

// 可见错误文案：损坏与版本不支持要和「首次为空」区分开，页面据此提示并保留原数据。
const ARCHIVE_BROKEN = '本机训练档案格式损坏，请重置本地档案后再试';
const ARCHIVE_UNSUPPORTED = '本机训练档案版本不受支持，请升级小程序或重置本地档案';
const ARCHIVE_READ_FAILED = '读取本机训练档案失败：';
const ARCHIVE_WRITE_FAILED = '保存本机训练档案失败：';
// 撤回/恢复：这一把属于另一份本机档案（换档之后的迟到点击），一律不落盘。
const ATTEMPT_ARCHIVE_MISMATCH = '这一把属于原来的本机档案，未做改动';
// 撤回/恢复：这一把的当前状态已经不是发起时的那一种（迟到的旧回调）。
const ATTEMPT_STALE = '这一把的状态已经变了，请刷新后再试';
// 场次删除：确认必须带原档案、原场次与打开确认时的快照，三者缺一都不写档案。
const SESSION_DELETE_INCOMPLETE = '删除场次需要原档案 ID、原场次 ID 和确认快照，未做任何改动';
const SESSION_DELETE_STALE = '这场训练的内容已经变化，这次删除没有生效；请按最新范围重新确认';
const SESSION_DELETE_ARCHIVE_MISMATCH = '这场训练属于原来的本机档案，未做改动';

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

/**
 * 一个操作 ID 是否已经被这份档案占用了：已提交（含已撤回）的把次，或还没落盘的
 * 「进行中」操作。只有当返回值是 false 时才能拿这个 ID 当作新一把的 ID。
 */
function attemptIdTaken(archive, id) {
  if (!archive || !hasText(id)) return true;
  if ((archive.attempts || []).some(item => item.id === id)) return true;
  if ((archive.pendingSaves || []).some(item => item.opId === id)) return true;
  return false;
}

/**
 * 由本层自己生成一个新把次 ID，并在**这份档案**里另取一个唯一的。
 *
 * 页面没带 opId 的「新一把」走这里：先按 newOperationId 生成，若与已提交（含已撤回）
 * 或待保存的 ID 撞上就再生成一个。撞上时必须换新 ID，而不是把这次新意图当成
 * 「迟到的显式 opId 重放」去复用别人（甚至已被撤回）的那一把——显式带 opId 的
 * 请求另有去重路径（见 saveAttempt），两者不能互相顶替。
 *
 * isRetired 是保存前读到的删除凭据（pending/removed/墓碑）：已删除的原 ID 同样不能
 * 被新一把复用，否则一次巧合的 ID 撞名就会把删掉的记录写回来。凭据读不出来时调用方
 * 不会走到这里（宁可不保存）。
 */
function newUniqueAttemptId(archive, isRetired) {
  const retired = typeof isRetired === 'function' ? isRetired : () => false;
  let candidate = newOperationId();
  let salt = 0;
  while (attemptIdTaken(archive, candidate) || retired(candidate)) {
    salt += 1;
    candidate = newOperationId() + '-' + salt;
  }
  return candidate;
}

/**
 * 把次的**有效状态变更版本**（T030–T033 返工）。
 *
 * 撤回与恢复每次真正落盘都会把这一把的 rev 加一：页面渲染控件时把当时读到的 rev
 * 随点击带回来（expectedRev），档案层在落盘前与最新持久状态比较，不相等就按过期
 * 事件拒绝、一个字都不写。于是「3→2→3 之后重放旧的撤回」这类 ABA 不会再得逞：
 * 旧事件带来的版本早就不是当前版本了。
 *
 * 旧档案没有这个字段：一律按 0 读（缺省版本），只读打开不迁移、不回写。
 */
function attemptRev(attempt) {
  return attempt && Number.isInteger(attempt.rev) && attempt.rev > 0 ? attempt.rev : 0;
}

function bumpAttemptRev(attempt) {
  const next = attemptRev(attempt) + 1;
  attempt.rev = next;
  return next;
}

/**
 * 请求里带回来的「预期版本」。识别四种写法（任一即可）：
 *   expectedRev / expectedVersion / rev —— 撤回、恢复的直接字段；
 *   expected —— 只有取值是可比较的整数时才算版本；'effective' / 'undone' 这类
 *   状态名仍走原来的预期状态核对（见 expectedStateMismatch）。
 * 拿不到可比较的版本时返回 null：调用方按「调用方没有版本可校验」处理，保持旧调用
 * （例如旧页面、旧测试）的兼容行为。
 */
function requestedAttemptRev(data) {
  const source = data || {};
  const candidates = [source.expectedRev, source.expectedVersion, source.rev, source.expected];
  for (const value of candidates) {
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * 「第 N 把」的**显示序号**：同一场次、同一条线路里，按把次序号（seq）排出的位置，
 * 但只给**有效把次**连续编号——已撤回的那一把不占号，所以撤回第 2 把之后再成功记入
 * 一把，新一把显示「第 2 把」，恢复原来的第 2 把时它又接回原号。
 *
 * 这只是显示口径：档案里的原 ID、seq 与归属不动，备注和视频仍按原把次 ID 索引；
 * 编号只读推导，不写档案、不迁移旧数据。
 *
 * 已撤回但仍留在页面上的那一把（最近一次撤回的行原位保留「恢复」）拿**恢复位置号**：
 * 恢复后它会回到的顺序，例如第 2 把撤回后显示「第 2 把」，但它不计入有效把数，也不让
 * 其他有效把次跳号。pendingSaves 只在页面展示待保存行时并入
 * （options.includePending）：待保存的一把按它落盘后占据的有效顺序显示（通常就是下一个号）。
 *
 * 现场逐把、归档逐把、线路历史、视频标题与纠错确认都读取这一份投影，不各自编号。
 */
function attemptOrdinalMap(archive, sessionId, routeId, options) {
  const inScope = item => item.sessionId === sessionId && item.routeId === routeId;
  const attempts = ((archive && archive.attempts) || []).filter(inScope);
  const pending = options && options.includePending
    ? ((archive && archive.pendingSaves) || []).filter(inScope)
    : [];
  // 有效把次与待保存的一把一起按 seq 排；已撤回的不参与计数，只按同一顺序占一个
  // 恢复位置。sort 在 Node 与小程序运行时都是稳定排序，同 seq 的旧档按原顺序读。
  const rows = attempts
    .map(item => ({ id: item.id, seq: item.seq || 0, counted: isEffectiveAttempt(item) }))
    .concat(pending.map(item => ({ id: item.opId, seq: item.seq || 0, counted: true })));
  rows.sort((left, right) => left.seq - right.seq);
  const ordinals = new Map();
  let counted = 0;
  rows.forEach(row => {
    if (row.counted) {
      counted += 1;
      ordinals.set(row.id, counted);
    } else {
      // 恢复位置号：恢复后它接在已经数过的有效把次后面；不增加有效计数。
      ordinals.set(row.id, counted + 1);
    }
  });
  return ordinals;
}

function attemptOrdinal(archive, attempt) {
  if (!attempt) return 0;
  return attemptOrdinalMap(archive, attempt.sessionId, attempt.routeId).get(attempt.id) || 0;
}

function ordinalLabel(value) {
  return '第 ' + (value > 0 ? value : 1) + ' 把';
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
    // 已经点了撤回/恢复、但撤回标记还没落盘的操作（T032）：按把次 ID 各留一条。
    pendingUndos: [],
    pendingRestores: [],
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
  const undosRaw = raw.pendingUndos === undefined ? [] : raw.pendingUndos;
  const restoresRaw = raw.pendingRestores === undefined ? [] : raw.pendingRestores;
  if (
    !Array.isArray(sessionRoutesRaw) ||
    !Array.isArray(pendingRaw) ||
    !Array.isArray(correctionsRaw) ||
    !Array.isArray(undosRaw) ||
    !Array.isArray(restoresRaw)
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
      hasText(item.createdAt) &&
      // 撤回标记：缺字段（旧档案）或空串都表示这一把仍有效。
      (item.undoneAt === undefined || typeof item.undoneAt === 'string') &&
      // 有效状态变更版本：旧档案缺字段（按 0 读），已写入的必须是非负整数。
      (item.rev === undefined || (Number.isInteger(item.rev) && item.rev >= 0)) &&
      // 已结清的撤回/恢复操作凭据：缺字段（旧档案）按空列表读取，不迁移。
      (item.settledOps === undefined ||
        (Array.isArray(item.settledOps) &&
          item.settledOps.every(op => op && hasText(op.opId))))
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
  // 撤回/恢复的「进行中」标记：目标把次、原场次与原线路缺一不可。
  const markOk = item =>
    item && hasText(item.attemptId) && hasText(item.sessionId) && hasText(item.routeId);
  const undosOk = undosRaw.every(markOk);
  const restoresOk = restoresRaw.every(markOk);
  if (
    !gymsOk ||
    !sessionsOk ||
    !routesOk ||
    !sessionRoutesOk ||
    !attemptsOk ||
    !pendingOk ||
    !correctionsOk ||
    !undosOk ||
    !restoresOk
  ) {
    return null;
  }

  const uniqueIds = items => new Set(items.map(item => item.id)).size === items.length;
  const uniqueOpIds = new Set(pendingRaw.map(item => item.opId)).size === pendingRaw.length;
  const uniqueCorrectionIds =
    new Set(correctionsRaw.map(item => item.attemptId)).size === correctionsRaw.length;
  // 同一把次最多各挂一条撤回标记与一条恢复标记（两种意图互斥，见 undoAttempt/restoreAttempt）。
  const uniqueUndoIds = new Set(undosRaw.map(item => item.attemptId)).size === undosRaw.length;
  const uniqueRestoreIds =
    new Set(restoresRaw.map(item => item.attemptId)).size === restoresRaw.length;
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
    !uniqueUndoIds ||
    !uniqueRestoreIds ||
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

  // 撤回/恢复的「进行中」标记只在还能应用时保留：目标把次必须仍存在、归属一致，
  // 且当前状态还没走到这次意图的终点（撤回标记对应的把次已撤回、恢复标记对应的把次
  // 已恢复时，意图已经达成，丢掉标记即可）。丢掉标记不改变任何把次，重复请求按
  // 持久状态幂等收敛；已达成意图的迟到重试不会把状态翻回去。
  const markStillApplies = (item, undone) => {
    const attempt = attemptById.get(item.attemptId);
    return Boolean(
      attempt &&
        attempt.sessionId === item.sessionId &&
        attempt.routeId === item.routeId &&
        rules.isUndoneAttempt(attempt) === undone
    );
  };
  const pendingUndos = undosRaw.filter(item => markStillApplies(item, false));
  const pendingRestores = restoresRaw.filter(item => markStillApplies(item, true));

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
    pendingUndos,
    pendingRestores,
    activeSessionId: hasText(raw.activeSessionId) ? raw.activeSessionId : '',
    activeRouteId: hasText(raw.activeRouteId) ? raw.activeRouteId : ''
  };
}

// ------------------------------------------------------------------ *
// T067：文本恢复的代际选择
// ------------------------------------------------------------------ *

function isRecord(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      !Object.prototype.hasOwnProperty.call(value, '__proto__')
  );
}

function isSafeArchiveId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function stageKeysFor(generation) {
  return {
    archiveKey: BACKUP_STAGE_PREFIX + generation + '.archive',
    wishlistKey: BACKUP_STAGE_PREFIX + generation + '.wishlist'
  };
}

function legacyLayout() {
  return {
    ok: true,
    error: '',
    code: 'legacy',
    generation: '',
    archiveKey: ARCHIVE_KEY,
    wishlistKey: WISHLIST_KEY,
    legacy: true,
    record: null
  };
}

/**
 * 严格解析 commit 键：只有本层写出的、键名与代际一致、字段齐全的小记录才算有效。
 * 提交记录损坏时不猜、不回退旧键，由读取入口返回可见错误。
 */
function parseCommitRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  if (!isRecord(record)) return null;
  const keys = [
    'version',
    'generation',
    'archiveKey',
    'wishlistKey',
    'archiveId',
    'archiveBytes',
    'wishlistBytes',
    'archiveChecksum',
    'wishlistChecksum',
    'committedAt',
    'previous'
  ];
  if (Object.keys(record).length !== keys.length) return null;
  if (!keys.every(key => Object.prototype.hasOwnProperty.call(record, key))) return null;
  if (record.version !== LAYOUT_VERSION) return null;
  if (typeof record.generation !== 'string' || !LAYOUT_GENERATION_PATTERN.test(record.generation)) {
    return null;
  }
  const expected = stageKeysFor(record.generation);
  if (record.archiveKey !== expected.archiveKey || record.wishlistKey !== expected.wishlistKey) {
    return null;
  }
  if (!isSafeArchiveId(record.archiveId)) return null;
  if (!Number.isInteger(record.archiveBytes) || record.archiveBytes < 0) return null;
  if (!Number.isInteger(record.wishlistBytes) || record.wishlistBytes < 0) return null;
  if (typeof record.archiveChecksum !== 'string' || typeof record.wishlistChecksum !== 'string') {
    return null;
  }
  if (typeof record.committedAt !== 'string' || !record.committedAt) return null;
  const previous = record.previous;
  if (!isRecord(previous)) return null;
  const previousKeys = [
    'archiveKey',
    'wishlistKey',
    'archivePresent',
    'wishlistPresent',
    'archiveBytes',
    'wishlistBytes',
    'archiveChecksum',
    'wishlistChecksum'
  ];
  if (Object.keys(previous).length !== previousKeys.length) return null;
  if (!previousKeys.every(key => Object.prototype.hasOwnProperty.call(previous, key))) return null;
  if (typeof previous.archiveKey !== 'string' || !previous.archiveKey) return null;
  if (typeof previous.wishlistKey !== 'string' || !previous.wishlistKey) return null;
  if (typeof previous.archivePresent !== 'boolean' || typeof previous.wishlistPresent !== 'boolean') {
    return null;
  }
  if (!Number.isInteger(previous.archiveBytes) || previous.archiveBytes < 0) return null;
  if (!Number.isInteger(previous.wishlistBytes) || previous.wishlistBytes < 0) return null;
  if (
    typeof previous.archiveChecksum !== 'string' ||
    typeof previous.wishlistChecksum !== 'string'
  ) {
    return null;
  }
  return record;
}

function committedLayout(record) {
  return {
    ok: true,
    error: '',
    code: 'committed',
    generation: record.generation,
    archiveKey: record.archiveKey,
    wishlistKey: record.wishlistKey,
    legacy: false,
    record
  };
}

let layoutCache = null;

/**
 * 当前代际。没有 commit 键时沿用旧键布局（等于没有恢复过）。
 * 结果在进程内缓存；恢复提交与冷启动恢复成功后由本模块更新，测试可用 resetLayoutCache。
 * getStorageInfoSync 只用来判断 commit 键是否存在：没有恢复过时，档案读取不会多一次
 * getStorageSync，旧行为与调用次数保持不变。
 */
function resolveLayout() {
  if (layoutCache) return layoutCache;
  let keys;
  try {
    const info = wx.getStorageInfoSync();
    keys = info && Array.isArray(info.keys) ? info.keys : [];
  } catch (error) {
    return {
      ok: false,
      error: LAYOUT_READ_FAILED + errorText(error),
      code: 'layout-unreadable',
      generation: '',
      archiveKey: '',
      wishlistKey: '',
      legacy: false,
      record: null
    };
  }
  if (keys.indexOf(BACKUP_COMMIT_KEY) === -1) {
    layoutCache = legacyLayout();
    return layoutCache;
  }
  let raw;
  try {
    raw = wx.getStorageSync(BACKUP_COMMIT_KEY);
  } catch (error) {
    return {
      ok: false,
      error: LAYOUT_READ_FAILED + errorText(error),
      code: 'layout-unreadable',
      generation: '',
      archiveKey: '',
      wishlistKey: '',
      legacy: false,
      record: null
    };
  }
  const record = parseCommitRecord(raw);
  if (!record) {
    return {
      ok: false,
      error: LAYOUT_BROKEN,
      code: 'layout-broken',
      generation: '',
      archiveKey: '',
      wishlistKey: '',
      legacy: false,
      record: null
    };
  }
  layoutCache = committedLayout(record);
  return layoutCache;
}

function resetLayoutCache() {
  layoutCache = null;
}

/**
 * 只有 T067 的提交成功后才调用：让同进程后续读取立刻跟随新代际。
 */
function activateLayout(record) {
  const parsed = parseCommitRecord(typeof record === 'string' ? record : JSON.stringify(record));
  if (!parsed) return false;
  layoutCache = committedLayout(parsed);
  return true;
}

/**
 * 按当前布局读取一把键的原文；present:false 只表示读到空值，读取失败单独返回 ok:false。
 */
function readStorageText(key) {
  try {
    const value = wx.getStorageSync(key);
    if (value === '' || value === null || value === undefined) {
      return { ok: true, present: false, value: '', raw: value };
    }
    if (typeof value !== 'string') {
      return { ok: false, present: false, value: '', raw: value, error: '本机存储值不是文本：' + key };
    }
    return { ok: true, present: true, value, raw: value };
  } catch (error) {
    return { ok: false, present: false, value: '', raw: '', error: errorText(error) };
  }
}

function readActiveArchiveRaw() {
  const layout = resolveLayout();
  if (!layout.ok) {
    return { ok: false, present: false, value: '', layout, key: '', error: layout.error };
  }
  const read = readStorageText(layout.archiveKey);
  return {
    ok: read.ok,
    present: read.present,
    value: read.value,
    raw: read.raw,
    error: read.error || '',
    layout,
    key: layout.archiveKey
  };
}

function readActiveWishlistRaw() {
  const layout = resolveLayout();
  if (!layout.ok) {
    return { ok: false, present: false, value: '', layout, key: '', error: layout.error };
  }
  const read = readStorageText(layout.wishlistKey);
  return {
    ok: read.ok,
    present: read.present,
    value: read.value,
    raw: read.raw,
    error: read.error || '',
    layout,
    key: layout.wishlistKey
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
  const layout = resolveLayout();
  if (!layout.ok) {
    return {
      archive: createEmptyArchive(),
      error: layout.error,
      ok: false,
      present: false,
      corrupt: false,
      layout
    };
  }
  let raw;
  try {
    raw = wx.getStorageSync(layout.archiveKey);
  } catch (error) {
    return {
      archive: createEmptyArchive(),
      error: ARCHIVE_READ_FAILED + errorText(error),
      ok: false,
      present: false,
      corrupt: false,
      layout
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    // 恢复过之后 active 键缺失不能当成「首次进入」：那会把新一代静默读成空档。
    if (!layout.legacy) {
      return {
        archive: createEmptyArchive(),
        error: ARCHIVE_BROKEN,
        ok: false,
        present: true,
        corrupt: true,
        layout
      };
    }
    return {
      archive: createEmptyArchive(),
      error: '',
      ok: true,
      present: false,
      corrupt: false,
      layout
    };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return {
      archive: createEmptyArchive(),
      error: ARCHIVE_BROKEN,
      ok: false,
      present: true,
      corrupt: true,
      layout
    };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version !== undefined && parsed.version !== STATE_VERSION) {
    return {
      archive: createEmptyArchive(),
      error: ARCHIVE_UNSUPPORTED,
      ok: false,
      present: true,
      corrupt: true,
      layout
    };
  }

  const archive = normalizeArchive(parsed);
  if (!archive) {
    return {
      archive: createEmptyArchive(),
      error: ARCHIVE_BROKEN,
      ok: false,
      present: true,
      corrupt: true,
      layout
    };
  }
  return { archive, error: '', ok: true, present: true, corrupt: false, layout };
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
  const layout = resolveLayout();
  if (!layout.ok) return { ok: false, error: layout.error, key: '' };
  try {
    wx.setStorageSync(layout.archiveKey, JSON.stringify(archive));
    return { ok: true, error: '', key: layout.archiveKey };
  } catch (error) {
    return { ok: false, error: ARCHIVE_WRITE_FAILED + errorText(error), key: layout.archiveKey };
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

/**
 * 有效把次：已提交且未被撤回。旧档案没有撤回标记时一律有效；判定只有这一份，
 * 页面、统计、小结与清单共用 rules 的同一个函数（见 utils/training-rules.js）。
 */
function isEffectiveAttempt(attempt) {
  return rules.isEffectiveAttempt(attempt);
}

/** 已撤回把次：带非空撤回标记。旧档案缺字段时一律 false（有效），不迁移。 */
function isUndoneAttempt(attempt) {
  return rules.isUndoneAttempt(attempt);
}

function effectiveAttempts(attempts) {
  return rules.effectiveAttempts(attempts);
}

/**
 * 一场次/一条线路下的把次，按序号从小到大。
 *
 * 缺省只给**有效把次**（已撤回的那一把不在里面），因此把数、逐把列表与完攀口径一致；
 * 需要连撤回记录一起看时传 { includeUndone: true }（撤回/恢复界面在原位置保留那一把，
 * 恢复入口仍落在原处）。撤回标记本身不影响排序：序号是持久不变的。
 */
function attemptsFor(archive, filter) {
  const all = (archive && archive.attempts) || [];
  const match = filter || {};
  return all
    .filter(
      item =>
        (match.includeUndone === true || isEffectiveAttempt(item)) &&
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
 *
 * 只统计**有效把次**（未撤回的那一把，T032）：撤回唯一一把抱石完攀后这条线重新可记，
 * 恢复后再次封锁。已撤回的把次不计入 sendCount，也不作为更正目标。
 *
 * options.ignorePendingOpId：把这一条「进行中」的完攀当作不属于封锁来源。只有
 * saveAttempt 恢复同一次操作时用它——否则那条在途完攀会把唯一能补齐它的重试
 * 自己也挡在门外。别的操作（换 opId、别的在途）一律照旧计入封锁。
 */
function routeCompletion(archive, routeId, options) {
  const unknown = {
    known: false,
    routeId: routeId || '',
    isBoulder: false,
    repeatable: true,
    sendCount: 0,
    pendingSendCount: 0,
    pendingCorrectionCount: 0,
    undoneCount: 0,
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

  const data = options || {};
  const ignorePendingOpId = hasText(data.ignorePendingOpId) ? data.ignorePendingOpId : '';
  const isBoulder = rules.isBoulderRoute(route);
  const attempts = (archive.attempts || []).filter(item => item.routeId === route.id);
  const effective = attempts.filter(isEffectiveAttempt);
  const sends = effective.filter(item => item.result === 'send');
  const pendingSends = (archive.pendingSaves || []).filter(
    item =>
      item.routeId === route.id &&
      item.result === 'send' &&
      item.opId !== ignorePendingOpId
  );
  // 撤回进行中：一个「恢复」已经在途的完攀同样算待确认完攀——否则它提交后这条线会多出
  // 第二次有效完攀。已撤回却还没恢复的那一把本身不算（它就是待恢复的那一次）。
  const attemptById = new Map(attempts.map(item => [item.id, item]));
  const pendingRestoreSends = (archive.pendingRestores || []).filter(marker => {
    if (marker.routeId !== route.id) return false;
    const attempt = attemptById.get(marker.attemptId);
    return Boolean(attempt && attempt.result === 'send' && !isEffectiveAttempt(attempt));
  });
  const pendingSendCount = pendingSends.length + pendingRestoreSends.length;
  const corrections = (archive.pendingCorrections || []).filter(
    item => item.routeId === route.id
  );
  const hasSend = sends.length > 0;
  const hasPendingSend = pendingSendCount > 0;
  const closed = isBoulder && (hasSend || hasPendingSend);
  const target = rules.latestSendAttempt(effective, route.id);
  const correcting = isBoulder && corrections.length > 0;

  return {
    known: true,
    routeId: route.id,
    isBoulder,
    repeatable: !isBoulder,
    sendCount: sends.length,
    pendingSendCount,
    pendingCorrectionCount: corrections.length,
    // 这条线上已撤回的把次数：页面据此在原位置保留撤回行、提供恢复入口。
    undoneCount: attempts.length - effective.length,
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
 * 「第几把」用的是这一把在**本场次本线路**里的显示序号（只数有效把次，见
 * attemptOrdinalMap），因此确认弹窗里的编号与现场、历史、视频标题完全一致。
 */
function correctionRow(archive, attempt) {
  const session = findById(archive.sessions, attempt.sessionId);
  const ordinal = attemptOrdinal(archive, attempt);
  return {
    attemptId: attempt.id,
    routeId: attempt.routeId,
    sessionId: attempt.sessionId,
    seq: attempt.seq || 0,
    label: ordinalLabel(ordinal),
    contextText: session
      ? session.date + ' ' + sessionLabel(archive, session) + ' · ' + gymName(archive, session.gymId)
      : ''
  };
}

/**
 * 这条抱石线里符合 accept 的有效把次，「序号大的在前、同序号后加入的在前」。
 * 已撤回的把次不在目标里：它已经不在有效集合，没有可更正的完攀。
 */
function correctionEntries(archive, route, accept) {
  return (archive.attempts || [])
    .map((item, index) => ({ item, index }))
    .filter(
      entry =>
        isEffectiveAttempt(entry.item) && entry.item.routeId === route.id && accept(entry.item)
    )
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
 * 只列**有效把次**（T032）：已撤回的那一把不进历史、不计把数与完攀，恢复后又回到原来的
 * 序号位置。整条线都把次都撤回时，这次训练不再出现在历史里。显示用的「第 N 把」是这一把
 * 在本场次本线路里的显示序号（只数有效把次，见 attemptOrdinalMap），因此撤回第 2 把
 * 后再记一把，历史里的新一把是第 2 把，与现场逐把、视频标题一致。
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
    if (!isEffectiveAttempt(attempt)) return;
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
      // 「第 N 把」用本场次本线路的显示序号（只数有效把次），不是这一份列表里的下标：
      // 撤回第 2 把之后新记的一把就是第 2 把，历史里不留空号，也不与现场编号打架。
      const ordinals = attemptOrdinalMap(archive, entry.session.id, route.id);
      return {
        sessionId: entry.session.id,
        date: entry.session.date,
        seq: entry.session.seq,
        sessionLabel: sessionLabel(archive, entry.session),
        gymId: entry.session.gymId,
        gymName: gymName(archive, entry.session.gymId),
        countText: ordered.length + ' 把',
        attempts: ordered.map(attempt => ({
          id: attempt.id,
          seq: attempt.seq || 0,
          label: ordinalLabel(ordinals.get(attempt.id) || 0),
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
 * 只统计本机档案里的**有效把次**（T032）：旧云汇总、旧 climbing_sessions 数据与别的线路
 * 都不参与，也不按名称、颜色或难度归并。线路或场次档案缺失时跳过，不猜；已撤回的把次
 * 不贡献把数与完攀，一条线的把次全部撤回后不再出现在这份历史里。
 */
function routesWithHistory(archive) {
  if (!archive) return [];

  const stats = new Map();
  (archive.attempts || []).forEach(attempt => {
    if (!isEffectiveAttempt(attempt)) return;
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
 * 保存前的删除凭据核对（只读）。
 *
 * 延迟 require training-attempt-delete 与 training-session-delete：它们顶层依赖
 * attempt-video → training-record-actions → 本模块，顶层互相 require 会形成初始化
 * 循环；这里只在真正保存时加载，那时本模块已经初始化完毕。读不出来或模块不可用时
 * 返回 ok:false，调用方不得把它当作「确认未删除」继续写档案。
 *
 * T052：整场删除的护栏也在这里合并。目标把次 ID（prepared/removed 或已收尾护栏）
 * 与单把删除的 pending/墓碑一样占用原 opId，即使请求把它塞进另一场在途保存也不能
 * 复活；新生成的 ID（newUniqueAttemptId 会避开这些 ID）与其他场次照常可写。
 * sessionState 用于在整场删除在途时拒绝该场的新保存。
 */
function deletionGuardFor(archiveId) {
  let deletion;
  try {
    deletion = require('./training-attempt-delete.js');
  } catch (error) {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机删除凭据失败：' + errorText(error) + '；未保存这一把'
    };
  }
  if (!deletion || typeof deletion.attemptDeletionGuard !== 'function') {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机删除凭据失败：删除凭据模块不可用；未保存这一把'
    };
  }
  const attemptGuard = deletion.attemptDeletionGuard(archiveId);
  if (!attemptGuard.ok) return attemptGuard;

  let sessionDelete;
  try {
    sessionDelete = require('./training-session-delete.js');
  } catch (error) {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机场次删除凭据失败：' + errorText(error) + '；未保存这一把'
    };
  }
  if (!sessionDelete || typeof sessionDelete.sessionFenceState !== 'function') {
    return {
      ok: false,
      code: 'delete-unreadable',
      error: '读取本机场次删除凭据失败：场次删除模块不可用；未保存这一把'
    };
  }
  const sessionGuard = sessionDelete.sessionFenceState(archiveId);
  if (!sessionGuard.ok) {
    return {
      ok: false,
      code: sessionGuard.code || 'delete-unreadable',
      error: (sessionGuard.error || '读取本机场次删除凭据失败') + '；未保存这一把'
    };
  }
  return {
    ok: true,
    present: Boolean(attemptGuard.present || sessionGuard.present),
    has(attemptId) {
      return attemptGuard.has(attemptId) || Boolean(sessionGuard.attemptState(attemptId));
    },
    stateOf(attemptId) {
      return attemptGuard.stateOf(attemptId) || sessionGuard.attemptState(attemptId) || '';
    },
    sessionState(sessionId) {
      return sessionGuard.sessionState(sessionId) || '';
    }
  };
}

/**
 * 保存一把结果与备注。
 *
 * 输入：{ opId?, archiveId?, sessionId?, routeId, result: 'fail'|'send', note?, now? }
 * 返回：{ ok, error, archive, attempt, opId, duplicate, blocked, conflict? }
 *
 * - 同一 opId 重复提交/迟到回调：复用已落盘的把次，只提交一次；这一把已经撤回时
 *   仍然复用原记录（duplicate:true、undone:true），既不复活撤回的那一把、也不新建第二把
 *   ——撤回保留的正是原保存请求的 opId，去重凭据不因撤回而失效；
 * - 同一 opId 已经进入长按删除流程（journal 的 pending/prepared/removed 或墓碑）：
 *   整条拒绝（删除已收尾 code:attempt-deleted；删除未确认/待清理 code:attempt-deleting，
 *   两者都 blocked:true），不写档案也不生成待保存行；
 *   journal 读取失败时不当作「未删除」继续写（code:delete-unreadable）；
 * - 新一次真实尝试：页面换新 opId，得到新的把次 ID；页面**没带 opId** 时由本层生成，
 *   并保证这份档案里唯一且不在删除凭据里（见 newUniqueAttemptId）：与已撤回、仍有效
 *   或已删除的 ID 撞名时另取一个 ID，而不是把这次新意图误当成「迟到的显式 opId
 *   重放」去复用别人那一把；
 * - archiveId 与当前档案不一致（换档之后的迟到重试）：整条不落盘；
 * - 抱石已确认（或别的操作已在提交中）完攀：不再新增，blocked，需先「改为未完成」；
 * - 落盘失败：ok:false，不报已保存；先落盘的「进行中」标记让同 opId 重试复用同一把，
 *   且这条已持久化的待保存操作**重开之后仍能由它自己的 opId 补齐**——第一段写就失败、
 *   或第一段已落盘而回执丢失、或第二段提交失败，都留下同一条可恢复的记录；
 * - 借用在途操作的 opId 换线路/场次/结果/备注：conflict，按原记录拒绝，不新建也不覆盖。
 *
 * 恢复只认「同一次操作」：opId 对应的待保存记录必须在场次、线路、结果与备注上逐项
 * 与本次请求一致，否则视为别的操作借用，直接拒绝。同 opId 的重试把自己的那条在途
 * 完攀排除出抱石封锁（否则它会把唯一能补齐它的重试挡在门外），别的在途操作与已确认
 * 完攀照旧封锁。
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

  const loaded = loadState();
  if (!loaded.ok) {
    return {
      ok: false,
      blocked: false,
      error: loaded.error,
      archive: loaded.archive,
      opId: hasText(data.opId) ? data.opId : newOperationId()
    };
  }
  const current = loaded.archive;

  // 换档之后的迟到重试：这次请求渲染时用的档案 ID 已经不是当前这一份，整条不落盘。
  if (hasText(data.archiveId) && data.archiveId !== current.archiveId) {
    return {
      ok: false,
      blocked: false,
      code: 'archive-mismatch',
      error: ATTEMPT_ARCHIVE_MISMATCH,
      archive: current,
      opId: hasText(data.opId) ? data.opId : ''
    };
  }

  // 删除凭据核对：在档案身份校验之后、任何写或分配保存标记之前。
  // - 显式 opId 一旦属于已删除/正在删除的原记录（prepared、已移出待清理或墓碑），
  //   整条拒绝；只按当前 archiveId + 原 opId 判定，换场次/线路/内容也不能写回；
  // - 无显式 opId 的新一把由生成器避开这些 ID（见 newUniqueAttemptId）；
  // - journal 读取/解析失败时同样不写：没有确认「未删除」之前，迟到的旧 opId
  //   不能借一次读故障复活记录。
  const explicitOpId = hasText(data.opId) ? data.opId : '';
  const deletionGuard = deletionGuardFor(current.archiveId);
  if (!deletionGuard.ok) {
    return {
      ok: false,
      blocked: false,
      code: 'delete-unreadable',
      reason: deletionGuard.code || '',
      error:
        (deletionGuard.error || '读取本机删除凭据失败') +
        '；这次没有保存，请稍后重试',
      archive: current,
      // 没有显式 ID 时也给调用方一个可重试的 ID（与档案读失败时同一口径）；
      // 这次并没有分配保存标记，也没有写档案。
      opId: explicitOpId || newOperationId()
    };
  }
  if (explicitOpId && deletionGuard.has(explicitOpId)) {
    const deleting = deletionGuard.stateOf(explicitOpId) === 'pending';
    return {
      ok: false,
      // 业务拒绝：调用方只提示，不生成「待保存」重试行，也不报保存成功。
      blocked: true,
      code: deleting ? 'attempt-deleting' : 'attempt-deleted',
      deleted: !deleting,
      pendingDeletion: deleting,
      error: deleting
        ? '这一把的删除还没有完成或本机视频副本仍在清理，不能再用原来的操作 ID 写回；请稍后重试或重开确认'
        : '这一把已经删除，不能再用原来的操作 ID 写回；如需记录请重新点结果按钮',
      archive: current,
      opId: explicitOpId
    };
  }

  // 显式 opId 沿用它（去重凭据）；没带 opId 的新一把由本层另取一个档案内唯一、
  // 且不在删除凭据里的 ID。
  const opId = explicitOpId || newUniqueAttemptId(current, id => deletionGuard.has(id));

  // 同一操作重复提交或迟到回调：复用原把次，不新增、不覆盖。
  // 这一把已被撤回时同样只复用原记录：撤回保留原 ID 就是留下去重凭据，迟到的保存
  // 不能把撤回标记抹掉（不复活），也不能绕开它再记一把（不重复）。
  const existing = current.attempts.find(item => item.id === opId);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      undone: isUndoneAttempt(existing),
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

  // 整场删除在途/已提交：这一场不能再接受新保存。原 opId 的迟到重放已在上面的
  // 删除凭据核对里按 archiveId + attemptId 挡住；这里挡住同场的新 ID，避免在
  // 「凭据已落盘、档案尚未删除」的窗口里又长出一把。
  if (typeof deletionGuard.sessionState === 'function') {
    const sessionState = deletionGuard.sessionState(session.id);
    if (sessionState) {
      return {
        ok: false,
        blocked: true,
        code: 'session-deleting',
        error:
          sessionState === 'prepared'
            ? '这一场正在删除，不能继续记录；请稍后重试或重开确认'
            : '这一场已经删除，不能再写入新的把次',
        archive: current,
        opId: opId
      };
    }
  }

  // 已落盘的「进行中」标记：这是同一次操作的重试，还是别的操作借了这个 opId？
  const pendingExisting = current.pendingSaves.find(item => item.opId === opId) || null;

  if (pendingExisting) {
    // 晚到的页面不能借用在途操作的 opId：原归属（场次、线路）、结果与备注必须逐项
    // 一致，不一致时按原记录拒绝——既不新建别的把次，也不覆盖已持久化的那一次操作。
    const sameIntent =
      pendingExisting.sessionId === session.id &&
      pendingExisting.routeId === route.id &&
      pendingExisting.result === result &&
      pendingExisting.note === note;
    if (!sameIntent) {
      return {
        ok: false,
        blocked: false,
        conflict: true,
        error: '这个操作 ID 属于另一条待保存记录，不能按新内容提交；请在原「待保存」行重试',
        archive: current,
        opId: opId
      };
    }
  }

  // 抱石首次完攀守卫：已确认、或**别的操作**仍在提交中的完攀都关闭新增入口。
  // 恢复自己那次在途操作时把自己的那条排除在外，否则这条待保存的完攀永远补不上。
  const completion = routeCompletion(current, route.id, { ignorePendingOpId: opId });
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
 *
 * 已撤回的把次（T032）拒绝改备注：这一把当前不在有效集合里，迟到的备注回调不能
 * 改动它保留的原备注——恢复后拿到的仍是撤回前那一句。
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
  if (!isEffectiveAttempt(attempt)) {
    return {
      ok: false,
      code: 'undone',
      error: '这一把已撤回，未改备注；如需继续记录请先恢复这一把',
      archive: current
    };
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
 *
 * 已撤回的把次（T032）不参与更正：撤回已经表达了「这一把不算」，把它再翻成未完成既
 * 不是用户意图、也会在恢复后与撤回标记打架；要改就先用恢复拿回原把次。
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
  if (!isEffectiveAttempt(attempt)) {
    return {
      ok: false,
      code: 'undone',
      error: '这一把已撤回，不在有效记录里，未做更正；如需继续记录请先恢复这一把',
      archive: current
    };
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

/**
 * 长按删除一把已保存的有效把次（T048–T050 追加返工）。
 *
 * 输入：{ archiveId?, sessionId?, routeId?, expectedRev?, expectedNote?, expectedResult? }
 * 返回：{ ok, code, error, archive, attempt, receiptLost? }
 * code：deleted / deleted-receipt-lost / missing / undone / conflict / stale / pending /
 *       archive-mismatch / unreadable / write-failed / write-failed-unverified。
 *
 * 与「撤回」不同，这里是把这一把从记录数据里**物理移出**：整条 attempts 记录（结果、
 * 备注、时间、序号与 ID）都不再保留；其余把次的 ID、内部 seq、备注与归属逐项不动。
 * 显示编号由 attemptOrdinalMap 按剩余有效把次重算，因此 7 把删除第 5 把后原第 6、7 把
 * 分别显示第 5、6 把。nextAttemptSeq 不回收，新记的一把永远拿更大的内部序号与新 ID，
 * 被删把次的 ID 不会被重新分配。
 *
 * 版本/内容核对（只按原把次 ID 定位，不按显示序号）：
 * - expectedRev 是页面渲染这一行时读到的 rev；撤回/恢复过的一把版本已前进时拒绝；
 * - expectedNote / expectedResult 是打开删除确认时的原文；期间别人改了备注或结果时
 *   拒绝，避免把一次基于旧画面的确认落到已经变化的记录上；
 * - 同一场同一线还有「进行中」保存、或这一把挂着撤回/恢复/更正标记时拒绝（pending）：
 *   先让在途操作落盘，避免一次删除与另一段两段写互相覆盖。
 *
 * 写失败分两种：写前失败（盘上仍有这一把）返回 write-failed，调用方回滚删除凭据；
 * 写成功但回执丢失或首次读回失败时再读一次档案，能确认已移出就按 deleted-receipt-lost
 * 成功返回（调用方继续清理视频副本），读回也失败则返回 write-failed-unverified，让
 * 持久删除凭据在重开后重新核对，而不是报「没删」或「删了别的」。
 */
function deleteAttempt(attemptId, input) {
  const data = input || {};
  if (!hasText(attemptId)) {
    return { ok: false, code: 'missing', error: '缺少要删除的把次 ID', archive: null, attempt: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, archive: loaded.archive, attempt: null };
  }
  const current = loaded.archive;

  if (hasText(data.archiveId) && data.archiveId !== current.archiveId) {
    return {
      ok: false,
      code: 'archive-mismatch',
      error: ATTEMPT_ARCHIVE_MISMATCH,
      archive: current,
      attempt: null
    };
  }

  const attempt = current.attempts.find(item => item.id === attemptId) || null;
  if (!attempt) {
    return {
      ok: false,
      code: 'missing',
      error: '找不到这一把，可能已经被删除或重置',
      archive: current,
      attempt: null
    };
  }
  if (hasText(data.sessionId) && data.sessionId !== attempt.sessionId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前场次，未做删除', archive: current, attempt: clone(attempt) };
  }
  if (hasText(data.routeId) && data.routeId !== attempt.routeId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前线路，未做删除', archive: current, attempt: clone(attempt) };
  }
  if (!isEffectiveAttempt(attempt)) {
    return {
      ok: false,
      code: 'undone',
      error: '这一把已撤回，不在有效记录里，未做删除；如需移除请先恢复再操作',
      archive: current,
      attempt: clone(attempt)
    };
  }
  if (!findById(current.sessions, attempt.sessionId)) {
    return { ok: false, code: 'missing', error: '原场次已不存在，未做删除', archive: current, attempt: clone(attempt) };
  }
  if (!findById(current.routes, attempt.routeId)) {
    return { ok: false, code: 'missing', error: '原线路已不存在，未做删除', archive: current, attempt: clone(attempt) };
  }

  // 过期画面：版本、备注或结果任意一项与打开确认时不同，都不按旧确认删除。
  if (
    Number.isInteger(data.expectedRev) &&
    data.expectedRev >= 0 &&
    data.expectedRev !== attemptRev(attempt)
  ) {
    return { ok: false, code: 'stale', error: ATTEMPT_STALE, archive: current, attempt: clone(attempt) };
  }
  if (
    typeof data.expectedNote === 'string' &&
    data.expectedNote !== (attempt.note || '')
  ) {
    return {
      ok: false,
      code: 'stale',
      error: '这一把的备注已经变化，这次删除没有生效；请按最新内容重新确认',
      archive: current,
      attempt: clone(attempt)
    };
  }
  if (hasText(data.expectedResult) && data.expectedResult !== attempt.result) {
    return {
      ok: false,
      code: 'stale',
      error: '这一把的结果已经变化，这次删除没有生效；请按最新内容重新确认',
      archive: current,
      attempt: clone(attempt)
    };
  }

  // 在途操作：同一场同一线还有待保存的一把，或这一把本身挂着撤回/恢复/更正标记。
  const pendingOnRoute = (current.pendingSaves || []).some(
    item => item.sessionId === attempt.sessionId && item.routeId === attempt.routeId
  );
  const pendingOnAttempt = [
    ...(current.pendingUndos || []),
    ...(current.pendingRestores || []),
    ...(current.pendingCorrections || [])
  ].some(item => item.attemptId === attemptId);
  if (pendingOnRoute || pendingOnAttempt) {
    return {
      ok: false,
      code: 'pending',
      error: pendingOnAttempt
        ? '这一把还有未完成的操作，先重试或完成它，再删除这把'
        : '这条线还有一把没保存：先在「待保存」行重试保存，再删除',
      archive: current,
      attempt: clone(attempt)
    };
  }

  // 只移出这一个 ID；其余把次（含他们的 seq、备注与结果）一个字段都不动。
  const next = clone(current);
  next.attempts = next.attempts.filter(item => item.id !== attemptId);
  // 进行中标记若残留也不再指向不存在的把次；正常路径上面的 pending 守卫已经拒绝。
  next.pendingCorrections = (next.pendingCorrections || []).filter(item => item.attemptId !== attemptId);
  next.pendingUndos = (next.pendingUndos || []).filter(item => item.attemptId !== attemptId);
  next.pendingRestores = (next.pendingRestores || []).filter(item => item.attemptId !== attemptId);
  // nextAttemptSeq 保持原值：内部序号单调，被删把次不会被新记一把复用。

  const saved = saveArchive(next);
  if (saved.ok) {
    return {
      ok: true,
      code: 'deleted',
      receiptLost: false,
      error: '',
      archive: next,
      attempt: clone(attempt)
    };
  }

  // 写抛错：回执不明确。读回最新档案判断这一把是否已经移出。
  const reread = loadState();
  if (!reread.ok) {
    return {
      ok: false,
      code: 'write-failed-unverified',
      // 不报「已删除」也不报「没删除」：持久删除凭据会在重开后按档案核对。
      error: saved.error + '；记录是否已删除暂未确认，重开或重试时会重新核对',
      archive: current,
      attempt: clone(attempt)
    };
  }
  if (reread.archive.archiveId === current.archiveId) {
    const stillThere = reread.archive.attempts.some(item => item.id === attemptId);
    if (!stillThere) {
      return {
        ok: true,
        code: 'deleted-receipt-lost',
        receiptLost: true,
        error: '',
        archive: reread.archive,
        attempt: clone(attempt)
      };
    }
    return {
      ok: false,
      code: 'write-failed',
      error: saved.error,
      archive: reread.archive,
      attempt: clone(attempt)
    };
  }
  return {
    ok: false,
    code: 'write-failed-unverified',
    error: saved.error + '；读取到另一份本机档案，记录是否已删除暂未确认',
    archive: reread.archive,
    attempt: clone(attempt)
  };
}

// ------------------------------------------------------------------ *
// 整场删除（T051）
// ------------------------------------------------------------------ *

/**
 * 快照用的稳定序列化：对象键排序、数组保持原序。同一份档案在 Node 与小程序运行时
 * 得到同一段文本，快照令牌才能同步比对。
 */
function stableSnapshotValue(value) {
  if (Array.isArray(value)) return value.map(stableSnapshotValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    Object.keys(value)
      .sort()
      .forEach(key => {
        sorted[key] = stableSnapshotValue(value[key]);
      });
    return sorted;
  }
  return value;
}

/**
 * 快照令牌：不是密码学摘要，只用来同步回答「确认框打开时的本场范围是否仍一字不差」。
 * 两路 32 位混合后拼成 16 位十六进制，足以区分同数量但结果、备注或原把被替换的情况。
 */
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 本场持久待办（只读）：待保存、更正、撤回、恢复各自按原场次 ID 命中。
 * 整场删除会连同这些记录的目标场次一起移出，所以在途操作必须先落盘或先完成，
 * 否则一次删除会和另一段两段写互相覆盖。
 */
function sessionPendingSummary(archive, sessionId) {
  const count = list => (list || []).filter(item => item && item.sessionId === sessionId).length;
  const pending = {
    saves: count(archive.pendingSaves),
    corrections: count(archive.pendingCorrections),
    undos: count(archive.pendingUndos),
    restores: count(archive.pendingRestores)
  };
  pending.total = pending.saves + pending.corrections + pending.undos + pending.restores;
  pending.text = pending.saves
    ? '本场还有 ' + pending.saves + ' 把没保存：先在「待保存」行重试保存，再删除场次'
    : pending.total
      ? '本场还有 ' + pending.total + ' 项撤回、恢复或更正没有完成，请先处理再删除场次'
      : '';
  return pending;
}

/**
 * 本场确认快照：原日期、岩馆、场次、场内线路关联和全部把次（含已撤回）的实际内容。
 *
 * 令牌覆盖每个把次的 ID、内部 seq、线路、结果、备注、撤回标记、rev 与创建时间，
 * 以及每条场内关联的线路 ID 与加入时间。因此「把数不变，但结果/备注/原把被替换」
 * 或同数量换线都会让令牌变化，旧确认只能重新读取后再确认。把次的显示编号不在这里：
 * 它只按同日顺序推导，删除同一天其他场次后由页面按最新档案重算。
 */
function sessionScopeSnapshot(archive, session) {
  const routeLinks = (archive.sessionRoutes || [])
    .filter(link => link.sessionId === session.id)
    .map(link => ({
      routeId: link.routeId,
      addedAt: hasText(link.addedAt) ? link.addedAt : ''
    }))
    .sort(
      (left, right) =>
        compareText(left.routeId, right.routeId) || compareText(left.addedAt, right.addedAt)
    );
  const scopedAttempts = (archive.attempts || []).filter(
    item => item.sessionId === session.id
  );
  const attemptRows = scopedAttempts
    .map(item => ({
      id: item.id,
      seq: item.seq || 0,
      routeId: item.routeId,
      result: item.result,
      note: item.note || '',
      undoneAt: hasText(item.undoneAt) ? item.undoneAt : '',
      rev: attemptRev(item),
      createdAt: item.createdAt || ''
    }))
    .sort(
      (left, right) => left.seq - right.seq || compareText(left.id, right.id)
    );
  const gym = findById(archive.gyms, session.gymId);
  const label = sessionLabel(archive, session);
  const core = {
    archiveId: archive.archiveId,
    sessionId: session.id,
    date: session.date,
    gymId: session.gymId,
    gymName: gym ? gym.name : '',
    seq: session.seq,
    label,
    routeLinks,
    attempts: attemptRows
  };
  return {
    token: snapshotHash(JSON.stringify(stableSnapshotValue(core))),
    archiveId: archive.archiveId,
    sessionId: session.id,
    date: session.date,
    gymId: session.gymId,
    gymName: gym ? gym.name : '',
    seq: session.seq,
    label,
    routeIds: routeLinks.map(link => link.routeId),
    attemptIds: attemptRows.map(item => item.id),
    routeCount: routeLinks.length,
    attemptCount: attemptRows.length,
    effectiveAttemptCount: scopedAttempts.filter(isEffectiveAttempt).length,
    undoneAttemptCount: scopedAttempts.filter(item => !isEffectiveAttempt(item)).length,
    sendCount: scopedAttempts.filter(
      item => isEffectiveAttempt(item) && item.result === 'send'
    ).length
  };
}

/**
 * 本场是否已经完整、干净地不在档案里：场次本身、场内关联、全部把次和四类持久待办
 * 都不再按这个原场次 ID 命中。只缺场次但还留着归属记录时不算「已删除」，不报成功。
 */
function sessionFullyAbsent(archive, sessionId) {
  return Boolean(
    archive &&
      !findById(archive.sessions, sessionId) &&
      !(archive.sessionRoutes || []).some(link => link.sessionId === sessionId) &&
      !(archive.attempts || []).some(item => item.sessionId === sessionId) &&
      !(archive.pendingSaves || []).some(item => item.sessionId === sessionId) &&
      !(archive.pendingCorrections || []).some(item => item.sessionId === sessionId) &&
      !(archive.pendingUndos || []).some(item => item.sessionId === sessionId) &&
      !(archive.pendingRestores || []).some(item => item.sessionId === sessionId)
  );
}

function sessionDeleteResult(fields) {
  return Object.assign(
    {
      ok: false,
      code: '',
      error: '',
      archive: null,
      archiveId: '',
      sessionId: '',
      writeAttempted: false,
      written: false,
      removed: null,
      receiptLost: false,
      unknown: false,
      removedAttemptIds: [],
      removedRouteIds: [],
      activeSessionId: '',
      activeRouteId: '',
      successor: null,
      target: null,
      snapshot: null,
      pending: null
    },
    fields || {}
  );
}

function requestedSessionSnapshot(data) {
  const source = data.snapshot;
  if (hasText(source)) return { token: source, archiveId: '', sessionId: '' };
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return {
      token: hasText(source.token) ? source.token : '',
      archiveId: hasText(source.archiveId) ? source.archiveId : '',
      sessionId: hasText(source.sessionId) ? source.sessionId : ''
    };
  }
  return {
    token: hasText(data.snapshotToken) ? data.snapshotToken : '',
    archiveId: '',
    sessionId: ''
  };
}

function sessionTargetView(archive, session, snapshot) {
  return {
    sessionId: snapshot.sessionId,
    date: snapshot.date,
    gymId: snapshot.gymId,
    gymName: snapshot.gymName,
    seq: snapshot.seq,
    label: snapshot.label,
    routeCount: snapshot.routeCount,
    attemptCount: snapshot.attemptCount,
    effectiveAttemptCount: snapshot.effectiveAttemptCount,
    undoneAttemptCount: snapshot.undoneAttemptCount,
    sendCount: snapshot.sendCount,
    isActive: archive.activeSessionId === session.id
  };
}

function latestSameGymSessionOnDate(archive, date, gymId) {
  return (
    (archive.sessions || [])
      .filter(item => item.date === date && item.gymId === gymId)
      .sort((left, right) => (left.seq || 0) - (right.seq || 0))
      .pop() || null
  );
}

function sessionHasRoute(archive, sessionId, routeId) {
  if (!hasText(sessionId) || !hasText(routeId)) return false;
  return (archive.sessionRoutes || []).some(
    link => link.sessionId === sessionId && link.routeId === routeId
  );
}

/**
 * 读取整场删除的当前目标与确认快照（只读，不写盘）。
 *
 * 输入：{ archiveId, sessionId }。两者都必需：调用方渲染确认框时拿到的原档案与原场次
 * 一起决定这次删除的对象，缺一个都不猜。
 *
 * 返回 { ok, code, error, archive, archiveId, sessionId, present, canDelete,
 *        target, snapshot, pending, cleanlyAbsent }。code：
 * - ready：目标仍在、没有命中本场的持久待办，可用 snapshot 打开二次确认；
 * - pending：目标仍在，但有本场待保存/更正/撤回/恢复；canDelete:false，先处理；
 * - missing：目标已经不在当前档案（present:false）；cleanlyAbsent 表示本场关联、
 *   把次与待办也已全部清空，可把重复确认按「已删除」收尾；
 * - 请求不完整、archive-mismatch 或 unreadable：不写盘，页面按可见错误处理。
 */
function inspectSessionDeletion(input) {
  const data = input || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  const base = {
    ok: false,
    code: '',
    error: '',
    archive: null,
    archiveId,
    sessionId,
    present: false,
    canDelete: false,
    cleanlyAbsent: false,
    target: null,
    snapshot: null,
    pending: null
  };
  if (!archiveId || !sessionId) {
    return Object.assign(base, { code: 'incomplete-request', error: SESSION_DELETE_INCOMPLETE });
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return Object.assign(base, {
      code: 'unreadable',
      error: loaded.error,
      archive: loaded.archive
    });
  }
  const current = loaded.archive;
  if (current.archiveId !== archiveId) {
    return Object.assign(base, {
      code: 'archive-mismatch',
      error: SESSION_DELETE_ARCHIVE_MISMATCH,
      archive: current
    });
  }

  const session = findById(current.sessions, sessionId);
  if (!session) {
    return Object.assign(base, {
      ok: true,
      code: 'missing',
      archive: current,
      present: false,
      canDelete: false,
      cleanlyAbsent: sessionFullyAbsent(current, sessionId)
    });
  }

  const snapshot = sessionScopeSnapshot(current, session);
  const pending = sessionPendingSummary(current, sessionId);
  return {
    ok: true,
    code: pending.total > 0 ? 'pending' : 'ready',
    error: pending.text,
    archive: current,
    archiveId,
    sessionId,
    present: true,
    canDelete: pending.total === 0,
    cleanlyAbsent: false,
    target: sessionTargetView(current, session, snapshot),
    snapshot,
    pending
  };
}

/**
 * 按原档案 + 原场次 + 确认快照一次提交整场删除（T051）。
 *
 * 输入：{ archiveId, sessionId, snapshot }。snapshot 是 inspectSessionDeletion 返回的
 * 快照对象，或它里面的 token 字符串；两者都必须来自同一份原档案原场次。
 *
 * 一次档案写入只做这几件事：
 * - 原场次本身、它自己的全部场内线路关联、全部把次（含已撤回）原样移出；
 * - 当前场正是目标时，同日同馆剩余场次里选内部 seq 最大的一场接续；没有就把当前
 *   场次与线路清空。接续场不包含原当前线路时清掉线路指针，仍包含则保留；
 * - 其他场次、原 ID、内部 seq、next* 单调计数器、长期线路与场外照片一概不动。
 * 本场有持久待办（待保存/更正/撤回/恢复）时整条拒绝，不写一个字节。
 *
 * 失败与回执语义复用现有档案层口径：
 * - 写前失败、重读仍能看到原场次：code write-failed，written:false、removed:false；
 * - 写抛错但重读同一份档案已完整移出：code removed-receipt-lost，removed:true；
 * - 重读失败、换档或只移出了一半：code write-failed-unverified，removed:null、
 *   unknown:true，绝不报已删除；
 * - 目标在读取时就已经干净地不在：code already-removed，不写盘，removed:true。
 *
 * 返回 { ok, code, error, archive, writeAttempted, written, removed, receiptLost,
 *        unknown, removedAttemptIds, removedRouteIds, activeSessionId, activeRouteId,
 *        successor, target, snapshot, pending }。ok:true 只表示删除已确认（本次写入或
 *        读取确认早已移出），不代表任何媒体被清理——媒体由 T052 协调器另做。
 */
function commitSessionDeletion(input) {
  const data = input || {};
  const archiveId = hasText(data.archiveId) ? data.archiveId : '';
  const sessionId = hasText(data.sessionId) ? data.sessionId : '';
  const requested = requestedSessionSnapshot(data);
  const base = sessionDeleteResult({ archiveId, sessionId });
  if (!archiveId || !sessionId || !requested.token) {
    return Object.assign(base, { code: 'incomplete-request', error: SESSION_DELETE_INCOMPLETE });
  }
  if (requested.archiveId && requested.archiveId !== archiveId) {
    return Object.assign(base, {
      code: 'archive-mismatch',
      error: SESSION_DELETE_ARCHIVE_MISMATCH,
      unknown: true
    });
  }
  if (requested.sessionId && requested.sessionId !== sessionId) {
    return Object.assign(base, { code: 'stale', error: SESSION_DELETE_STALE });
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return Object.assign(base, {
      code: 'unreadable',
      error: loaded.error,
      archive: loaded.archive,
      unknown: true
    });
  }
  const current = loaded.archive;
  if (current.archiveId !== archiveId) {
    return Object.assign(base, {
      code: 'archive-mismatch',
      error: SESSION_DELETE_ARCHIVE_MISMATCH,
      archive: current,
      unknown: true
    });
  }

  const session = findById(current.sessions, sessionId);
  if (!session) {
    if (sessionFullyAbsent(current, sessionId)) {
      return Object.assign(base, {
        ok: true,
        code: 'already-removed',
        archive: current,
        removed: true,
        activeSessionId: current.activeSessionId,
        activeRouteId: current.activeRouteId
      });
    }
    return Object.assign(base, {
      code: 'missing',
      error: '原场次已不在档案里，但还有本场归属记录残留；未做改动',
      archive: current,
      removed: false,
      unknown: true
    });
  }

  const snapshot = sessionScopeSnapshot(current, session);
  const pending = sessionPendingSummary(current, sessionId);
  const target = sessionTargetView(current, session, snapshot);
  if (snapshot.token !== requested.token) {
    return Object.assign(base, {
      code: 'stale',
      error: SESSION_DELETE_STALE,
      archive: current,
      removed: false,
      target,
      snapshot,
      pending
    });
  }
  if (pending.total > 0) {
    return Object.assign(base, {
      code: 'pending',
      error: pending.text,
      archive: current,
      removed: false,
      target,
      snapshot,
      pending
    });
  }

  const removedAttemptIds = (current.attempts || [])
    .filter(item => item.sessionId === sessionId)
    .map(item => item.id);
  const removedRouteIds = [];
  (current.sessionRoutes || []).forEach(link => {
    if (link.sessionId === sessionId && removedRouteIds.indexOf(link.routeId) === -1) {
      removedRouteIds.push(link.routeId);
    }
  });

  const next = clone(current);
  next.sessions = next.sessions.filter(item => item.id !== sessionId);
  next.sessionRoutes = next.sessionRoutes.filter(link => link.sessionId !== sessionId);
  next.attempts = next.attempts.filter(item => item.sessionId !== sessionId);
  // 待办已经在上面整条拒绝；这里只做防御性清理，正常路径不会命中。
  next.pendingSaves = (next.pendingSaves || []).filter(item => item.sessionId !== sessionId);
  next.pendingCorrections = (next.pendingCorrections || []).filter(
    item => item.sessionId !== sessionId
  );
  next.pendingUndos = (next.pendingUndos || []).filter(item => item.sessionId !== sessionId);
  next.pendingRestores = (next.pendingRestores || []).filter(
    item => item.sessionId !== sessionId
  );

  let successor = null;
  if (current.activeSessionId === sessionId) {
    successor = latestSameGymSessionOnDate(next, session.date, session.gymId);
    next.activeSessionId = successor ? successor.id : '';
    if (!successor) {
      next.activeRouteId = '';
    } else if (
      !sessionHasRoute(next, successor.id, next.activeRouteId) ||
      !findById(next.routes, next.activeRouteId)
    ) {
      next.activeRouteId = '';
    }
  }

  const saved = saveArchive(next);
  if (saved.ok) {
    return Object.assign(base, {
      ok: true,
      code: 'removed',
      archive: next,
      writeAttempted: true,
      written: true,
      removed: true,
      removedAttemptIds,
      removedRouteIds,
      activeSessionId: next.activeSessionId,
      activeRouteId: next.activeRouteId,
      successor: successor ? clone(successor) : null,
      target,
      snapshot,
      pending
    });
  }

  // 回执不明确：重读当前档案后才允许报成功。
  const reread = loadState();
  if (!reread.ok || reread.archive.archiveId !== archiveId) {
    return Object.assign(base, {
      code: 'write-failed-unverified',
      error: saved.error + '；记录是否已删除暂未确认，重开或重试时会重新核对',
      archive: reread.ok ? reread.archive : current,
      writeAttempted: true,
      removed: null,
      unknown: true,
      target,
      snapshot,
      pending
    });
  }
  if (sessionFullyAbsent(reread.archive, sessionId)) {
    return Object.assign(base, {
      ok: true,
      code: 'removed-receipt-lost',
      archive: reread.archive,
      writeAttempted: true,
      written: true,
      removed: true,
      receiptLost: true,
      removedAttemptIds,
      removedRouteIds,
      activeSessionId: reread.archive.activeSessionId,
      activeRouteId: reread.archive.activeRouteId,
      successor: successor ? clone(successor) : null,
      target,
      snapshot,
      pending
    });
  }
  if (findById(reread.archive.sessions, sessionId)) {
    return Object.assign(base, {
      code: 'write-failed',
      error: saved.error,
      archive: reread.archive,
      writeAttempted: true,
      removed: false,
      target,
      snapshot,
      pending
    });
  }
  return Object.assign(base, {
    code: 'write-failed-unverified',
    error: saved.error + '；重读到不完整的本场数据，是否已删除暂未确认',
    archive: reread.archive,
    writeAttempted: true,
    removed: null,
    unknown: true,
    target,
    snapshot,
    pending
  });
}

// ------------------------------------------------------------------ *
// 撤回 / 恢复同一把次（T032）
// ------------------------------------------------------------------ *

/**
 * 撤回/恢复共用的写前校验：每次都先读**最新**持久状态，再逐项核对这次操作的对象。
 *
 * 输入：{ archiveId?, routeId?, sessionId? }。
 * - archiveId：调用方渲染时用的档案 ID，与当前档案不一致时按迟到操作拒绝（不落盘）；
 * - routeId / sessionId：原归属，与本把次不一致时拒绝。
 *
 * 返回 { ok, code, error, archive, attempt }；ok:false 时 attempt 为 null。
 * code：'' / missing / unreadable / archive-mismatch / conflict。
 */
function loadAttemptForChange(attemptId, input) {
  const data = input || {};
  if (!hasText(attemptId)) {
    return { ok: false, code: 'missing', error: '缺少要操作的把次 ID', archive: null, attempt: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, archive: loaded.archive, attempt: null };
  }
  const current = loaded.archive;

  if (hasText(data.archiveId) && data.archiveId !== current.archiveId) {
    return { ok: false, code: 'archive-mismatch', error: ATTEMPT_ARCHIVE_MISMATCH, archive: current, attempt: null };
  }

  const attempt = current.attempts.find(item => item.id === attemptId) || null;
  if (!attempt) {
    return { ok: false, code: 'missing', error: '找不到这一把，可能已被重置', archive: current, attempt: null };
  }
  if (hasText(data.routeId) && data.routeId !== attempt.routeId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前线路，未做改动', archive: current, attempt: null };
  }
  if (hasText(data.sessionId) && data.sessionId !== attempt.sessionId) {
    return { ok: false, code: 'conflict', error: '这一把不属于当前场次，未做改动', archive: current, attempt: null };
  }
  // 原场次与原线路都必须还在：归属不清时不动任何记录，也不猜一个新归属。
  if (!findById(current.sessions, attempt.sessionId)) {
    return { ok: false, code: 'missing', error: '原场次已不存在，未做改动', archive: current, attempt: null };
  }
  if (!findById(current.routes, attempt.routeId)) {
    return { ok: false, code: 'missing', error: '原线路已不存在，未做改动', archive: current, attempt: null };
  }

  return { ok: true, code: '', error: '', archive: current, attempt };
}

/**
 * 「预期状态」核对（T032）：调用方可以带上它渲染时看到的状态——撤回传 'effective'
 * （这一把当时是有效的），恢复传 'undone'（当时是已撤回的）。
 * 与当前持久状态不符时返回 true，调用方按 stale 拒绝，让基于过时画面的操作不落盘；
 * 不传时不校验这一项；取值不认识时一律拒绝，不猜用户意图。
 */
function expectedStateMismatch(data, attempt) {
  if (!hasText(data.expected)) return false;
  const undone = isUndoneAttempt(attempt);
  if (data.expected === 'effective') return undone;
  if (data.expected === 'undone') return !undone;
  return true;
}

/**
 * 「预期版本」核对（T030–T033 返工）：调用方把渲染控件时读到的 rev 随点击带回来，
 * 与最新持久状态里的 rev 不等时返回 true，调用方按 stale 拒绝、一个字都不写。
 *
 * 这一项才是防 ABA 的那一项：只比「当前状态」挡不住 3→2→3 之后重放的旧撤回
 * （它看到的状态又变回有效了，看起来完全合法），只有「这一把变过几次」能把旧事件
 * 认出来。请求里没有可比较的版本时不校验（保持旧调用兼容）。
 */
function expectedRevMismatch(data, attempt) {
  const wanted = requestedAttemptRev(data);
  return wanted !== null && wanted !== attemptRev(attempt);
}

/**
 * 这一把上已经结清的撤回/恢复操作凭据（T032）。
 *
 * 每次撤回或恢复落盘成功后，都把这次操作的 opId 连同意图记在原把次上。于是同一操作的
 * 迟到回调、回执丢失后的重试都能被认出来「早已结清」，只回读当前状态、不再写盘——
 * 因此延迟到达的撤回不会撤销后来成功的恢复，延迟到达的恢复也不会撤销后来成功的撤回，
 * 并且重开之后依然成立（凭据在档案里，不靠内存）。旧档案没有这个字段时按空列表读取。
 */
function findSettledOp(attempt, opId) {
  const ops = Array.isArray(attempt.settledOps) ? attempt.settledOps : [];
  return ops.find(op => op && op.opId === opId) || null;
}

/**
 * 只读：这一把上是否有**某个指定操作**（撤回或恢复自己的 opId）的落盘凭据。
 *
 * 调用方拿它回答一个很窄的问题：「盘上现在的状态，是不是我刚才那一次操作写出来的？」
 * 只按状态判断是不够的——另一个写者、另一份档案或另一个 opId 也可能把这一把带到同样的
 * 状态；那种情况下不能告诉人「此前那次已确认成功」。返回 { opId, undone, at } 或 null。
 */
function attemptSettledOp(attempt, opId) {
  if (!attempt || !hasText(opId)) return null;
  const found = findSettledOp(attempt, opId);
  return found ? clone(found) : null;
}

function recordSettledOp(attempt, opId, undone, at) {
  const ops = Array.isArray(attempt.settledOps) ? attempt.settledOps : [];
  attempt.settledOps = ops
    .filter(op => op && op.opId !== opId)
    .concat([{ opId, undone, at }]);
}

/**
 * 这条线上除 excludeAttemptId 以外，是否还有「在途的抱石完攀」：别的待保存完攀，
 * 或别的已经撤回、正等着恢复的完攀。恢复守卫据此判断会不会凑出第二次有效完攀。
 */
function hasOtherPendingSend(archive, routeId, excludeAttemptId) {
  const pendingSave = (archive.pendingSaves || []).some(
    item => item.routeId === routeId && item.result === 'send'
  );
  if (pendingSave) return true;
  const attemptById = new Map((archive.attempts || []).map(item => [item.id, item]));
  return (archive.pendingRestores || []).some(marker => {
    if (marker.routeId !== routeId || marker.attemptId === excludeAttemptId) return false;
    const attempt = attemptById.get(marker.attemptId);
    return Boolean(attempt && attempt.result === 'send' && !isEffectiveAttempt(attempt));
  });
}

/**
 * 撤回同一把次（T032）。把指定原把次标成「已撤回」——不物理删除、不改结果、不动其他把次。
 *
 * 输入：{ routeId?, sessionId?, archiveId?, expected?, expectedRev?, opId?, now? }，把次由第一个
 * 参数的稳定 ID 指定（这个 ID 就是原保存请求的 opId，撤回后仍然认得它）。opId 是**这次撤回
 * 操作**自己的去重凭据：缺省时由本层生成并随返回值给出，页面重试时带上同一个 opId。
 * expectedRev 是渲染这个控件时读到的这一把的 rev（见 attemptRev）：与最新持久状态不等时
 * 按过期事件拒绝，不落盘——这是防「旧的撤回在 3→2→3 之后又被重放」的那一项。
 * 返回 { ok, code, error, archive, attempt, opId }。code：
 *   undone（本次已撤回）/ settled（这个 opId 早就结清过，只回读当前状态）/
 *   missing / conflict / archive-mismatch / stale / unreadable / write-failed。
 *
 * 保留原把次的一切：ID、序号、场次、线路、结果、备注与创建时间逐项不变，只多一个
 * undoneAt 时间戳、把 rev 加一（以及这次操作的结清凭据 settledOps）。因此恢复能拿回
 * 同一次操作；同 opId 的迟到 saveAttempt 仍会被去重（对比原 ID，不新建第二把），也不会
 * 清掉撤回标记把它复活。
 *
 * 两段写：先落盘「撤回进行中」标记（pendingUndos），再提交标记本身并清掉进行中记录。
 * 第一段失败不落任何数据；第二段失败时进行中标记已落盘，重开后可重试同一意图；
 * 第二段其实已经写成而只是回执丢失时，重试按结清凭据认出这次操作已结清——不再写一次。
 */
function undoAttempt(attemptId, input) {
  const data = input || {};
  const pre = loadAttemptForChange(attemptId, data);
  if (!pre.ok) return pre;

  const current = pre.archive;
  const attempt = pre.attempt;
  const opId = hasText(data.opId) ? data.opId : newOperationId();

  // 这次操作已经结清过（回执丢失后的同一意图重试、迟到的旧撤回回调）：只回读当前状态，
  // 不写盘。因此它既不会复活已撤回的那一把，也不会撤销后来成功的恢复。
  if (findSettledOp(attempt, opId)) {
    return {
      ok: true,
      code: 'settled',
      settled: true,
      duplicate: true,
      error: '',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }
  if (expectedRevMismatch(data, attempt)) {
    return { ok: false, code: 'stale', error: ATTEMPT_STALE, archive: current, attempt: null, opId };
  }
  if (expectedStateMismatch(data, attempt)) {
    return { ok: false, code: 'stale', error: ATTEMPT_STALE, archive: current, attempt: null, opId };
  }
  // 已经是撤回状态：重复点击、重开的迟到回调都只复用结果，不改任何记录。
  if (!isEffectiveAttempt(attempt)) {
    return {
      ok: true,
      code: 'undone',
      duplicate: true,
      error: '',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }

  const at = timestamp(data.now);

  // 第一段：落盘「撤回进行中」标记（按把次 ID 去重，重试不产生第二条）。
  const staging = clone(current);
  staging.pendingUndos = staging.pendingUndos
    .filter(item => item.attemptId !== attempt.id)
    .concat([
      {
        opId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        routeId: attempt.routeId,
        createdAt: at
      }
    ]);
  // 同一把次不能同时挂着撤回与恢复两种意图：本次撤回优先，清掉可能残留的恢复标记。
  staging.pendingRestores = staging.pendingRestores.filter(item => item.attemptId !== attempt.id);
  const staged = saveArchive(staging);
  if (!staged.ok) {
    return { ok: false, code: 'write-failed', error: staged.error, archive: current, attempt: null, opId };
  }

  // 第二段：只标这一把的撤回时间、把 rev 加一与这次操作的结清凭据，并清掉进行中标记。
  const committed = clone(staging);
  const target = committed.attempts.find(item => item.id === attempt.id);
  target.undoneAt = at;
  bumpAttemptRev(target);
  recordSettledOp(target, opId, true, at);
  committed.pendingUndos = committed.pendingUndos.filter(item => item.attemptId !== attempt.id);
  const saved = saveArchive(committed);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, archive: staging, attempt: null, opId };
  }
  return {
    ok: true,
    code: 'undone',
    duplicate: false,
    error: '',
    archive: committed,
    attempt: clone(target),
    opId
  };
}

/**
 * 恢复同一把次（T032）：清掉撤回标记，把原来那一把放回有效集合。
 *
 * 输入与返回形状同 undoAttempt（opId 是这次**恢复操作**自己的去重凭据；expectedRev 是
 * 渲染这次恢复入口时读到的 rev）。code：
 *   restored（本次恢复成功）/ settled（这个 opId 早就结清过，只回读当前状态）/
 *   active（本来就已经有效，幂等）/ conflict（抱石会变成第二次有效完攀）/
 *   missing / archive-mismatch / stale / unreadable / write-failed。
 *
 * 恢复拿回的就是原把次：同 ID、同序号、同场次、同线路、同结果与同备注，时间不变，
 * 撤回标记被清掉、rev 再加一；这次恢复的结清凭据与撤回那次一样记在这一把上
 * （见 settledOps），供迟到回调识别。
 * 绳攀（顶绳/先锋）沿原规则可重复完攀，恢复只影响把数与完攀把数。
 *
 * 抱石守卫：恢复一把已撤回的完攀前先**重新计算**这条线当前的有效完攀与在途完攀；
 * 只要已经有别的有效完攀或待确认完攀，就返回 conflict 且不落盘——恢复不可制造第二次
 * 有效抱石完攀。判定与 routeCompletion 同源，因此在途的恢复也会先封锁新增。
 */
function restoreAttempt(attemptId, input) {
  const data = input || {};
  const pre = loadAttemptForChange(attemptId, data);
  if (!pre.ok) return pre;

  const current = pre.archive;
  const attempt = pre.attempt;
  const opId = hasText(data.opId) ? data.opId : newOperationId();

  // 这次恢复已经结清过：只回读当前状态，不写盘（也不会把后来又被撤回的那一把再次恢复）。
  if (findSettledOp(attempt, opId)) {
    return {
      ok: true,
      code: 'settled',
      settled: true,
      duplicate: true,
      error: '',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }
  if (expectedRevMismatch(data, attempt)) {
    return { ok: false, code: 'stale', error: ATTEMPT_STALE, archive: current, attempt: null, opId };
  }
  if (expectedStateMismatch(data, attempt)) {
    return { ok: false, code: 'stale', error: ATTEMPT_STALE, archive: current, attempt: null, opId };
  }
  // 已经是有效状态：重复点击、迟到的旧恢复回调都只复用结果，不改任何记录。
  if (isEffectiveAttempt(attempt)) {
    return {
      ok: true,
      code: 'active',
      duplicate: true,
      error: '',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }

  const route = findById(current.routes, attempt.routeId);
  const completion = routeCompletion(current, route.id);
  const isBoulderSend = attempt.result === 'send' && rules.isBoulderRoute(route);
  if (isBoulderSend && completion.hasSend) {
    return {
      ok: false,
      code: 'conflict',
      blocked: true,
      conflict: 'second-send',
      error: '这条抱石线已经有有效完攀，恢复会造成第二次完攀；请先处理现有完攀',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }
  if (isBoulderSend && hasOtherPendingSend(current, route.id, attempt.id)) {
    return {
      ok: false,
      code: 'conflict',
      blocked: true,
      conflict: 'pending-send',
      error: '这条抱石线还有完攀在提交中，请稍候再恢复',
      archive: current,
      attempt: clone(attempt),
      opId
    };
  }

  // 第一段：落盘「恢复进行中」标记。
  const at = timestamp(data.now);
  const staging = clone(current);
  staging.pendingRestores = staging.pendingRestores
    .filter(item => item.attemptId !== attempt.id)
    .concat([
      {
        opId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        routeId: attempt.routeId,
        createdAt: at
      }
    ]);
  staging.pendingUndos = staging.pendingUndos.filter(item => item.attemptId !== attempt.id);
  const staged = saveArchive(staging);
  if (!staged.ok) {
    return { ok: false, code: 'write-failed', error: staged.error, archive: current, attempt: null, opId };
  }

  // 第二段：清掉这一把的撤回标记、把 rev 加一、记下这次恢复的结清凭据；其他字段一律不动。
  const committed = clone(staging);
  const target = committed.attempts.find(item => item.id === attempt.id);
  delete target.undoneAt;
  bumpAttemptRev(target);
  recordSettledOp(target, opId, false, at);
  committed.pendingRestores = committed.pendingRestores.filter(item => item.attemptId !== attempt.id);
  const saved = saveArchive(committed);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, archive: staging, attempt: null, opId };
  }
  return {
    ok: true,
    code: 'restored',
    duplicate: false,
    error: '',
    archive: committed,
    attempt: clone(target),
    opId
  };
}


module.exports = {
  NAMESPACE,
  ARCHIVE_KEY,
  WISHLIST_KEY,
  PHOTO_INDEX_KEY,
  REBUILDABLE_PREFIXES,
  STATE_VERSION,
  ARCHIVE_BROKEN,
  ARCHIVE_UNSUPPORTED,
  // T067：文本恢复的代际布局。commit/pending/stage 键都在正式命名空间内，按受保护键处理。
  BACKUP_COMMIT_KEY,
  BACKUP_PENDING_KEY,
  BACKUP_STAGE_PREFIX,
  LAYOUT_VERSION,
  LAYOUT_READ_FAILED,
  LAYOUT_BROKEN,
  stageKeysFor,
  parseCommitRecord,
  resolveLayout,
  resetLayoutCache,
  activateLayout,
  readStorageText,
  readActiveArchiveRaw,
  readActiveWishlistRaw,
  isRecord,
  isSafeArchiveId,
  newArchiveId,
  ATTEMPT_ARCHIVE_MISMATCH,
  ATTEMPT_STALE,
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
  isEffectiveAttempt,
  effectiveAttempts,
  newOperationId,
  newUniqueAttemptId,
  attemptRev,
  attemptOrdinalMap,
  attemptOrdinal,
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
  // T048–T050 追加返工：长按删除有效把次（物理移出记录；视频副本由调用方凭删除凭据清理）
  deleteAttempt,
  // T051：整场删除的只读快照与一次档案提交（媒体由 T052 协调器另做）
  inspectSessionDeletion,
  commitSessionDeletion,
  undoAttempt,
  restoreAttempt,
  attemptSettledOp,
  // 转出线路规则，页面与档案层共用同一份判定。
  CLIMB_TYPES: rules.CLIMB_TYPES,
  GRADES_BY_TYPE: rules.GRADES_BY_TYPE,
  DEFAULT_CLIMB_TYPE: rules.DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE: rules.DEFAULT_GRADE,
  isBoulderRoute: rules.isBoulderRoute,
  isUndoneAttempt: rules.isUndoneAttempt,
  isGradeForType: rules.isGradeForType,
  resolveGradeForType: rules.resolveGradeForType
};
