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
 *   climbingNote.gymLogTrial.photos.v1       照片与归属索引（受保护）
 *   climbingNote.gymLogTrial.photoThumbs.v1  缩略图元数据（可重建缓存）
 *   <USER_DATA_PATH>/gym-log-trial-photos/v1/{main,thumb}/photo-<seq>.jpg
 *
 * 失败恢复入口：
 * - recover()：中止重启前未完成的操作，清理可证明无引用的本服务文件；
 * - cleanupOrphans()：只清理 main/thumb 目录中不被任何照片记录或进行中操作引用的文件。
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
const INDEX_VERSION = 1;
const THUMB_CACHE_VERSION = 1;
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
      .map(operation => operation.photoId);
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
      // 当前实际占用 + 新主图 + 新缩略图 + 更换余量，必须不超过预算。
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
      const spaceLoaded = loadIndex();
      if (!spaceLoaded.ok) {
        return markOperationFailed(op, 'index-read-failed', spaceLoaded.error);
      }
      const measured = await measureIndex(spaceLoaded.index);
      if (!measured.ok) {
        return markOperationFailed(
          op,
          'space-measure-failed',
          measured.error
        );
      }
      const spaceCheck = spaceMeter.checkSave(
        measured.totalBytes,
        mainTempStat.bytes,
        thumbTempStat.bytes
      );
      if (!spaceCheck.ok) {
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

      const mainWritten = await files.writeMain(
        op.photoId,
        mainCompressed.path
      );
      if (!mainWritten.ok) {
        return markOperationFailed(op, 'file-write-failed', mainWritten.error);
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
    const written = await files.writeThumb(photoId, compressed.path);
    if (!written.ok) {
      return fail('thumbnail-failed', written.error, {
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

  async function cleanupOrphansWithIndex(index) {
    const referenced = new Set();
    for (const photo of index.photos) {
      referenced.add(files.mainPath(photo.photoId));
      referenced.add(files.thumbPath(photo.photoId));
    }
    // 其他实例仍在执行的操作，其文件尚不能证明无引用。
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
      if (operation.photoId) {
        referenced.add(files.mainPath(operation.photoId));
        referenced.add(files.thumbPath(operation.photoId));
      }
    }

    const deleted = [];
    const errors = [];
    const mainList = await files.listMain();
    if (!mainList.ok) errors.push(mainList.error);
    if (mainList.ok) {
      for (const file of mainList.files) {
        if (referenced.has(file.path)) continue;
        const removed = await files.remove(file.path);
        if (removed.ok) {
          if (removed.existed) deleted.push(file.path);
        } else {
          errors.push(removed.error);
        }
      }
    }
    const thumbList = await files.listThumb();
    if (!thumbList.ok) errors.push(thumbList.error);
    if (thumbList.ok) {
      for (const file of thumbList.files) {
        if (referenced.has(file.path)) continue;
        const removed = await files.remove(file.path);
        if (removed.ok) {
          if (removed.existed) deleted.push(file.path);
        } else {
          errors.push(removed.error);
        }
      }
    }

    if (errors.length) {
      return fail('file-delete-failed', errors.join('；'), { deleted });
    }
    return { ok: true, deleted };
  }

  async function cleanupOrphans() {
    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    return cleanupOrphansWithIndex(loaded.index);
  }

  async function recover() {
    const invalidAttribution = attributionError();
    if (invalidAttribution) return invalidAttribution;

    const loaded = loadIndex();
    if (!loaded.ok) return loaded;
    const index = loaded.index;
    const abortedOps = [];
    let changed = false;
    for (const operation of index.operations) {
      if (operation.status !== 'started') continue;
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

    // 缩略图缓存可重建：只保留仍有照片记录的条目。
    const cache = loadThumbCache();
    const photoIds = new Set(index.photos.map(photo => photo.photoId));
    const kept = cache.items.filter(item => photoIds.has(item.photoId));
    if (kept.length !== cache.items.length) {
      saveThumbCache({ version: THUMB_CACHE_VERSION, items: kept });
    }

    const cleanup = await cleanupOrphansWithIndex(index);
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

  function clearThumbCacheKey() {
    try {
      if (typeof storage.remove === 'function') {
        storage.remove(THUMB_CACHE_KEY);
      } else {
        storage.set(THUMB_CACHE_KEY, JSON.stringify(createEmptyThumbCache()));
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 普通清缓存：只删除可重建的缩略图文件与缩略图元数据。
   * 主图、照片索引、场次、尝试、待确认操作和其他缓存键都不动。
   * 有照片操作未完成时拒绝执行，避免删掉正在写入的缩略图。
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

    const thumbList = await files.listThumb();
    if (!thumbList.ok) {
      return fail('file-delete-failed', thumbList.error);
    }

    const deleted = [];
    const errors = [];
    for (const file of thumbList.files) {
      const removed = await files.remove(file.path);
      if (removed.ok) {
        if (removed.existed) deleted.push(file.path);
      } else {
        errors.push(removed.error);
      }
    }
    const thumbCacheCleared = clearThumbCacheKey();
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
  INDEX_VERSION,
  THUMB_CACHE_VERSION,
  LOCAL_STORAGE_TYPE,
  PHOTO_POLICY,
  ERROR_TEXT,
  createRoutePhotoService,
  createWxStorage,
  normalizeIndex,
  normalizeThumbCache,
  createEmptyIndex,
  routeKey
};
