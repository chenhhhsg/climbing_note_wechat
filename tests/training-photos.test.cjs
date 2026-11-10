/**
 * T019 正式记录版 · 线路主照片持久服务测试（PH01–PH16）
 *
 * 直接加载正式工程的真实照片服务、文件适配器、空间计量与页面控制器，
 * 只替换微信存储、文件系统、图片压缩、选择器与弹窗：
 * - 真实执行 utils/training-photos.js / training-photo-files.js / training-photo-space.js；
 * - 用可控虚拟文件验证“文件和索引都成功才成功”、写入异常、重试幂等、更换与移除边界；
 * - 逐项核对照片落在 <USER_DATA_PATH>/training-photos/v1/<archiveId>/ 下，
 *   索引记录照片 ID、本机存储位置、所属档案与线路 ID；临时选图路径不作长期引用；
 * - 验证跨档案与同色线路互不影响、普通清缓存只清可重建项、被引用原图保留。

 * 替身通过不代表真机、开发者工具或真实微信账号已通过；手机拍照/相册权限、
 * 退出重开与次日岩馆回看仍属整体验收（待验）。
 *
 * 运行：node --test tests/training-photos.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const FILES_JS = path.join(ROOT, 'utils', 'training-photo-files.js');
const SPACE_JS = path.join(ROOT, 'utils', 'training-photo-space.js');
const SERVICE_JS = path.join(ROOT, 'utils', 'training-photos.js');

const USER_DATA_PATH = 'http://usr';
const ARCHIVE_A = 'archive-test-a1';
const ARCHIVE_B = 'archive-test-b2';
const ROUTE_BLUE = 'route-1';
const ROUTE_BLUE_SAME_COLOR = 'route-2';
const ROUTE_RED = 'route-3';

const PHOTO_ROOT_A = USER_DATA_PATH + '/training-photos/v1/' + ARCHIVE_A;
const PHOTO_ROOT_B = USER_DATA_PATH + '/training-photos/v1/' + ARCHIVE_B;
const MAIN_A = PHOTO_ROOT_A + '/main';
const THUMB_A = PHOTO_ROOT_A + '/thumb';

// 保存流程的实际压缩结果：主图 150000 字节、缩略图 12000 字节。
const MAIN_BYTES = 150000;
const THUMB_BYTES = 12000;

const storage = new Map();
const virtual = {
  files: new Map(),
  dirs: new Set(),
  imageMeta: new Map(),
  calls: {
    mkdir: [],
    copyFile: [],
    unlink: [],
    stat: [],
    readdir: [],
    getImageInfo: [],
    compressImage: [],
    canvasToTempFilePath: []
  }
};
const faults = {
  copyFile: false,
  writeSpace: false,
  unlink: false,
  stat: false,
  getImageInfo: false,
  compress: false,
  canvas: false
};
const wxLog = {
  getKeys: [],
  setKeys: [],
  removeKeys: [],
  failKeys: new Set(),
  modalConfirm: true,
  previews: [],
  toasts: [],
  mediaCalls: [],
  imageCalls: [],
  pickerCalls: [],
  chooseBehavior: 'success',
  activeSheetIndex: 0,
  sourceBytes: 500000
};

let holdCompress = null;
let sourceSeq = 0;
let tempSeq = 0;

function resetAll() {
  storage.clear();
  virtual.files.clear();
  virtual.dirs.clear();
  virtual.imageMeta.clear();
  Object.keys(virtual.calls).forEach(key => {
    virtual.calls[key] = [];
  });
  faults.copyFile = false;
  faults.writeSpace = false;
  faults.unlink = false;
  faults.stat = false;
  faults.getImageInfo = false;
  faults.compress = false;
  faults.canvas = false;
  wxLog.getKeys = [];
  wxLog.setKeys = [];
  wxLog.removeKeys = [];
  wxLog.failKeys = new Set();
  wxLog.modalConfirm = true;
  wxLog.previews = [];
  wxLog.toasts = [];
  wxLog.mediaCalls = [];
  wxLog.imageCalls = [];
  wxLog.pickerCalls = [];
  wxLog.chooseBehavior = 'success';
  wxLog.activeSheetIndex = 0;
  wxLog.sourceBytes = 500000;
  holdCompress = null;
  sourceSeq = 0;
  tempSeq = 0;
}

function addSourceImage(width, height, bytes) {
  sourceSeq += 1;
  const filePath = 'http://tmp/selected-' + sourceSeq + '.jpg';
  virtual.files.set(
    filePath,
    Buffer.alloc(typeof bytes === 'number' ? bytes : wxLog.sourceBytes, 1)
  );
  virtual.imageMeta.set(filePath, {
    width: width || 2400,
    height: height || 1600
  });
  return filePath;
}

function addVirtualFile(filePath, bytes) {
  virtual.files.set(filePath, Buffer.alloc(bytes, 7));
}

// 本档案目录里还剩几个受管文件（成功照片应有 2 个：主图 + 缩略图）。
function filesLeft() {
  return filesUnder(PHOTO_ROOT_A).length;
}

function filesUnder(prefix) {
  return Array.from(virtual.files.keys()).filter(
    key => key.indexOf(prefix) === 0
  );
}

function createGate() {
  let release;
  const promise = new Promise(resolve => {
    release = resolve;
  });
  return { promise, release };
}

const fileSystem = {
  mkdir(options) {
    virtual.calls.mkdir.push({
      dirPath: options.dirPath,
      recursive: options.recursive
    });
    virtual.dirs.add(options.dirPath);
    options.success({});
  },
  copyFile(options) {
    virtual.calls.copyFile.push({
      srcPath: options.srcPath,
      destPath: options.destPath
    });
    if (faults.writeSpace) {
      options.fail({ errMsg: 'copyFile:fail no space left on device' });
      return;
    }
    if (faults.copyFile) {
      options.fail({ errMsg: 'copyFile:fail mock write failed' });
      return;
    }
    if (!virtual.files.has(options.srcPath)) {
      options.fail({ errMsg: 'copyFile:fail no such file or directory' });
      return;
    }
    virtual.files.set(
      options.destPath,
      Buffer.from(virtual.files.get(options.srcPath))
    );
    const meta = virtual.imageMeta.get(options.srcPath);
    if (meta) virtual.imageMeta.set(options.destPath, Object.assign({}, meta));
    options.success({});
  },
  unlink(options) {
    virtual.calls.unlink.push({ filePath: options.filePath });
    if (faults.unlink) {
      options.fail({ errMsg: 'unlink:fail mock delete failed' });
      return;
    }
    if (!virtual.files.has(options.filePath)) {
      options.fail({ errMsg: 'unlink:fail no such file or directory' });
      return;
    }
    virtual.files.delete(options.filePath);
    options.success({});
  },
  stat(options) {
    virtual.calls.stat.push({ path: options.path });
    if (faults.stat) {
      options.fail({ errMsg: 'stat:fail mock stat failed' });
      return;
    }
    if (!virtual.files.has(options.path)) {
      options.fail({ errMsg: 'stat:fail no such file or directory' });
      return;
    }
    options.success({
      stats: { size: virtual.files.get(options.path).length }
    });
  },
  readdir(options) {
    virtual.calls.readdir.push({ dirPath: options.dirPath });
    const prefix = options.dirPath + '/';
    const names = [];
    virtual.files.forEach((value, key) => {
      if (key.indexOf(prefix) !== 0) return;
      const rest = key.slice(prefix.length);
      if (rest && rest.indexOf('/') === -1) names.push(rest);
    });
    options.success({ files: names });
  }
};

function pickerResult(source) {
  tempSeq += 1;
  const filePath = 'http://tmp/picked-' + tempSeq + '.jpg';
  virtual.files.set(filePath, Buffer.alloc(wxLog.sourceBytes, 1));
  virtual.imageMeta.set(filePath, { width: 2400, height: 1600 });
  return filePath;
}

global.wx = {
  env: { USER_DATA_PATH },
  getStorageSync(key) {
    wxLog.getKeys.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    if (wxLog.failKeys.has(key)) {
      throw { errMsg: 'setStorageSync:fail mock storage error' };
    }
    storage.set(key, value);
  },
  removeStorageSync(key) {
    wxLog.removeKeys.push(key);
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: Array.from(storage.keys()) };
  },
  getFileSystemManager() {
    return fileSystem;
  },
  getImageInfo(options) {
    virtual.calls.getImageInfo.push({ src: options.src });
    if (faults.getImageInfo) {
      options.fail({ errMsg: 'getImageInfo:fail mock' });
      return;
    }
    const meta = virtual.imageMeta.get(options.src);
    if (!meta) {
      options.fail({ errMsg: 'getImageInfo:fail no such file' });
      return;
    }
    options.success({ width: meta.width, height: meta.height, type: 'jpeg' });
  },
  compressImage(options) {
    virtual.calls.compressImage.push({
      src: options.src,
      quality: options.quality,
      compressedWidth: options.compressedWidth
    });
    if (faults.compress) {
      options.fail({ errMsg: 'compressImage:fail mock compress failed' });
      return;
    }
    // 复现开发者工具：持久 http://usr 路径压缩失败，临时路径正常。
    if (options.src.indexOf(USER_DATA_PATH + '/') === 0) {
      options.fail({ errMsg: "compressImage:fail file doesn't exist" });
      return;
    }
    const meta = virtual.imageMeta.get(options.src);
    if (!meta) {
      options.fail({ errMsg: 'compressImage:fail no such file' });
      return;
    }
    const width = options.compressedWidth || meta.width;
    const height = Math.max(1, Math.round((meta.height * width) / meta.width));
    const finish = () => {
      tempSeq += 1;
      const filePath = 'http://tmp/compressed-' + tempSeq + '.jpg';
      const bytes = width <= 400 ? THUMB_BYTES : MAIN_BYTES;
      virtual.files.set(filePath, Buffer.alloc(bytes, 2));
      virtual.imageMeta.set(filePath, { width, height });
      options.success({ tempFilePath: filePath });
    };
    if (holdCompress) holdCompress.then(finish);
    else finish();
  },
  createOffscreenCanvas(options) {
    // 模拟不支持画布压缩的基础库：压缩器失败后没有可用回退。
    if (faults.canvas) return undefined;
    const canvas = {
      width: options && options.width,
      height: options && options.height,
      getContext() {
        return { drawImage() {} };
      },
      createImage() {
        const image = {};
        setTimeout(() => {
          if (typeof image.onload === 'function') image.onload();
        }, 0);
        return image;
      }
    };
    return canvas;
  },
  canvasToTempFilePath(options) {
    virtual.calls.canvasToTempFilePath.push({
      width: options.destWidth,
      height: options.destHeight
    });
    tempSeq += 1;
    const filePath = 'http://tmp/canvas-' + tempSeq + '.jpg';
    virtual.files.set(filePath, Buffer.alloc(THUMB_BYTES, 3));
    virtual.imageMeta.set(filePath, {
      width: options.destWidth,
      height: options.destHeight
    });
    options.success({ tempFilePath: filePath });
  },
  chooseMedia(options) {
    wxLog.mediaCalls.push(options);
    wxLog.pickerCalls.push({
      picker: 'media',
      options,
      argCount: arguments.length
    });
    if (wxLog.chooseBehavior === 'cancel') {
      options.fail({ errMsg: 'chooseMedia:fail cancel' });
      return;
    }
    if (wxLog.chooseBehavior === 'deny') {
      options.fail({ errMsg: 'chooseMedia:fail auth deny' });
      return;
    }
    if (wxLog.chooseBehavior === 'empty') {
      options.success({ tempFiles: [] });
      return;
    }
    options.success({ tempFiles: [{ tempFilePath: pickerResult('media') }] });
  },
  chooseImage(options) {
    wxLog.imageCalls.push(options);
    wxLog.pickerCalls.push({
      picker: 'image',
      options,
      argCount: arguments.length
    });
    if (wxLog.chooseBehavior === 'cancel') {
      options.fail({ errMsg: 'chooseImage:fail cancel' });
      return;
    }
    if (wxLog.chooseBehavior === 'empty') {
      options.success({ tempFilePaths: [] });
      return;
    }
    options.success({ tempFilePaths: [pickerResult('image')] });
  },
  showModal(options) {
    options.success({ confirm: wxLog.modalConfirm, cancel: !wxLog.modalConfirm });
  },
  showActionSheet(options) {
    options.success({ tapIndex: wxLog.activeSheetIndex });
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  previewImage(options) {
    wxLog.previews.push(options);
  }
};

const store = require(STORE_JS);
const filesModule = require(FILES_JS);
const spaceModule = require(SPACE_JS);
const serviceModule = require(SERVICE_JS);

function makeFiles(archiveId, options) {
  const config = options || {};
  return filesModule.createWxTrainingPhotoFiles({
    archiveId,
    wxApi: config.wxApi || global.wx,
    userDataPath: config.userDataPath
  });
}

function makeService(archiveId, options) {
  const config = options || {};
  return serviceModule.createTrainingPhotoService({
    archiveId,
    files: config.files || makeFiles(archiveId, config),
    space: config.space,
    storage: config.storage,
    now: config.now,
    instanceId: config.instanceId,
    runtimeId: config.runtimeId,
    instanceTtlMs: config.instanceTtlMs
  });
}

function indexOf() {
  const raw = storage.get(store.PHOTO_INDEX_KEY);
  return raw ? JSON.parse(raw) : null;
}

function putIndex(index) {
  storage.set(store.PHOTO_INDEX_KEY, JSON.stringify(index));
}

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------- PH01 归属与位置

test('PH01 照片写入本机档案目录，索引按档案与线路记录照片 ID 与存储位置', async () => {
  const source = addSourceImage();
  const service = makeService(ARCHIVE_A);
  const result = await service.addPhoto({ routeId: ROUTE_BLUE, sourcePath: source });

  assert.equal(result.ok, true);
  assert.equal(result.photo.routeId, ROUTE_BLUE);
  assert.equal(result.photo.archiveId, ARCHIVE_A);
  assert.equal(result.photo.storage.type, 'local');
  assert.match(
    result.photo.storage.location,
    new RegExp('^' + MAIN_A.replace(/\//g, '\\/') + '\\/photo-[A-Za-z0-9_-]+\\.jpg$')
  );
  assert.ok(virtual.dirs.has(MAIN_A), '应创建主图目录');
  assert.ok(virtual.dirs.has(THUMB_A), '应创建缩略图目录');

  // 缩略图落在同一档案目录的 thumb/ 下，主图与缩略图都是持久文件。
  const listed = filesUnder(PHOTO_ROOT_A);
  assert.equal(listed.length, 2, '本档案目录下应只有主图与缩略图两个文件');
  assert.ok(listed.some(item => item.indexOf(MAIN_A) === 0));
  assert.ok(listed.some(item => item.indexOf(THUMB_A) === 0));

  const index = indexOf();
  assert.equal(index.version, 1);
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].archiveId, ARCHIVE_A);
  assert.equal(index.photos[0].routeId, ROUTE_BLUE);
  assert.equal(index.photos[0].photoId, result.photo.photoId);
  assert.equal(index.photos[0].storage.location, result.photo.storage.location);
  assert.equal(index.routes.length, 1);
  assert.equal(index.routes[0].photoId, result.photo.photoId);
  // 临时选图路径只用于本次读取，不进索引也不进持久位置。
  assert.ok(JSON.stringify(index).indexOf('http://tmp/') === -1);
});

test('PH02 文件写不进去时不报成功，也不留下被索引引用的照片', async () => {
  const source = addSourceImage();
  faults.copyFile = true;
  const service = makeService(ARCHIVE_A);
  const result = await service.addPhoto({ routeId: ROUTE_BLUE, sourcePath: source });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'file-write-failed');
  assert.equal(filesLeft(), 0);
  assert.deepEqual(filesUnder(PHOTO_ROOT_A), [], '失败写入不留下受管文件');
});

test('PH03 索引写失败时不报成功，并清理未提交的文件', async () => {
  const source = addSourceImage();
  wxLog.failKeys.add(store.PHOTO_INDEX_KEY);
  const service = makeService(ARCHIVE_A);
  const result = await service.addPhoto({ routeId: ROUTE_BLUE, sourcePath: source });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'index-write-failed');
  assert.equal(indexOf(), null);
  assert.deepEqual(filesUnder(PHOTO_ROOT_A), [], '索引失败后应清掉未提交的主图与缩略图');
});

test('PH04 压缩或尺寸读取失败时不产生照片记录', async () => {
  const source = addSourceImage();
  faults.getImageInfo = true;
  const service = makeService(ARCHIVE_A);
  const result = await service.addPhoto({ routeId: ROUTE_BLUE, sourcePath: source });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source-unreadable');
  assert.equal(filesLeft(), 0);

  resetAll();
  const source2 = addSourceImage();
  // 压缩器与画布回退都不可用：明确失败，且不产生记录。
  faults.compress = true;
  faults.canvas = true;
  const service2 = makeService(ARCHIVE_A);
  const result2 = await service2.addPhoto({ routeId: ROUTE_BLUE, sourcePath: source2 });
  assert.equal(result2.ok, false);
  assert.equal(result2.code, 'compress-failed');
  assert.equal(filesLeft(), 0);
  assert.deepEqual(filesUnder(PHOTO_ROOT_A), []);
});

// ---------------------------------------------------------------- PH05 新增/重复/重试

test('PH05 同一线路已有主照片时新增被拒绝，且不覆盖旧照片', async () => {
  const service = makeService(ARCHIVE_A);
  const first = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(first.ok, true);

  const second = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-has-photo');

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.ok, true);
  assert.equal(shown.photo.photoId, first.photo.photoId);
  assert.ok(virtual.files.has(shown.photo.storage.location), '旧主图仍可读');
});

test('PH06 同一操作 ID 的迟到重试幂等：复用同一张照片，不产生第二份', async () => {
  const service = makeService(ARCHIVE_A);
  const source = addSourceImage();
  const first = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: source,
    opId: 'photo-op-retry-1'
  });
  assert.equal(first.ok, true);

  const again = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: source,
    opId: 'photo-op-retry-1'
  });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.photoId, first.photoId);

  const index = indexOf();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].photoId, first.photo.photoId);
});

// ---------------------------------------------------------------- PH07 更换

test('PH07 更换成功后新主图生效，旧主图与旧缩略图被释放', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  const oldMain = added.photo.storage.location;
  const oldThumb = added.thumbnail.location;

  const replaced = await service.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(replaced.ok, true);
  assert.notEqual(replaced.photo.photoId, added.photo.photoId);
  assert.ok(virtual.files.has(replaced.photo.storage.location));
  assert.equal(virtual.files.has(oldMain), false, '旧主图应被释放');
  assert.equal(virtual.files.has(oldThumb), false, '旧缩略图应被释放');

  const index = indexOf();
  assert.equal(index.photos.length, 1, '索引只保留当前主照片');
  assert.equal(index.photos[0].photoId, replaced.photo.photoId);
  assert.equal(index.routes[0].rev, 2);
});

test('PH08 更换失败时保留原照片，页面读到的仍是旧主图', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });

  faults.copyFile = true;
  const replaced = await service.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(replaced.ok, false);
  assert.equal(replaced.code, 'file-write-failed');

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.ok, true);
  assert.equal(shown.photo.photoId, added.photo.photoId);
  assert.equal(shown.photo.storage.location, added.photo.storage.location);
  assert.ok(virtual.files.has(shown.photo.storage.location));
});

// ---------------------------------------------------------------- PH09 移除

test('PH09 移除成功后索引与文件都释放，线路状态回到无照片', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });

  const removed = await service.removePhoto({ routeId: ROUTE_BLUE });
  assert.equal(removed.ok, true);
  assert.equal(virtual.files.has(added.photo.storage.location), false);

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.ok, true);
  assert.equal(shown.status, 'none');
  assert.equal(shown.photo, null);
  assert.equal(indexOf().photos.length, 0);
});

test('PH10 文件删不掉时移除已生效但明确回报未清理，可稍后清理孤儿', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  faults.unlink = true;

  const removed = await service.removePhoto({ routeId: ROUTE_BLUE });
  assert.equal(removed.ok, false);
  assert.equal(removed.associationRemoved, true);
  assert.equal(removed.recoverable, true);
  // 关联已移除：线路不再引用这张照片，但文件仍在，属于可清理的孤儿。
  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.status, 'none');
  assert.ok(virtual.files.has(added.photo.storage.location));

  faults.unlink = false;
  const cleaned = await service.cleanupOrphans();
  assert.equal(cleaned.ok, true);
  assert.equal(virtual.files.has(added.photo.storage.location), false);
});

// ---------------------------------------------------------------- PH11 空间

test('PH11 空间不足时拒绝新增，旧照片与索引保持可读', async () => {
  // 单张照片实际占用 162000 字节（主图 150000 + 缩略图 12000）。
  const policy = { budgetBytes: 300000, warnBytes: 200000, reserveBytes: 50000 };
  const service = makeService(ARCHIVE_A, { space: policy });
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(added.ok, true);

  // 当前占用 162000 + 新照片 162000 + 更换余量 50000 > 400000
  const blocked = await service.addPhoto({
    routeId: ROUTE_BLUE_SAME_COLOR,
    sourcePath: addSourceImage()
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'space-insufficient');
  assert.ok(blocked.space, '应回报空间读数供页面解释原因');
  assert.equal(blocked.space.budgetBytes, 300000);

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.ok, true);
  assert.equal(shown.photo.photoId, added.photo.photoId);
  assert.ok(virtual.files.has(shown.photo.storage.location), '旧主图保留');
  assert.equal(indexOf().photos.length, 1);
});

test('PH12 空间占用按实际文件逐项计量，未完成操作的文件照实计入', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  // 模拟一次失败写入留下的孤儿文件。
  const orphan = MAIN_A + '/photo-999.jpg';
  addVirtualFile(orphan, 1024);

  const usage = await service.getSpaceUsage();
  assert.equal(usage.ok, true);
  assert.equal(usage.mainBytes, MAIN_BYTES + 1024);
  assert.equal(usage.thumbBytes, THUMB_BYTES);
  assert.equal(usage.totalBytes, MAIN_BYTES + THUMB_BYTES + 1024);
  assert.equal(usage.orphanBytes, 1024);
  assert.equal(usage.fileCount, 3);
  assert.equal(usage.photoCount, 1);
  assert.equal(usage.missingThumbs.length, 0);
  assert.ok(virtual.files.has(added.photo.storage.location));
});

// ---------------------------------------------------------------- PH13 清缓存与重建

test('PH13 普通清缓存只删可重建缩略图，主图、索引与被引用原图保留', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  const mainPath = added.photo.storage.location;
  const thumbPath = added.thumbnail.location;

  const cleared = await service.clearRebuildableCache();
  assert.equal(cleared.ok, true);
  assert.equal(virtual.files.has(thumbPath), false, '缩略图文件应被删除');
  assert.equal(virtual.files.has(mainPath), true, '主图必须保留');
  assert.equal(indexOf().photos.length, 1, '照片索引必须保留');
  assert.equal(storage.has(serviceModule.THUMB_CACHE_KEY), false, '缩略图元数据应清掉');

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.status, 'ready-thumb-missing');
  assert.equal(shown.photo.thumbnail.available, false);
});

test('PH14 清缓存后可从主图重建缩略图，缺失数回到 0', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  await service.clearRebuildableCache();

  const rebuilt = await service.rebuildMissingThumbnails();
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.rebuiltCount, 1);
  assert.deepEqual(rebuilt.failed, []);

  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.status, 'ready');
  assert.equal(shown.photo.thumbnail.available, true);
  assert.equal(shown.photo.photoId, added.photo.photoId);
  assert.ok(virtual.files.has(shown.photo.storage.location));
  assert.ok(virtual.files.has(shown.photo.thumbnail.location));
});

test('PH15 有照片操作未完成时拒绝清缓存与孤儿清理', async () => {
  const service = makeService(ARCHIVE_A);
  holdCompress = createGate();
  const pending = service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });

  const cleared = await service.clearRebuildableCache();
  assert.equal(cleared.ok, false);
  assert.equal(cleared.code, 'operation-in-progress');

  holdCompress.release();
  const added = await pending;
  assert.equal(added.ok, true);
});

test('PH16 缩略图元数据缺失不影响主图，重建只补缓存', async () => {
  const service = makeService(ARCHIVE_A);
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  // 模拟系统清理掉了缩略图文件（元数据仍在）。
  virtual.files.delete(added.thumbnail.location);

  const usage = await service.getSpaceUsage();
  assert.equal(usage.ok, true);
  assert.equal(usage.missingThumbs.length, 1);
  assert.equal(usage.orphanBytes, 0);

  const rebuilt = await service.rebuildMissingThumbnails();
  assert.equal(rebuilt.ok, true);
  const shown = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shown.photo.thumbnail.available, true);
});

// ---------------------------------------------------------------- PH17 档案与线路隔离

test('PH17 同色线路各自独立：一条线的照片不落到另一条线，也不被它的移除影响', async () => {
  const service = makeService(ARCHIVE_A);
  const blue = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  const blue2 = await service.addPhoto({
    routeId: ROUTE_BLUE_SAME_COLOR,
    sourcePath: addSourceImage()
  });
  assert.equal(blue.ok, true);
  assert.equal(blue2.ok, true);
  assert.notEqual(blue.photo.photoId, blue2.photo.photoId);
  assert.notEqual(blue.photo.storage.location, blue2.photo.storage.location);

  const removedBlue = await service.removePhoto({ routeId: ROUTE_BLUE });
  assert.equal(removedBlue.ok, true);

  const shownOther = await service.getRoutePhoto({ routeId: ROUTE_BLUE_SAME_COLOR });
  assert.equal(shownOther.ok, true);
  assert.equal(shownOther.photo.photoId, blue2.photo.photoId);
  assert.ok(virtual.files.has(blue2.photo.storage.location), '同色另一条线的照片保留');

  const shownRed = await service.getRoutePhoto({ routeId: ROUTE_RED });
  assert.equal(shownRed.status, 'none');
});

test('PH18 其他档案的索引与文件受保护：空间统计、清理与移除都不影响它', async () => {
  const serviceA = makeService(ARCHIVE_A);
  const serviceB = makeService(ARCHIVE_B);
  const a = await serviceA.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  const b = await serviceB.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  // 两个档案的索引记录各自独立，线路 ID 相同也互不干扰。
  const index = indexOf();
  assert.equal(index.photos.length, 2);
  const archives = index.photos.map(photo => photo.archiveId).sort();
  assert.deepEqual(archives, [ARCHIVE_A, ARCHIVE_B]);
  assert.ok(b.photo.storage.location.indexOf(PHOTO_ROOT_B) === 0);

  const shownB = await serviceB.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(shownB.photo.photoId, b.photo.photoId);

  // B 的空间统计只算自己目录里的文件。
  const usageB = await serviceB.getSpaceUsage();
  assert.equal(usageB.mainBytes, MAIN_BYTES);
  assert.equal(usageB.mainBytes + usageB.thumbBytes, MAIN_BYTES + THUMB_BYTES);

  // A 的孤儿清理不会碰 B 的文件。
  const cleaned = await serviceA.cleanupOrphans();
  assert.equal(cleaned.ok, true);
  assert.ok(virtual.files.has(a.photo.storage.location));
  assert.ok(virtual.files.has(b.photo.storage.location), 'B 的主图必须保留');

  // A 的移除不影响 B。
  const removedA = await serviceA.removePhoto({ routeId: ROUTE_BLUE });
  assert.equal(removedA.ok, true);
  assert.ok(virtual.files.has(b.photo.storage.location));
  const stillB = await serviceB.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(stillB.ok, true);
  assert.equal(stillB.status, 'ready');
});

// ---------------------------------------------------------------- PH19 异常与恢复

test('PH19 索引损坏时读写真假都明确失败，且不覆盖原数据', async () => {
  storage.set(store.PHOTO_INDEX_KEY, '{ this is not json');
  const service = makeService(ARCHIVE_A);

  const read = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(read.ok, false);
  assert.equal(read.code, 'index-broken');

  const write = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'index-broken');
  assert.equal(storage.get(store.PHOTO_INDEX_KEY), '{ this is not json');
});

test('PH20 新运行期恢复会中止已中断的操作，并清理无引用的文件', async () => {
  const service = makeService(ARCHIVE_A, { runtimeId: 'runtime-old' });
  // 构造一次“刚开始写就被掐断”的操作：压缩一直不返回。
  holdCompress = createGate();
  const pending = service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  const started = indexOf();
  assert.equal(started.operations.length, 1);
  assert.equal(started.operations[0].status, 'started');
  const abortedPhotoId = started.operations[0].photoId;

  // 新运行期的服务实例：旧运行期的 started 操作必须被中止。
  const fresh = makeService(ARCHIVE_A, { runtimeId: 'runtime-new' });
  const recovered = await fresh.recover();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.abortedOps, [started.operations[0].opId]);

  const after = indexOf();
  assert.equal(after.operations[0].status, 'aborted');
  assert.equal(after.operations[0].error, '服务重启或操作已结束，未完成操作已中止');
  // 被中止的操作没有提交，它的文件不应被当成受引用文件留下。
  assert.equal(virtual.files.has(MAIN_A + '/' + abortedPhotoId + '.jpg'), false);

  holdCompress.release();
  await pending;
});

test('PH21 缺档案标识时读写都明确失败，不落到根目录', async () => {
  const service = makeService('');
  const added = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage()
  });
  assert.equal(added.ok, false);
  assert.equal(added.code, 'missing-archive');

  const files = makeFiles('');
  const ready = await files.ensureReady();
  assert.equal(ready.ok, false);
  assert.match(ready.error, /本机档案标识/);
  assert.deepEqual(filesUnder(USER_DATA_PATH + '/training-photos'), []);
});

// ---------------------------------------------------------------- PH22 存储契约

test('PH22 照片键都在正式命名空间内，清缓存只清可重建项', async () => {
  const service = makeService(ARCHIVE_A);
  await service.addPhoto({ routeId: ROUTE_BLUE, sourcePath: addSourceImage() });

  // 三级存储：受保护的照片索引、可重建的缩略图元数据、受保护的并发协调数据。
  assert.equal(serviceModule.INDEX_KEY, store.PHOTO_INDEX_KEY);
  assert.equal(store.isProtectedKey(serviceModule.INDEX_KEY), true);
  assert.equal(store.isRebuildableKey(serviceModule.THUMB_CACHE_KEY), true);
  [serviceModule.INSTANCE_KEY, serviceModule.RESERVATION_KEY, serviceModule.DELETION_KEY]
    .forEach(key => {
      assert.ok(key.indexOf(store.NAMESPACE) === 0, key + ' 应在正式命名空间内');
      assert.equal(store.isProtectedKey(key), true, key + ' 不应被普通清缓存删掉');
    });
  assert.ok(storage.has(serviceModule.THUMB_CACHE_KEY), '保存后应写入缩略图元数据');

  // 命名空间外的旧试用工程键不属于本层，清缓存不动它。
  storage.set('climbingNote.gymLogTrial.photos.v1', '{"untouched":true}');
  const cleared = store.clearRebuildableStorage();
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.removed, [serviceModule.THUMB_CACHE_KEY]);
  assert.ok(storage.has(serviceModule.INDEX_KEY), '照片索引必须保留');
  assert.ok(storage.has('climbingNote.gymLogTrial.photos.v1'), '命名空间外的键不动');
});

test('PH23 空间策略可注入小数值，且提醒线与余量不超过预算', () => {
  const policy = spaceModule.resolveSpacePolicy({
    budgetBytes: 100000,
    warnBytes: 900000,
    reserveBytes: 500000
  });
  assert.equal(policy.budgetBytes, 100000);
  assert.equal(policy.warnBytes, 100000);
  assert.equal(policy.reserveBytes, 100000);
  assert.equal(spaceModule.isSpaceError('copyFile:fail no space left on device'), true);
  assert.equal(spaceModule.isSpaceError('copyFile:fail mock write failed'), false);
  assert.equal(spaceModule.formatBytes(0), '0 KB');
});
