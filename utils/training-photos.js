/**
 * 正式记录版 · 线路主照片持久服务（仅本机，T019）
 *
 * 负责一条长期线路至多一张主照片的归属、持久文件、索引和失败恢复：
 * - 归属在操作启动时固定为“本机档案 ID + 稳定线路 ID”，档案 ID 来自 T016 本机档案；
 * - 主图先写入用户文件目录，再写索引；两步都成功才返回成功；
 * - 索引是受保护的用户资料，缩略图元数据是可重建缓存，分别使用专用键；
 * - 照片标识（photoId）与存储类型/位置分开保存，为以后迁移云端留出契约；
 * - 本模块不访问云、不读旧云记录，也不清除其他命名空间的数据。
 *
 * 数据版本与专用位置（正式本机命名空间，常量取自 utils/training-store.js）：
 *   climbingNote.training.v1.photos                   照片与归属索引（受保护）
 *   climbingNote.training.v1.thumbs.photos            缩略图元数据（可重建缓存）
 *   climbingNote.training.v1.photoCoordination.*      并发协调数据（租约/预留/删除声明）
 *   <USER_DATA_PATH>/training-photos/v1/<archiveId>/{main,thumb}/photo-<seq>.jpg
 *
 * 文件目录按本机档案分目录，因此“服务实例能看到的本目录文件”就等于“本档案的
 * 照片文件”。引用统计、孤儿清理、缩略图重建都只按当前档案的照片记录、进行中操作
 * 与在途预留判定；其他档案的同色线路、其他档案的索引与文件都不受影响。
 *
 * 并发与恢复约定：
 * - 运行期（runtime）与应用进程/小程序启动一一对应，模块加载时生成；同一运行期
 *   可以创建多个服务实例（不同页面、不同档案），它们共享同一个 runtimeId。
 *   运行期身份说明“这个 JS 上下文还活着”；单个服务实例的 instanceId 只用于区分实例。
 * - 模块级内存登记 RUNTIME_ACTIVITY 记录同一运行期内每个异步保存/重建/删除声明的
 *   开始与结束。持久记录只说明“某实例曾声明在做”，共享登记才说明“promise 还没结束”。
 *   因此同一运行期的新服务实例能区分仍在执行的 promise（保护）与已结束但终态/
 *   释放写回失败的残留（可恢复），不需要新增持久租约或依赖 TTL。
 * - recover() 立即中止其他运行期留下的 started 操作；同一运行期只有共享登记仍在的
 *   操作才保留。已结束但终态写回失败的操作、已结束但声明释放失败的删除/预留，
 *   由同运行期新实例在故障解除后回收并允许同 opId 重试。TTL 只用于没有 runtimeId
 *   的旧版协调数据。
 * - 任何会新增受管字节的路径（新增/更换/缩略图重建）在写入前必须先在
 *   photoReservations 键登记在途预留；预算检查计入“实际占用 + 先到预留 + 本次新增 + R”。
 *   预留按登记顺序（claimSeq）先到先得，后到者返回可恢复错误并可重试；预留随操作
 *   结束（提交/失败/中止）释放。释放写入失败时，下一次 claim/recover 按共享登记
 *   回收残留预留；同一 opId 重试视为新的尝试，会取代该 opId 的旧预留。
 *   若租约/预留协调数据无法可靠写入，保存会在动受管文件前安全失败。
 * - 删除声明确认“某个 photoId 的旧文件正在被异步删除”。保存/重试遇到声明时返回
 *   可重试忙状态，不写入或提交；维护操作在发出 unlink 前登记声明，并在异步边界后
 *   再次确认引用，避免旧 unlink 回调删掉后来提交的主图。声明释放写回失败时，
 *   共享登记已经结束，同运行期新实例可回收它；仍持有登记的活跃删除继续受保护。
 * - 维护操作（cleanupOrphans / clearRebuildableCache）在异步边界之后按最新索引、
 *   在途预留与删除声明重新确认引用关系，不用过期快照删除文件。
 *
 * 失败恢复入口：
 * - recover()：中止真正中断的旧操作、释放过期租约与预留，清理可证明无引用的文件；
 * - cleanupOrphans()：只清理 main/thumb 目录中不被照片记录、进行中操作或预留引用的文件。
 *
 * 本轮只实现 local 存储，不发起任何上传或云调用。
 */
const {
  isSafePhotoId,
  errorText
} = require('./training-photo-files.js');
const {
  PHOTO_SPACE_POLICY,
  createPhotoSpaceMeter,
  isSpaceError
} = require('./training-photo-space.js');
const { NAMESPACE, PHOTO_INDEX_KEY } = require('./training-store.js');

const INDEX_KEY = PHOTO_INDEX_KEY;
const THUMB_CACHE_KEY = NAMESPACE + 'thumbs.photos';
// 活跃实例租约与在途字节预留都是可重建的协调数据，不参与照片身份；
// 单独成键，避免把易变的并发状态写进受保护的照片索引。
const INSTANCE_KEY = NAMESPACE + 'photoCoordination.instances';
const RESERVATION_KEY = NAMESPACE + 'photoCoordination.reservations';
const DELETION_KEY = NAMESPACE + 'photoCoordination.deletes';
const INDEX_VERSION = 1;
const THUMB_CACHE_VERSION = 1;
const INSTANCE_LEASE_VERSION = 1;
const RESERVATION_VERSION = 1;
const DELETION_VERSION = 1;
// 租约过期时间只用于没有运行期标识的旧版协调数据；同一运行期的实例不靠它判死。
const INSTANCE_TTL_MS = 5 * 60 * 1000;
// 模块加载即代表一次新的 JS 运行期；重新启动小程序/进程会得到新的 runtimeId。
// 同一运行期内的多个服务实例共享它，便于区分“实例”和“运行期是否已重启”。
const RUNTIME_ID =
  'photo-runtime-' +
  Date.now().toString(36) +
  '-' +
  Math.random().toString(36).slice(2, 10);

/**
 * 同一 JS 运行期内所有服务实例共享的“真实执行中”登记（仅内存，不持久化）。
 *
 * 持久记录（started 操作、预留、删除声明）只说明某个实例“曾声明要做”；
 * 这里的登记才说明该实例在本次运行期里对应的异步操作“还没有结束”。
 * 因此同一运行期的新服务实例可以区分：
 * - 登记仍在：原实例的 promise 仍活跃（含长 await/后台暂停），必须保护；
 * - 登记已消失：原 promise 已经结束，只是终态/释放写回失败，可以安全恢复。
 * 进程/小程序重启后登记随模块一起消失，与新的 runtimeId 共同证明旧操作已中断。
 *
 * 键包含运行期与实例标识，不同运行期、不同实例（含其他 owner/dataset）
 * 不会互相释放；不同存储实例只要实例标识不同也互不影响。
 */
const RUNTIME_ACTIVITY = {
  operations: new Map(),
  reservations: new Map(),
  deletions: new Map()
};

function activityKey(kind, runtimeId, instanceId, rest) {
  return JSON.stringify(
    [kind, runtimeId, instanceId].concat(rest || [])
  );
}
const LOCAL_STORAGE_TYPE = 'local';
const OPERATION_KINDS = ['add', 'replace', 'remove'];
const OPERATION_STATUSES = ['started', 'committed', 'failed', 'aborted'];

// 300–800 KB 是压缩试验目标，不是已核验的硬上限；不据此拒绝保存。
const PHOTO_POLICY = {
  mainMaxEdge: 2048,
  mainQuality: 80,
  thumbMaxEdge: 320,
  thumbQuality: 70,
  // 300–800 KB 是压缩试验目标，不是已核验的硬上限；不据此拒绝保存。
  mainTargetBytes: {
    min: 300 * 1024,
    max: 800 * 1024
  }
};

const ERROR_TEXT = {
  'missing-archive': '缺少本机档案标识（archiveId），不能读写线路照片',
  'missing-route': '缺少稳定线路标识（routeId）',
  'missing-source': '缺少照片来源文件',
  'invalid-photo-id': '照片标识无效',
  'invalid-op-id': '照片操作标识无效',
  'index-read-failed': '读取照片索引失败',
  'index-broken': '照片索引格式损坏；为保护已保存照片，未自动重建',
  'index-write-failed': '照片索引写入失败',
  'source-unreadable': '读取照片尺寸失败',
  'compress-failed': '照片压缩失败',
  'file-write-failed': '照片文件写入失败',
  'thumbnail-failed': '缩略图生成失败',
  'coordination-failed':
    '照片并发协调数据写入失败，已停止写入并保留原有照片',
  'cleanup-in-progress': '照片文件正在清理，请稍后重试',
  'space-insufficient':
    '本机照片空间不足，旧照片和记录已保留；请清理可重建缓存或管理照片后重试',
  'space-measure-failed': '读取照片实际占用失败，为保护已保存照片未继续写入',
  'no-photo': '该线路还没有照片',
  'already-has-photo': '该线路已有主照片，请使用更换',
  'operation-in-progress': '同一照片操作正在进行或未完成，请稍后重试',
  'operation-mismatch': '该操作 ID 已用于其他照片操作',
  'stale-operation': '该照片操作已被更新的操作取代，未写入',
  'missing-file': '本机照片不可用，可重新添加',
  'not-found': '没有找到该照片',
  'photo-record-missing': '照片索引与线路关联不一致，请重新添加照片，或在个人页重置本机档案',
  'file-delete-failed': '照片文件删除失败',
  unexpected: '照片操作出现未预期错误'
};

const NON_RECOVERABLE = new Set([
  'missing-archive',
  'missing-route',
  'missing-source',
  'invalid-photo-id',
  'invalid-op-id',
  'not-found',
  'no-photo',
  'already-has-photo',
  'operation-mismatch'
]);

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasVisibleText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSeq(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function routeKey(archiveId, routeId) {
  return JSON.stringify([archiveId, routeId]);
}

function isScope(record) {
  return (
    record &&
    hasText(record.archiveId) &&
    hasText(record.routeId)
  );
}

function makeInstanceId() {
  return (
    'photo-svc-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

function createEmptyIndex() {
  return {
    version: INDEX_VERSION,
    nextPhotoSeq: 1,
    nextOpSeq: 1,
    routes: [],
    photos: [],
    operations: []
  };
}

function createEmptyThumbCache() {
  return { version: THUMB_CACHE_VERSION, items: [] };
}

function photoSeqOf(photoId) {
  const match = /^photo-(\d+)$/.exec(
    typeof photoId === 'string' ? photoId : ''
  );
  return match ? Number(match[1]) : 0;
}

/**
 * 只接受当前版本、结构完整且引用自洽的索引。损坏时返回 null，
 * 由调用方返回可识别错误；不自动重建，避免把已保存照片当成没发生。
 */
function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== INDEX_VERSION) return null;
  if (!isSeq(raw.nextPhotoSeq) || !isSeq(raw.nextOpSeq)) return null;
  if (
    !Array.isArray(raw.routes) ||
    !Array.isArray(raw.photos) ||
    !Array.isArray(raw.operations)
  ) {
    return null;
  }

  const routeKeys = new Set();
  for (const route of raw.routes) {
    if (!isScope(route)) return null;
    if (typeof route.photoId !== 'string') return null;
    if (route.photoId && !isSafePhotoId(route.photoId)) return null;
    if (!isNonNegativeInt(route.rev) || !isNonNegativeInt(route.activeOpSeq)) {
      return null;
    }
    const key = routeKey(route.archiveId, route.routeId);
    if (routeKeys.has(key)) return null;
    routeKeys.add(key);
  }

  const photoIds = new Set();
  const photoByRoute = new Map();
  let maxPhotoSeq = 0;
  for (const photo of raw.photos) {
    if (!photo || !isSafePhotoId(photo.photoId)) return null;
    if (!isScope(photo)) return null;
    if (
      !photo.storage ||
      photo.storage.type !== LOCAL_STORAGE_TYPE ||
      !hasText(photo.storage.location)
    ) {
      return null;
    }
    if (
      !photo.bytes ||
      !isNonNegativeNumber(photo.bytes.main) ||
      !isNonNegativeNumber(photo.bytes.thumb)
    ) {
      return null;
    }
    if (!isSeq(photo.width) || !isSeq(photo.height)) return null;
    if (!hasText(photo.createdAt)) return null;
    if (photoIds.has(photo.photoId)) return null;
    photoIds.add(photo.photoId);
    maxPhotoSeq = Math.max(maxPhotoSeq, photoSeqOf(photo.photoId));
    const key = routeKey(photo.archiveId, photo.routeId);
    if (!routeKeys.has(key)) return null;
    photoByRoute.set(key, photo.photoId);
  }
  if (raw.nextPhotoSeq <= maxPhotoSeq) return null;

  for (const route of raw.routes) {
    if (!route.photoId) continue;
    const key = routeKey(route.archiveId, route.routeId);
    if (photoByRoute.get(key) !== route.photoId) return null;
  }

  const operationKeys = new Set();
  let maxOpSeq = 0;
  for (const operation of raw.operations) {
    if (!operation || !hasText(operation.opId)) return null;
    if (!isSeq(operation.seq)) return null;
    if (!hasText(operation.instanceId)) return null;
    // runtimeId 为第二轮返工新增；旧版索引没有该字段仍可读，由 recover()
    // 按旧租约规则处理，不因为升级索引而丢掉已保存照片。
    if (
      operation.runtimeId !== undefined &&
      typeof operation.runtimeId !== 'string'
    ) {
      return null;
    }
    if (!isScope(operation)) return null;
    if (!OPERATION_KINDS.includes(operation.kind)) return null;
    if (!OPERATION_STATUSES.includes(operation.status)) return null;
    if (typeof operation.photoId !== 'string') return null;
    if (operation.photoId && !isSafePhotoId(operation.photoId)) return null;
    if (typeof operation.basePhotoId !== 'string') return null;
    if (
      operation.basePhotoId &&
      !isSafePhotoId(operation.basePhotoId)
    ) {
      return null;
    }
    if (!isNonNegativeInt(operation.baseRev)) return null;
    if (!hasText(operation.startedAt)) return null;
    if (typeof operation.finishedAt !== 'string') return null;
    if (typeof operation.error !== 'string') return null;
    const key = JSON.stringify([operation.archiveId, operation.opId]);
    if (operationKeys.has(key)) return null;
    operationKeys.add(key);
    maxOpSeq = Math.max(maxOpSeq, operation.seq);
  }
  if (raw.nextOpSeq <= maxOpSeq) return null;

  return {
    version: INDEX_VERSION,
    nextPhotoSeq: raw.nextPhotoSeq,
    nextOpSeq: raw.nextOpSeq,
    routes: raw.routes,
    photos: raw.photos,
    operations: raw.operations
  };
}

function normalizeThumbCache(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== THUMB_CACHE_VERSION ||
    !Array.isArray(raw.items)
  ) {
    return createEmptyThumbCache();
  }
  const seen = new Set();
  const items = [];
  for (const item of raw.items) {
    if (!item || !isSafePhotoId(item.photoId)) continue;
    if (!hasText(item.location) || !isNonNegativeNumber(item.bytes)) continue;
    if (seen.has(item.photoId)) continue;
    seen.add(item.photoId);
    items.push(item);
  }
  return { version: THUMB_CACHE_VERSION, items };
}

function createEmptyLeases() {
  return { version: INSTANCE_LEASE_VERSION, instances: [] };
}

/**
 * 只接受结构完整的活跃实例租约；损坏时按“没有活跃实例”处理，
 * 因为租约只是可重建的协调数据，宁可让 recover() 保守地恢复遗留操作。
 */
function normalizeLeases(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== INSTANCE_LEASE_VERSION ||
    !Array.isArray(raw.instances)
  ) {
    return createEmptyLeases();
  }
  const seen = new Set();
  const instances = [];
  for (const item of raw.instances) {
    if (!item || !hasText(item.instanceId)) continue;
    if (!isNonNegativeNumber(item.heartbeatMs)) continue;
    if (seen.has(item.instanceId)) continue;
    seen.add(item.instanceId);
    instances.push({
      instanceId: item.instanceId,
      runtimeId: hasText(item.runtimeId) ? item.runtimeId : '',
      archiveId: hasText(item.archiveId) ? item.archiveId : '',
      heartbeatAt: hasText(item.heartbeatAt) ? item.heartbeatAt : '',
      heartbeatMs: item.heartbeatMs
    });
  }
  return { version: INSTANCE_LEASE_VERSION, instances };
}

function createEmptyReservations() {
  return { version: RESERVATION_VERSION, nextClaimSeq: 1, items: [] };
}

function normalizeReservations(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== RESERVATION_VERSION ||
    !Array.isArray(raw.items)
  ) {
    return createEmptyReservations();
  }
  const seen = new Set();
  const items = [];
  let maxClaimSeq = 0;
  for (const item of raw.items) {
    if (!item || !hasText(item.reservationId)) continue;
    if (!hasText(item.instanceId)) continue;
    if (!isNonNegativeInt(item.bytes)) continue;
    if (!isSeq(item.claimSeq)) continue;
    if (seen.has(item.reservationId)) continue;
    seen.add(item.reservationId);
    maxClaimSeq = Math.max(maxClaimSeq, item.claimSeq);
    items.push({
      reservationId: item.reservationId,
      instanceId: item.instanceId,
      runtimeId: hasText(item.runtimeId) ? item.runtimeId : '',
      archiveId: hasText(item.archiveId) ? item.archiveId : '',
      photoId: isSafePhotoId(item.photoId) ? item.photoId : '',
      opId: hasText(item.opId) ? item.opId : '',
      kind: hasText(item.kind) ? item.kind : '',
      bytes: item.bytes,
      claimSeq: item.claimSeq,
      startedAt: hasText(item.startedAt) ? item.startedAt : ''
    });
  }
  const nextClaimSeq = isSeq(raw.nextClaimSeq) && raw.nextClaimSeq > maxClaimSeq
    ? raw.nextClaimSeq
    : maxClaimSeq + 1;
  return { version: RESERVATION_VERSION, nextClaimSeq, items };
}

function createEmptyDeletions() {
  return { version: DELETION_VERSION, nextClaimSeq: 1, items: [] };
}

function normalizeDeletions(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== DELETION_VERSION ||
    !Array.isArray(raw.items)
  ) {
    return createEmptyDeletions();
  }
  const seen = new Set();
  const items = [];
  let maxClaimSeq = 0;
  for (const item of raw.items) {
    if (!item || !hasText(item.claimId)) continue;
    if (!hasText(item.instanceId)) continue;
    if (!isSafePhotoId(item.photoId)) continue;
    if (!isSeq(item.claimSeq)) continue;
    if (seen.has(item.claimId)) continue;
    seen.add(item.claimId);
    maxClaimSeq = Math.max(maxClaimSeq, item.claimSeq);
    items.push({
      claimId: item.claimId,
      instanceId: item.instanceId,
      runtimeId: hasText(item.runtimeId) ? item.runtimeId : '',
      archiveId: hasText(item.archiveId) ? item.archiveId : '',
      photoId: item.photoId,
      claimSeq: item.claimSeq,
      startedAt: hasText(item.startedAt) ? item.startedAt : ''
    });
  }
  const nextClaimSeq =
    isSeq(raw.nextClaimSeq) && raw.nextClaimSeq > maxClaimSeq
      ? raw.nextClaimSeq
      : maxClaimSeq + 1;
  return { version: DELETION_VERSION, nextClaimSeq, items };
}

// 文件名 → photoId：只接受本服务命名空间里的 photo-<seq>.jpg 形态。
function photoIdFromFileName(name) {
  const match = /^(photo-[A-Za-z0-9_-]+)\.(?:jpg|jpeg|png)$/i.exec(
    typeof name === 'string' ? name : ''
  );
  return match ? match[1] : '';
}

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
    // 只删除指定缓存键；不使用全局清空接口，也不碰其他命名空间。
    remove(key) {
      if (!api) throw new Error('微信存储不可用');
      if (typeof api.removeStorageSync === 'function') {
        api.removeStorageSync(key);
        return;
      }
      api.setStorageSync(key, '');
    }
  };
}

function fail(code, detail, extra) {
  const base = ERROR_TEXT[code] || ERROR_TEXT.unexpected;
  let message = base;
  if (detail) {
    message = detail.indexOf(base) === 0 ? detail : base + '：' + detail;
  }
  const result = {
    ok: false,
    code,
    error: message,
    recoverable: !NON_RECOVERABLE.has(code)
  };
  return Object.assign(result, extra || {});
}

function createTrainingPhotoService(options) {
  const config = options || {};
  const archiveId =
    typeof config.archiveId === 'string' ? config.archiveId : '';
  const files = config.files;
  const storage = config.storage || createWxStorage(config.wxApi);
  const now =
    typeof config.now === 'function'
      ? config.now
      : () => new Date().toISOString();
  const instanceId = hasText(config.instanceId)
    ? config.instanceId
    : makeInstanceId();
  // 运行期身份默认取模块加载时生成的标识；测试或宿主可显式注入，
  // 模拟“新的小程序运行期/新进程”，但新服务实例本身不代表新运行期。
  const runtimeId = hasText(config.runtimeId) ? config.runtimeId : RUNTIME_ID;
  // 活跃实例租约的过期时间；测试可注入较小值来构造“真正中断”的遗留操作。
  const instanceTtlMs = isNonNegativeInt(config.instanceTtlMs)
    ? config.instanceTtlMs
    : INSTANCE_TTL_MS;
  const policy = Object.assign({}, PHOTO_POLICY, config.policy || {});
  const spaceMeter = createPhotoSpaceMeter({
    files,
    policy: config.space || PHOTO_SPACE_POLICY
  });
  const spacePolicy = spaceMeter.policy;

  // 本运行期共享登记中属于“某个真实异步操作/预留/删除声明”的键。
  // 登记只在对象开始后写入、在对应 promise 的 finally 结束路径移除；移除后即使
  // 持久状态因故障未写回，同运行期的其他实例也能把它当作已结束的残留回收。
  function operationActivityKey(operation) {
    return activityKey(
      'operation',
      operation.runtimeId || runtimeId,
      operation.instanceId || instanceId,
      [operation.archiveId || archiveId, operation.opId, operation.seq]
    );
  }

  function operationTokenLive(operation) {
    if (!operation || operation.runtimeId !== runtimeId) return false;
    return RUNTIME_ACTIVITY.operations.has(operationActivityKey(operation));
  }

  function beginOperationToken(operation) {
    RUNTIME_ACTIVITY.operations.set(
      operationActivityKey(operation),
      true
    );
  }

  function endOperationToken(operation) {
    RUNTIME_ACTIVITY.operations.delete(operationActivityKey(operation));
  }

  function reservationActivityKey(item) {
    return activityKey(
      'reservation',
      item.runtimeId || runtimeId,
      item.instanceId || instanceId,
      [item.reservationId]
    );
  }

  function deletionActivityKey(item) {
    return activityKey(
      'deletion',
      item.runtimeId || runtimeId,
      item.instanceId || instanceId,
      [item.claimId]
    );
  }

  function attributionError() {
    if (!hasVisibleText(archiveId)) return fail('missing-archive');
    if (!files) {
      return fail('unexpected', '缺少照片文件适配器');
    }
    return null;
  }

  function loadIndex() {
    let raw;
    try {
      raw = storage.get(INDEX_KEY);
    } catch (error) {
      return fail('index-read-failed', errorText(error));
    }
    if (raw === '' || raw === null || raw === undefined) {
      return { ok: true, index: createEmptyIndex() };
    }
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return fail('index-broken');
    }
    const index = normalizeIndex(parsed);
    if (!index) return fail('index-broken');
    return { ok: true, index };
  }

  function saveIndex(index) {
    try {
      storage.set(INDEX_KEY, JSON.stringify(index));
      return { ok: true };
    } catch (error) {
      return fail('index-write-failed', errorText(error));
    }
  }

  function loadThumbCache() {
    let raw;
    try {
      raw = storage.get(THUMB_CACHE_KEY);
    } catch (error) {
      return createEmptyThumbCache();
    }
    if (raw === '' || raw === null || raw === undefined) {
      return createEmptyThumbCache();
    }
    try {
      return normalizeThumbCache(
        typeof raw === 'string' ? JSON.parse(raw) : raw
      );
    } catch (error) {
      return createEmptyThumbCache();
    }
  }

  function saveThumbCache(cache) {
    try {
      storage.set(THUMB_CACHE_KEY, JSON.stringify(cache));
      return true;
    } catch (error) {
      // 缩略图元数据可重建，写失败不影响主照片和索引。
      return false;
    }
  }

  /**
   * 删除一个可重建的协调键。适配器没有 remove 时退回写入空串，
   * 与缩略图缓存清理的既有做法一致（读取方把空串当成“不存在”）。
   */
  function removeCoordinationKey(key) {
    try {
      if (typeof storage.remove === 'function') {
        storage.remove(key);
      } else {
        storage.set(key, '');
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // ---- 活跃实例租约/运行期：区分同一运行期的活跃实例与真正中断的遗留操作 ----

  function currentTimeMs() {
    const parsed = Date.parse(now());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function loadLeases() {
    let raw;
    try {
      raw = storage.get(INSTANCE_KEY);
    } catch (error) {
      return createEmptyLeases();
    }
    if (raw === '' || raw === null || raw === undefined) {
      return createEmptyLeases();
    }
    try {
      return normalizeLeases(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (error) {
      return createEmptyLeases();
    }
  }

  function leaseMapOf(leases) {
    const map = new Map();
    for (const item of leases.instances) map.set(item.instanceId, item);
    return map;
  }

  function saveLeases(instances) {
    try {
      storage.set(
        INSTANCE_KEY,
        JSON.stringify({ version: INSTANCE_LEASE_VERSION, instances })
      );
      return true;
    } catch (error) {
      // 租约是可重建的协调数据；写失败意味着无法向其他实例证明本实例活跃，
      // 调用方必须在本实例动受管文件前安全失败，而不是继续写入后被当成孤儿。
      return false;
    }
  }

  function isLeaseFresh(item, timeMs) {
    if (!item || !isNonNegativeNumber(item.heartbeatMs)) return false;
    return item.heartbeatMs + instanceTtlMs >= timeMs;
  }

  /**
   * 同一运行期的租约始终视为存活：租约时间只说明“多久没刷新”，不能证明
   * 回调已死（后台暂停、长 await 都会超过 TTL）。旧版没有 runtimeId 的租约
   * 仍按 TTL 判断，保证升级前的协调数据可恢复。其他运行期已被新运行期取代。
   */
  function isLeaseProtected(item, timeMs) {
    if (!item) return false;
    if (item.runtimeId === runtimeId) return true;
    if (hasText(item.runtimeId)) return false;
    return isLeaseFresh(item, timeMs);
  }

  /**
   * 刷新本实例的租约。只在真正要动受管文件/索引的操作前调用；
   * 返回值必须被检查：写不进去就不允许继续危险写入。
   */
  function touchInstance() {
    const timeMs = currentTimeMs();
    const leases = loadLeases();
    const kept = leases.instances.filter(
      item => item.instanceId !== instanceId && isLeaseProtected(item, timeMs)
    );
    kept.push({
      instanceId,
      runtimeId,
      archiveId,
      heartbeatAt: now(),
      heartbeatMs: timeMs
    });
    return saveLeases(kept);
  }

  /** 丢弃已被取代的租约，返回是否发生了写入。 */
  function pruneLeases(timeMs) {
    const leases = loadLeases();
    const kept = leases.instances.filter(item => isLeaseProtected(item, timeMs));
    if (kept.length === leases.instances.length) return false;
    if (kept.length === 0) return removeCoordinationKey(INSTANCE_KEY);
    return saveLeases(kept);
  }

  // ---- 在途字节预留：让并发的新增/更换/重建共享同一份已预留预算 ----

  function readReservations() {
    let raw;
    try {
      raw = storage.get(RESERVATION_KEY);
    } catch (error) {
      return {
        ok: false,
        error: '读取照片空间预留失败：' + errorText(error)
      };
    }
    if (raw === '' || raw === null || raw === undefined) {
      return { ok: true, state: createEmptyReservations() };
    }
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: '照片空间预留格式不可读' };
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== RESERVATION_VERSION
    ) {
      return { ok: false, error: '照片空间预留格式不可读' };
    }
    return { ok: true, state: normalizeReservations(parsed) };
  }

  function saveReservations(state) {
    try {
      storage.set(RESERVATION_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  function findOperationForReservation(index, item) {
    if (!hasText(item.opId)) return null;
    return (
      index.operations.find(
        operation =>
          operation.opId === item.opId &&
          operation.archiveId === item.archiveId
      ) || null
    );
  }

  /**
   * 一笔预留是否仍然代表“正在进行的写入”。
   * - 有 opId：只跟随该操作的 started 状态；失败/中止/提交后的残留一律可回收，
   *   即使释放协调键的写入曾经失败。
   * - 重建缩略图没有操作记录：同一运行期以共享登记为准——登记仍在说明对应实例
   *   尚未结束，登记已消失说明释放写回失败但写入已经结束，可以回收。其他运行期
   *   或旧版过期数据按租约/版本判断。
   */
  function reservationStillNeeded(item, index, timeMs, leaseMap) {
    if (hasText(item.opId)) {
      const operation = findOperationForReservation(index, item);
      return Boolean(operation && operation.status === 'started');
    }
    if (item.runtimeId === runtimeId) {
      return RUNTIME_ACTIVITY.reservations.has(reservationActivityKey(item));
    }
    if (hasText(item.runtimeId)) return false;
    return isLeaseFresh(leaseMap.get(item.instanceId), timeMs);
  }

  function liveReservationItems(state, index, timeMs, leaseMap) {
    return state.items.filter(item =>
      reservationStillNeeded(item, index, timeMs, leaseMap)
    );
  }

  /**
   * 同步登记一笔预留（读—改—写之间没有 await，同一实例内不会交错）。
   * 登记前先回收已终止操作的残留预留；返回 priorReservedBytes：
   * 登记顺序更早的预留合计，用于“先到先得”的预算检查。
   * 同一 opId 的新尝试会取代该 opId 的旧预留（上一次失败/崩溃留下的）。
   */
  function claimReservation(input) {
    const bytes = isNonNegativeInt(input.bytes) ? input.bytes : 0;
    const read = readReservations();
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    const loaded = loadIndex();
    if (!loaded.ok) {
      return {
        ok: false,
        error: '读取照片索引失败，无法确认在途预留：' + loaded.error
      };
    }
    const timeMs = currentTimeMs();
    const leaseMap = leaseMapOf(loadLeases());
    const state = read.state;
    const kept = liveReservationItems(
      state,
      loaded.index,
      timeMs,
      leaseMap
    ).filter(
      item =>
        !(
          hasText(input.opId) &&
          item.opId === input.opId &&
          item.archiveId === archiveId
        )
    );
    const claimSeq = state.nextClaimSeq;
    let priorReservedBytes = 0;
    for (const item of kept) {
      if (item.claimSeq < claimSeq) priorReservedBytes += item.bytes;
    }
    const reservationId =
      'photo-res-' + claimSeq + '-' + Math.random().toString(36).slice(2, 8);
    const items = kept.concat([
      {
        reservationId,
        instanceId,
        runtimeId,
        archiveId,
        photoId: isSafePhotoId(input.photoId) ? input.photoId : '',
        opId: hasText(input.opId) ? input.opId : '',
        kind: hasText(input.kind) ? input.kind : '',
        bytes,
        claimSeq,
        startedAt: now()
      }
    ]);
    const saved = saveReservations({
      version: RESERVATION_VERSION,
      nextClaimSeq: claimSeq + 1,
      items
    });
    if (!saved) {
      return { ok: false, error: '无法登记照片空间预留' };
    }
    const claimed = {
      reservationId,
      instanceId,
      runtimeId
    };
    RUNTIME_ACTIVITY.reservations.set(
      reservationActivityKey(claimed),
      true
    );
    return { ok: true, reservationId, priorReservedBytes, claimSeq, bytes };
  }

  function releaseReservation(reservationId) {
    if (!hasText(reservationId)) return true;
    // 先结束本运行期登记，再尝试持久化释放；写回失败时残留可由下一次
    // claim/recover 按“登记已消失”回收，而不是永久占用预算。
    RUNTIME_ACTIVITY.reservations.delete(
      reservationActivityKey({ reservationId, instanceId, runtimeId })
    );
    const read = readReservations();
    if (!read.ok) return false;
    const state = read.state;
    const items = state.items.filter(
      item => item.reservationId !== reservationId
    );
    if (items.length === state.items.length) return true;
    if (items.length === 0) return removeCoordinationKey(RESERVATION_KEY);
    return saveReservations({
      version: RESERVATION_VERSION,
      nextClaimSeq: state.nextClaimSeq,
      items
    });
  }

  /**
   * 回收已终止操作/已结束实例留下的预留。恢复入口和下一次登记都会调用，
   * 因此“释放协调键写失败”留下的残留在故障解除后仍可被清理。
   */
  function pruneStaleReservations(index) {
    const read = readReservations();
    if (!read.ok) return { ok: false, error: read.error };
    const timeMs = currentTimeMs();
    const leaseMap = leaseMapOf(loadLeases());
    const items = liveReservationItems(read.state, index, timeMs, leaseMap);
    if (items.length === read.state.items.length) {
      return { ok: true, pruned: 0 };
    }
    if (items.length === 0) {
      const removed = removeCoordinationKey(RESERVATION_KEY);
      return removed
        ? { ok: true, pruned: read.state.items.length }
        : { ok: false, error: '清理照片空间预留失败' };
    }
    const saved = saveReservations({
      version: RESERVATION_VERSION,
      nextClaimSeq: read.state.nextClaimSeq,
      items
    });
    return saved
      ? { ok: true, pruned: read.state.items.length - items.length }
      : { ok: false, error: '清理照片空间预留失败' };
  }

  function reservedPhotoIds() {
    const read = readReservations();
    if (!read.ok) return [];
    return read.state.items
      .filter(item => item.archiveId === archiveId)
      .map(item => item.photoId)
      .filter(photoId => Boolean(photoId));
  }

  /**
   * 是否有本操作之外的在途预留引用该照片。
   * 读取失败时保守返回 true：无法证明没有其他写入时不动文件。
   */
  function hasOtherReservationForPhoto(photoId, exceptOpId) {
    const read = readReservations();
    if (!read.ok) return true;
    return read.state.items.some(
      item =>
        item.photoId === photoId &&
        (!hasText(exceptOpId) || item.opId !== exceptOpId)
    );
  }

  // ---- 文件删除声明：封锁“异步 unlink 回调”与“同 photoId 重试”的竞争 ----

  function readDeletions() {
    let raw;
    try {
      raw = storage.get(DELETION_KEY);
    } catch (error) {
      return {
        ok: false,
        error: '读取照片文件删除声明失败：' + errorText(error)
      };
    }
    if (raw === '' || raw === null || raw === undefined) {
      return { ok: true, state: createEmptyDeletions() };
    }
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: '照片文件删除声明格式不可读' };
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== DELETION_VERSION
    ) {
      return { ok: false, error: '照片文件删除声明格式不可读' };
    }
    return { ok: true, state: normalizeDeletions(parsed) };
  }

  function saveDeletions(state) {
    try {
      storage.set(DELETION_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 声明是否仍由存活的异步删除持有。同一运行期以共享登记为准：
   * 登记仍在说明对应实例的 unlink promise 尚未结束（可能是真实进行中的删除）；
   * 登记已消失说明 promise 已结束、只是释放写回失败，声明可以回收。
   * 其他运行期随进程/小程序重启结束，其遗留声明可以立即回收。
   */
  function deletionStillHeld(item) {
    if (item.runtimeId !== runtimeId) return false;
    return RUNTIME_ACTIVITY.deletions.has(deletionActivityKey(item));
  }

  function persistPrunedDeletions(state, items) {
    if (items.length === state.items.length) return true;
    if (items.length === 0) return removeCoordinationKey(DELETION_KEY);
    return saveDeletions({
      version: DELETION_VERSION,
      nextClaimSeq: state.nextClaimSeq,
      items
    });
  }

  /** 该照片是否有进行中的删除声明；读取失败时按“有声明”安全阻塞写入。 */
  function deletionBlocksPhoto(photoId) {
    const read = readDeletions();
    if (!read.ok) return true;
    const kept = read.state.items.filter(deletionStillHeld);
    persistPrunedDeletions(read.state, kept);
    return kept.some(item => item.photoId === photoId);
  }

  /**
   * 登记“我要删除这个 photoId 的旧文件”。失败时调用方不得删除；
   * 已有同一照片的声明时返回 busy，交给现有清理/重试流程收尾。
   */
  function beginDeletion(photoId) {
    const read = readDeletions();
    if (!read.ok) return { ok: false, error: read.error };
    const state = read.state;
    const kept = state.items.filter(deletionStillHeld);
    if (kept.some(item => item.photoId === photoId)) {
      persistPrunedDeletions(state, kept);
      return { ok: false, busy: true, error: '该照片文件正在清理' };
    }
    const claimSeq = state.nextClaimSeq;
    const claimId =
      'photo-del-' + claimSeq + '-' + Math.random().toString(36).slice(2, 8);
    const items = kept.concat([
      {
        claimId,
        instanceId,
        runtimeId,
        archiveId,
        photoId,
        claimSeq,
        startedAt: now()
      }
    ]);
    const saved = saveDeletions({
      version: DELETION_VERSION,
      nextClaimSeq: claimSeq + 1,
      items
    });
    if (!saved) {
      return { ok: false, error: '无法登记照片文件删除声明' };
    }
    RUNTIME_ACTIVITY.deletions.set(
      deletionActivityKey({
        claimId,
        instanceId,
        runtimeId
      }),
      true
    );
    return { ok: true, claimId };
  }

  function endDeletion(claimId) {
    if (!hasText(claimId)) return true;
    // 先结束登记再写持久释放：unlink 已经结束，写回失败留下的声明属于可回收
    // 残留，不能继续阻塞同运行期其他实例或同 opId 重试。
    RUNTIME_ACTIVITY.deletions.delete(
      deletionActivityKey({ claimId, instanceId, runtimeId })
    );
    const read = readDeletions();
    if (!read.ok) return false;
    const items = read.state.items.filter(item => item.claimId !== claimId);
    if (items.length === read.state.items.length) return true;
    if (items.length === 0) return removeCoordinationKey(DELETION_KEY);
    return saveDeletions({
      version: DELETION_VERSION,
      nextClaimSeq: read.state.nextClaimSeq,
      items
    });
  }

  function pruneDeletions() {
    const read = readDeletions();
    if (!read.ok) return false;
    return persistPrunedDeletions(
      read.state,
      read.state.items.filter(deletionStillHeld)
    );
  }

  /**
   * 需要受预算约束的一次受管写入：先证明本实例仍活跃、确认没有进行中的删除，
   * 再登记预留，最后按“实际占用 + 先到预留 + 本次新增 + R”检查峰值。
   * 调用方必须在 finally 中释放预留。
   */
  async function reserveForWrite(input) {
    if (!touchInstance()) {
      return {
        ok: false,
        code: 'coordination-failed',
        error: '无法写入照片实例租约；为避免其他实例把本次写入当成孤儿，已停止写入'
      };
    }
    if (deletionBlocksPhoto(input.photoId)) {
      return {
        ok: false,
        code: 'cleanup-in-progress',
        error: '该照片文件正在清理或清理声明不可读，请稍后重试'
      };
    }
    const claim = claimReservation({
      photoId: input.photoId,
      opId: input.opId,
      kind: input.kind,
      bytes: input.bytes
    });
    if (!claim.ok) {
      return { ok: false, code: 'space-measure-failed', error: claim.error };
    }
    const loaded = loadIndex();
    if (!loaded.ok) {
      releaseReservation(claim.reservationId);
      return loaded;
    }
    const measured = await measureIndex(loaded.index);
    if (!measured.ok) {
      releaseReservation(claim.reservationId);
      return measured;
    }
    const spaceCheck = spaceMeter.checkSave(
      measured.totalBytes + claim.priorReservedBytes,
      input.mainBytes || 0,
      input.thumbBytes || 0
    );
    if (!spaceCheck.ok) {
      releaseReservation(claim.reservationId);
      return {
        ok: false,
        code: 'space-insufficient',
        spaceCheck,
        measured
      };
    }
    return { ok: true, claim, measured, spaceCheck };
  }

  function findRoute(index, routeId) {
    return index.routes.find(
      route =>
        route.archiveId === archiveId &&
        route.routeId === routeId
    );
  }

  function ensureRoute(index, routeId) {
    let route = findRoute(index, routeId);
    if (route) return route;
    route = {
      archiveId,
      routeId,
      photoId: '',
      rev: 0,
      activeOpSeq: 0
    };
    index.routes.push(route);
    return route;
  }

  function findPhoto(index, photoId) {
    return index.photos.find(
      photo =>
        photo.photoId === photoId &&
        photo.archiveId === archiveId
    );
  }

  function findOperation(index, opId) {
    if (!hasText(opId)) return null;
    return index.operations.find(
      operation =>
        operation.opId === opId &&
        operation.archiveId === archiveId
    );
  }

  /**
   * 按实际文件逐项计量；同一线路跨天读取不会重复计费。
   * 统计范围是本档案专用目录中的全部受管文件（含孤儿文件），
   * 因为这些文件共同占用同一份本机照片预算。
   */
  async function measureIndex(index) {
    // 目录与档案一一对应：只有本档案的照片记录、本档案进行中的操作与本档案
    // 在途预留与这个目录里的文件相关，其他档案的记录不能算作本目录的引用。
    const startedPhotoIds = index.operations
      .filter(
        operation =>
          operation.archiveId === archiveId &&
          operation.status === 'started' &&
          operation.photoId
      )
      .map(operation => operation.photoId)
      .concat(reservedPhotoIds());
    const measured = await spaceMeter.measure({
      photos: index.photos.filter(photo => photo.archiveId === archiveId),
      startedPhotoIds
    });
    if (!measured.ok) {
      return fail('space-measure-failed', measured.error);
    }
    const archivePhotos = index.photos.filter(
      photo => photo.archiveId === archiveId
    );
    return Object.assign({}, measured, {
      photoCount: archivePhotos.length,
      archivePhotoCount: archivePhotos.length
    });
  }

  function nextPhotoId(index) {
    let photoId;
    do {
      photoId = 'photo-' + index.nextPhotoSeq;
      index.nextPhotoSeq += 1;
    } while (
      index.photos.some(photo => photo.photoId === photoId)
    );
    return photoId;
  }

  function describePhoto(record) {
    return {
      photoId: record.photoId,
      archiveId: record.archiveId,
      routeId: record.routeId,
      storage: {
        type: record.storage.type,
        location: record.storage.location
      },
      width: record.width,
      height: record.height,
      bytes: {
        main: record.bytes.main,
        thumb: record.bytes.thumb
      },
      createdAt: record.createdAt,
      overTargetBytes: record.bytes.main > policy.mainTargetBytes.max
    };
  }

  function isValidRouteId(routeId) {
    return hasVisibleText(routeId);
  }

  function duplicateResult(kind, operation) {
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const route = findRoute(loaded.index, operation.routeId);
    // 已提交的旧操作只有在仍被线路引用时才算重复成功；
    // 被移除或更换后再次回调不能恢复旧照片。
    if (!route || route.photoId !== operation.photoId) {
      return fail('stale-operation', '', {
        opId: operation.opId,
        photoId: operation.photoId,
        kind
      });
    }
    const photo = findPhoto(loaded.index, operation.photoId);
    if (!photo) return fail('photo-record-missing');
    return {
      ok: true,
      duplicate: true,
      opId: operation.opId,
      photoId: operation.photoId,
      kind,
      status: 'committed',
      photo: describePhoto(photo)
    };
  }

  function prepareSave(kind, input) {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return { result: invalidAttribution };

    const routeId = input.routeId;
    if (!isValidRouteId(routeId)) return { result: fail('missing-route') };
    const sourcePath = input.sourcePath;
    if (!hasVisibleText(sourcePath)) {
      return { result: fail('missing-source') };
    }
    const requestedOpId = input.opId;
    if (
      requestedOpId !== undefined &&
      requestedOpId !== null &&
      requestedOpId !== '' &&
      !hasText(requestedOpId)
    ) {
      return { result: fail('invalid-op-id') };
    }
    if (hasText(requestedOpId) && requestedOpId.length > 120) {
      return { result: fail('invalid-op-id', '操作 ID 过长') };
    }

    const loaded = loadIndex();
    if (!loaded.ok) return { result: loaded };
    const index = loaded.index;
    const opId = hasText(requestedOpId) ? requestedOpId : '';
    const existing = opId ? findOperation(index, opId) : null;

    if (existing) {
      if (existing.kind !== kind || existing.routeId !== routeId) {
        return { result: fail('operation-mismatch', '', { opId }) };
      }
      if (existing.status === 'committed') {
        return { result: duplicateResult(kind, existing) };
      }
      if (existing.status === 'started') {
        // 同一实例仍登记有真实执行中的 promise 时拒绝重入；别的实例一律保守忙，
        // 等 recover() 按共享登记判断其是否已经结束。
        if (
          existing.instanceId !== instanceId ||
          operationTokenLive(existing)
        ) {
          return {
            result: fail('operation-in-progress', '', { opId })
          };
        }
        // 同一实例内没有正在执行、但仍是 started：按可重试处理。
      }

      const route = findRoute(index, routeId);
      if (!route || route.activeOpSeq !== existing.seq) {
        return {
          result: fail('stale-operation', '', {
            opId,
            photoId: existing.photoId
          })
        };
      }
      if (kind === 'add') {
        if (route.photoId && route.photoId !== existing.photoId) {
          return { result: fail('stale-operation', '', { opId }) };
        }
        if (route.photoId === existing.photoId) {
          return { result: duplicateResult(kind, existing) };
        }
      }
      if (kind === 'replace') {
        if (route.photoId !== existing.basePhotoId) {
          return {
            result: fail('stale-operation', '', {
              opId,
              photoId: existing.photoId
            })
          };
        }
      }

      existing.status = 'started';
      existing.instanceId = instanceId;
      existing.runtimeId = runtimeId;
      existing.finishedAt = '';
      existing.error = '';
      const saved = saveIndex(index);
      if (!saved.ok) return { result: saved };
      beginOperationToken(existing);
      return { proceed: true, index, op: existing, sourcePath };
    }

    const route = findRoute(index, routeId);
    if (kind === 'add') {
      if (route && route.photoId) {
        return {
          result: fail('already-has-photo', '', {
            photoId: route.photoId
          })
        };
      }
    } else if (!route || !route.photoId) {
      return { result: fail('no-photo') };
    }

    const seq = index.nextOpSeq;
    index.nextOpSeq += 1;
    const finalOpId = opId || 'photo-op-' + seq;
    if (findOperation(index, finalOpId)) {
      return { result: fail('invalid-op-id', '操作 ID 已存在') };
    }
    const target = ensureRoute(index, routeId);
    const basePhotoId = target.photoId || '';
    const baseRev = target.rev;
    const photoId = nextPhotoId(index);
    const operation = {
      opId: finalOpId,
      seq,
      instanceId,
      runtimeId,
      archiveId,
      routeId,
      kind,
      status: 'started',
      photoId: kind === 'remove' ? '' : photoId,
      basePhotoId,
      baseRev,
      startedAt: now(),
      finishedAt: '',
      error: ''
    };
    target.activeOpSeq = seq;
    index.operations.push(operation);

    const saved = saveIndex(index);
    if (!saved.ok) return { result: saved };
    beginOperationToken(operation);
    return { proceed: true, index, op: operation, sourcePath };
  }

  function prepareRemove(input) {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return { result: invalidAttribution };
    const routeId = input.routeId;
    if (!isValidRouteId(routeId)) return { result: fail('missing-route') };

    const loaded = loadIndex();
    if (!loaded.ok) return { result: loaded };
    const index = loaded.index;
    const requestedOpId = input.opId;
    if (
      requestedOpId !== undefined &&
      requestedOpId !== null &&
      requestedOpId !== '' &&
      !hasText(requestedOpId)
    ) {
      return { result: fail('invalid-op-id') };
    }
    if (hasText(requestedOpId) && requestedOpId.length > 120) {
      return { result: fail('invalid-op-id', '操作 ID 过长') };
    }
    const opId = hasText(requestedOpId) ? requestedOpId : '';
    const existing = opId ? findOperation(index, opId) : null;

    if (existing) {
      if (existing.kind !== 'remove' || existing.routeId !== routeId) {
        return { result: fail('operation-mismatch', '', { opId }) };
      }
      if (existing.status === 'committed') {
        return { cleanupCommitted: true, op: existing };
      }
      if (existing.status === 'started') {
        if (
          existing.instanceId !== instanceId ||
          operationTokenLive(existing)
        ) {
          return { result: fail('operation-in-progress', '', { opId }) };
        }
      }
      const route = findRoute(index, routeId);
      if (
        !route ||
        route.activeOpSeq !== existing.seq ||
        route.photoId !== existing.basePhotoId
      ) {
        return { result: fail('stale-operation', '', { opId }) };
      }
      existing.status = 'started';
      existing.instanceId = instanceId;
      existing.runtimeId = runtimeId;
      existing.finishedAt = '';
      existing.error = '';
      const saved = saveIndex(index);
      if (!saved.ok) return { result: saved };
      beginOperationToken(existing);
      return { proceed: true, op: existing };
    }

    const route = findRoute(index, routeId);
    if (!route || !route.photoId) return { result: fail('no-photo') };

    const seq = index.nextOpSeq;
    index.nextOpSeq += 1;
    const finalOpId = opId || 'photo-op-' + seq;
    if (findOperation(index, finalOpId)) {
      return { result: fail('invalid-op-id', '操作 ID 已存在') };
    }
    const operation = {
      opId: finalOpId,
      seq,
      instanceId,
      runtimeId,
      archiveId,
      routeId,
      kind: 'remove',
      status: 'started',
      photoId: route.photoId,
      basePhotoId: route.photoId,
      baseRev: route.rev,
      startedAt: now(),
      finishedAt: '',
      error: ''
    };
    route.activeOpSeq = seq;
    index.operations.push(operation);

    const saved = saveIndex(index);
    if (!saved.ok) return { result: saved };
    beginOperationToken(operation);
    return { proceed: true, op: operation };
  }

  /**
   * 删除一个尚未被索引引用、也没有其他写入正在处理的照片文件。
   * 索引不可读、有其他 started 操作、其他在途预留或进行中的删除声明时保留文件；
   * 真正 unlink 前登记删除声明，异步删除期间同 photoId 的保存会返回可重试忙状态。
   */
  async function cleanupUncommitted(photoId, opId) {
    if (!isSafePhotoId(photoId)) return { deleted: [], error: '' };
    const loaded = loadIndex();
    if (!loaded.ok) {
      return { deleted: [], error: '索引不可读，保留未引用文件' };
    }
    const referenced =
      loaded.index.photos.some(photo => photo.photoId === photoId) ||
      loaded.index.routes.some(route => route.photoId === photoId);
    if (referenced) {
      return { deleted: [], error: '照片仍被索引引用，未删除' };
    }
    if (
      loaded.index.operations.some(
        operation =>
          operation.status === 'started' && operation.photoId === photoId
      )
    ) {
      return { deleted: [], error: '有进行中的操作引用该照片，保留文件' };
    }
    if (hasOtherReservationForPhoto(photoId, opId)) {
      return { deleted: [], error: '有其他在途预留引用该照片，保留文件' };
    }
    const claim = beginDeletion(photoId);
    if (!claim.ok) {
      return {
        deleted: [],
        error: claim.busy
          ? '照片文件正在清理，保留文件'
          : claim.error || '无法登记照片文件删除声明，保留文件'
      };
    }
    const deleted = [];
    const errors = [];
    try {
      // 登记声明后再次确认：等待期间可能有同 opId 的重试重新置为 started。
      const fresh = loadIndex();
      if (!fresh.ok) {
        return { deleted, error: '索引不可读，保留未引用文件' };
      }
      const stillReferenced =
        fresh.index.photos.some(photo => photo.photoId === photoId) ||
        fresh.index.routes.some(route => route.photoId === photoId) ||
        fresh.index.operations.some(
          operation =>
            operation.status === 'started' && operation.photoId === photoId
        );
      if (stillReferenced || hasOtherReservationForPhoto(photoId, opId)) {
        return { deleted, error: '照片已被重新引用，保留文件' };
      }
      const main = await files.remove(files.mainPath(photoId));
      if (main.ok) {
        if (main.existed) deleted.push(files.mainPath(photoId));
      } else {
        errors.push(main.error);
      }
      const thumb = await files.remove(files.thumbPath(photoId));
      if (thumb.ok) {
        if (thumb.existed) deleted.push(files.thumbPath(photoId));
      } else {
        errors.push(thumb.error);
      }
    } finally {
      endDeletion(claim.claimId);
    }
    return { deleted, error: errors.join('；') };
  }

  async function markOperationFailed(op, code, detail, extra) {
    // 实际写入报空间不足时统一归为可恢复的空间错误，页面才能给出管理入口。
    const finalCode =
      code !== 'space-insufficient' && isSpaceError(detail)
        ? 'space-insufficient'
        : code;
    const loaded = loadIndex();
    if (loaded.ok) {
      const current = findOperation(loaded.index, op.opId);
      if (
        current &&
        current.status === 'started' &&
        current.seq === op.seq &&
        current.instanceId === op.instanceId
      ) {
        current.status = 'failed';
        current.finishedAt = now();
        current.error =
          detail || ERROR_TEXT[finalCode] || ERROR_TEXT.unexpected;
        saveIndex(loaded.index);
      }
    }
    const cleanup = await cleanupUncommitted(op.photoId, op.opId);
    return fail(
      finalCode,
      detail,
      Object.assign(
        {
          opId: op.opId,
          photoId: op.photoId,
          cleanedFiles: cleanup.deleted
        },
        extra || {}
      )
    );
  }

  function removeThumbCacheItem(photoId) {
    const cache = loadThumbCache();
    const next = cache.items.filter(item => item.photoId !== photoId);
    if (next.length !== cache.items.length) {
      saveThumbCache({ version: THUMB_CACHE_VERSION, items: next });
    }
  }

  function upsertThumbCache(photo, thumbResult) {
    const cache = loadThumbCache();
    const item = {
      photoId: photo.photoId,
      location: thumbResult.path,
      bytes: thumbResult.bytes,
      width: thumbResult.width || photo.width,
      height: thumbResult.height || photo.height,
      updatedAt: now()
    };
    const next = cache.items.filter(
      entry => entry.photoId !== photo.photoId
    );
    next.push(item);
    saveThumbCache({ version: THUMB_CACHE_VERSION, items: next });
  }

  /**
   * 照片记录是否仍然存在（且仍被自己的线路引用）。异步写入的每个边界之后都要复查，
   * 避免用过期引用把缩略图写回已移除或已更换的照片。
   * 按 photoId + 本档案查找：重建只覆盖本档案里仍被线路引用的照片。
   */
  function photoRecordStillPresent(photoId) {
    const loaded = loadIndex();
    if (!loaded.ok) return false;
    const record = loaded.index.photos.find(
      photo => photo.photoId === photoId && photo.archiveId === archiveId
    );
    if (!record) return false;
    const route = loaded.index.routes.find(
      item =>
        item.archiveId === record.archiveId &&
        item.routeId === record.routeId
    );
    return Boolean(route && route.photoId === photoId);
  }

  /**
   * 提交后按实际文件复查缩略图：并发清缓存可能刚好删掉了刚写入的缩略图，
   * 主图是唯一副本、缩略图可重建，这里用同一临时文件立刻补写一次。
   * 补写失败不影响“照片已保存”，缺失的缩略图仍可稍后重建。
   */
  async function ensureThumbWritten(photo, compressed, thumbResult) {
    const thumbStat = await files.stat(files.thumbPath(photo.photoId));
    if (thumbStat.ok && thumbStat.exists && thumbStat.bytes > 0) return;
    const rewritten = await files.writeThumb(photo.photoId, compressed.path);
    if (!rewritten.ok) return;
    upsertThumbCache(
      photo,
      Object.assign({}, rewritten, {
        width: thumbResult.width,
        height: thumbResult.height
      })
    );
  }

  async function runSave(kind, op, sourcePath) {
    try {
      const ready = await files.ensureReady();
      if (!ready.ok) {
        return markOperationFailed(op, 'file-write-failed', ready.error);
      }

      const info = await files.getImageInfo(sourcePath);
      if (!info.ok) {
        return markOperationFailed(op, 'source-unreadable', info.error);
      }

      const mainCompressed = await files.compressImage({
        srcPath: sourcePath,
        maxEdge: policy.mainMaxEdge,
        quality: policy.mainQuality
      });
      if (!mainCompressed.ok) {
        return markOperationFailed(
          op,
          'compress-failed',
          mainCompressed.error
        );
      }

      // 缩略图从刚压缩好的临时主图生成：内容与持久主图一致、保持整幅画面，
      // 同时不依赖压缩器能否读取用户文件目录里的持久路径。
      const thumbCompressed = await files.compressImage({
        srcPath: mainCompressed.path,
        maxEdge: policy.thumbMaxEdge,
        quality: policy.thumbQuality
      });
      if (!thumbCompressed.ok) {
        return markOperationFailed(
          op,
          'thumbnail-failed',
          thumbCompressed.error
        );
      }

      // 先按真实待写入文件大小估算峰值，再动受管目录：
      // 实际占用 + 先到的在途预留 + 新主图 + 新缩略图 + 更换余量，必须不超过预算。
      // 更换时旧主图仍在，峰值天然包含新旧共存，不提前删旧照片制造空间。
      const mainTempStat = await files.stat(mainCompressed.path);
      if (!mainTempStat.ok || !mainTempStat.exists || !(mainTempStat.bytes > 0)) {
        return markOperationFailed(
          op,
          'file-write-failed',
          '无法读取待写入主图大小'
        );
      }
      const thumbTempStat = await files.stat(thumbCompressed.path);
      if (
        !thumbTempStat.ok ||
        !thumbTempStat.exists ||
        !(thumbTempStat.bytes > 0)
      ) {
        return markOperationFailed(
          op,
          'thumbnail-failed',
          '无法读取待写入缩略图大小'
        );
      }

      // 登记在途预留后才做预算判断：同一服务或不同实例的并发保存共享这份预留，
      // 后到者会看到先到者的预留并被拒绝，而不是各自按同一份未预留预算放行。
      const reserved = await reserveForWrite({
        photoId: op.photoId,
        opId: op.opId,
        kind,
        bytes: mainTempStat.bytes + thumbTempStat.bytes,
        mainBytes: mainTempStat.bytes,
        thumbBytes: thumbTempStat.bytes
      });
      if (!reserved.ok) {
        if (reserved.code === 'space-insufficient') {
          const spaceCheck = reserved.spaceCheck;
          return markOperationFailed(
            op,
            'space-insufficient',
            spaceCheck.message,
            {
              space: {
                reason: spaceCheck.reason,
                policy: spaceCheck.policy,
                totalBytes: spaceCheck.totalBytes,
                newBytes: spaceCheck.newBytes,
                projectedBytes: spaceCheck.projectedBytes,
                peakBytes: spaceCheck.peakBytes,
                budgetBytes: spaceCheck.policy.budgetBytes,
                warnBytes: spaceCheck.policy.warnBytes,
                reserveBytes: spaceCheck.policy.reserveBytes
              }
            }
          );
        }
        if (
          reserved.code === 'index-read-failed' ||
          reserved.code === 'index-broken' ||
          reserved.code === 'coordination-failed' ||
          reserved.code === 'cleanup-in-progress'
        ) {
          return markOperationFailed(op, reserved.code, reserved.error);
        }
        return markOperationFailed(
          op,
          'space-measure-failed',
          reserved.error || '无法登记照片空间预留'
        );
      }

      try {
        const mainWritten = await files.writeMain(
          op.photoId,
          mainCompressed.path
        );
        if (!mainWritten.ok) {
          return markOperationFailed(
            op,
            'file-write-failed',
            mainWritten.error
          );
        }

        const thumbWritten = await files.writeThumb(
          op.photoId,
          thumbCompressed.path
        );
        if (!thumbWritten.ok) {
          return markOperationFailed(
            op,
            'thumbnail-failed',
            thumbWritten.error
          );
        }

        // 文件和缩略图都已落盘，最后一步才是提交索引。
        const loaded = loadIndex();
        if (!loaded.ok) {
          return markOperationFailed(op, 'index-read-failed', loaded.error);
        }
        const index = loaded.index;
        const current = findOperation(index, op.opId);
        if (
          !current ||
          current.status !== 'started' ||
          current.seq !== op.seq ||
          current.instanceId !== op.instanceId
        ) {
          return markOperationFailed(op, 'stale-operation');
        }
        const route = findRoute(index, op.routeId);
        if (
          !route ||
          route.activeOpSeq !== op.seq ||
          route.rev !== op.baseRev
        ) {
          return markOperationFailed(op, 'stale-operation');
        }
        if (kind === 'add' && route.photoId !== '') {
          return markOperationFailed(op, 'stale-operation');
        }
        if (kind === 'replace' && route.photoId !== op.basePhotoId) {
          return markOperationFailed(op, 'stale-operation');
        }

        // 最后一刻再确认没有进行中的删除声明：如果维护在文件写入后才登记了声明，
        // 本次提交会引用一个可能即将被旧 unlink 删掉的文件，必须按可重试忙状态退回。
        if (deletionBlocksPhoto(op.photoId)) {
          return markOperationFailed(
            op,
            'cleanup-in-progress',
            '照片文件正在清理，本次保存未提交'
          );
        }

        const photo = {
          photoId: op.photoId,
          archiveId,
          routeId: op.routeId,
          storage: {
            type: LOCAL_STORAGE_TYPE,
            location: files.mainPath(op.photoId)
          },
          width: mainCompressed.width,
          height: mainCompressed.height,
          bytes: {
            main: mainWritten.bytes,
            thumb: thumbWritten.bytes
          },
          createdAt: now()
        };
        if (kind === 'replace') {
          index.photos = index.photos.filter(
            entry => entry.photoId !== op.basePhotoId
          );
        }
        index.photos.push(photo);
        route.photoId = op.photoId;
        route.rev = op.baseRev + 1;
        current.status = 'committed';
        current.finishedAt = now();
        current.error = '';

        const saved = saveIndex(index);
        if (!saved.ok) {
          return markOperationFailed(
            op,
            'index-write-failed',
            saved.error
          );
        }

        // 缩略图元数据是缓存；写失败不改变“照片已保存”的结果。
        upsertThumbCache(
          photo,
          Object.assign({}, thumbWritten, {
            width: thumbCompressed.width,
            height: thumbCompressed.height
          })
        );

        // 普通清缓存可能恰好在本照片提交前后删除缩略图；已提交的主照片是唯一副本，
        // 这里按实际文件复查一次，缺失就立刻用同一临时文件补写，避免新照片没有缩略图。
        await ensureThumbWritten(
          photo,
          thumbCompressed,
          Object.assign({}, thumbWritten, {
            width: thumbCompressed.width,
            height: thumbCompressed.height
          })
        );

        let cleanupError = '';
        if (kind === 'replace' && op.basePhotoId) {
          const baseMain = await files.remove(
            files.mainPath(op.basePhotoId)
          );
          const baseThumb = await files.remove(
            files.thumbPath(op.basePhotoId)
          );
          removeThumbCacheItem(op.basePhotoId);
          if (!baseMain.ok || !baseThumb.ok) {
            cleanupError =
              (baseMain.error || '') + (baseThumb.error || '');
          }
        }

        return {
          ok: true,
          duplicate: false,
          opId: op.opId,
          photoId: op.photoId,
          kind,
          status: 'committed',
          photo: describePhoto(photo),
          thumbnail: {
            type: LOCAL_STORAGE_TYPE,
            location: thumbWritten.path,
            bytes: thumbWritten.bytes
          },
          cleanupError
        };
      } finally {
        releaseReservation(reserved.claim.reservationId);
      }
    } catch (error) {
      return markOperationFailed(op, 'unexpected', errorText(error));
    }
  }

  async function finishRemove(op) {
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const referenced =
      loaded.index.photos.some(photo => photo.photoId === op.photoId) ||
      loaded.index.routes.some(route => route.photoId === op.photoId);
    if (referenced) {
      return fail('stale-operation', '', {
        opId: op.opId,
        photoId: op.photoId
      });
    }
    const main = await files.remove(files.mainPath(op.photoId));
    const thumb = await files.remove(files.thumbPath(op.photoId));
    removeThumbCacheItem(op.photoId);
    if (!main.ok || !thumb.ok) {
      return fail('file-delete-failed', main.error || thumb.error, {
        opId: op.opId,
        photoId: op.photoId,
        associationRemoved: true
      });
    }
    return {
      ok: true,
      duplicate: true,
      opId: op.opId,
      photoId: op.photoId,
      kind: 'remove',
      removed: true,
      associationRemoved: true
    };
  }

  async function runRemove(op) {
    try {
      const loaded = loadIndex();
      if (!loaded.ok) return loaded;
      const index = loaded.index;
      const current = findOperation(index, op.opId);
      if (
        !current ||
        current.status !== 'started' ||
        current.seq !== op.seq ||
        current.instanceId !== op.instanceId
      ) {
        return fail('stale-operation', '', {
          opId: op.opId,
          photoId: op.photoId
        });
      }
      const route = findRoute(index, op.routeId);
      if (
        !route ||
        route.activeOpSeq !== op.seq ||
        route.rev !== op.baseRev ||
        route.photoId !== op.basePhotoId
      ) {
        return fail('stale-operation', '', {
          opId: op.opId,
          photoId: op.photoId
        });
      }

      // 先提交“不再引用”，再删文件：索引失败时旧照片与旧索引都保持可读；
      // 删除失败时关联已移除，返回可恢复错误，不虚报成功。
      index.photos = index.photos.filter(
        entry => entry.photoId !== op.photoId
      );
      route.photoId = '';
      route.rev = op.baseRev + 1;
      current.status = 'committed';
      current.finishedAt = now();
      current.error = '';

      const saved = saveIndex(index);
      if (!saved.ok) {
        return fail('index-write-failed', saved.error, {
          opId: op.opId,
          photoId: op.photoId
        });
      }

      return finishRemove(current);
    } catch (error) {
      return fail('unexpected', errorText(error), {
        opId: op.opId,
        photoId: op.photoId
      });
    }
  }

  async function addPhoto(input) {
    const prepared = prepareSave('add', input || {});
    if (!prepared.proceed) return prepared.result;
    try {
      return await runSave('add', prepared.op, prepared.sourcePath);
    } finally {
      // 无论提交、失败还是异常，都结束本次真实执行登记；之后同运行期的
      // 其他实例才能把写回失败的终态当作已结束操作恢复，而不会误判仍活跃。
      endOperationToken(prepared.op);
    }
  }

  async function replacePhoto(input) {
    const prepared = prepareSave('replace', input || {});
    if (!prepared.proceed) return prepared.result;
    try {
      return await runSave('replace', prepared.op, prepared.sourcePath);
    } finally {
      endOperationToken(prepared.op);
    }
  }

  async function removePhoto(input) {
    const prepared = prepareRemove(input || {});
    if (prepared.cleanupCommitted) return finishRemove(prepared.op);
    if (!prepared.proceed) return prepared.result;
    try {
      return await runRemove(prepared.op);
    } finally {
      endOperationToken(prepared.op);
    }
  }

  async function describeRoutePhoto(routeId) {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    if (!isValidRouteId(routeId)) return fail('missing-route');

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const route = findRoute(loaded.index, routeId);
    if (!route || !route.photoId) {
      return {
        ok: true,
        status: 'none',
        routeId,
        photo: null,
        routeRevision: route ? route.rev : 0
      };
    }
    const record = findPhoto(loaded.index, route.photoId);
    if (!record) return fail('photo-record-missing', '', { routeId });

    const mainPath = files.mainPath(record.photoId);
    const mainStat = await files.stat(mainPath);
    if (!mainStat.ok) {
      return fail('missing-file', mainStat.error, {
        status: 'missing-file',
        routeId,
        photo: describePhoto(record)
      });
    }
    if (!mainStat.exists || !(mainStat.bytes > 0)) {
      return fail('missing-file', '', {
        status: 'missing-file',
        routeId,
        photo: describePhoto(record)
      });
    }

    const thumbPath = files.thumbPath(record.photoId);
    const thumbStat = await files.stat(thumbPath);
    const thumbnailAvailable =
      thumbStat.ok && thumbStat.exists && thumbStat.bytes > 0;

    const photo = describePhoto(record);
    photo.storage.location = mainPath;
    photo.bytes.main = mainStat.bytes;
    // bytes.thumb 必须反映当前实际可用的缩略图；清缓存/重建后不能再回放写入时的旧快照。
    photo.bytes.thumb = thumbnailAvailable ? thumbStat.bytes : 0;
    photo.thumbnail = {
      type: LOCAL_STORAGE_TYPE,
      location: thumbPath,
      available: thumbnailAvailable,
      bytes: thumbnailAvailable ? thumbStat.bytes : 0
    };
    return {
      ok: true,
      status: thumbnailAvailable ? 'ready' : 'ready-thumb-missing',
      routeId,
      routeRevision: route.rev,
      photo
    };
  }

  async function getRoutePhoto(input) {
    return describeRoutePhoto((input || {}).routeId);
  }

  async function getPhoto(input) {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const photoId = (input || {}).photoId;
    if (!isSafePhotoId(photoId)) return fail('invalid-photo-id');

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const record = findPhoto(loaded.index, photoId);
    if (!record) return fail('not-found');

    const mainPath = files.mainPath(photoId);
    const mainStat = await files.stat(mainPath);
    if (!mainStat.ok) {
      return fail('missing-file', mainStat.error, {
        status: 'missing-file',
        photo: describePhoto(record)
      });
    }
    if (!mainStat.exists || !(mainStat.bytes > 0)) {
      return fail('missing-file', '', {
        status: 'missing-file',
        photo: describePhoto(record)
      });
    }
    const thumbPath = files.thumbPath(photoId);
    const thumbStat = await files.stat(thumbPath);
    const thumbnailAvailable =
      thumbStat.ok && thumbStat.exists && thumbStat.bytes > 0;
    const photo = describePhoto(record);
    photo.storage.location = mainPath;
    photo.bytes.main = mainStat.bytes;
    // 同上：按当前实际缩略图报告字节，缺失时为 0。
    photo.bytes.thumb = thumbnailAvailable ? thumbStat.bytes : 0;
    photo.thumbnail = {
      type: LOCAL_STORAGE_TYPE,
      location: thumbPath,
      available: thumbnailAvailable,
      bytes: thumbnailAvailable ? thumbStat.bytes : 0
    };
    return {
      ok: true,
      status: thumbnailAvailable ? 'ready' : 'ready-thumb-missing',
      photo
    };
  }

  /**
   * 缩略图只依赖主图，按照片记录重建；不改变主图或关联。
   * 供当前数据集公开入口和“清缓存后重建”共用。
   *
   * 重建同样会新增受管字节，因此必须和其他保存路径共享预算与在途预留；
   * 异步压缩/写入的每个边界之后都复查照片记录，已移除/已更换的照片不再写回。
   */
  async function rebuildThumbnailRecord(record) {
    const photoId = record.photoId;
    const mainPath = files.mainPath(photoId);
    const mainStat = await files.stat(mainPath);
    if (!mainStat.ok || !mainStat.exists || !(mainStat.bytes > 0)) {
      return fail('missing-file', '', { photo: describePhoto(record) });
    }
    const compressed = await files.compressImage({
      srcPath: mainPath,
      maxEdge: policy.thumbMaxEdge,
      quality: policy.thumbQuality
    });
    if (!compressed.ok) {
      return fail('thumbnail-failed', compressed.error, {
        photoId,
        photo: describePhoto(record)
      });
    }
    const tempStat = await files.stat(compressed.path);
    if (!tempStat.ok || !tempStat.exists || !(tempStat.bytes > 0)) {
      return fail('thumbnail-failed', '无法读取待写入缩略图大小', {
        photoId,
        photo: describePhoto(record)
      });
    }

    const reserved = await reserveForWrite({
      photoId,
      kind: 'rebuild-thumb',
      bytes: tempStat.bytes,
      thumbBytes: tempStat.bytes
    });
    if (!reserved.ok) {
      if (reserved.code === 'space-insufficient') {
        const spaceCheck = reserved.spaceCheck;
        return fail('space-insufficient', spaceCheck.message, {
          photoId,
          photo: describePhoto(record),
          space: {
            reason: spaceCheck.reason,
            policy: spaceCheck.policy,
            totalBytes: spaceCheck.totalBytes,
            newBytes: spaceCheck.newBytes,
            projectedBytes: spaceCheck.projectedBytes,
            peakBytes: spaceCheck.peakBytes,
            budgetBytes: spaceCheck.policy.budgetBytes,
            warnBytes: spaceCheck.policy.warnBytes,
            reserveBytes: spaceCheck.policy.reserveBytes
          }
        });
      }
      if (
        reserved.code === 'index-read-failed' ||
        reserved.code === 'index-broken'
      ) {
        return fail(reserved.code, reserved.error, { photoId });
      }
      return fail(
        'space-measure-failed',
        reserved.error || '无法登记照片空间预留',
        { photoId }
      );
    }

    try {
      // 写入前先确认照片记录仍存在：等待期间被移除/更换就不再产生新文件。
      if (!photoRecordStillPresent(photoId)) {
        return fail('not-found', '照片已移除，未重建缩略图', {
          photoId,
          photo: describePhoto(record)
        });
      }
      const written = await files.writeThumb(photoId, compressed.path);
      if (!written.ok) {
        return fail('thumbnail-failed', written.error, {
          photoId,
          photo: describePhoto(record)
        });
      }
      // 写入后复查：期间被移除/更换则撤销这次写入，不给已移除照片留下孤儿缩略图。
      if (!photoRecordStillPresent(photoId)) {
        await files.remove(files.thumbPath(photoId));
        removeThumbCacheItem(photoId);
        return fail('not-found', '照片已移除，已撤销这次缩略图写入', {
          photoId,
          photo: describePhoto(record)
        });
      }
      upsertThumbCache(
        record,
        Object.assign({}, written, {
          width: compressed.width,
          height: compressed.height
        })
      );
      return {
        ok: true,
        photoId,
        thumbnail: {
          type: LOCAL_STORAGE_TYPE,
          location: written.path,
          available: true,
          bytes: written.bytes
        }
      };
    } finally {
      releaseReservation(reserved.claim.reservationId);
    }
  }

  async function rebuildThumbnail(input) {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const photoId = (input || {}).photoId;
    if (!isSafePhotoId(photoId)) return fail('invalid-photo-id');

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const record = findPhoto(loaded.index, photoId);
    if (!record) return fail('not-found');
    return rebuildThumbnailRecord(record);
  }

  /**
   * 当前“有引用”的受管文件路径：照片记录、进行中操作、在途预留。
   * 维护操作在异步边界之后必须重新计算它，不能用过期快照判断无引用。
   * 在途预留读不出来时返回 ok:false，调用方必须停止删除而不是猜“无引用”。
   */
  function collectReferencedPaths(index) {
    const referenced = new Set();
    // 路径由本档案目录拼出，所以只有本档案的记录/操作/预留算引用；
    // 其他档案的 photoId 即使同名也不会出现在本目录的文件清单里。
    for (const photo of index.photos) {
      if (photo.archiveId !== archiveId) continue;
      referenced.add(files.mainPath(photo.photoId));
      referenced.add(files.thumbPath(photo.photoId));
    }
    for (const operation of index.operations) {
      if (operation.archiveId !== archiveId) continue;
      if (operation.status !== 'started') continue;
      if (!operation.photoId) continue;
      referenced.add(files.mainPath(operation.photoId));
      referenced.add(files.thumbPath(operation.photoId));
    }
    const read = readReservations();
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    for (const item of read.state.items) {
      if (item.archiveId !== archiveId) continue;
      if (!item.photoId) continue;
      referenced.add(files.mainPath(item.photoId));
      referenced.add(files.thumbPath(item.photoId));
    }
    return { ok: true, paths: referenced };
  }

  function fileNameOf(filePath) {
    const parts = String(filePath || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /**
   * 清理 main/thumb 目录中无引用的本服务文件。
   * 逐个候选文件在删除前按最新索引、进行中操作与在途预留重新确认引用关系；
   * 真正删除前登记删除声明，并在异步读取之后再次复查，避免旧 unlink 回调
   * 删掉后来提交的主图。删除声明写入失败时保留文件，不冒险删除。
   */
  async function cleanupOrphansInternal() {
    const deleted = [];
    const errors = [];

    const listed = [];
    const mainList = await files.listMain();
    if (!mainList.ok) errors.push(mainList.error);
    if (mainList.ok) {
      for (const file of mainList.files) listed.push(file.path);
    }
    const thumbList = await files.listThumb();
    if (!thumbList.ok) errors.push(thumbList.error);
    if (thumbList.ok) {
      for (const file of thumbList.files) listed.push(file.path);
    }

    for (const path of listed) {
      const fresh = loadIndex();
      if (!fresh.ok) {
        // 索引不可读时无法证明“无引用”，停止删除并保留用户文件。
        errors.push(fresh.error);
        break;
      }
      const freshRefs = collectReferencedPaths(fresh.index);
      if (!freshRefs.ok) {
        errors.push(freshRefs.error);
        break;
      }
      if (freshRefs.paths.has(path)) continue;

      const photoId = photoIdFromFileName(fileNameOf(path));
      if (!photoId) {
        // 不是本服务 photo-<id>.jpg 命名的文件不会被任何保存复用，可直接清理。
        const removed = await files.remove(path);
        if (removed.ok) {
          if (removed.existed) deleted.push(path);
        } else {
          errors.push(removed.error);
        }
        continue;
      }

      const claim = beginDeletion(photoId);
      if (!claim.ok) {
        if (!claim.busy) {
          errors.push(claim.error || '无法登记照片文件删除声明');
        }
        continue;
      }
      try {
        // 登记声明后再次复查：清单读取期间可能有重试开始写同一 photoId。
        const recheck = loadIndex();
        if (!recheck.ok) {
          errors.push(recheck.error);
          break;
        }
        const recheckRefs = collectReferencedPaths(recheck.index);
        if (!recheckRefs.ok) {
          errors.push(recheckRefs.error);
          break;
        }
        if (recheckRefs.paths.has(path)) continue;
        const removed = await files.remove(path);
        if (removed.ok) {
          if (removed.existed) deleted.push(path);
        } else {
          errors.push(removed.error);
        }
      } finally {
        endDeletion(claim.claimId);
      }
    }

    if (errors.length) {
      return fail('file-delete-failed', errors.join('；'), { deleted });
    }
    return { ok: true, deleted };
  }

  async function cleanupOrphans() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    return cleanupOrphansInternal();
  }

  /**
   * 初始化/重启恢复。
   *
   * 运行期身份先排除“旧运行期已中断”的遗留；同一运行期再以模块级共享登记
   * 区分“某个服务实例的 promise 仍在执行”和“promise 已结束、只是终态写回失败”。
   * 前者（含其他档案、后台暂停或长 await）保留；后者立即中止，
   * 不需要等租约 TTL。旧版没有 runtimeId 的记录退回租约 TTL 判断。
   */
  async function recover() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const index = loaded.index;
    const timeMs = currentTimeMs();
    const leaseMap = leaseMapOf(loadLeases());

    function operationStillRunning(operation) {
      if (hasText(operation.runtimeId)) {
        // 其他运行期的操作随进程/小程序重启结束；同一运行期只认共享登记，
        // 不能用“runtimeId 相同”或“实例还存在于某处”证明 promise 仍在执行。
        if (operation.runtimeId !== runtimeId) return false;
        return RUNTIME_ACTIVITY.operations.has(
          operationActivityKey(operation)
        );
      }
      // 旧版记录没有运行期标识：只按租约（或租约里的运行期）兼容判断。
      const lease = leaseMap.get(operation.instanceId);
      if (!lease) return false;
      if (hasText(lease.runtimeId)) return lease.runtimeId === runtimeId;
      return isLeaseFresh(lease, timeMs);
    }

    const abortedOps = [];
    let changed = false;
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
      if (operationStillRunning(operation)) continue;
      operation.status = 'aborted';
      operation.finishedAt = now();
      operation.error = '服务重启或操作已结束，未完成操作已中止';
      abortedOps.push(operation.opId);
      changed = true;
    }
    if (changed) {
      const saved = saveIndex(index);
      if (!saved.ok) return saved;
    }

    // 已被取代的租约、终止操作的残留预留与结束运行期的删除声明一起回收，
    // 避免崩溃实例长期占用预算或让旧 unlink 继续生效。
    pruneLeases(timeMs);
    pruneStaleReservations(index);
    pruneDeletions();

    // 缩略图缓存可重建：只保留仍有照片记录的条目。
    const cache = loadThumbCache();
    const photoIds = new Set(index.photos.map(photo => photo.photoId));
    const kept = cache.items.filter(item => photoIds.has(item.photoId));
    if (kept.length !== cache.items.length) {
      if (kept.length === 0) {
        removeCoordinationKey(THUMB_CACHE_KEY);
      } else {
        saveThumbCache({ version: THUMB_CACHE_VERSION, items: kept });
      }
    }

    const cleanup = await cleanupOrphansInternal();
    if (!cleanup.ok) return cleanup;
    return {
      ok: true,
      abortedOps,
      deleted: cleanup.deleted
    };
  }

  async function listPhotos() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const photos = loaded.index.photos
      .filter(
        photo =>
          photo.archiveId === archiveId
      )
      .map(describePhoto);
    return {
      ok: true,
      photos,
      totalBytes: photos.reduce(
        (sum, photo) => sum + photo.bytes.main + photo.bytes.thumb,
        0
      )
    };
  }

  /**
   * 照片已用空间与提醒状态。统计的是实际受管文件字节：
   * main/、thumb/ 中的每个文件逐项 stat，不用写入时记录的单图估值。
   */
  async function getSpaceUsage() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    return measureIndex(loaded.index);
  }

  /**
   * 缩略图元数据只移除这次真正删掉文件的条目；被保留的缩略图（例如清缓存期间
   * 新提交的照片）仍保留元数据。全部删完时移除整键，保持“清缓存后缓存键消失”的既有契约。
   */
  function trimThumbCache(deletedPhotoIds) {
    const cache = loadThumbCache();
    const kept = cache.items.filter(
      item => !deletedPhotoIds.has(item.photoId)
    );
    if (kept.length === cache.items.length) return true;
    if (kept.length === 0) return removeCoordinationKey(THUMB_CACHE_KEY);
    return saveThumbCache({ version: THUMB_CACHE_VERSION, items: kept });
  }

  /**
   * 普通清缓存：只删除可重建的缩略图文件与缩略图元数据。
   * 主图、照片索引、场次、尝试、待确认操作和其他缓存键都不动。
   * 有照片操作未完成时拒绝执行，避免删掉正在写入的缩略图。
   *
   * 删除前逐个候选文件按最新索引与在途预留复查：清缓存期间刚提交/刚开始的
   * 新照片缩略图不会被这次清理删掉（只处理开始时已存在或当前完全无引用的缩略图）。
   */
  async function clearRebuildableCache() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    if (loaded.index.operations.some(op => op.status === 'started')) {
      return fail(
        'operation-in-progress',
        '有照片操作未完成，暂不清除缓存'
      );
    }

    if (!touchInstance()) {
      return fail(
        'coordination-failed',
        '无法写入照片实例租约，暂不清除缓存'
      );
    }
    const startReferenced = collectReferencedPaths(loaded.index);
    if (!startReferenced.ok) {
      return fail('file-delete-failed', startReferenced.error);
    }
    const thumbList = await files.listThumb();
    if (!thumbList.ok) {
      return fail('file-delete-failed', thumbList.error);
    }

    const deleted = [];
    const deletedPhotoIds = new Set();
    const errors = [];
    for (const file of thumbList.files) {
      const photoId = photoIdFromFileName(file.name);
      const fresh = loadIndex();
      if (!fresh.ok) {
        errors.push(fresh.error);
        break;
      }
      const currentReferenced = collectReferencedPaths(fresh.index);
      if (!currentReferenced.ok) {
        errors.push(currentReferenced.error);
        break;
      }
      // 开始时已被引用：属于本次要清理的可重建缩略图。
      // 开始时未被引用、现在却被引用：清缓存期间新出现的照片，跳过不删。
      if (
        currentReferenced.paths.has(file.path) &&
        !startReferenced.paths.has(file.path)
      ) {
        continue;
      }
      const removed = await files.remove(file.path);
      if (removed.ok) {
        if (removed.existed) {
          deleted.push(file.path);
          if (photoId) deletedPhotoIds.add(photoId);
        }
      } else {
        errors.push(removed.error);
      }
    }

    const thumbCacheCleared = trimThumbCache(deletedPhotoIds);
    if (!thumbCacheCleared) {
      errors.push('缩略图元数据清理失败');
    }
    if (errors.length) {
      return fail('file-delete-failed', errors.join('；'), {
        deleted,
        thumbCacheCleared,
        rebuildable: true
      });
    }
    return {
      ok: true,
      deleted,
      deletedCount: deleted.length,
      thumbCacheCleared,
      // 便于页面直接展示保护范围，而不是让调用方猜。
      protectedKeys: [INDEX_KEY],
      protectedFiles: 'main/'
    };
  }

  /**
   * 缩略图缺失时从持久主图重建（只针对本档案，主图是唯一副本）。
   * 只补充可重建缓存，不改变主图、照片关联、场次或尝试。
   */
  async function rebuildMissingThumbnails() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    if (loaded.index.operations.some(op => op.status === 'started')) {
      return fail(
        'operation-in-progress',
        '有照片操作未完成，暂不重建缩略图'
      );
    }

    touchInstance();
    // 只重建本档案目录里的照片：缩略图文件落在本档案目录下，
    // 其他档案的照片文件不在本服务实例的可见范围里。
    const photos = loaded.index.photos.filter(
      photo => photo.archiveId === archiveId
    );
    const rebuilt = [];
    const failed = [];
    let skipped = 0;
    for (const photo of photos) {
      const thumbStat = await files.stat(files.thumbPath(photo.photoId));
      if (thumbStat.ok && thumbStat.exists && thumbStat.bytes > 0) {
        skipped += 1;
        continue;
      }
      const result = await rebuildThumbnailRecord(photo);
      if (result.ok) {
        rebuilt.push(photo.photoId);
      } else {
        failed.push({
          photoId: photo.photoId,
          code: result.code || 'thumbnail-failed',
          error: result.error || '缩略图重建失败'
        });
      }
    }
    return {
      ok: failed.length === 0,
      rebuilt,
      rebuiltCount: rebuilt.length,
      skipped,
      failed,
      total: photos.length
    };
  }

  /**
   * 显式放弃本档案下仍未完成的操作。只用于本机档案重置/更换档案：
   * 页面已经丢弃旧档案上下文，继续写入只会留下不可见的半成品。正常 recover()
   * 不会调用它，因此同一运行期其他实例/档案的活跃保存不受影响。
   */
  function abandonStartedOperations() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const index = loaded.index;
    const abortedOps = [];
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
      if (
        operation.archiveId !== archiveId
      ) {
        continue;
      }
      operation.status = 'aborted';
      operation.finishedAt = now();
      operation.error = '本机档案已更换，未完成操作已中止';
      abortedOps.push(operation.opId);
    }
    if (abortedOps.length) {
      const saved = saveIndex(index);
      if (!saved.ok) return saved;
    }
    pruneStaleReservations(index);
    return { ok: true, abortedOps };
  }

  return {
    archiveId,
    instanceId,
    runtimeId,
    spacePolicy,
    keys: {
      index: INDEX_KEY,
      thumbCache: THUMB_CACHE_KEY
    },
    addPhoto,
    replacePhoto,
    removePhoto,
    getRoutePhoto,
    getPhoto,
    rebuildThumbnail,
    cleanupOrphans,
    recover,
    abandonStartedOperations,
    listPhotos,
    getSpaceUsage,
    clearRebuildableCache,
    rebuildMissingThumbnails
  };
}

module.exports = {
  INDEX_KEY,
  THUMB_CACHE_KEY,
  INSTANCE_KEY,
  RESERVATION_KEY,
  DELETION_KEY,
  INDEX_VERSION,
  THUMB_CACHE_VERSION,
  INSTANCE_LEASE_VERSION,
  RESERVATION_VERSION,
  DELETION_VERSION,
  INSTANCE_TTL_MS,
  RUNTIME_ID,
  LOCAL_STORAGE_TYPE,
  PHOTO_POLICY,
  ERROR_TEXT,
  createTrainingPhotoService,
  createWxStorage,
  normalizeIndex,
  normalizeThumbCache,
  normalizeLeases,
  normalizeReservations,
  normalizeDeletions,
  createEmptyIndex,
  createEmptyDeletions,
  routeKey
};
