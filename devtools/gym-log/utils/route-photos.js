/**
 * 岩馆快速记录 · 线路照片持久服务（仅本机）
 *
 * 负责一条长期线路至多一张主照片的归属、持久文件、索引和失败恢复：
 * - 归属在操作启动时固定为“试用用户 + 试用数据集 + 稳定线路 ID”；
 * - 主图先写入用户文件目录，再写索引；两步都成功才返回成功；
 * - 索引是受保护的用户资料，缩略图元数据是可重建缓存，分别使用专用键；
 * - 照片标识（photoId）与存储类型/位置分开保存，为以后迁移云端留出契约；
 * - 本模块不访问云、不读正式记录，也不清除其他命名空间的数据。
 *
 * 数据版本与专用位置：
 *   climbingNote.gymLogTrial.photos.v1          照片与归属索引（受保护）
 *   climbingNote.gymLogTrial.photoThumbs.v1     缩略图元数据（可重建缓存）
 *   climbingNote.gymLogTrial.photoInstances.v1  活跃实例租约（可重建协调数据）
 *   climbingNote.gymLogTrial.photoReservations.v1 在途字节预留（可重建协调数据）
 *   <USER_DATA_PATH>/gym-log-trial-photos/v1/{main,thumb}/photo-<seq>.jpg
 *
 * 并发与恢复约定（返工轮补充）：
 * - 任何会新增受管字节的路径（新增/更换/缩略图重建）在写入前必须先在
 *   photoReservations 键登记在途预留；预算检查计入“实际占用 + 先到预留 + 本次新增 + R”。
 *   预留按登记顺序（claimSeq）先到先得，后到者返回可恢复错误并可重试；预留随操作
 *   结束（提交/失败/中止）释放，进程崩溃后的预留由下一次 recover() 释放。
 * - recover() 只中止“租约已过期或未知实例”留下的 started 操作；其他仍活跃实例
 *   （含其他 owner/dataset）的进行中操作不会被当作崩溃遗留处理。
 * - 维护操作（cleanupOrphans / clearRebuildableCache）在异步边界之后按最新索引与
 *   在途预留重新确认引用关系，不用过期快照删除文件。
 *
 * 失败恢复入口：
 * - recover()：中止真正中断的旧操作、释放过期租约与预留，清理可证明无引用的文件；
 * - cleanupOrphans()：只清理 main/thumb 目录中不被照片记录、进行中操作或预留引用的文件。
 *
 * 本轮只实现 local 存储，不发起任何上传或云调用。
 */
const { isSafePhotoId, errorText } = require('./photo-files');
const {
  PHOTO_SPACE_POLICY,
  createPhotoSpaceMeter,
  isSpaceError
} = require('./photo-space');

const INDEX_KEY = 'climbingNote.gymLogTrial.photos.v1';
const THUMB_CACHE_KEY = 'climbingNote.gymLogTrial.photoThumbs.v1';
// 活跃实例租约与在途字节预留都是可重建的协调数据，不参与照片身份；
// 单独成键，避免把易变的并发状态写进受保护的照片索引。
const INSTANCE_KEY = 'climbingNote.gymLogTrial.photoInstances.v1';
const RESERVATION_KEY = 'climbingNote.gymLogTrial.photoReservations.v1';
const INDEX_VERSION = 1;
const THUMB_CACHE_VERSION = 1;
const INSTANCE_LEASE_VERSION = 1;
const RESERVATION_VERSION = 1;
// 租约过期时间：超过该时间没有心跳的实例按“已中断”处理，可恢复其遗留操作。
const INSTANCE_TTL_MS = 5 * 60 * 1000;
const LOCAL_STORAGE_TYPE = 'local';
const OPERATION_KINDS = ['add', 'replace', 'remove'];
const OPERATION_STATUSES = ['started', 'committed', 'failed', 'aborted'];

// 300–800 KB 是压缩试验目标，不是已核验的硬上限；不据此拒绝保存。
const PHOTO_POLICY = {
  mainMaxEdge: 2048,
  mainQuality: 80,
  thumbMaxEdge: 320,
  thumbQuality: 70,
  trialTargetBytes: {
    min: 300 * 1024,
    max: 800 * 1024
  }
};

const ERROR_TEXT = {
  'missing-owner': '缺少试用用户归属（ownerId），不能读写线路照片',
  'missing-dataset': '缺少试用数据集标识（datasetId），不能读写线路照片',
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
  'photo-record-missing': '照片索引与线路关联不一致，请重新添加或重置试用照片',
  'file-delete-failed': '照片文件删除失败',
  unexpected: '照片操作出现未预期错误'
};

const NON_RECOVERABLE = new Set([
  'missing-owner',
  'missing-dataset',
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

function routeKey(ownerId, datasetId, routeId) {
  return JSON.stringify([ownerId, datasetId, routeId]);
}

function isScope(record) {
  return (
    record &&
    hasText(record.ownerId) &&
    hasText(record.datasetId) &&
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
    const key = routeKey(route.ownerId, route.datasetId, route.routeId);
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
    const key = routeKey(photo.ownerId, photo.datasetId, photo.routeId);
    if (!routeKeys.has(key)) return null;
    photoByRoute.set(key, photo.photoId);
  }
  if (raw.nextPhotoSeq <= maxPhotoSeq) return null;

  for (const route of raw.routes) {
    if (!route.photoId) continue;
    const key = routeKey(route.ownerId, route.datasetId, route.routeId);
    if (photoByRoute.get(key) !== route.photoId) return null;
  }

  const operationKeys = new Set();
  let maxOpSeq = 0;
  for (const operation of raw.operations) {
    if (!operation || !hasText(operation.opId)) return null;
    if (!isSeq(operation.seq)) return null;
    if (!hasText(operation.instanceId)) return null;
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
    const key = JSON.stringify([
      operation.ownerId,
      operation.datasetId,
      operation.opId
    ]);
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
      ownerId: hasText(item.ownerId) ? item.ownerId : '',
      datasetId: hasText(item.datasetId) ? item.datasetId : '',
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
      ownerId: hasText(item.ownerId) ? item.ownerId : '',
      datasetId: hasText(item.datasetId) ? item.datasetId : '',
      photoId: isSafePhotoId(item.photoId) ? item.photoId : '',
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

function createRoutePhotoService(options) {
  const config = options || {};
  const ownerId =
    typeof config.ownerId === 'string' ? config.ownerId : '';
  const datasetId =
    typeof config.datasetId === 'string' ? config.datasetId : '';
  const files = config.files;
  const storage = config.storage || createWxStorage(config.wxApi);
  const now =
    typeof config.now === 'function'
      ? config.now
      : () => new Date().toISOString();
  const instanceId = hasText(config.instanceId)
    ? config.instanceId
    : makeInstanceId();
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
  const inflight = new Map();

  function attributionError() {
    if (!hasVisibleText(ownerId)) return fail('missing-owner');
    if (!hasVisibleText(datasetId)) return fail('missing-dataset');
    if (!files) {
      return fail('unexpected', '缺少照片文件适配器');
    }
    return null;
  }

  function operationKey(opId) {
    return JSON.stringify([ownerId, datasetId, opId]);
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

  // ---- 活跃实例租约：区分“仍然活跃的其他实例”和“真正中断的遗留操作” ----

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

  function saveLeases(instances) {
    try {
      storage.set(
        INSTANCE_KEY,
        JSON.stringify({ version: INSTANCE_LEASE_VERSION, instances })
      );
      return true;
    } catch (error) {
      // 租约是可重建的协调数据；写失败只影响“其他实例能否看到我活跃”。
      return false;
    }
  }

  function isLeaseFresh(item, timeMs) {
    if (!item || !isNonNegativeNumber(item.heartbeatMs)) return false;
    return item.heartbeatMs + instanceTtlMs >= timeMs;
  }

  /**
   * 刷新本实例的心跳。只在真正要动受管文件/索引的操作前后调用，
   * 让其他实例的 recover() 能把本实例的进行中操作视为活跃。
   */
  function touchInstance() {
    const timeMs = currentTimeMs();
    const leases = loadLeases();
    const kept = leases.instances.filter(
      item => item.instanceId !== instanceId && isLeaseFresh(item, timeMs)
    );
    kept.push({
      instanceId,
      ownerId,
      datasetId,
      heartbeatAt: now(),
      heartbeatMs: timeMs
    });
    return saveLeases(kept);
  }

  function liveInstanceIds(timeMs) {
    const leases = loadLeases();
    const live = new Set();
    for (const item of leases.instances) {
      if (isLeaseFresh(item, timeMs)) live.add(item.instanceId);
    }
    return live;
  }

  /** 丢弃过期租约，返回是否发生了写入。 */
  function pruneLeases(timeMs) {
    const leases = loadLeases();
    const kept = leases.instances.filter(item => isLeaseFresh(item, timeMs));
    if (kept.length === leases.instances.length) return false;
    if (kept.length === 0) return removeCoordinationKey(INSTANCE_KEY);
    return saveLeases(kept);
  }

  // ---- 在途字节预留：让并发的新增/更换/重建共享同一份已预留预算 ----

  function loadReservations() {
    let raw;
    try {
      raw = storage.get(RESERVATION_KEY);
    } catch (error) {
      return createEmptyReservations();
    }
    if (raw === '' || raw === null || raw === undefined) {
      return createEmptyReservations();
    }
    try {
      return normalizeReservations(
        typeof raw === 'string' ? JSON.parse(raw) : raw
      );
    } catch (error) {
      return createEmptyReservations();
    }
  }

  function saveReservations(state) {
    try {
      storage.set(RESERVATION_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 同步登记一笔预留（读—改—写之间没有 await，同一实例内不会交错）。
   * 返回 priorReservedBytes：登记顺序更早的预留合计，用于“先到先得”的预算检查。
   */
  function claimReservation(input) {
    const bytes = isNonNegativeInt(input.bytes) ? input.bytes : 0;
    const state = loadReservations();
    const claimSeq = state.nextClaimSeq;
    let priorReservedBytes = 0;
    for (const item of state.items) {
      if (item.claimSeq < claimSeq) priorReservedBytes += item.bytes;
    }
    const reservationId =
      'photo-res-' + claimSeq + '-' + Math.random().toString(36).slice(2, 8);
    const items = state.items.concat([
      {
        reservationId,
        instanceId,
        ownerId,
        datasetId,
        photoId: isSafePhotoId(input.photoId) ? input.photoId : '',
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
    return { ok: true, reservationId, priorReservedBytes, claimSeq, bytes };
  }

  function releaseReservation(reservationId) {
    if (!hasText(reservationId)) return true;
    const state = loadReservations();
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

  /** 释放已不在活跃列表中的实例预留，避免崩溃实例的预留长期占用预算。 */
  function pruneReservations(liveIds) {
    const state = loadReservations();
    const items = state.items.filter(item => liveIds.has(item.instanceId));
    if (items.length === state.items.length) return false;
    if (items.length === 0) return removeCoordinationKey(RESERVATION_KEY);
    return saveReservations({
      version: RESERVATION_VERSION,
      nextClaimSeq: state.nextClaimSeq,
      items
    });
  }

  function reservedPhotoIds() {
    return loadReservations()
      .items.map(item => item.photoId)
      .filter(photoId => Boolean(photoId));
  }

  /**
   * 需要受预算约束的一次受管写入：先登记预留，再按“实际占用 + 先到预留 + 本次新增 + R”
   * 检查峰值。调用方必须在 finally 中释放预留。
   */
  async function reserveForWrite(input) {
    touchInstance();
    const claim = claimReservation({
      photoId: input.photoId,
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
        route.ownerId === ownerId &&
        route.datasetId === datasetId &&
        route.routeId === routeId
    );
  }

  function ensureRoute(index, routeId) {
    let route = findRoute(index, routeId);
    if (route) return route;
    route = {
      ownerId,
      datasetId,
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
        photo.ownerId === ownerId &&
        photo.datasetId === datasetId
    );
  }

  function findOperation(index, opId) {
    if (!hasText(opId)) return null;
    return index.operations.find(
      operation =>
        operation.opId === opId &&
        operation.ownerId === ownerId &&
        operation.datasetId === datasetId
    );
  }

  /**
   * 按实际文件逐项计量；同一线路跨天读取不会重复计费。
   * 统计范围是专用目录中的全部受管文件（含旧数据集与孤儿文件），
   * 因为这些文件共同占用同一个本机试用预算。
   */
  async function measureIndex(index) {
    const startedPhotoIds = index.operations
      .filter(operation => operation.status === 'started' && operation.photoId)
      .map(operation => operation.photoId)
      .concat(reservedPhotoIds());
    const measured = await spaceMeter.measure({
      photos: index.photos,
      startedPhotoIds
    });
    if (!measured.ok) {
      return fail('space-measure-failed', measured.error);
    }
    const ownerPhotos = index.photos.filter(
      photo => photo.ownerId === ownerId
    );
    return Object.assign({}, measured, {
      photoCount: ownerPhotos.length,
      currentDatasetPhotoCount: ownerPhotos.filter(
        photo => photo.datasetId === datasetId
      ).length
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
      ownerId: record.ownerId,
      datasetId: record.datasetId,
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
      overTrialTarget: record.bytes.main > policy.trialTargetBytes.max
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
        if (
          existing.instanceId !== instanceId ||
          inflight.has(operationKey(opId))
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
      existing.finishedAt = '';
      existing.error = '';
      const saved = saveIndex(index);
      if (!saved.ok) return { result: saved };
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
      ownerId,
      datasetId,
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
          inflight.has(operationKey(opId))
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
      existing.finishedAt = '';
      existing.error = '';
      const saved = saveIndex(index);
      if (!saved.ok) return { result: saved };
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
      ownerId,
      datasetId,
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
    return { proceed: true, op: operation };
  }

  /**
   * 删除一个尚未被索引引用的照片文件。索引不可读时不做删除：
   * 无法证明“无引用”就不能动用户文件。
   */
  async function cleanupUncommitted(photoId) {
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
    const deleted = [];
    const errors = [];
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
    const cleanup = await cleanupUncommitted(op.photoId);
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
   * 这里按 photoId + owner 查找（不限当前数据集）：重建会覆盖保留的旧数据集照片。
   */
  function photoRecordStillPresent(photoId) {
    const loaded = loadIndex();
    if (!loaded.ok) return false;
    const record = loaded.index.photos.find(
      photo => photo.photoId === photoId && photo.ownerId === ownerId
    );
    if (!record) return false;
    const route = loaded.index.routes.find(
      item =>
        item.ownerId === record.ownerId &&
        item.datasetId === record.datasetId &&
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
          reserved.code === 'index-broken'
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

        const photo = {
          photoId: op.photoId,
          ownerId,
          datasetId,
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
    const key = operationKey(prepared.op.opId);
    if (inflight.has(key)) {
      return fail('operation-in-progress', '', {
        opId: prepared.op.opId
      });
    }
    inflight.set(key, true);
    try {
      return await runSave('add', prepared.op, prepared.sourcePath);
    } finally {
      inflight.delete(key);
    }
  }

  async function replacePhoto(input) {
    const prepared = prepareSave('replace', input || {});
    if (!prepared.proceed) return prepared.result;
    const key = operationKey(prepared.op.opId);
    if (inflight.has(key)) {
      return fail('operation-in-progress', '', {
        opId: prepared.op.opId
      });
    }
    inflight.set(key, true);
    try {
      return await runSave('replace', prepared.op, prepared.sourcePath);
    } finally {
      inflight.delete(key);
    }
  }

  async function removePhoto(input) {
    const prepared = prepareRemove(input || {});
    if (prepared.cleanupCommitted) return finishRemove(prepared.op);
    if (!prepared.proceed) return prepared.result;
    const key = operationKey(prepared.op.opId);
    if (inflight.has(key)) {
      return fail('operation-in-progress', '', {
        opId: prepared.op.opId
      });
    }
    inflight.set(key, true);
    try {
      return await runRemove(prepared.op);
    } finally {
      inflight.delete(key);
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
   */
  function collectReferencedPaths(index) {
    const referenced = new Set();
    for (const photo of index.photos) {
      referenced.add(files.mainPath(photo.photoId));
      referenced.add(files.thumbPath(photo.photoId));
    }
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
      if (!operation.photoId) continue;
      referenced.add(files.mainPath(operation.photoId));
      referenced.add(files.thumbPath(operation.photoId));
    }
    for (const photoId of reservedPhotoIds()) {
      referenced.add(files.mainPath(photoId));
      referenced.add(files.thumbPath(photoId));
    }
    return referenced;
  }

  /**
   * 清理 main/thumb 目录中无引用的本服务文件。
   * 逐个候选文件在删除前按最新索引、进行中操作与在途预留重新确认引用关系：
   * 读取文件清单期间刚提交的主图/缩略图不会被过期快照删掉。
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
      if (collectReferencedPaths(fresh.index).has(path)) continue;
      const removed = await files.remove(path);
      if (removed.ok) {
        if (removed.existed) deleted.push(path);
      } else {
        errors.push(removed.error);
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
   * 只把“租约已过期或从未登记的实例”留下的 started 操作当作崩溃遗留中止；
   * 其他仍活跃实例（含其他 owner/dataset）的进行中操作不会被本实例修改，
   * 它们的主图也不会被清理。真正的遗留操作、过期租约与预留仍然会被恢复。
   */
  async function recover() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const index = loaded.index;
    const timeMs = currentTimeMs();
    const live = liveInstanceIds(timeMs);
    // 本实例当然是活跃的；本实例自己的 started 操作交给同一 opId 的重试逻辑处理。
    live.add(instanceId);

    const abortedOps = [];
    let changed = false;
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
      if (operation.instanceId === instanceId) continue;
      if (live.has(operation.instanceId)) continue;
      operation.status = 'aborted';
      operation.finishedAt = now();
      operation.error = '服务重启，未完成操作已中止';
      abortedOps.push(operation.opId);
      changed = true;
    }
    if (changed) {
      const saved = saveIndex(index);
      if (!saved.ok) return saved;
    }

    // 过期租约与它们留下的预留一起释放，避免崩溃实例长期占用预算。
    pruneLeases(timeMs);
    pruneReservations(live);

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
          photo.ownerId === ownerId && photo.datasetId === datasetId
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

    touchInstance();
    const startReferenced = collectReferencedPaths(loaded.index);
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
      // 开始时已被引用：属于本次要清理的可重建缩略图。
      // 开始时未被引用、现在却被引用：清缓存期间新出现的照片，跳过不删。
      if (
        currentReferenced.has(file.path) &&
        !startReferenced.has(file.path)
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
   * 缩略图缺失时从持久主图重建（同一试用用户的当前与旧数据集）。
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
    // 缩略图缓存按本服务目录共享；重置后保留的旧数据集照片也属于同一试用用户，
    // 清缓存后一并重建，避免“缺失数”永远无法降到 0。
    const photos = loaded.index.photos.filter(
      photo => photo.ownerId === ownerId
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

  return {
    ownerId,
    datasetId,
    instanceId,
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
  INDEX_VERSION,
  THUMB_CACHE_VERSION,
  INSTANCE_LEASE_VERSION,
  RESERVATION_VERSION,
  INSTANCE_TTL_MS,
  LOCAL_STORAGE_TYPE,
  PHOTO_POLICY,
  ERROR_TEXT,
  createRoutePhotoService,
  createWxStorage,
  normalizeIndex,
  normalizeThumbCache,
  normalizeLeases,
  normalizeReservations,
  createEmptyIndex,
  routeKey
};
