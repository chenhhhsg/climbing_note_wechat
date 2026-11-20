/**
 * 本机文本备份与隔离恢复核心（T067）
 *
 * 只处理文字：训练档案（岩馆、场次、线路、场内关联、逐把结果与备注、撤回标记）、
 * 下次想爬清单，以及明确列出的辅助字段（单调计数器、当前场次/线路选择）。照片、
 * 视频、各自的索引与操作日志都不进备份文本，也不在这里读写。
 *
 * 文本封套（format / version / exportedAt / contents / training / wishlist / auxiliary /
 * summary）是可粘贴、可重新解析的 JSON。summary 不是信任输入：恢复前会按实际解析出的
 * 训练与清单重算并把字节数、条目数、备注数逐项比对，不一致就拒绝，不写一个键。
 *
 * 安全边界：
 * - 预演（inspectText）只解析与校验，零存储写入；正式恢复必须显式传 confirmed:true
 *   和预演拿到的 previewToken（文本哈希），否则拒绝。
 * - 严格结构校验：不用原型/构造器字段，不做 ID 补写或猜测，重复 ID、跨表引用缺失、
 *   清单归属不符、未知字段都按无效输入拒绝；输入超过内部大小护栏也拒绝且不写。
 * - 当前档案/清单读取失败时，不把失败当成「没有数据」，也不覆盖任何键；原键原样保留。
 *
 * 提交协议（wx 不保证多把写入原子）：
 * 1. 先把新一代档案原文、清单原文分别写到各自独立的 stage 键（避免两条接近上限的
 *    字符串挤在同一把键里），每次写入后都读回逐字节核对；
 * 2. 两份都核对通过后，才写很小的 backup.commit 键。commit 是唯一提交点；读取入口按
 *    commit 同时选择档案与清单，所以不会看到一半新一半旧；
 * 3. commit 之前的任何失败只留下不可见的 pending/stage（不删除、不自动回滚），旧档继续
 *    可读；commit 写入失败但回执丢失时以读回内容为准；
 * 4. 重开时 recoverPending 只核对并报告：没有持久提交键时绝不自动把 stage 提升为当前
 *    代际，完整 stage 交给用户重新预演并显式确认；已有有效提交时按提交记录判定。
 * 5. 预演令牌在本进程内一次性使用：提交键写出（成功、未知或读回不一致）后立即作废，
 *    代际移动或进程重开后的旧令牌都需要重新预演。
 *
 * 正式恢复会为导入档案换一个新的 archiveId（新代际归属）：旧照片索引按老 archiveId
 * 归属，不会被新档案关联，也不会被删除；旧 archive/wishlist 键原样保留，供诊断导出。
 *
 * 对外接口：
 *   exportText({ now })                 只读生成备份文本与实读摘要
 *   inspectText(text, { now })          独立预演，零写入，返回一次性 previewToken
 *   confirmRestore(text, { confirmed:true, previewToken, now })
 *                                       显式确认恢复；失败不写，成功后返回新归属与回执
 *   exportDiagnostics({ now })          只读导出当前/上一代原文（含受损原文逐字保留）
 *   recoverPending({ now })             冷启动核对：只报告，不补写提交键、不启用未提交的 stage
 */
'use strict';
const store = require('./training-store.js');
const wishlist = require('./training-wishlist.js');

const FORMAT = 'climbing-note-text-backup';
const DIAGNOSTICS_FORMAT = 'climbing-note-text-diagnostics';
const BACKUP_VERSION = 1;
const DIAGNOSTICS_VERSION = 1;

// 内部输入护栏（不是产品承诺）：整段文本与两把 stage 键各自留出余量。
const MAX_BACKUP_BYTES = 960 * 1024;
const MAX_ARCHIVE_BYTES = 768 * 1024;
const MAX_WISHLIST_BYTES = 192 * 1024;

const INCLUDED = [
  'training.gyms',
  'training.sessions',
  'training.routes',
  'training.sessionRoutes',
  'training.attempts',
  'training.attempts.note',
  'training.attempts.undoneAt',
  'training.attempts.settledOps',
  'wishlist.items',
  'auxiliary.counters',
  'auxiliary.activeSelection'
];
const EXCLUDED = [
  'photos',
  'photoIndex',
  'videos',
  'videoMarkers',
  'operationJournals',
  'pendingOperations',
  'cloudRecords'
];

const ENVELOPE_KEYS = [
  'format',
  'version',
  'exportedAt',
  'contents',
  'training',
  'wishlist',
  'auxiliary',
  'summary'
];
const TRAINING_KEYS = [
  'version',
  'archiveId',
  'gyms',
  'sessions',
  'routes',
  'sessionRoutes',
  'attempts'
];
const GYM_KEYS = ['id', 'name', 'createdAt'];
const SESSION_KEYS = ['id', 'seq', 'gymId', 'date', 'createdAt'];
const ROUTE_KEYS = [
  'id',
  'seq',
  'gymId',
  'name',
  'climbType',
  'grade',
  'colorName',
  'colorHex',
  'createdAt'
];
const LINK_KEYS = ['sessionId', 'routeId', 'addedAt'];
const ATTEMPT_KEYS = [
  'id',
  'seq',
  'sessionId',
  'routeId',
  'result',
  'note',
  'createdAt',
  'undoneAt',
  'rev',
  'settledOps'
];
const SETTLED_KEYS = ['opId', 'undone', 'at'];
const AUXILIARY_KEYS = ['counters', 'activeSelection'];
const COUNTER_KEYS = ['nextGymSeq', 'nextSessionSeq', 'nextRouteSeq', 'nextAttemptSeq'];
const ACTIVE_KEYS = ['sessionId', 'routeId'];
const WISHLIST_KEYS = ['version', 'items'];
const WISH_ITEM_KEYS = ['archiveId', 'routeId', 'gymId', 'addedAt', 'archivedAt'];
const SUMMARY_KEYS = [
  'archiveId',
  'gyms',
  'sessions',
  'routes',
  'sessionRoutes',
  'attempts',
  'notes',
  'sends',
  'fails',
  'undone',
  'wishlist',
  'wishlistActive',
  'wishlistArchived',
  'trainingBytes',
  'wishlistBytes',
  'auxiliaryBytes',
  'totalBytes'
];
const PREVIOUS_KEYS = [
  'archiveKey',
  'wishlistKey',
  'archivePresent',
  'wishlistPresent',
  'archiveBytes',
  'wishlistBytes',
  'archiveChecksum',
  'wishlistChecksum'
];
const PENDING_KEYS = [
  'version',
  'generation',
  'archiveKey',
  'wishlistKey',
  'rebindArchiveId',
  'sourceArchiveId',
  'confirmedAt',
  'archiveBytes',
  'wishlistBytes',
  'archiveChecksum',
  'wishlistChecksum',
  'previous'
];

const ERROR = {
  BROKEN_TEXT: '备份文本不是有效 JSON',
  UNSUPPORTED: '备份文本版本不受支持，请升级小程序后重试',
  INVALID: '备份文本结构不符合当前版本要求',
  REFERENCE: '备份文本里的引用对不上，未做任何写入',
  OWNERSHIP: '备份清单的档案归属不完整或不一致，未做任何写入',
  SUMMARY: '备份摘要与文本实际内容不一致，未做任何写入',
  TOO_LARGE: '备份文本超过本机可处理的大小护栏，未做任何写入',
  CONFIRM: '正式恢复需要用户明确确认（confirmed:true）',
  PREVIEW: '正式恢复必须先预演，并使用预演返回的令牌',
  CURRENT_UNREADABLE: '读取当前本机档案/清单失败，未做任何写入',
  WRITE_FAILED: '本机写入失败，原档案与清单保持不变',
  COMMITTED_UNVERIFIED: '恢复已提交但回读核对未通过，请导出诊断'
};

let generationSeq = 0;

// 本进程内已签发的预演令牌。令牌本身只是文本哈希，单凭哈希无法区分「刚预演」和
// 「先前已经确认过」；这里记录签发时的代际与是否已消耗。正式恢复只接受未消耗、且
// 仍属于当前代际的令牌。进程重开后记录自然消失，重新预演即可；这正是 UI 侧需要
// 重新绑定 nonce 与文本的地方。
const MAX_ISSUED_PREVIEWS = 32;
const issuedPreviews = new Map();

function rememberPreview(token, generation, consumed) {
  issuedPreviews.set(token, { generation, consumed });
  if (issuedPreviews.size > MAX_ISSUED_PREVIEWS) {
    // 只淘汰尚未消耗的旧记录；已消耗的令牌必须继续拦到进程结束。
    for (const [key, value] of issuedPreviews) {
      if (!value.consumed && key !== token) {
        issuedPreviews.delete(key);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ *
// 基础工具：UTF-8 字节数、纯文本哈希、时间与结构判定
// ------------------------------------------------------------------ *

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

function isRecord(value) {
  return store.isRecord(value);
}

function isSafeArchiveId(value) {
  return store.isSafeArchiveId(value);
}

function hasExactKeys(record, keys) {
  if (!isRecord(record)) return false;
  const own = Object.keys(record);
  return own.length === keys.length && keys.every(key => own.indexOf(key) !== -1);
}

function hasShape(record, required, allowed) {
  if (!isRecord(record)) return false;
  const own = Object.keys(record);
  if (!required.every(key => own.indexOf(key) !== -1)) return false;
  return own.every(key => allowed.indexOf(key) !== -1);
}

/**
 * UTF-8 字节数。小程序环境不假设有 Buffer；孤立代理项按 3 字节计，与 Node 的
 * Buffer.byteLength 一致（替换字符 U+FFFD）。
 */
function utf8Bytes(text) {
  if (typeof text !== 'string') return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * 稳定的非加密文本指纹：用于提交回执、stage 读回核对与诊断。不是安全哈希。
 */
function hashText(text) {
  let left = 0x811c9dc5;
  let right = 0x1000193;
  const value = typeof text === 'string' ? text : '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul((right + code + 1) >>> 0, 0x85ebca6b) >>> 0;
  }
  return (
    left.toString(16).padStart(8, '0') +
    right.toString(16).padStart(8, '0')
  );
}

function timestamp(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (hasText(now)) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function isIsoTime(value) {
  return hasText(value) && !Number.isNaN(new Date(value).getTime());
}

function previewToken(text) {
  return 'bkp1-' + hashText(text);
}

function currentPreviewGeneration() {
  try {
    const layout = store.resolveLayout();
    return layout && layout.ok ? layout.generation : null;
  } catch (error) {
    return null;
  }
}

/**
 * 记录一次预演签发：绑定当前代际。令牌本身已经由文本哈希确定，不再重复保存原文。
 */
function registerPreview(text) {
  const token = previewToken(text);
  rememberPreview(token, currentPreviewGeneration(), false);
  return token;
}

/**
 * 令牌是否仍可用于这次确认：未被先前提交消耗、且签发后当前代际没有移动。
 * 未登记过的令牌按兼容路径放行（例如进程重开后重新粘贴的确定性哈希），真正的重复
 * 确认会在第一次走到提交点后被登记为已消耗。
 */
function previewTokenState(token) {
  const entry = issuedPreviews.get(token);
  if (!entry) return { ok: true, issued: false };
  if (entry.consumed) return { ok: false, issued: true };
  if (entry.generation !== null) {
    const generation = currentPreviewGeneration();
    if (generation !== null && generation !== entry.generation) {
      return { ok: false, issued: true };
    }
  }
  return { ok: true, issued: true };
}

/**
 * 提交点已经写出（成功、未知或读回不一致）后，旧令牌一律作废；仅预提交失败保留。
 */
function markPreviewConsumed(token) {
  const entry = issuedPreviews.get(token);
  if (entry) {
    entry.consumed = true;
    return;
  }
  rememberPreview(token, currentPreviewGeneration(), true);
}

function emptyResult(code, error) {
  return { ok: false, code, error };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// ------------------------------------------------------------------ *
// 严格校验
// ------------------------------------------------------------------ *

function validateTraining(training) {
  if (!hasExactKeys(training, TRAINING_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：训练字段');
  }
  if (training.version !== store.STATE_VERSION) {
    return emptyResult('unsupported-version', ERROR.UNSUPPORTED);
  }
  if (!isSafeArchiveId(training.archiveId)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：档案 ID');
  }
  if (
    !Array.isArray(training.gyms) ||
    !Array.isArray(training.sessions) ||
    !Array.isArray(training.routes) ||
    !Array.isArray(training.sessionRoutes) ||
    !Array.isArray(training.attempts)
  ) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：训练列表');
  }

  const gymIds = new Set();
  for (const gym of training.gyms) {
    if (!hasShape(gym, ['id', 'name'], GYM_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：岩馆字段');
    }
    if (!hasText(gym.id) || !hasText(gym.name)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：岩馆 ID/名称');
    }
    if (gym.createdAt !== undefined && !hasText(gym.createdAt)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：岩馆时间');
    }
    if (gymIds.has(gym.id)) return emptyResult('invalid-schema', ERROR.INVALID + '：岩馆 ID 重复');
    gymIds.add(gym.id);
  }

  const sessionIds = new Set();
  let maxSessionSeq = 0;
  for (const session of training.sessions) {
    if (!hasShape(session, SESSION_KEYS, SESSION_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：场次字段');
    }
    if (!hasText(session.id) || !isSeq(session.seq) || !hasText(session.gymId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：场次 ID/序号/岩馆');
    }
    if (!store.isDateString(session.date) || !hasText(session.createdAt)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：场次日期/时间');
    }
    if (sessionIds.has(session.id)) return emptyResult('invalid-schema', ERROR.INVALID + '：场次 ID 重复');
    sessionIds.add(session.id);
    if (!gymIds.has(session.gymId)) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：场次岩馆');
    }
    maxSessionSeq = Math.max(maxSessionSeq, session.seq);
  }

  const routesById = new Map();
  let maxRouteSeq = 0;
  for (const route of training.routes) {
    let invalidRouteField = false;
    if (!hasShape(route, ['id', 'seq', 'gymId', 'name', 'grade'], ROUTE_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：线路字段');
    }
    if (!hasText(route.id) || !isSeq(route.seq) || !hasText(route.gymId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：线路 ID/序号/岩馆');
    }
    if (!hasText(route.name) || !hasText(route.grade)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：线路名称/等级');
    }
    ['climbType', 'colorName', 'colorHex', 'createdAt'].forEach(key => {
      if (route[key] !== undefined && typeof route[key] !== 'string') {
        invalidRouteField = true;
      }
    });
    if (invalidRouteField) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：线路辅助字段');
    }
    if (routesById.has(route.id)) return emptyResult('invalid-schema', ERROR.INVALID + '：线路 ID 重复');
    if (!gymIds.has(route.gymId)) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：线路岩馆');
    }
    routesById.set(route.id, route);
    maxRouteSeq = Math.max(maxRouteSeq, route.seq);
  }

  const linkKeys = new Set();
  for (const link of training.sessionRoutes) {
    if (!hasShape(link, ['sessionId', 'routeId'], LINK_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：场内关联字段');
    }
    if (!hasText(link.sessionId) || !hasText(link.routeId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：场内关联 ID');
    }
    if (link.addedAt !== undefined && typeof link.addedAt !== 'string') {
      return emptyResult('invalid-schema', ERROR.INVALID + '：关联时间');
    }
    if (!sessionIds.has(link.sessionId) || !routesById.has(link.routeId)) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：场内关联');
    }
    const key = link.sessionId + '\u0000' + link.routeId;
    if (linkKeys.has(key)) return emptyResult('invalid-schema', ERROR.INVALID + '：场内关联重复');
    linkKeys.add(key);
  }

  const attemptIds = new Set();
  let maxAttemptSeq = 0;
  for (const attempt of training.attempts) {
    if (!hasShape(attempt, ['id', 'seq', 'sessionId', 'routeId', 'result', 'note', 'createdAt'], ATTEMPT_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次字段');
    }
    if (!hasText(attempt.id) || !isSeq(attempt.seq)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次 ID/序号');
    }
    if (!hasText(attempt.sessionId) || !hasText(attempt.routeId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次归属');
    }
    if (attempt.result !== 'fail' && attempt.result !== 'send') {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次结果');
    }
    if (typeof attempt.note !== 'string' || !hasText(attempt.createdAt)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次备注/时间');
    }
    if (attempt.undoneAt !== undefined && typeof attempt.undoneAt !== 'string') {
      return emptyResult('invalid-schema', ERROR.INVALID + '：撤回标记');
    }
    if (attempt.rev !== undefined && !(Number.isInteger(attempt.rev) && attempt.rev >= 0)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：把次版本');
    }
    if (attempt.settledOps !== undefined) {
      if (!Array.isArray(attempt.settledOps)) {
        return emptyResult('invalid-schema', ERROR.INVALID + '：结清操作列表');
      }
      for (const op of attempt.settledOps) {
        if (!hasExactKeys(op, SETTLED_KEYS)) {
          return emptyResult('invalid-schema', ERROR.INVALID + '：结清操作字段');
        }
        if (!hasText(op.opId) || typeof op.undone !== 'boolean' || !hasText(op.at)) {
          return emptyResult('invalid-schema', ERROR.INVALID + '：结清操作值');
        }
      }
    }
    if (!sessionIds.has(attempt.sessionId) || !routesById.has(attempt.routeId)) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：把次归属');
    }
    if (attemptIds.has(attempt.id)) return emptyResult('invalid-schema', ERROR.INVALID + '：把次 ID 重复');
    attemptIds.add(attempt.id);
    maxAttemptSeq = Math.max(maxAttemptSeq, attempt.seq);
  }

  return {
    ok: true,
    routesById,
    maxSeqs: {
      // 岩馆没有内部 seq 字段，与 store.normalizeCounter 的口径一致：只要求计数器为正。
      nextGymSeq: 0,
      nextSessionSeq: maxSessionSeq,
      nextRouteSeq: maxRouteSeq,
      nextAttemptSeq: maxAttemptSeq
    }
  };
}

function validateWishlistDoc(doc, sourceArchiveId, routesById) {
  if (!hasExactKeys(doc, WISHLIST_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：清单字段');
  }
  if (doc.version !== wishlist.WISHLIST_VERSION) {
    return emptyResult('unsupported-version', ERROR.UNSUPPORTED);
  }
  if (!Array.isArray(doc.items)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：清单列表');
  }
  const seen = new Set();
  for (const item of doc.items) {
    if (!hasExactKeys(item, WISH_ITEM_KEYS)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：清单条目字段');
    }
    if (!hasText(item.archiveId) || item.archiveId !== sourceArchiveId) {
      return emptyResult('wishlist-ownership', ERROR.OWNERSHIP);
    }
    if (!hasText(item.routeId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：清单线路 ID');
    }
    const route = routesById.get(item.routeId);
    if (!route) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：清单线路');
    }
    if (typeof item.gymId !== 'string' || item.gymId !== route.gymId) {
      return emptyResult('reference-error', ERROR.REFERENCE + '：清单岩馆');
    }
    if (!hasText(item.addedAt) || typeof item.archivedAt !== 'string') {
      return emptyResult('invalid-schema', ERROR.INVALID + '：清单时间');
    }
    if (seen.has(item.routeId)) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：清单线路重复');
    }
    seen.add(item.routeId);
  }
  return { ok: true };
}

function validateAuxiliary(auxiliary, training, maxSeqs) {
  if (!hasExactKeys(auxiliary, AUXILIARY_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：辅助字段');
  }
  if (!hasExactKeys(auxiliary.counters, COUNTER_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：计数器字段');
  }
  for (const key of COUNTER_KEYS) {
    const value = auxiliary.counters[key];
    if (!isSeq(value) || value <= maxSeqs[key]) {
      return emptyResult('invalid-schema', ERROR.INVALID + '：计数器值');
    }
  }
  if (!hasExactKeys(auxiliary.activeSelection, ACTIVE_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：当前选择字段');
  }
  const active = auxiliary.activeSelection;
  if (typeof active.sessionId !== 'string' || typeof active.routeId !== 'string') {
    return emptyResult('invalid-schema', ERROR.INVALID + '：当前选择类型');
  }
  if (active.sessionId && !training.sessions.some(item => item.id === active.sessionId)) {
    return emptyResult('reference-error', ERROR.REFERENCE + '：当前场次');
  }
  if (active.routeId && !training.routes.some(item => item.id === active.routeId)) {
    return emptyResult('reference-error', ERROR.REFERENCE + '：当前线路');
  }
  return { ok: true };
}

function computeSummary(training, wishlistDoc, auxiliary) {
  const attempts = training.attempts;
  // sends/fails 只数未撤回的当前有效把次；undone 单独计数，notes 数所有非空备注原文
  // （含已撤回的那一把），与「文本完整往返」的口径一致。
  const active = attempts.filter(attempt => !attempt.undoneAt);
  const trainingBytes = utf8Bytes(JSON.stringify(training));
  const wishlistBytes = utf8Bytes(JSON.stringify(wishlistDoc));
  const auxiliaryBytes = utf8Bytes(JSON.stringify(auxiliary));
  return {
    archiveId: training.archiveId,
    gyms: training.gyms.length,
    sessions: training.sessions.length,
    routes: training.routes.length,
    sessionRoutes: training.sessionRoutes.length,
    attempts: attempts.length,
    notes: attempts.filter(attempt => attempt.note.length > 0).length,
    sends: active.filter(attempt => attempt.result === 'send').length,
    fails: active.filter(attempt => attempt.result === 'fail').length,
    undone: attempts.filter(attempt => Boolean(attempt.undoneAt)).length,
    wishlist: wishlistDoc.items.length,
    wishlistActive: wishlistDoc.items.filter(item => !item.archivedAt).length,
    wishlistArchived: wishlistDoc.items.filter(item => Boolean(item.archivedAt)).length,
    trainingBytes,
    wishlistBytes,
    auxiliaryBytes,
    totalBytes: trainingBytes + wishlistBytes + auxiliaryBytes
  };
}

function sameSummary(actual, expected) {
  if (!hasExactKeys(actual, SUMMARY_KEYS)) return false;
  return SUMMARY_KEYS.every(key => actual[key] === expected[key]);
}

function validateContents(contents) {
  if (!isRecord(contents)) return false;
  const keys = Object.keys(contents);
  if (keys.length !== 2 || keys.indexOf('includes') === -1 || keys.indexOf('excludes') === -1) {
    return false;
  }
  const same = (left, right) =>
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index]);
  return same(contents.includes, INCLUDED) && same(contents.excludes, EXCLUDED);
}

/**
 * 严格校验完整备份文本。summary 由实际解析出的内容重算，输入里的 summary 只用于比对。
 */
function validateEnvelope(parsed) {
  if (!isRecord(parsed)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：封套');
  }
  if (!hasExactKeys(parsed, ENVELOPE_KEYS)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：封套字段');
  }
  if (parsed.format !== FORMAT) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：格式标识');
  }
  if (parsed.version !== BACKUP_VERSION) {
    return emptyResult('unsupported-version', ERROR.UNSUPPORTED);
  }
  if (!isIsoTime(parsed.exportedAt)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：导出时间');
  }
  if (!validateContents(parsed.contents)) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：包含范围');
  }
  const training = validateTraining(parsed.training);
  if (!training.ok) return training;
  const wl = validateWishlistDoc(parsed.wishlist, parsed.training.archiveId, training.routesById);
  if (!wl.ok) return wl;
  const auxiliary = validateAuxiliary(parsed.auxiliary, parsed.training, training.maxSeqs);
  if (!auxiliary.ok) return auxiliary;
  const expected = computeSummary(parsed.training, parsed.wishlist, parsed.auxiliary);
  if (!sameSummary(parsed.summary, expected)) {
    return emptyResult('summary-mismatch', ERROR.SUMMARY);
  }
  return {
    ok: true,
    training: parsed.training,
    wishlist: parsed.wishlist,
    auxiliary: parsed.auxiliary,
    summary: expected
  };
}

// ------------------------------------------------------------------ *
// 文本构造与导出
// ------------------------------------------------------------------ *

function trainingDocOf(archive) {
  return {
    version: store.STATE_VERSION,
    archiveId: archive.archiveId,
    gyms: archive.gyms.map(gym => {
      const doc = { id: gym.id, name: gym.name };
      if (hasText(gym.createdAt)) doc.createdAt = gym.createdAt;
      return doc;
    }),
    sessions: archive.sessions.map(session => ({
      id: session.id,
      seq: session.seq,
      gymId: session.gymId,
      date: session.date,
      createdAt: session.createdAt
    })),
    routes: archive.routes.map(route => {
      const doc = {
        id: route.id,
        seq: route.seq,
        gymId: route.gymId,
        name: route.name
      };
      if (typeof route.climbType === 'string') doc.climbType = route.climbType;
      doc.grade = route.grade;
      if (typeof route.colorName === 'string') doc.colorName = route.colorName;
      if (typeof route.colorHex === 'string') doc.colorHex = route.colorHex;
      if (hasText(route.createdAt)) doc.createdAt = route.createdAt;
      return doc;
    }),
    sessionRoutes: archive.sessionRoutes.map(link => {
      const doc = { sessionId: link.sessionId, routeId: link.routeId };
      if (typeof link.addedAt === 'string') doc.addedAt = link.addedAt;
      return doc;
    }),
    attempts: archive.attempts.map(attempt => {
      const doc = {
        id: attempt.id,
        seq: attempt.seq,
        sessionId: attempt.sessionId,
        routeId: attempt.routeId,
        result: attempt.result,
        note: attempt.note,
        createdAt: attempt.createdAt
      };
      if (typeof attempt.undoneAt === 'string') doc.undoneAt = attempt.undoneAt;
      if (Number.isInteger(attempt.rev)) doc.rev = attempt.rev;
      if (Array.isArray(attempt.settledOps) && attempt.settledOps.length > 0) {
        doc.settledOps = attempt.settledOps.map(op => ({
          opId: op.opId,
          undone: op.undone === true,
          at: op.at
        }));
      }
      return doc;
    })
  };
}

function wishlistDocOf(state, archiveId) {
  return {
    version: wishlist.WISHLIST_VERSION,
    items: state.items
      .filter(item => item.archiveId === archiveId)
      .map(item => ({
        archiveId: item.archiveId,
        routeId: item.routeId,
        gymId: item.gymId,
        addedAt: item.addedAt,
        archivedAt: item.archivedAt
      }))
  };
}

function auxiliaryOf(archive) {
  return {
    counters: {
      nextGymSeq: archive.nextGymSeq,
      nextSessionSeq: archive.nextSessionSeq,
      nextRouteSeq: archive.nextRouteSeq,
      nextAttemptSeq: archive.nextAttemptSeq
    },
    activeSelection: {
      sessionId: archive.activeSessionId || '',
      routeId: archive.activeRouteId || ''
    }
  };
}

function buildEnvelope(training, wishlistDoc, auxiliary, now) {
  return {
    format: FORMAT,
    version: BACKUP_VERSION,
    exportedAt: timestamp(now),
    contents: { includes: INCLUDED.slice(), excludes: EXCLUDED.slice() },
    training,
    wishlist: wishlistDoc,
    auxiliary,
    summary: computeSummary(training, wishlistDoc, auxiliary)
  };
}

/**
 * 从当前本机读取文字并生成备份文本。只读，不写任何键。
 */
function exportText(options) {
  const data = options || {};
  const loaded = store.loadState();
  if (!loaded.ok) {
    return emptyResult('current-unreadable', loaded.error);
  }
  if (!loaded.present) {
    return emptyResult('empty-current', '当前没有可导出的本机训练档案');
  }
  const currentWishlist = wishlist.loadWishlist();
  if (!currentWishlist.ok) {
    return emptyResult(
      currentWishlist.corrupt ? 'current-damaged' : 'current-unreadable',
      currentWishlist.error
    );
  }

  const training = trainingDocOf(loaded.archive);
  const wishlistDoc = wishlistDocOf(currentWishlist.state, loaded.archive.archiveId);
  const auxiliary = auxiliaryOf(loaded.archive);
  const omittedWishlist = currentWishlist.state.items.length - wishlistDoc.items.length;

  const builtTraining = validateTraining(training);
  if (!builtTraining.ok) return builtTraining;
  const builtWishlist = validateWishlistDoc(
    wishlistDoc,
    loaded.archive.archiveId,
    builtTraining.routesById
  );
  if (!builtWishlist.ok) return builtWishlist;
  const builtAuxiliary = validateAuxiliary(auxiliary, training, builtTraining.maxSeqs);
  if (!builtAuxiliary.ok) return builtAuxiliary;

  const text = JSON.stringify(buildEnvelope(training, wishlistDoc, auxiliary, data.now));
  const bytes = utf8Bytes(text);
  if (bytes > MAX_BACKUP_BYTES) {
    return emptyResult('too-large', ERROR.TOO_LARGE);
  }

  // 摘要以实际解析结果为准：重新解析生成的文本并校验，避免写出自相矛盾的封套。
  let reparsed;
  try {
    reparsed = JSON.parse(text);
  } catch (error) {
    return emptyResult('self-check-failed', '备份文本自检失败：' + errorText(error));
  }
  const checked = validateEnvelope(reparsed);
  if (!checked.ok) return checked;

  return {
    ok: true,
    code: 'exported',
    error: '',
    text,
    bytes,
    summary: checked.summary,
    omittedWishlist,
    warnings:
      omittedWishlist > 0
        ? ['有 ' + omittedWishlist + ' 条清单未注明当前档案归属，未纳入本次备份；原键保留']
        : []
  };
}

/**
 * 预演的内部实现：解析并严格校验文本，返回摘要与令牌。零写入。
 */
function inspectTextCore(text, options) {
  const data = options || {};
  if (typeof text !== 'string') {
    return emptyResult('broken-text', ERROR.BROKEN_TEXT);
  }
  const bytes = utf8Bytes(text);
  if (bytes > MAX_BACKUP_BYTES) {
    return emptyResult('too-large', ERROR.TOO_LARGE);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return emptyResult('broken-text', ERROR.BROKEN_TEXT);
  }
  const checked = validateEnvelope(parsed);
  if (!checked.ok) return checked;
  return {
    ok: true,
    code: 'preview',
    error: '',
    token: previewToken(text),
    bytes,
    summary: checked.summary,
    plan: {
      sourceArchiveId: checked.training.archiveId,
      sessions: checked.summary.sessions,
      routes: checked.summary.routes,
      attempts: checked.summary.attempts,
      wishlist: checked.summary.wishlist,
      note: '正式恢复会为导入档案分配新的 archiveId；现有照片、视频与索引不会关联到这份档案，也不会被删除'
    },
    training: checked.training,
    wishlistDoc: checked.wishlist,
    auxiliary: checked.auxiliary
  };
}

/**
 * 预演：校验并签发一次可用的确认令牌。零写入。
 */
function inspectText(text, options) {
  const inspected = inspectTextCore(text, options);
  if (inspected.ok) inspected.token = registerPreview(text);
  return inspected;
}

// ------------------------------------------------------------------ *
// 提交记录与写入核对
// ------------------------------------------------------------------ *

function readKeyText(key) {
  return store.readStorageText(key);
}

/**
 * 写一把键并立即读回逐字节核对。区分三种结果：
 * - ok:true：读回一致（receiptLost 表示写调用报错但内容已持久化）；
 * - mismatch：写调用成功但读回内容不同；
 * - unknown：写调用报错且读回也失败，无法判断是否落盘。
 */
function writeVerified(key, text) {
  let thrown = null;
  try {
    wx.setStorageSync(key, text);
  } catch (error) {
    thrown = error;
  }
  const read = readKeyText(key);
  if (!read.ok) {
    return { ok: false, persisted: null, unknown: true, mismatch: false, receiptLost: false, error: read.error };
  }
  if (read.present && read.value === text) {
    return {
      ok: true,
      persisted: true,
      unknown: false,
      mismatch: false,
      receiptLost: Boolean(thrown),
      error: thrown ? errorText(thrown) : ''
    };
  }
  if (thrown) {
    return { ok: false, persisted: false, unknown: false, mismatch: false, receiptLost: false, error: errorText(thrown) };
  }
  return {
    ok: false,
    persisted: false,
    unknown: false,
    mismatch: true,
    receiptLost: false,
    error: '写入后读回与预期不一致'
  };
}

function parsePrevious(raw) {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).length !== PREVIOUS_KEYS.length) return null;
  if (!PREVIOUS_KEYS.every(key => Object.prototype.hasOwnProperty.call(raw, key))) return null;
  if (!hasText(raw.archiveKey) || !hasText(raw.wishlistKey)) return null;
  if (typeof raw.archivePresent !== 'boolean' || typeof raw.wishlistPresent !== 'boolean') return null;
  if (!Number.isInteger(raw.archiveBytes) || raw.archiveBytes < 0) return null;
  if (!Number.isInteger(raw.wishlistBytes) || raw.wishlistBytes < 0) return null;
  if (typeof raw.archiveChecksum !== 'string' || typeof raw.wishlistChecksum !== 'string') return null;
  return raw;
}

function parsePending(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  if (Object.keys(record || {}).length !== PENDING_KEYS.length) return null;
  if (!PENDING_KEYS.every(key => Object.prototype.hasOwnProperty.call(record, key))) return null;
  if (record.version !== store.LAYOUT_VERSION) return null;
  if (typeof record.generation !== 'string' || !/^[A-Za-z0-9_-]{6,90}$/.test(record.generation)) {
    return null;
  }
  const keys = store.stageKeysFor(record.generation);
  if (record.archiveKey !== keys.archiveKey || record.wishlistKey !== keys.wishlistKey) return null;
  if (!isSafeArchiveId(record.rebindArchiveId) || !isSafeArchiveId(record.sourceArchiveId)) {
    return null;
  }
  if (record.rebindArchiveId === record.sourceArchiveId) return null;
  if (!isIsoTime(record.confirmedAt)) return null;
  if (!Number.isInteger(record.archiveBytes) || record.archiveBytes < 0) return null;
  if (!Number.isInteger(record.wishlistBytes) || record.wishlistBytes < 0) return null;
  if (typeof record.archiveChecksum !== 'string' || typeof record.wishlistChecksum !== 'string') {
    return null;
  }
  if (!parsePrevious(record.previous)) return null;
  return record;
}

function newGenerationId() {
  generationSeq += 1;
  return (
    'bkp-' +
    Date.now().toString(36) +
    '-' +
    generationSeq +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

function previousOf(layout) {
  const archiveRead = readKeyText(layout.archiveKey);
  if (!archiveRead.ok) {
    return { ok: false, error: archiveRead.error };
  }
  const wishlistRead = readKeyText(layout.wishlistKey);
  if (!wishlistRead.ok) {
    return { ok: false, error: wishlistRead.error };
  }
  return {
    ok: true,
    previous: {
      archiveKey: layout.archiveKey,
      wishlistKey: layout.wishlistKey,
      archivePresent: archiveRead.present,
      wishlistPresent: wishlistRead.present,
      archiveBytes: utf8Bytes(archiveRead.value),
      wishlistBytes: utf8Bytes(wishlistRead.value),
      archiveChecksum: archiveRead.present ? hashText(archiveRead.value) : '',
      wishlistChecksum: wishlistRead.present ? hashText(wishlistRead.value) : ''
    }
  };
}

function buildReboundArchive(training, auxiliary, rebindArchiveId) {
  return {
    version: store.STATE_VERSION,
    archiveId: rebindArchiveId,
    nextGymSeq: auxiliary.counters.nextGymSeq,
    nextSessionSeq: auxiliary.counters.nextSessionSeq,
    nextRouteSeq: auxiliary.counters.nextRouteSeq,
    nextAttemptSeq: auxiliary.counters.nextAttemptSeq,
    gyms: cloneJson(training.gyms),
    sessions: cloneJson(training.sessions),
    routes: cloneJson(training.routes),
    sessionRoutes: cloneJson(training.sessionRoutes),
    attempts: cloneJson(training.attempts),
    pendingSaves: [],
    pendingCorrections: [],
    pendingUndos: [],
    pendingRestores: [],
    activeSessionId: auxiliary.activeSelection.sessionId,
    activeRouteId: auxiliary.activeSelection.routeId
  };
}

function reboundWishlistDoc(doc, rebindArchiveId) {
  return {
    version: wishlist.WISHLIST_VERSION,
    items: doc.items.map(item => ({
      archiveId: rebindArchiveId,
      routeId: item.routeId,
      gymId: item.gymId,
      addedAt: item.addedAt,
      archivedAt: item.archivedAt
    }))
  };
}

function commitRecordOf(pending) {
  return {
    version: store.LAYOUT_VERSION,
    generation: pending.generation,
    archiveKey: pending.archiveKey,
    wishlistKey: pending.wishlistKey,
    archiveId: pending.rebindArchiveId,
    archiveBytes: pending.archiveBytes,
    wishlistBytes: pending.wishlistBytes,
    archiveChecksum: pending.archiveChecksum,
    wishlistChecksum: pending.wishlistChecksum,
    committedAt: pending.confirmedAt,
    previous: pending.previous
  };
}

function commitFailure(result, prefix) {
  if (result.mismatch) {
    return emptyResult('commit-unverified', ERROR.COMMITTED_UNVERIFIED + '（提交键读回不一致）');
  }
  if (result.unknown) {
    return emptyResult('commit-unknown', '提交结果无法确认；重开后按提交记录选择完整的一代');
  }
  return emptyResult(prefix, ERROR.WRITE_FAILED + '：' + result.error);
}

/**
 * 把两把 stage 与最后一个 commit 键按顺序写出并逐一读回核对。
 * commit 键写入前不会改变任何读取入口看到的状态。
 */
function stageAndCommit(plan) {
  const layout = store.resolveLayout();
  if (!layout.ok) return emptyResult('current-unreadable', layout.error);

  const pendingRead = readKeyText(store.BACKUP_PENDING_KEY);
  if (!pendingRead.ok) return emptyResult('pending-read-failed', pendingRead.error);
  let generation = '';
  if (pendingRead.present) {
    const previousPending = parsePending(pendingRead.value);
    if (previousPending && previousPending.generation !== layout.generation) {
      generation = previousPending.generation;
    }
  }
  if (!generation) generation = newGenerationId();
  const keys = store.stageKeysFor(generation);

  const pending = {
    version: store.LAYOUT_VERSION,
    generation,
    archiveKey: keys.archiveKey,
    wishlistKey: keys.wishlistKey,
    rebindArchiveId: plan.rebindArchiveId,
    sourceArchiveId: plan.sourceArchiveId,
    confirmedAt: timestamp(plan.now),
    archiveBytes: utf8Bytes(plan.archiveText),
    wishlistBytes: utf8Bytes(plan.wishlistText),
    archiveChecksum: hashText(plan.archiveText),
    wishlistChecksum: hashText(plan.wishlistText),
    previous: plan.previous
  };
  const pendingText = JSON.stringify(pending);

  const pendingWrite = writeVerified(store.BACKUP_PENDING_KEY, pendingText);
  if (!pendingWrite.ok) {
    return emptyResult(
      pendingWrite.unknown ? 'pending-write-unknown' : 'pending-write-failed',
      ERROR.WRITE_FAILED + '：' + pendingWrite.error
    );
  }

  const archiveWrite = writeVerified(pending.archiveKey, plan.archiveText);
  if (!archiveWrite.ok) {
    return emptyResult(
      archiveWrite.unknown ? 'stage-archive-write-unknown' : 'stage-archive-write-failed',
      ERROR.WRITE_FAILED + '：' + archiveWrite.error
    );
  }

  const wishlistWrite = writeVerified(pending.wishlistKey, plan.wishlistText);
  if (!wishlistWrite.ok) {
    return emptyResult(
      wishlistWrite.unknown ? 'stage-wishlist-write-unknown' : 'stage-wishlist-write-failed',
      ERROR.WRITE_FAILED + '：' + wishlistWrite.error
    );
  }

  // 提交前再完整读回两把 stage，防止「写调用成功但内容被替换」的静默故障。
  const archiveCheck = readKeyText(pending.archiveKey);
  const wishlistCheck = readKeyText(pending.wishlistKey);
  if (
    !archiveCheck.ok ||
    !archiveCheck.present ||
    archiveCheck.value !== plan.archiveText ||
    !wishlistCheck.ok ||
    !wishlistCheck.present ||
    wishlistCheck.value !== plan.wishlistText
  ) {
    return emptyResult('stage-readback-mismatch', ERROR.WRITE_FAILED + '：两把 stage 读回与预期不一致');
  }

  // 提交点之前先丢掉进程内布局缓存：从这里开始，任何读取都必须重新看盘上的 commit，
  // 不能继续拿旧的 legacy/committed 布局回答。
  store.resetLayoutCache();
  const commitText = JSON.stringify(commitRecordOf(pending));
  const commitWrite = writeVerified(store.BACKUP_COMMIT_KEY, commitText);
  if (!commitWrite.ok) {
    // 提交键可能已经以未知/损坏的形态落盘：丢掉进程内布局缓存，让后续读取按盘上
    // 的 commit 重新判断（要么完整新一代，要么可见错误），不继续拿旧缓存充数。
    store.resetLayoutCache();
    return commitFailure(commitWrite, 'commit-write-failed');
  }

  // commit 已持久化：内容必须在提交点之后仍与预期一致。
  const commitRead = readKeyText(store.BACKUP_COMMIT_KEY);
  if (!commitRead.ok || !commitRead.present || commitRead.value !== commitText) {
    store.resetLayoutCache();
    return emptyResult('commit-unverified', ERROR.COMMITTED_UNVERIFIED + '（提交键读回不一致）');
  }
  if (!store.activateLayout(commitRecordOf(pending))) {
    store.resetLayoutCache();
    return emptyResult('commit-unverified', ERROR.COMMITTED_UNVERIFIED + '（提交记录无法解析）');
  }
  return {
    ok: true,
    code: commitWrite.receiptLost ? 'restored-receipt-lost' : 'restored',
    error: '',
    record: pending,
    pendingWrite,
    archiveWrite,
    wishlistWrite,
    commitWrite
  };
}

function countsOf(summary) {
  return {
    gyms: summary.gyms,
    sessions: summary.sessions,
    routes: summary.routes,
    sessionRoutes: summary.sessionRoutes,
    attempts: summary.attempts,
    notes: summary.notes,
    sends: summary.sends,
    fails: summary.fails,
    undone: summary.undone,
    wishlist: summary.wishlist,
    wishlistActive: summary.wishlistActive,
    wishlistArchived: summary.wishlistArchived
  };
}

/**
 * 提交后用公开读取入口复核：两份读取都要看到同一代与同样的计数。
 */
function verifyActive(expect) {
  const activeLayout = store.resolveLayout();
  if (!activeLayout.ok || activeLayout.legacy) {
    return { ok: false, error: ERROR.COMMITTED_UNVERIFIED + '：当前代际未生效' };
  }
  const loaded = store.loadState();
  if (!loaded.ok || !loaded.present) {
    return { ok: false, error: loaded.error || ERROR.COMMITTED_UNVERIFIED };
  }
  if (loaded.archive.archiveId !== expect.rebindArchiveId) {
    return { ok: false, error: ERROR.COMMITTED_UNVERIFIED + '：档案归属不一致' };
  }
  const storedWishlist = wishlist.loadWishlist();
  if (!storedWishlist.ok) {
    return { ok: false, error: storedWishlist.error || ERROR.COMMITTED_UNVERIFIED };
  }
  const trainingDoc = trainingDocOf(loaded.archive);
  const wishlistDoc = wishlistDocOf(storedWishlist.state, expect.rebindArchiveId);
  const auxiliary = auxiliaryOf(loaded.archive);
  const summary = computeSummary(trainingDoc, wishlistDoc, auxiliary);
  const actual = countsOf(summary);
  const wanted = countsOf(expect.summary);
  const keys = Object.keys(wanted);
  if (!keys.every(key => actual[key] === wanted[key])) {
    return { ok: false, error: ERROR.COMMITTED_UNVERIFIED + '：计数与备份不一致' };
  }
  return { ok: true, summary, archiveId: expect.rebindArchiveId };
}

// ------------------------------------------------------------------ *
// 正式恢复
// ------------------------------------------------------------------ *

/**
 * 正式恢复。必须显式 confirmed:true 且带预演令牌；校验/读取失败一律不写。
 */
function confirmRestore(text, options) {
  const data = options || {};
  if (data.confirmed !== true) {
    return emptyResult('confirmation-required', ERROR.CONFIRM);
  }
  if (typeof data.previewToken !== 'string' || data.previewToken !== previewToken(text)) {
    return emptyResult('preview-required', ERROR.PREVIEW);
  }
  const previewed = previewTokenState(data.previewToken);
  if (!previewed.ok) {
    return emptyResult('preview-stale', ERROR.PREVIEW + '：该预演已被使用或代际已变化，请重新预演');
  }

  const inspected = inspectTextCore(text, data);
  if (!inspected.ok) return inspected; // 无效/超限：零写入

  const layout = store.resolveLayout();
  if (!layout.ok) return emptyResult('current-unreadable', layout.error);
  const previous = previousOf(layout);
  if (!previous.ok) {
    return emptyResult('current-read-failed', ERROR.CURRENT_UNREADABLE + '：' + previous.error);
  }

  let rebindArchiveId = store.newArchiveId();
  while (rebindArchiveId === inspected.training.archiveId) {
    rebindArchiveId = store.newArchiveId();
  }

  const newArchive = buildReboundArchive(inspected.training, inspected.auxiliary, rebindArchiveId);
  const normalized = store.normalizeArchive(newArchive);
  if (!normalized || normalized.archiveId !== rebindArchiveId) {
    return emptyResult('invalid-schema', ERROR.INVALID + '：恢复后的档案');
  }
  const normalizedTraining = trainingDocOf(normalized);
  const checkedTraining = validateTraining(normalizedTraining);
  if (!checkedTraining.ok) return checkedTraining;
  const newWishlistDoc = reboundWishlistDoc(inspected.wishlistDoc, rebindArchiveId);
  const checkedWishlist = validateWishlistDoc(
    newWishlistDoc,
    rebindArchiveId,
    checkedTraining.routesById
  );
  if (!checkedWishlist.ok) return checkedWishlist;
  const activeAuxiliary = auxiliaryOf(normalized);
  const checkedAuxiliary = validateAuxiliary(
    activeAuxiliary,
    normalizedTraining,
    checkedTraining.maxSeqs
  );
  if (!checkedAuxiliary.ok) return checkedAuxiliary;

  const archiveText = JSON.stringify(normalized);
  const wishlistText = JSON.stringify(newWishlistDoc);
  if (utf8Bytes(archiveText) > MAX_ARCHIVE_BYTES) {
    return emptyResult('too-large', ERROR.TOO_LARGE + '：档案');
  }
  if (utf8Bytes(wishlistText) > MAX_WISHLIST_BYTES) {
    return emptyResult('too-large', ERROR.TOO_LARGE + '：清单');
  }

  const staged = stageAndCommit({
    rebindArchiveId,
    sourceArchiveId: inspected.training.archiveId,
    archiveText,
    wishlistText,
    previous: previous.previous,
    now: data.now
  });
  if (!staged.ok) {
    // 只有走到提交点之后（未知/读回不一致）才作废旧令牌；提交点之前的失败仍可原样重试。
    if (staged.code === 'commit-unknown' || staged.code === 'commit-unverified') {
      markPreviewConsumed(data.previewToken);
    }
    return staged;
  }
  // 提交键已经持久化：同一预演令牌不再能重复触发一次恢复。
  markPreviewConsumed(data.previewToken);

  const verified = verifyActive({
    rebindArchiveId,
    summary: computeSummary(
      trainingDocOf(normalized),
      newWishlistDoc,
      activeAuxiliary
    )
  });
  if (!verified.ok) {
    return {
      ok: false,
      code: 'committed-unverified',
      error: ERROR.COMMITTED_UNVERIFIED + '：' + verified.error,
      committed: true,
      generation: staged.record.generation,
      rebindArchiveId,
      previous: previous.previous
    };
  }

  return {
    ok: true,
    code: staged.code,
    error: '',
    committed: true,
    sourceArchiveId: inspected.training.archiveId,
    rebindArchiveId,
    generation: staged.record.generation,
    previous: previous.previous,
    summary: verified.summary,
    bytes: inspected.bytes,
    receipt: {
      pending: staged.pendingWrite.receiptLost ? 'receipt-lost' : 'written',
      archive: staged.archiveWrite.receiptLost ? 'receipt-lost' : 'written',
      wishlist: staged.wishlistWrite.receiptLost ? 'receipt-lost' : 'written',
      commit: staged.commitWrite.receiptLost ? 'receipt-lost' : 'written'
    }
  };
}

// ------------------------------------------------------------------ *
// 冷启动核对：只报告未提交的 stage，绝不自行选择新的当前代际
// ------------------------------------------------------------------ *

function recoverPending(options) {
  const layout = store.resolveLayout();
  if (!layout.ok) return emptyResult('layout-unreadable', layout.error);

  const pendingRead = readKeyText(store.BACKUP_PENDING_KEY);
  if (!pendingRead.ok) return emptyResult('pending-read-failed', pendingRead.error);
  if (!pendingRead.present) {
    return { ok: true, code: 'nothing-to-recover', error: '', action: 'none' };
  }
  const pending = parsePending(pendingRead.value);
  if (!pending) {
    return emptyResult('pending-broken', '恢复计划记录损坏，未做任何写入');
  }
  if (!layout.legacy) {
    if (layout.generation === pending.generation) {
      return { ok: true, code: 'already-committed', error: '', action: 'none' };
    }
    // 已有更新的提交：不覆盖较新的状态，也不删除旧计划。
    return { ok: true, code: 'pending-superseded', error: '', action: 'none' };
  }
  if (
    pending.previous.archiveKey !== layout.archiveKey ||
    pending.previous.wishlistKey !== layout.wishlistKey
  ) {
    return emptyResult('pending-mismatch', '恢复计划与当前旧档不一致，未做任何写入');
  }

  // 失败后用户可能已经继续记录了新内容。只有当前旧档仍与确认时的回执完全一致，
  // 才能自动补提交；否则保留较新的普通写入，交给用户重新确认。
  const currentArchive = readKeyText(layout.archiveKey);
  const currentWishlist = readKeyText(layout.wishlistKey);
  if (!currentArchive.ok || !currentWishlist.ok) {
    return emptyResult('pending-unreadable', '读取当前旧档失败，未做任何写入');
  }
  const sameAsPrevious = (read, present, bytes, checksum) => {
    if (read.present !== present) return false;
    if (!present) return true;
    return utf8Bytes(read.value) === bytes && hashText(read.value) === checksum;
  };
  if (
    !sameAsPrevious(
      currentArchive,
      pending.previous.archivePresent,
      pending.previous.archiveBytes,
      pending.previous.archiveChecksum
    ) ||
    !sameAsPrevious(
      currentWishlist,
      pending.previous.wishlistPresent,
      pending.previous.wishlistBytes,
      pending.previous.wishlistChecksum
    )
  ) {
    return {
      ok: true,
      code: 'pending-stale',
      error: '',
      action: 'none',
      note: '确认之后旧档又有了新的写入，未自动覆盖；如需恢复请重新确认'
    };
  }

  const archiveRead = readKeyText(pending.archiveKey);
  const wishlistRead = readKeyText(pending.wishlistKey);
  if (!archiveRead.ok || !wishlistRead.ok) {
    return emptyResult('pending-unreadable', '恢复原文读取失败，未做任何写入');
  }
  if (
    !archiveRead.present ||
    utf8Bytes(archiveRead.value) !== pending.archiveBytes ||
    hashText(archiveRead.value) !== pending.archiveChecksum ||
    !wishlistRead.present ||
    utf8Bytes(wishlistRead.value) !== pending.wishlistBytes ||
    hashText(wishlistRead.value) !== pending.wishlistChecksum
  ) {
    return emptyResult('pending-incomplete', '恢复原文不完整，未提交');
  }

  let archive;
  let wishlistDoc;
  try {
    archive = JSON.parse(archiveRead.value);
    wishlistDoc = JSON.parse(wishlistRead.value);
  } catch (error) {
    return emptyResult('pending-damaged', '恢复原文无法解析，未提交');
  }
  if (!isRecord(archive) || archive.archiveId !== pending.rebindArchiveId) {
    return emptyResult('pending-damaged', '恢复档案归属不一致，未提交');
  }
  const normalized = store.normalizeArchive(archive);
  if (!normalized || normalized.archiveId !== pending.rebindArchiveId) {
    return emptyResult('pending-damaged', '恢复档案结构不一致，未提交');
  }
  const training = trainingDocOf(normalized);
  const checkedTraining = validateTraining(training);
  if (!checkedTraining.ok) return checkedTraining;
  const checkedWishlist = validateWishlistDoc(
    wishlistDoc,
    pending.rebindArchiveId,
    checkedTraining.routesById
  );
  if (!checkedWishlist.ok) return checkedWishlist;

  // 冷启动只核对并报告，绝不替用户补写提交键：确认调用曾明确报告失败、或进程在
  // 提交点前中断时，用户还没有在失败之后重新确认。stage 原文保持不可见、原档继续
  // 可读，等待用户重新预演并显式确认（显式重试会复用同一代 stage）。
  return {
    ok: true,
    code: 'pending-staged',
    error: '',
    action: 'none',
    generation: pending.generation,
    rebindArchiveId: pending.rebindArchiveId,
    note: '确认恢复尚未写入提交记录，冷启动不会自动启用；如需恢复请重新预演并确认'
  };
}

// ------------------------------------------------------------------ *
// 受损诊断：保留当前与上一代原文的精确字节
// ------------------------------------------------------------------ *

function describeKey(key) {
  const read = readKeyText(key);
  if (!read.ok) {
    return { key, readFailed: true, present: false, error: read.error };
  }
  if (!read.present) {
    return {
      key,
      readFailed: false,
      present: false,
      bytes: 0,
      checksum: '',
      text: '',
      parseOk: true,
      parseError: ''
    };
  }
  let parseOk = true;
  let parseError = '';
  try {
    JSON.parse(read.value);
  } catch (error) {
    parseOk = false;
    parseError = errorText(error);
  }
  return {
    key,
    readFailed: false,
    present: true,
    bytes: utf8Bytes(read.value),
    checksum: hashText(read.value),
    text: read.value,
    parseOk,
    parseError
  };
}

/**
 * 导出当前与上一代（如果恢复过）的训练/清单原文。只读；不截断、不重排原文。
 */
function exportDiagnostics(options) {
  const data = options || {};
  const layout = store.resolveLayout();
  const doc = {
    format: DIAGNOSTICS_FORMAT,
    version: DIAGNOSTICS_VERSION,
    exportedAt: timestamp(data.now),
    contents: {
      includes: ['current.archive.text', 'current.wishlist.text', 'previous.archive.text', 'previous.wishlist.text'],
      excludes: EXCLUDED.slice()
    },
    layout: layout.ok
      ? {
          ok: true,
          code: layout.code,
          legacy: layout.legacy,
          generation: layout.generation,
          archiveKey: layout.archiveKey,
          wishlistKey: layout.wishlistKey
        }
      : { ok: false, code: layout.code, error: layout.error },
    current: null,
    previous: null
  };

  if (layout.ok) {
    doc.current = {
      archive: describeKey(layout.archiveKey),
      wishlist: describeKey(layout.wishlistKey)
    };
    if (!layout.legacy && layout.record && layout.record.previous) {
      doc.previous = {
        archive: describeKey(layout.record.previous.archiveKey),
        wishlist: describeKey(layout.record.previous.wishlistKey)
      };
    }
  } else {
    // 提交记录损坏时无法确定当前代际：把旧键原样附在 legacy 下，明确标注不是当前代际。
    doc.legacy = {
      archive: describeKey(store.ARCHIVE_KEY),
      wishlist: describeKey(store.WISHLIST_KEY)
    };
  }

  const text = JSON.stringify(doc);
  return {
    ok: true,
    code: 'diagnostics',
    error: '',
    text,
    bytes: utf8Bytes(text),
    layout: doc.layout,
    current: doc.current,
    previous: doc.previous,
    legacy: doc.legacy || null
  };
}

module.exports = {
  FORMAT,
  DIAGNOSTICS_FORMAT,
  BACKUP_VERSION,
  DIAGNOSTICS_VERSION,
  MAX_BACKUP_BYTES,
  MAX_ARCHIVE_BYTES,
  MAX_WISHLIST_BYTES,
  INCLUDED,
  EXCLUDED,
  ERROR,
  utf8Bytes,
  hashText,
  previewToken,
  validateTraining,
  validateWishlistDoc,
  validateAuxiliary,
  computeSummary,
  validateEnvelope,
  trainingDocOf,
  wishlistDocOf,
  auxiliaryOf,
  exportText,
  inspectText,
  confirmRestore,
  recoverPending,
  exportDiagnostics
};
