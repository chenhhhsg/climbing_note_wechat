/**
 * 岩馆快速记录 · 线路照片本地持久服务测试（PS01–PS06）
 *
 * 直接加载 devtools/gym-log/utils/ 下的真实服务与文件适配器：
 * - PS01/PS02/PS03/PS04/PS05 用可控文件与存储替身验证归属、原子提交、
 *   失败恢复、重复/乱序和移除边界；
 * - PS06 另用 Node 实际磁盘文件系统执行真实文件适配器，证明持久文件、
 *   临时文件失效后的读取、缩略图和索引位置分开。
 *
 * 替身通过不代表开发者工具、真机或正式账号隔离已通过。
 *
 * 运行：node --test tests/route-photos.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEV_PROJECT = path.join(ROOT, 'devtools', 'gym-log');
const PHOTO_FILES_JS = path.join(DEV_PROJECT, 'utils', 'photo-files.js');
const ROUTE_PHOTOS_JS = path.join(DEV_PROJECT, 'utils', 'route-photos.js');

const photoFiles = require(PHOTO_FILES_JS);
const routePhotos = require(ROUTE_PHOTOS_JS);

const INDEX_KEY = routePhotos.INDEX_KEY;
const THUMB_CACHE_KEY = routePhotos.THUMB_CACHE_KEY;

const L1 = 'route-chalkbox-blue-dyn';
const L2 = 'route-chalkbox-blue-balance';
const L3 = 'route-local-1';

const ROOT_DIR = '/wx/user/gym-log-trial-photos/v1';
const MAIN_DIR = ROOT_DIR + '/main';
const THUMB_DIR = ROOT_DIR + '/thumb';

function createFakeFiles() {
  const sources = new Map();
  const mains = new Map();
  const thumbs = new Map();
  const compressed = new Map();
  const calls = {
    ensureReady: 0,
    getImageInfo: 0,
    compress: [],
    writeMain: 0,
    writeThumb: 0,
    remove: [],
    stat: 0,
    listMain: 0,
    listThumb: 0
  };
  const faults = {
    ensureReady: 0,
    getImageInfo: 0,
    compress: 0,
    writeMain: 0,
    writeThumb: 0,
    stat: 0,
    remove: 0,
    listMain: 0,
    listThumb: 0
  };
  const faultOptions = { writeMainLeavesPartial: false };
  let sourceSeq = 0;
  let compressSeq = 0;

  const holdMap = {
    ensureReady: [],
    getImageInfo: [],
    compress: [],
    writeMain: [],
    writeThumb: [],
    stat: [],
    remove: [],
    listMain: [],
    listThumb: []
  };
  const callCounts = {};
  const callWaiters = [];

  function noteCall(name) {
    callCounts[name] = (callCounts[name] || 0) + 1;
    const count = callCounts[name];
    for (let index = callWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = callWaiters[index];
      if (waiter.name === name && count >= waiter.index) {
        callWaiters.splice(index, 1);
        waiter.resolve(count);
      }
    }
    return count;
  }

  function waitForCall(name, index) {
    if ((callCounts[name] || 0) >= index) {
      return Promise.resolve(callCounts[name]);
    }
    return new Promise(resolve => {
      callWaiters.push({ name, index, resolve });
    });
  }

  function holdCall(name, index) {
    let release;
    const promise = new Promise(resolve => {
      release = resolve;
    });
    const hold = { index, promise, release };
    holdMap[name].push(hold);
    return function releaseHold() {
      const at = holdMap[name].indexOf(hold);
      if (at !== -1) holdMap[name].splice(at, 1);
      release();
    };
  }

  async function maybeHold(name, count) {
    const list = holdMap[name] || [];
    const hold = list.find(item => item.index === count);
    if (hold) await hold.promise;
  }

  function consumeFault(name) {
    if (faults[name] > 0) {
      faults[name] -= 1;
      return true;
    }
    return false;
  }

  function addSource(options) {
    sourceSeq += 1;
    const srcPath = '/wx/tmp/picker-' + sourceSeq + '.png';
    sources.set(srcPath, {
      bytes: options.bytes,
      width: options.width,
      height: options.height
    });
    return srcPath;
  }

  function removeSource(srcPath) {
    sources.delete(srcPath);
  }

  function mainPath(photoId) {
    return MAIN_DIR + '/' + photoId + '.jpg';
  }

  function thumbPath(photoId) {
    return THUMB_DIR + '/' + photoId + '.jpg';
  }

  function hasMain(photoId) {
    return mains.has(photoId);
  }

  function hasThumb(photoId) {
    return thumbs.has(photoId);
  }

  function mainBytes(photoId) {
    return mains.has(photoId) ? mains.get(photoId).bytes : 0;
  }

  function thumbBytes(photoId) {
    return thumbs.has(photoId) ? thumbs.get(photoId).bytes : 0;
  }

  function scaleDimensions(width, height, maxEdge) {
    const longest = Math.max(width, height);
    const scale = maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }

  function readEntry(srcPath) {
    if (sources.has(srcPath)) return sources.get(srcPath);
    if (compressed.has(srcPath)) return compressed.get(srcPath);
    const name = path.posix.basename(srcPath).replace(/\.jpg$/i, '');
    if (srcPath.indexOf(MAIN_DIR + '/') === 0 && mains.has(name)) {
      return mains.get(name);
    }
    return null;
  }

  return {
    rootDir: ROOT_DIR,
    mainDir: MAIN_DIR,
    thumbDir: THUMB_DIR,
    mainPath,
    thumbPath,
    addSource,
    removeSource,
    hasMain,
    hasThumb,
    mainBytes,
    thumbBytes,
    mains,
    thumbs,
    sources,
    calls,
    faults,
    faultOptions,
    waitForCall,
    holdCall,

    async ensureReady() {
      calls.ensureReady += 1;
      const count = noteCall('ensureReady');
      await maybeHold('ensureReady', count);
      if (consumeFault('ensureReady')) {
        return { ok: false, error: 'fake ensureReady failure' };
      }
      return { ok: true };
    },

    async getImageInfo(srcPath) {
      calls.getImageInfo += 1;
      const count = noteCall('getImageInfo');
      await maybeHold('getImageInfo', count);
      if (consumeFault('getImageInfo')) {
        return { ok: false, error: 'fake getImageInfo failure' };
      }
      const entry = readEntry(srcPath);
      if (!entry) return { ok: false, error: 'fake source missing' };
      return {
        ok: true,
        width: entry.width,
        height: entry.height,
        type: 'png'
      };
    },

    async compressImage(options) {
      const count = noteCall('compress');
      await maybeHold('compress', count);
      if (consumeFault('compress')) {
        return { ok: false, error: 'fake compress failure' };
      }
      const entry = readEntry(options.srcPath);
      if (!entry) return { ok: false, error: 'fake compress source missing' };
      compressSeq += 1;
      const dims = scaleDimensions(
        entry.width,
        entry.height,
        options.maxEdge
      );
      const outPath = '/wx/tmp/compressed-' + compressSeq + '.png';
      compressed.set(outPath, {
        bytes: entry.bytes,
        width: dims.width,
        height: dims.height
      });
      calls.compress.push({
        srcPath: options.srcPath,
        maxEdge: options.maxEdge,
        quality: options.quality,
        width: dims.width,
        height: dims.height
      });
      return {
        ok: true,
        path: outPath,
        width: dims.width,
        height: dims.height
      };
    },

    async writeMain(photoId, srcPath) {
      calls.writeMain += 1;
      const count = noteCall('writeMain');
      await maybeHold('writeMain', count);
      const entry = readEntry(srcPath);
      if (consumeFault('writeMain') || !entry) {
        if (faultOptions.writeMainLeavesPartial) {
          mains.set(photoId, {
            bytes: 10,
            width: entry ? entry.width : 1,
            height: entry ? entry.height : 1
          });
        }
        return { ok: false, error: 'fake writeMain failure' };
      }
      mains.set(photoId, {
        bytes: entry.bytes,
        width: entry.width,
        height: entry.height
      });
      return { ok: true, path: mainPath(photoId), bytes: entry.bytes };
    },

    async writeThumb(photoId, srcPath) {
      calls.writeThumb += 1;
      const count = noteCall('writeThumb');
      await maybeHold('writeThumb', count);
      const entry = readEntry(srcPath);
      if (consumeFault('writeThumb') || !entry) {
        return { ok: false, error: 'fake writeThumb failure' };
      }
      thumbs.set(photoId, {
        bytes: entry.bytes,
        width: entry.width,
        height: entry.height
      });
      return { ok: true, path: thumbPath(photoId), bytes: entry.bytes };
    },

    async stat(targetPath) {
      calls.stat += 1;
      const count = noteCall('stat');
      await maybeHold('stat', count);
      if (consumeFault('stat')) {
        return { ok: false, error: 'fake stat failure' };
      }
      if (targetPath.indexOf(MAIN_DIR + '/') === 0) {
        const name = path.posix.basename(targetPath).replace(/\.jpg$/i, '');
        if (!mains.has(name)) return { ok: true, exists: false, bytes: 0 };
        return { ok: true, exists: true, bytes: mains.get(name).bytes };
      }
      if (targetPath.indexOf(THUMB_DIR + '/') === 0) {
        const name = path.posix.basename(targetPath).replace(/\.jpg$/i, '');
        if (!thumbs.has(name)) return { ok: true, exists: false, bytes: 0 };
        return { ok: true, exists: true, bytes: thumbs.get(name).bytes };
      }
      if (sources.has(targetPath) || compressed.has(targetPath)) {
        const entry = sources.get(targetPath) || compressed.get(targetPath);
        return { ok: true, exists: true, bytes: entry.bytes };
      }
      return { ok: true, exists: false, bytes: 0 };
    },

    async remove(targetPath) {
      calls.remove.push(targetPath);
      const count = noteCall('remove');
      await maybeHold('remove', count);
      if (consumeFault('remove')) {
        return { ok: false, error: 'fake remove failure' };
      }
      if (targetPath.indexOf(MAIN_DIR + '/') === 0) {
        const name = path.posix.basename(targetPath).replace(/\.jpg$/i, '');
        const existed = mains.delete(name);
        return { ok: true, existed };
      }
      if (targetPath.indexOf(THUMB_DIR + '/') === 0) {
        const name = path.posix.basename(targetPath).replace(/\.jpg$/i, '');
        const existed = thumbs.delete(name);
        return { ok: true, existed };
      }
      return { ok: true, existed: false };
    },

    async listMain() {
      calls.listMain += 1;
      const count = noteCall('listMain');
      await maybeHold('listMain', count);
      if (consumeFault('listMain')) {
        return { ok: false, error: 'fake listMain failure' };
      }
      return {
        ok: true,
        files: Array.from(mains.keys()).map(photoId => ({
          name: photoId + '.jpg',
          path: mainPath(photoId)
        }))
      };
    },

    async listThumb() {
      calls.listThumb += 1;
      const count = noteCall('listThumb');
      await maybeHold('listThumb', count);
      if (consumeFault('listThumb')) {
        return { ok: false, error: 'fake listThumb failure' };
      }
      return {
        ok: true,
        files: Array.from(thumbs.keys()).map(photoId => ({
          name: photoId + '.jpg',
          path: thumbPath(photoId)
        }))
      };
    }
  };
}

function createFakeStorage() {
  const map = new Map();
  const log = { gets: [], sets: [] };
  const faults = { failGet: false, failIndexSetAt: 0, indexSets: 0 };
  return {
    map,
    log,
    faults,
    get(key) {
      log.gets.push(key);
      if (faults.failGet) {
        throw { errMsg: 'getStorageSync:fail mock' };
      }
      return map.has(key) ? map.get(key) : '';
    },
    set(key, value) {
      log.sets.push(key);
      if (key === INDEX_KEY) {
        faults.indexSets += 1;
        if (
          faults.failIndexSetAt > 0 &&
          faults.indexSets === faults.failIndexSetAt
        ) {
          throw { errMsg: 'setStorageSync:fail mock index write' };
        }
      }
      map.set(key, value);
    },
    raw(key) {
      const value = map.get(key);
      return value ? JSON.parse(value) : null;
    },
    has(key) {
      return map.has(key);
    }
  };
}

function createHarness(options) {
  const config = options || {};
  const files = createFakeFiles();
  const storage = createFakeStorage();
  const service = routePhotos.createRoutePhotoService({
    ownerId: config.ownerId === undefined ? 'trial-user-a' : config.ownerId,
    datasetId: config.datasetId === undefined ? 'trial-dataset-1' : config.datasetId,
    files,
    storage,
    instanceId: config.instanceId || 'svc-a',
    now: () => '2026-11-06T10:00:00.000Z'
  });
  return { files, storage, service };
}

function newService(harness, options) {
  const config = options || {};
  return routePhotos.createRoutePhotoService({
    ownerId: config.ownerId || 'trial-user-a',
    datasetId: config.datasetId || 'trial-dataset-1',
    files: harness.files,
    storage: harness.storage,
    instanceId: config.instanceId || 'svc-b',
    now: () => '2026-11-06T11:00:00.000Z'
  });
}

function sample(files, name) {
  const presets = {
    p1: { bytes: 520 * 1024, width: 3000, height: 2000 },
    p2: { bytes: 640 * 1024, width: 2400, height: 3200 },
    p3: { bytes: 410 * 1024, width: 1600, height: 1200 },
    p4: { bytes: 900 * 1024, width: 4000, height: 3000 }
  };
  return files.addSource(presets[name] || presets.p1);
}

function indexOf(storage) {
  return storage.raw(INDEX_KEY);
}

function operationOf(storage, opId) {
  const index = indexOf(storage);
  if (!index) return null;
  return (
    index.operations.find(operation => operation.opId === opId) || null
  );
}

async function readRoute(service, routeId) {
  return service.getRoutePhoto({ routeId });
}

// ---- PS01 持久化 ----

test('PS01 保存后临时文件失效、实例重建仍按归属读到同一 photoId 与持久主图', async () => {
  const harness = createHarness();
  const src = sample(harness.files, 'p1');

  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-save-1'
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.duplicate, false);
  assert.match(saved.photoId, /^photo-\d+$/);
  assert.equal(saved.photo.photoId, saved.photoId);
  assert.equal(saved.photo.storage.type, 'local');
  assert.equal(
    saved.photo.storage.location,
    harness.files.mainPath(saved.photoId),
    '索引位置必须是用户文件目录中的持久路径'
  );
  assert.ok(
    !saved.photo.storage.location.includes('/wx/tmp/'),
    '持久位置不能是选择器临时路径'
  );
  assert.equal(saved.photo.bytes.main, 520 * 1024);
  assert.equal(saved.photo.width, 2048);
  assert.equal(saved.photo.height, 1365);
  assert.equal(saved.photo.overTrialTarget, false);

  assert.equal(harness.files.hasMain(saved.photoId), true);
  assert.equal(harness.files.hasThumb(saved.photoId), true);
  assert.equal(harness.files.thumbBytes(saved.photoId), 520 * 1024);
  assert.equal(harness.files.calls.compress.length, 2);
  assert.equal(
    harness.files.calls.compress[1].srcPath.indexOf('/main/'),
    -1,
    '缩略图从压缩后的临时图生成，不依赖压缩器读取持久主图路径'
  );

  // 选择器临时文件按平台行为失效后，持久主图仍可读。
  harness.files.removeSource(src);
  assert.equal(harness.files.sources.has(src), false);

  const rebuilt = newService(harness);
  const read = await readRoute(rebuilt, L1);
  assert.equal(read.ok, true);
  assert.equal(read.status, 'ready');
  assert.equal(read.photo.photoId, saved.photoId);
  assert.equal(
    read.photo.storage.location,
    harness.files.mainPath(saved.photoId)
  );
  assert.equal(read.photo.thumbnail.available, true);
  assert.equal(
    read.photo.thumbnail.location,
    harness.files.thumbPath(saved.photoId)
  );

  const index = indexOf(harness.storage);
  assert.equal(index.version, routePhotos.INDEX_VERSION);
  assert.equal(index.photos.length, 1);
  assert.equal(index.routes.length, 1);
  assert.equal(index.routes[0].photoId, saved.photoId);
  assert.equal(operationOf(harness.storage, 'op-save-1').status, 'committed');
  assert.ok(
    !JSON.stringify(index).includes('/wx/tmp/'),
    '索引中不得出现选择器临时路径'
  );
  assert.ok(
    harness.storage.log.gets
      .concat(harness.storage.log.sets)
      .every(key => key === INDEX_KEY || key === THUMB_CACHE_KEY),
    '只读写照片专用键'
  );
  assert.equal(
    routePhotos.THUMB_CACHE_KEY.indexOf('climbingNote.gymLogTrial.'),
    0
  );
  assert.notEqual(routePhotos.THUMB_CACHE_KEY, INDEX_KEY);
  assert.equal(index.photos[0].storage.type, 'local');
  assert.notEqual(index.photos[0].photoId, index.photos[0].storage.location);
});

test('PS01 索引提交失败时不显示成功，且清理未被引用的新文件', async () => {
  const harness = createHarness();
  const src = sample(harness.files, 'p1');
  // 第 1 次索引写入记录操作启动，第 2 次是提交；让提交失败。
  harness.storage.faults.failIndexSetAt = 2;

  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-index-fail'
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'index-write-failed');
  assert.equal(saved.recoverable, true);
  assert.match(saved.error, /照片索引写入失败/);

  const read = await readRoute(harness.service, L1);
  assert.equal(read.ok, true);
  assert.equal(read.status, 'none');
  assert.equal(read.photo, null);

  assert.equal(harness.files.hasMain(saved.photoId), false, '未提交主图应被清理');
  assert.equal(harness.files.hasThumb(saved.photoId), false);
  const index = indexOf(harness.storage);
  assert.equal(index.photos.length, 0);
  assert.equal(operationOf(harness.storage, 'op-index-fail').status, 'failed');

  // 清掉注入后同一 opId 重试：复用同一 photoId，只产生一个有效主图。
  harness.storage.faults.failIndexSetAt = 0;
  const retried = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-index-fail'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.photoId, saved.photoId);
  assert.equal(harness.files.mains.size, 1);
  assert.equal(harness.files.thumbs.size, 1);
  assert.equal(indexOf(harness.storage).photos.length, 1);
  assert.equal(operationOf(harness.storage, 'op-index-fail').status, 'committed');
  const afterRetry = await readRoute(harness.service, L1);
  assert.equal(afterRetry.photo.photoId, saved.photoId);
});

// ---- PS02 归属 ----

test('PS02 虚构 A/B、同色同级线路与不同数据集互不串线', async () => {
  const harness = createHarness();
  const userB = newService(harness, {
    ownerId: 'trial-user-b',
    instanceId: 'svc-b'
  });
  const datasetTwo = newService(harness, {
    datasetId: 'trial-dataset-2',
    instanceId: 'svc-ds2'
  });

  const a1 = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'a-l1'
  });
  const a2 = await harness.service.addPhoto({
    routeId: L2,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'a-l2'
  });
  // 数据集 1 先在同编号的新建线路上保存一张，验证数据集 3 不会继承。
  const a3 = await harness.service.addPhoto({
    routeId: L3,
    sourcePath: sample(harness.files, 'p4'),
    opId: 'a-l3'
  });
  const b1 = await userB.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p3'),
    opId: 'b-l1'
  });
  const d1 = await datasetTwo.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p4'),
    opId: 'ds2-l1'
  });

  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);
  assert.equal(a3.ok, true);
  assert.equal(b1.ok, true);
  assert.equal(d1.ok, true);
  assert.notEqual(a1.photoId, a2.photoId, '同色同级两条线各自独立');
  assert.notEqual(a1.photoId, b1.photoId, '不同用户各自独立');
  assert.notEqual(a1.photoId, d1.photoId, '不同数据集各自独立');

  const readA1 = await readRoute(harness.service, L1);
  const readA2 = await readRoute(harness.service, L2);
  const readA3 = await readRoute(harness.service, L3);
  const readB1 = await readRoute(userB, L1);
  const readD1 = await readRoute(datasetTwo, L1);
  assert.equal(readA1.photo.photoId, a1.photoId);
  assert.equal(readA2.photo.photoId, a2.photoId);
  assert.equal(readA3.photo.photoId, a3.photoId);
  assert.equal(readB1.photo.photoId, b1.photoId);
  assert.equal(readD1.photo.photoId, d1.photoId);

  // 新数据集不得继承同编号旧线路的照片。
  const freshDataset = newService(harness, {
    datasetId: 'trial-dataset-3',
    instanceId: 'svc-ds3'
  });
  const fresh = await readRoute(freshDataset, L3);
  assert.equal(fresh.status, 'none');
  assert.equal(fresh.photo, null);
  assert.equal(
    (await readRoute(harness.service, L3)).photo.photoId,
    a3.photoId,
    '原数据集仍能读到自己的同编号线路照片'
  );

  // 更换 A 的 L1 不影响 A 的 L2、B 的 L1、数据集 2 的 L1。
  const replaced = await harness.service.replacePhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p3'),
    opId: 'a-l1-replace'
  });
  assert.equal(replaced.ok, true);
  assert.notEqual(replaced.photoId, a1.photoId);
  assert.equal((await readRoute(harness.service, L2)).photo.photoId, a2.photoId);
  assert.equal((await readRoute(userB, L1)).photo.photoId, b1.photoId);
  assert.equal((await readRoute(datasetTwo, L1)).photo.photoId, d1.photoId);
  assert.equal(
    (await readRoute(harness.service, L1)).photo.photoId,
    replaced.photoId
  );

  // 移除 A 的 L1 也不影响其他归属。
  const removed = await harness.service.removePhoto({
    routeId: L1,
    opId: 'a-l1-remove'
  });
  assert.equal(removed.ok, true);
  assert.equal((await readRoute(harness.service, L1)).status, 'none');
  assert.equal((await readRoute(harness.service, L2)).photo.photoId, a2.photoId);
  assert.equal((await readRoute(harness.service, L3)).photo.photoId, a3.photoId);
  assert.equal((await readRoute(userB, L1)).photo.photoId, b1.photoId);
  assert.equal((await readRoute(datasetTwo, L1)).photo.photoId, d1.photoId);
  assert.equal(harness.files.hasMain(replaced.photoId), false);

  // 用 B 的 photoId 查 A 的读接口：不暴露其他归属的照片。
  const leaked = await harness.service.getPhoto({ photoId: b1.photoId });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.code, 'not-found');
});

test('PS02 缺少必要归属或线路标识时返回可识别错误且不写文件', async () => {
  const harness = createHarness();
  const src = sample(harness.files, 'p1');

  const noOwner = routePhotos.createRoutePhotoService({
    ownerId: '',
    datasetId: 'trial-dataset-1',
    files: harness.files,
    storage: harness.storage,
    instanceId: 'svc-no-owner'
  });
  const missingOwner = await noOwner.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'no-owner'
  });
  assert.equal(missingOwner.ok, false);
  assert.equal(missingOwner.code, 'missing-owner');
  assert.match(missingOwner.error, /ownerId/);

  const noDataset = routePhotos.createRoutePhotoService({
    ownerId: 'trial-user-a',
    datasetId: '   ',
    files: harness.files,
    storage: harness.storage,
    instanceId: 'svc-no-dataset'
  });
  const missingDataset = await noDataset.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'no-dataset'
  });
  assert.equal(missingDataset.ok, false);
  assert.equal(missingDataset.code, 'missing-dataset');

  const missingRoute = await harness.service.addPhoto({
    routeId: '',
    sourcePath: src,
    opId: 'no-route'
  });
  assert.equal(missingRoute.ok, false);
  assert.equal(missingRoute.code, 'missing-route');

  const missingSource = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: '',
    opId: 'no-source'
  });
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.code, 'missing-source');

  assert.equal(harness.files.calls.getImageInfo, 0);
  assert.equal(harness.files.calls.writeMain, 0);
  assert.equal(harness.storage.log.sets.length, 0);
  assert.equal(harness.storage.has(INDEX_KEY), false);
});

// ---- PS03 原子结果与恢复 ----

test('PS03 压缩、尺寸读取、主图写入与缩略图失败都不留假成功索引', async () => {
  const cases = [
    {
      label: '压缩失败',
      fault: 'compress',
      code: 'compress-failed'
    },
    {
      label: '尺寸读取失败',
      fault: 'getImageInfo',
      code: 'source-unreadable'
    },
    {
      label: '主图写入失败',
      fault: 'writeMain',
      code: 'file-write-failed',
      leavePartial: true
    },
    {
      label: '缩略图写入失败',
      fault: 'writeThumb',
      code: 'thumbnail-failed'
    }
  ];

  for (const item of cases) {
    const harness = createHarness();
    const src = sample(harness.files, 'p1');
    harness.files.faults[item.fault] = 1;
    if (item.leavePartial) {
      harness.files.faultOptions.writeMainLeavesPartial = true;
    }

    const saved = await harness.service.addPhoto({
      routeId: L1,
      sourcePath: src,
      opId: 'op-fault-' + item.fault
    });

    assert.equal(saved.ok, false, item.label);
    assert.equal(saved.code, item.code, item.label);
    assert.match(saved.error, /\S/);
    const read = await readRoute(harness.service, L1);
    assert.equal(read.status, 'none', item.label);
    assert.equal(read.photo, null, item.label);
    const index = indexOf(harness.storage);
    assert.equal(index.photos.length, 0, item.label + ' 不得留照片记录');
    assert.equal(index.routes[0].photoId, '', item.label);
    assert.equal(
      operationOf(harness.storage, 'op-fault-' + item.fault).status,
      'failed',
      item.label
    );
    assert.equal(
      harness.files.mains.size,
      0,
      item.label + ' 不得留下未引用主图'
    );
    assert.equal(
      harness.files.thumbs.size,
      0,
      item.label + ' 不得留下未引用缩略图'
    );
  }
});

test('PS03 操作启动时索引写入失败则不碰任何照片文件', async () => {
  const harness = createHarness();
  const src = sample(harness.files, 'p1');
  harness.storage.faults.failIndexSetAt = 1;

  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-start-fail'
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'index-write-failed');
  assert.equal(harness.files.calls.getImageInfo, 0);
  assert.equal(harness.files.calls.writeMain, 0);
  assert.equal(harness.files.calls.writeThumb, 0);
  assert.equal(harness.files.mains.size, 0);
  assert.equal(harness.storage.has(INDEX_KEY), false);
});

test('PS03 更换失败保留旧照片，重试后只留一个新主图', async () => {
  const harness = createHarness();
  const first = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-first'
  });
  const oldPath = first.photo.storage.location;

  harness.files.faults.writeMain = 1;
  harness.files.faultOptions.writeMainLeavesPartial = true;
  const failed = await harness.service.replacePhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-replace'
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'file-write-failed');
  const stillOld = await readRoute(harness.service, L1);
  assert.equal(stillOld.ok, true);
  assert.equal(stillOld.photo.photoId, first.photoId);
  assert.equal(stillOld.photo.storage.location, oldPath);
  assert.equal(harness.files.hasMain(first.photoId), true, '旧主图仍可读');
  assert.equal(harness.files.mains.size, 1, '失败的新文件不留孤儿');
  assert.equal(operationOf(harness.storage, 'op-replace').status, 'failed');

  const retried = await harness.service.replacePhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p3'),
    opId: 'op-replace'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicate, false);
  assert.notEqual(retried.photoId, first.photoId);
  assert.equal(harness.files.hasMain(first.photoId), false, '旧主图已清理');
  assert.equal(harness.files.mains.size, 1, '只保留一个有效主图');
  assert.equal(harness.files.thumbs.size, 1);
  assert.equal(
    (await readRoute(harness.service, L1)).photo.photoId,
    retried.photoId
  );
  assert.equal(operationOf(harness.storage, 'op-replace').status, 'committed');
});

test('PS03 步骤间中断后重启可中止操作、清理孤儿且不误删已引用主图', async () => {
  const harness = createHarness();
  const kept = await harness.service.addPhoto({
    routeId: L2,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-kept'
  });
  assert.equal(kept.ok, true);

  const releaseWrite = harness.files.holdCall('writeMain', 2);
  const interrupted = harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-interrupted'
  });
  await harness.files.waitForCall('writeMain', 2);
  assert.equal(operationOf(harness.storage, 'op-interrupted').status, 'started');

  const restarted = newService(harness, { instanceId: 'svc-restarted' });
  const recovered = await restarted.recover();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.abortedOps, ['op-interrupted']);
  assert.equal(
    operationOf(harness.storage, 'op-interrupted').status,
    'aborted'
  );
  assert.equal(harness.files.hasMain(kept.photoId), true, '被引用的主图不能删');
  assert.equal(harness.files.hasThumb(kept.photoId), true);

  releaseWrite();
  const late = await interrupted;
  assert.equal(late.ok, false);
  assert.equal(late.code, 'stale-operation');
  assert.equal(harness.files.hasMain(late.photoId), false, '迟到结果自行清理');

  const after = await readRoute(restarted, L1);
  assert.equal(after.status, 'none');
  const keptRead = await readRoute(restarted, L2);
  assert.equal(keptRead.ok, true);
  assert.equal(keptRead.photo.photoId, kept.photoId);

  // 重启后同一 opId 可以安全重试，且最终只有一个主图。
  const retried = await restarted.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-interrupted'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicate, false);
  assert.equal(harness.files.mains.size, 2);
  assert.equal(
    (await readRoute(restarted, L1)).photo.photoId,
    retried.photoId
  );
  assert.equal(operationOf(harness.storage, 'op-interrupted').status, 'committed');
});

test('PS03 重启清理孤立文件，同时保留索引引用的主图与缩略图', async () => {
  const harness = createHarness();
  const kept = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-kept'
  });
  // 模拟上一次中断留下的、无索引引用的本服务文件。
  harness.files.mains.set('photo-999', {
    bytes: 12345,
    width: 300,
    height: 200
  });
  harness.files.thumbs.set('photo-999', {
    bytes: 2345,
    width: 100,
    height: 80
  });

  const restarted = newService(harness, { instanceId: 'svc-clean' });
  const cleaned = await restarted.cleanupOrphans();
  assert.equal(cleaned.ok, true);
  assert.ok(cleaned.deleted.includes(harness.files.mainPath('photo-999')));
  assert.ok(cleaned.deleted.includes(harness.files.thumbPath('photo-999')));
  assert.equal(harness.files.hasMain('photo-999'), false);
  assert.equal(harness.files.hasThumb('photo-999'), false);
  assert.equal(harness.files.hasMain(kept.photoId), true);
  assert.equal(harness.files.hasThumb(kept.photoId), true);
});

test('PS03 索引损坏时拒绝重建和删除，已有主图保持原样', async () => {
  const harness = createHarness();
  const kept = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-kept'
  });
  const broken = indexOf(harness.storage);
  broken.version = routePhotos.INDEX_VERSION + 1;
  harness.storage.map.set(INDEX_KEY, JSON.stringify(broken));

  const read = await readRoute(harness.service, L1);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'index-broken');

  const recovered = await harness.service.recover();
  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'index-broken');
  assert.equal(harness.files.hasMain(kept.photoId), true, '损坏时不得清理用户文件');

  // 读取索引抛错时也不做删除。
  harness.storage.faults.failGet = true;
  const readFailed = await harness.service.getRoutePhoto({ routeId: L1 });
  assert.equal(readFailed.code, 'index-read-failed');
  const recoverFailed = await harness.service.recover();
  assert.equal(recoverFailed.code, 'index-read-failed');
  assert.equal(harness.files.hasMain(kept.photoId), true);
});

// ---- PS04 重复与乱序 ----

test('PS04 重复调用同一 opId 只提交一次，返回同一 photoId', async () => {
  const harness = createHarness();
  const src = sample(harness.files, 'p1');
  const first = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-dup'
  });
  const second = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: src,
    opId: 'op-dup'
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.photoId, first.photoId);
  assert.equal(harness.files.calls.writeMain, 1);
  assert.equal(harness.files.mains.size, 1);
  assert.equal(indexOf(harness.storage).photos.length, 1);
  assert.equal(
    indexOf(harness.storage).operations.filter(
      operation => operation.opId === 'op-dup'
    ).length,
    1
  );

  // 同一线路再次保存（新 opId）走 already-has-photo，不重复写文件。
  const third = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-dup-new'
  });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'already-has-photo');
  assert.equal(harness.files.calls.writeMain, 1);
});

test('PS04 同一 opId 并发调用不重复提交，第二次返回进行中', async () => {
  const harness = createHarness();
  const release = harness.files.holdCall('writeMain', 1);
  const pending = harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-concurrent-same'
  });
  await harness.files.waitForCall('writeMain', 1);

  const duplicate = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-concurrent-same'
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'operation-in-progress');
  assert.equal(harness.files.calls.writeMain, 1);

  release();
  const finished = await pending;
  assert.equal(finished.ok, true);
  assert.equal(harness.files.calls.writeMain, 1);
  assert.equal(indexOf(harness.storage).photos.length, 1);
});

test('PS04 两个不同 opId 并发：较新操作获胜，较旧迟到结果不得覆盖', async () => {
  const harness = createHarness();
  const releaseOne = harness.files.holdCall('writeMain', 1);
  const releaseTwo = harness.files.holdCall('writeMain', 2);

  const older = harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-older'
  });
  await harness.files.waitForCall('writeMain', 1);
  const newer = harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-newer'
  });
  await harness.files.waitForCall('writeMain', 2);

  releaseTwo();
  const newerResult = await newer;
  assert.equal(newerResult.ok, true);
  releaseOne();
  const olderResult = await older;
  assert.equal(olderResult.ok, false);
  assert.equal(olderResult.code, 'stale-operation');

  const read = await readRoute(harness.service, L1);
  assert.equal(read.photo.photoId, newerResult.photoId);
  assert.equal(harness.files.hasMain(newerResult.photoId), true);
  assert.equal(harness.files.hasMain(olderResult.photoId), false);
  assert.equal(harness.files.mains.size, 1);
  assert.equal(indexOf(harness.storage).photos.length, 1);
  assert.equal(operationOf(harness.storage, 'op-older').status, 'failed');
  assert.equal(operationOf(harness.storage, 'op-newer').status, 'committed');
});

test('PS04 旧更换回调不能覆盖更新版本，旧保存回调不能恢复已移除照片', async () => {
  const harness = createHarness();
  const base = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-base'
  });
  assert.equal(base.ok, true);

  const releaseReplace = harness.files.holdCall('writeMain', 1);
  const staleReplace = harness.service.replacePhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-stale-replace'
  });
  await harness.files.waitForCall('writeMain', 1);

  const removed = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove'
  });
  assert.equal(removed.ok, true);
  assert.equal((await readRoute(harness.service, L1)).status, 'none');

  releaseReplace();
  const staleResult = await staleReplace;
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.code, 'stale-operation');
  assert.equal((await readRoute(harness.service, L1)).status, 'none');
  assert.equal(harness.files.hasMain(base.photoId), false);
  assert.equal(harness.files.hasMain(staleResult.photoId), false);
  assert.equal(harness.files.mains.size, 0);
  assert.equal(indexOf(harness.storage).photos.length, 0);
});

test('PS04 串行、并发与实例重建后 operation 状态与实际主图一致', async () => {
  const harness = createHarness();
  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-state'
  });
  let index = indexOf(harness.storage);
  assert.equal(index.operations.length, 1);
  assert.equal(index.operations[0].status, 'committed');
  assert.equal(index.operations[0].photoId, saved.photoId);
  assert.equal(index.routes[0].activeOpSeq, index.operations[0].seq);
  assert.equal(index.routes[0].rev, 1);

  const restarted = newService(harness, { instanceId: 'svc-state-b' });
  const read = await readRoute(restarted, L1);
  assert.equal(read.photo.photoId, saved.photoId);
  const recovered = await restarted.recover();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.abortedOps, []);
  index = indexOf(harness.storage);
  assert.equal(index.operations[0].status, 'committed');
  assert.equal(index.routes[0].photoId, saved.photoId);
  assert.equal(harness.files.hasMain(saved.photoId), true);
});

// ---- PS05 移除与文件缺失 ----

test('PS05 移除成功只影响指定线路，并删除本服务主图与缩略图', async () => {
  const harness = createHarness();
  const keep = await harness.service.addPhoto({
    routeId: L2,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-keep'
  });
  const target = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-remove-target'
  });
  assert.equal(harness.files.mains.size, 2);

  const removed = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove-target-2'
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.photoId, target.photoId);
  assert.equal(harness.files.hasMain(target.photoId), false);
  assert.equal(harness.files.hasThumb(target.photoId), false);
  assert.equal(harness.files.hasMain(keep.photoId), true);
  assert.equal(harness.files.hasThumb(keep.photoId), true);
  assert.equal((await readRoute(harness.service, L1)).status, 'none');
  assert.equal(
    (await readRoute(harness.service, L2)).photo.photoId,
    keep.photoId
  );
  assert.equal(indexOf(harness.storage).photos.length, 1);
  assert.equal(operationOf(harness.storage, 'op-remove-target-2').status, 'committed');
});

test('PS05 移除索引写入失败保留照片与关联，可重试成功', async () => {
  const harness = createHarness();
  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-add'
  });
  // 第 1、2 次是新增启动与提交，第 3、4 次是移除启动与提交。
  harness.storage.faults.failIndexSetAt = 4;

  const failed = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove-fail'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'index-write-failed');
  assert.equal(failed.recoverable, true);
  assert.equal(harness.files.hasMain(saved.photoId), true, '索引失败不得先删文件');
  assert.equal(harness.files.hasThumb(saved.photoId), true);
  const stillThere = await readRoute(harness.service, L1);
  assert.equal(stillThere.ok, true);
  assert.equal(stillThere.photo.photoId, saved.photoId);

  harness.storage.faults.failIndexSetAt = 0;
  const retried = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove-fail'
  });
  assert.equal(retried.ok, true);
  assert.equal((await readRoute(harness.service, L1)).status, 'none');
  assert.equal(harness.files.hasMain(saved.photoId), false);
  assert.equal(operationOf(harness.storage, 'op-remove-fail').status, 'committed');
});

test('PS05 删除文件失败不虚报成功，关联移除后可重试清理', async () => {
  const harness = createHarness();
  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-add'
  });
  harness.files.faults.remove = 1;

  const failed = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove-file-fail'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'file-delete-failed');
  assert.equal(failed.recoverable, true);
  assert.equal(failed.associationRemoved, true);
  assert.equal((await readRoute(harness.service, L1)).status, 'none');
  assert.equal(harness.files.hasMain(saved.photoId), true, '删除失败文件仍在');

  const retried = await harness.service.removePhoto({
    routeId: L1,
    opId: 'op-remove-file-fail'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicate, true);
  assert.equal(harness.files.hasMain(saved.photoId), false);
  assert.equal(harness.files.hasThumb(saved.photoId), false);
});

test('PS05 读取缺失文件返回明确不可用结果，不返回其他线路照片', async () => {
  const harness = createHarness();
  const missing = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-missing'
  });
  const other = await harness.service.addPhoto({
    routeId: L2,
    sourcePath: sample(harness.files, 'p2'),
    opId: 'op-other'
  });
  harness.files.mains.delete(missing.photoId);

  const read = await readRoute(harness.service, L1);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'missing-file');
  assert.equal(read.status, 'missing-file');
  assert.equal(read.recoverable, true);
  assert.match(read.error, /本机照片不可用/);
  assert.equal(read.photo.photoId, missing.photoId, '保留可供页面处理的状态');
  assert.equal(read.photo.routeId, L1);
  assert.notEqual(read.photo.photoId, other.photoId, '不返回其他线路照片');

  const byId = await harness.service.getPhoto({ photoId: missing.photoId });
  assert.equal(byId.ok, false);
  assert.equal(byId.code, 'missing-file');
  const rebuilt = await harness.service.rebuildThumbnail({
    photoId: missing.photoId
  });
  assert.equal(rebuilt.ok, false);
  assert.equal(rebuilt.code, 'missing-file');

  const otherRead = await readRoute(harness.service, L2);
  assert.equal(otherRead.ok, true);
  assert.equal(otherRead.photo.photoId, other.photoId);
});

test('PS05 缩略图缺失时主图仍可读，并可从主图重建缩略图', async () => {
  const harness = createHarness();
  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-thumb'
  });
  harness.files.thumbs.delete(saved.photoId);
  harness.storage.map.delete(THUMB_CACHE_KEY);

  const read = await readRoute(harness.service, L1);
  assert.equal(read.ok, true);
  assert.equal(read.status, 'ready-thumb-missing');
  assert.equal(read.photo.thumbnail.available, false);
  assert.equal(read.photo.storage.location, harness.files.mainPath(saved.photoId));
  assert.equal(harness.files.hasMain(saved.photoId), true);

  const rebuilt = await harness.service.rebuildThumbnail({
    photoId: saved.photoId
  });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.thumbnail.available, true);
  assert.equal(harness.files.hasThumb(saved.photoId), true);
  const after = await readRoute(harness.service, L1);
  assert.equal(after.status, 'ready');
  assert.equal(after.photo.thumbnail.available, true);
});

// ---- PS06 迁移保留与回归 ----

test('PS06 photoId 与 local 位置分开，服务不访问云或正式记录', async () => {
  const source = fs.readFileSync(ROUTE_PHOTOS_JS, 'utf8');
  const filesSource = fs.readFileSync(PHOTO_FILES_JS, 'utf8');
  assert.doesNotMatch(source, /wx\.cloud|uploadFile|climbing_records|climbing_sessions/);
  assert.doesNotMatch(source, /clearStorageSync|clearStorage\(/);
  assert.doesNotMatch(filesSource, /wx\.cloud|uploadFile|climbing_records|climbing_sessions/);
  assert.match(source, /climbingNote\.gymLogTrial\.photos\.v1/);
  assert.match(source, /climbingNote\.gymLogTrial\.photoThumbs\.v1/);
  assert.match(source, /type: LOCAL_STORAGE_TYPE/);

  const harness = createHarness();
  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-contract'
  });
  assert.equal(saved.ok, true);
  const index = indexOf(harness.storage);
  const photo = index.photos[0];
  assert.equal(photo.storage.type, 'local');
  assert.equal(photo.photoId, saved.photoId);
  assert.notEqual(photo.photoId, photo.storage.location);
  assert.match(photo.storage.location, /gym-log-trial-photos\/v1\/main\/photo-\d+\.jpg$/);
});

test('PS06 微信 http://usr 与 wxfile://usr 前缀不被路径规范化折叠', () => {
  const devtools = photoFiles.createWxPhotoFiles({
    wxApi: { env: { USER_DATA_PATH: 'http://usr' } }
  });
  assert.equal(
    devtools.mainPath('photo-1'),
    'http://usr/gym-log-trial-photos/v1/main/photo-1.jpg'
  );
  assert.equal(
    devtools.thumbPath('photo-1'),
    'http://usr/gym-log-trial-photos/v1/thumb/photo-1.jpg'
  );

  const device = photoFiles.createWxPhotoFiles({
    wxApi: { env: { USER_DATA_PATH: 'wxfile://usr' } }
  });
  assert.equal(
    device.mainPath('photo-1'),
    'wxfile://usr/gym-log-trial-photos/v1/main/photo-1.jpg'
  );
  assert.equal(
    device.thumbPath('photo-1'),
    'wxfile://usr/gym-log-trial-photos/v1/thumb/photo-1.jpg'
  );
});

test('PS06 真实文件适配器在 Node 实际磁盘上完成保存、重建读取与缩略图', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 't010-route-photos-'));
  const userData = path.join(workDir, 'userdata');
  const tempDir = path.join(workDir, 'picker-temp');
  fs.mkdirSync(tmpNormalize(userData), { recursive: true });
  fs.mkdirSync(tmpNormalize(tempDir), { recursive: true });

  const compressRequests = [];
  let compressedSeq = 0;
  const wxShim = createNodeFsWxShim({
    userData,
    tempDir,
    compressRequests,
    nextCompressedPath: () => {
      compressedSeq += 1;
      return tmpNormalize(path.join(tempDir, 'compressed-' + compressedSeq + '.png'));
    }
  });

  const storage = createFakeStorage();
  try {
    const sourcePath = tmpNormalize(path.join(tempDir, 'sample.png'));
    fs.writeFileSync(sourcePath, makePng(3000, 2000));

    const files = photoFiles.createWxPhotoFiles({ wxApi: wxShim });
    const service = routePhotos.createRoutePhotoService({
      ownerId: 'trial-user-real',
      datasetId: 'trial-dataset-real',
      files,
      storage,
      instanceId: 'svc-real-a',
      now: () => '2026-11-06T12:00:00.000Z'
    });

    const saved = await service.addPhoto({
      routeId: L1,
      sourcePath,
      opId: 'op-real'
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.photo.storage.type, 'local');

    const mainPath = tmpNormalize(files.mainPath(saved.photoId));
    const thumbPath = tmpNormalize(files.thumbPath(saved.photoId));
    assert.ok(fs.existsSync(mainPath), '主图必须真实落盘');
    assert.ok(fs.existsSync(thumbPath), '缩略图必须真实落盘');
    assert.ok(fs.statSync(mainPath).size > 0);
    assert.ok(fs.statSync(thumbPath).size > 0);
    assert.equal(saved.photo.bytes.main, fs.statSync(mainPath).size);
    assert.equal(
      saved.photo.storage.location,
      files.mainPath(saved.photoId),
      '索引记录的是持久位置'
    );
    assert.ok(
      saved.photo.storage.location.indexOf('/main/photo-') > 0,
      '位置位于专用主图目录'
    );

    // 选择器临时文件失效后，用新适配器与新实例读取同一 photoId。
    fs.unlinkSync(sourcePath);
    assert.equal(fs.existsSync(sourcePath), false);
    const filesAgain = photoFiles.createWxPhotoFiles({ wxApi: wxShim });
    const restarted = routePhotos.createRoutePhotoService({
      ownerId: 'trial-user-real',
      datasetId: 'trial-dataset-real',
      files: filesAgain,
      storage,
      instanceId: 'svc-real-b'
    });
    const read = await restarted.getRoutePhoto({ routeId: L1 });
    assert.equal(read.ok, true);
    assert.equal(read.status, 'ready');
    assert.equal(read.photo.photoId, saved.photoId);
    assert.equal(tmpNormalize(read.photo.storage.location), mainPath);
    assert.equal(tmpNormalize(read.photo.thumbnail.location), thumbPath);
    assert.deepEqual(fs.readFileSync(mainPath), fs.readFileSync(thumbPath));

    const index = storage.raw(INDEX_KEY);
    assert.equal(index.photos[0].storage.type, 'local');
    assert.ok(
      !JSON.stringify(index).includes(tmpNormalize(tempDir)),
      '索引不得记录选择器临时目录'
    );
    assert.equal(compressRequests.length, 2, '主图与缩略图各压缩一次');
    assert.equal(compressRequests[0].compressedWidth, 2048);
    assert.equal(compressRequests[1].compressedWidth, 320);
    assert.equal(
      compressRequests[1].src.indexOf(tmpNormalize(tempDir)),
      0,
      '缩略图压缩源是临时图，不是用户文件目录里的持久主图'
    );

    // 目录里只有本服务文件。
    const mainDir = tmpNormalize(files.mainDir);
    const thumbDir = tmpNormalize(files.thumbDir);
    assert.deepEqual(fs.readdirSync(mainDir), [saved.photoId + '.jpg']);
    assert.deepEqual(fs.readdirSync(thumbDir), [saved.photoId + '.jpg']);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('PS06 既有回归数据键不被照片服务改写', async () => {
  const harness = createHarness();
  // 模拟独立试用工程原有的两个业务键；照片服务不得读取或写入它们。
  harness.storage.map.set(
    'climbingNote.gymLogTrial.v1',
    JSON.stringify({ version: 1, sessions: [], routes: [], attempts: [] })
  );
  harness.storage.map.set(
    'climbingNote.gymLogTrial.saveLedger.v1',
    JSON.stringify({ version: 1, records: [], loseNextReceipt: false })
  );
  const before = new Map(harness.storage.map);

  const saved = await harness.service.addPhoto({
    routeId: L1,
    sourcePath: sample(harness.files, 'p1'),
    opId: 'op-regression'
  });
  assert.equal(saved.ok, true);

  for (const key of [
    'climbingNote.gymLogTrial.v1',
    'climbingNote.gymLogTrial.saveLedger.v1'
  ]) {
    assert.equal(harness.storage.map.get(key), before.get(key), key + ' 未被改写');
    assert.ok(!harness.storage.log.gets.includes(key), key + ' 未被读取');
    assert.ok(!harness.storage.log.sets.includes(key), key + ' 未被写入');
  }
});

// ---- 测试辅助：Node fs 版 wx 文件系统与真实 PNG ----

function tmpNormalize(value) {
  return value.replace(/\\/g, '/');
}

function createNodeFsWxShim(options) {
  const fsManager = {
    mkdir(request) {
      try {
        fs.mkdirSync(tmpNormalize(request.dirPath), {
          recursive: Boolean(request.recursive)
        });
        request.success({});
      } catch (error) {
        request.fail({ errMsg: 'mkdir:fail ' + error.message });
      }
    },
    copyFile(request) {
      try {
        fs.copyFileSync(
          tmpNormalize(request.srcPath),
          tmpNormalize(request.destPath)
        );
        request.success({});
      } catch (error) {
        request.fail({ errMsg: 'copyFile:fail ' + error.message });
      }
    },
    stat(request) {
      try {
        const stat = fs.statSync(tmpNormalize(request.path));
        request.success({
          stats: {
            size: stat.size,
            isFile: () => stat.isFile()
          }
        });
      } catch (error) {
        request.fail({ errMsg: 'stat:fail ' + error.message });
      }
    },
    unlink(request) {
      try {
        fs.unlinkSync(tmpNormalize(request.filePath));
        request.success({});
      } catch (error) {
        request.fail({ errMsg: 'unlink:fail ' + error.message });
      }
    },
    readdir(request) {
      try {
        request.success({
          files: fs.readdirSync(tmpNormalize(request.dirPath))
        });
      } catch (error) {
        request.fail({ errMsg: 'readdir:fail ' + error.message });
      }
    }
  };

  return {
    env: { USER_DATA_PATH: tmpNormalize(options.userData) },
    getFileSystemManager() {
      return fsManager;
    },
    getImageInfo(request) {
      try {
        const buffer = fs.readFileSync(tmpNormalize(request.src));
        const dimensions = readPngSize(buffer);
        request.success({
          width: dimensions.width,
          height: dimensions.height,
          type: 'png',
          path: request.src
        });
      } catch (error) {
        request.fail({ errMsg: 'getImageInfo:fail ' + error.message });
      }
    },
    compressImage(request) {
      try {
        const target = options.nextCompressedPath();
        fs.copyFileSync(tmpNormalize(request.src), target);
        options.compressRequests.push({
          src: request.src,
          quality: request.quality,
          compressedWidth: request.compressedWidth || 0
        });
        request.success({ tempFilePath: target });
      } catch (error) {
        request.fail({ errMsg: 'compressImage:fail ' + error.message });
      }
    }
  };
}

function makePng(width, height) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const ihdr = pngChunk(
    'IHDR',
    Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 2, 0, 0, 0])
    ])
  );
  const row = Buffer.alloc(width * 3 + 1);
  const raw = Buffer.concat(
    Array.from({ length: height }, () => row)
  );
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function pngChunk(type, data) {
  const length = uint32(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = uint32(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngSize(buffer) {
  assert.equal(
    buffer.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    '样例必须是有效 PNG'
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}
