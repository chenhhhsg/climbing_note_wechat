/**
 * T012 · 照片空间、普通缓存保护与整批生命周期测试（PL01–PL06）
 *
 * 直接加载独立试用工程的真实页面、控制器、照片服务与文件适配器；
 * 只替换微信存储、文件系统、压缩器、选择器与弹窗：
 * - 逐项计量实际受管文件，用可注入小预算验证低于/等于/高于阈值；
 * - 新增/更换按“当前占用 + 新文件 + 更换余量”检查峰值，失败保留旧照片；
 * - 普通清缓存只删可重建缩略图，主图、索引、场次、尝试与待确认操作不变；
 * - 缩略图可从持久主图通过画布回退重建；
 * - 重置取消/失败/迟到回调、A/B 注入身份与缺文件展示分别断言。
 *
 * 替身通过不代表开发者工具、真机或真实微信账号隔离已通过。
 *
 * 运行：node --test tests/photo-lifecycle.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEV_PROJECT = path.join(ROOT, 'devtools', 'gym-log');
const PAGE_JS = path.join(DEV_PROJECT, 'pages', 'today', 'today.js');
const PAGE_WXML = path.join(DEV_PROJECT, 'pages', 'today', 'today.wxml');
const DETAIL_JS = path.join(
  DEV_PROJECT,
  'pages',
  'route-detail',
  'route-detail.js'
);
const DETAIL_WXML = path.join(
  DEV_PROJECT,
  'pages',
  'route-detail',
  'route-detail.wxml'
);
const STORE_JS = path.join(DEV_PROJECT, 'utils', 'store.js');
const SERVER_JS = path.join(DEV_PROJECT, 'utils', 'trial-save-server.js');
const ROUTE_PHOTOS_JS = path.join(DEV_PROJECT, 'utils', 'route-photos.js');
const PHOTO_FILES_JS = path.join(DEV_PROJECT, 'utils', 'photo-files.js');
const PHOTO_SPACE_JS = path.join(DEV_PROJECT, 'utils', 'photo-space.js');
const CONTROLLER_JS = path.join(DEV_PROJECT, 'utils', 'photo-controller.js');
const TRIAL_PHOTOS_JS = path.join(DEV_PROJECT, 'utils', 'trial-photos.js');
const README_PATH = path.join(DEV_PROJECT, 'README.md');

const ROUTE_BLUE = 'route-chalkbox-blue-dyn';
const ROUTE_BLUE_BALANCE = 'route-chalkbox-blue-balance';
const ROUTE_RED = 'route-chalkbox-red-overhang';
const USER_DATA_PATH = 'http://usr';
const PHOTO_ROOT = USER_DATA_PATH + '/gym-log-trial-photos/v1';

// 保存流程的实际压缩结果：主图 150000 字节、缩略图 12000 字节。
const MAIN_BYTES = 150000;
const THUMB_BYTES = 12000;
const PHOTO_BYTES = MAIN_BYTES + THUMB_BYTES;

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
    canvasToTempFilePath: [],
    chooseMedia: []
  }
};
const faults = {
  copyFile: false,
  writeSpace: false,
  unlink: false,
  stat: false,
  getImageInfo: false,
  compress: false
};
const wxLog = {
  getKeys: [],
  setKeys: [],
  removeKeys: [],
  failKeys: new Set(),
  failAfter: null,
  setShouldThrow: false,
  mediaCalls: [],
  modalCalls: [],
  toasts: [],
  previews: [],
  actionSheets: [],
  navigations: [],
  chooseBehavior: 'success',
  modalConfirm: true,
  actionSheetIndex: 0,
  sourceWidth: 2400,
  sourceHeight: 1600,
  sourceBytes: 500000,
  scrolls: []
};

let compressHold = null;
let sourceSeq = 0;
let compressSeq = 0;
let canvasSeq = 0;

function resetVirtual() {
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
  compressHold = null;
  sourceSeq = 0;
  compressSeq = 0;
  canvasSeq = 0;
}

function resetWxLog() {
  wxLog.getKeys = [];
  wxLog.setKeys = [];
  wxLog.removeKeys = [];
  wxLog.failKeys = new Set();
  wxLog.failAfter = null;
  wxLog.setShouldThrow = false;
  wxLog.mediaCalls = [];
  wxLog.modalCalls = [];
  wxLog.toasts = [];
  wxLog.previews = [];
  wxLog.actionSheets = [];
  wxLog.navigations = [];
  wxLog.chooseBehavior = 'success';
  wxLog.modalConfirm = true;
  wxLog.actionSheetIndex = 0;
  wxLog.scrolls = [];
}

function addSourceImage(width, height, bytes) {
  sourceSeq += 1;
  const filePath = 'http://tmp/selected-' + sourceSeq + '.jpg';
  const size =
    typeof bytes === 'number' ? bytes : wxLog.sourceBytes;
  virtual.files.set(filePath, Buffer.alloc(size, 1));
  virtual.imageMeta.set(filePath, {
    width: width || wxLog.sourceWidth,
    height: height || wxLog.sourceHeight
  });
  return filePath;
}

function addVirtualFile(filePath, bytes) {
  virtual.files.set(filePath, Buffer.alloc(bytes, 7));
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
      options.fail({
        errMsg: 'copyFile:fail no such file or directory'
      });
      return;
    }
    virtual.files.set(
      options.destPath,
      Buffer.from(virtual.files.get(options.srcPath))
    );
    const meta = virtual.imageMeta.get(options.srcPath);
    if (meta) {
      virtual.imageMeta.set(options.destPath, Object.assign({}, meta));
    }
    options.success({});
  },
  unlink(options) {
    virtual.calls.unlink.push({ filePath: options.filePath });
    if (faults.unlink) {
      options.fail({ errMsg: 'unlink:fail mock delete failed' });
      return;
    }
    if (!virtual.files.has(options.filePath)) {
      options.fail({
        errMsg: 'unlink:fail no such file or directory'
      });
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
      options.fail({
        errMsg: 'stat:fail no such file or directory'
      });
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

// ---- wx 模拟：真实 photo-files.js 会调用这些接口 ----
global.wx = {
  env: { USER_DATA_PATH },
  getStorageSync(key) {
    wxLog.getKeys.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    if (wxLog.setShouldThrow || wxLog.failKeys.has(key)) {
      throw { errMsg: 'setStorageSync:fail mock storage error' };
    }
    if (wxLog.failAfter && wxLog.failAfter.key === key) {
      wxLog.failAfter.count += 1;
      if (wxLog.failAfter.count > wxLog.failAfter.allowed) {
        throw { errMsg: 'setStorageSync:fail mock commit error' };
      }
    }
    storage.set(key, value);
  },
  removeStorageSync(key) {
    wxLog.removeKeys.push(key);
    storage.delete(key);
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
    const height = Math.max(
      1,
      Math.round((meta.height * width) / meta.width)
    );
    const finish = () => {
      compressSeq += 1;
      const filePath = 'http://tmp/compressed-' + compressSeq + '.jpg';
      const bytes = width <= 400 ? THUMB_BYTES : MAIN_BYTES;
      virtual.files.set(filePath, Buffer.alloc(bytes, 2));
      virtual.imageMeta.set(filePath, { width, height });
      options.success({ tempFilePath: filePath });
    };
    if (compressHold) {
      compressHold.then(finish);
    } else {
      finish();
    }
  },
  createOffscreenCanvas(options) {
    const canvas = {
      width: options.width,
      height: options.height,
      _srcPath: '',
      getContext() {
        return {
          drawImage() {}
        };
      },
      createImage() {
        const image = {};
        Object.defineProperty(image, 'src', {
          get() {
            return canvas._srcPath;
          },
          set(value) {
            canvas._srcPath = value;
            setImmediate(() => {
              if (typeof image.onload === 'function') image.onload();
            });
          }
        });
        return image;
      }
    };
    return canvas;
  },
  canvasToTempFilePath(options) {
    const meta = virtual.imageMeta.get(options.canvas._srcPath);
    virtual.calls.canvasToTempFilePath.push({
      src: options.canvas._srcPath,
      width: options.destWidth,
      height: options.destHeight
    });
    if (!meta) {
      options.fail({ errMsg: 'canvasToTempFilePath:fail no source' });
      return;
    }
    canvasSeq += 1;
    const filePath = 'http://tmp/canvas-thumb-' + canvasSeq + '.jpg';
    virtual.files.set(filePath, Buffer.alloc(THUMB_BYTES, 4));
    virtual.imageMeta.set(filePath, {
      width: options.destWidth || meta.width,
      height: options.destHeight || meta.height
    });
    options.success({ tempFilePath: filePath });
  },
  chooseMedia(options) {
    // 官方签名只有一个选项对象：success/fail 放在对象里。
    // 收到第 2 个及以后的参数时立即抛错，避免未修复的源码静静等不到回调。
    if (arguments.length !== 1) {
      throw new Error(
        'chooseMedia 只接受一个官方选项对象；实际收到 ' + arguments.length +
          ' 个参数，success/fail 必须放进同一个对象里'
      );
    }
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.success !== 'function' ||
      typeof options.fail !== 'function'
    ) {
      throw new Error('chooseMedia 的选项对象里应同时包含 success 与 fail');
    }
    wxLog.mediaCalls.push({
      count: options.count,
      mediaType: options.mediaType,
      sourceType: options.sourceType
    });
    if (wxLog.chooseBehavior === 'cancel') {
      options.fail({ errMsg: 'chooseMedia:fail cancel' });
      return;
    }
    if (wxLog.chooseBehavior === 'deny') {
      options.fail({ errMsg: 'chooseMedia:fail auth deny' });
      return;
    }
    if (wxLog.chooseBehavior === 'error') {
      options.fail({ errMsg: 'chooseMedia:fail mock system error' });
      return;
    }
    const filePath = addSourceImage(
      wxLog.sourceWidth,
      wxLog.sourceHeight,
      wxLog.sourceBytes
    );
    options.success({ tempFiles: [{ tempFilePath: filePath }], type: 'image' });
  },
  showModal(options) {
    wxLog.modalCalls.push({
      title: options.title,
      content: options.content,
      confirmText: options.confirmText,
      cancelText: options.cancelText
    });
    options.success({ confirm: wxLog.modalConfirm, cancel: !wxLog.modalConfirm });
  },
  showToast(options) {
    wxLog.toasts.push(options.title);
  },
  previewImage(options) {
    wxLog.previews.push({ current: options.current, urls: options.urls });
  },
  showActionSheet(options) {
    wxLog.actionSheets.push({ itemList: options.itemList });
    if (wxLog.actionSheetIndex === null) {
      options.fail({ errMsg: 'showActionSheet:fail cancel' });
      return;
    }
    options.success({ tapIndex: wxLog.actionSheetIndex });
  },
  pageScrollTo(options) {
    wxLog.scrolls.push(options);
  },
  navigateTo(options) {
    wxLog.navigations.push({ type: 'navigateTo', url: options.url });
  },
  navigateBack(options) {
    wxLog.navigations.push({ type: 'navigateBack', delta: options.delta });
  },
  reLaunch(options) {
    wxLog.navigations.push({ type: 'reLaunch', url: options.url });
  }
};

const store = require(STORE_JS);
const STORE_KEY = store.STORE_KEY;
const server = require(SERVER_JS);
const LEDGER_KEY = server.LEDGER_KEY;
const routePhotos = require(ROUTE_PHOTOS_JS);
const INDEX_KEY = routePhotos.INDEX_KEY;
const THUMB_CACHE_KEY = routePhotos.THUMB_CACHE_KEY;
const photoFiles = require(PHOTO_FILES_JS);
const photoSpace = require(PHOTO_SPACE_JS);
const trialPhotos = require(TRIAL_PHOTOS_JS);

let pageDefinition = null;
global.Page = definition => {
  pageDefinition = definition;
};
require(PAGE_JS);

let detailDefinition = null;
global.Page = definition => {
  detailDefinition = definition;
};
require(DETAIL_JS);

function resetHarness() {
  storage.clear();
  resetWxLog();
  resetVirtual();
  trialPhotos.setTrialSpacePolicy(null);
  trialPhotos.resetTrialPhotoService();
}

beforeEach(resetHarness);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function attachSetData(page) {
  page.setData = function setData(patch) {
    Object.keys(patch).forEach(key => {
      const value = patch[key];
      if (key.indexOf('.') === -1) {
        this.data[key] = value;
        return;
      }
      const parts = key.split('.');
      let target = this.data;
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!target[parts[index]] || typeof target[parts[index]] !== 'object') {
          target[parts[index]] = {};
        }
        target = target[parts[index]];
      }
      target[parts[parts.length - 1]] = value;
    });
  };
}

function createService(options) {
  const config = options || {};
  return routePhotos.createRoutePhotoService({
    ownerId: config.ownerId || trialPhotos.TRIAL_OWNER_ID,
    datasetId: config.datasetId || trialPhotos.TRIAL_DATASET_ID,
    files: photoFiles.createWxPhotoFiles(),
    instanceId: config.instanceId || 'svc-test',
    space: config.space
  });
}

async function createPage(options) {
  const config = options || {};
  if (config.space) trialPhotos.setTrialSpacePolicy(config.space);
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  attachSetData(page);
  page.onLoad(config.query || {});
  page._saveDelayMs = 0;
  await page._photoReady;
  return page;
}

async function createDetailPage(routeId) {
  const page = Object.create(detailDefinition);
  page.data = JSON.parse(JSON.stringify(detailDefinition.data));
  attachSetData(page);
  page.onLoad({ routeId });
  await page._photoReady;
  return page;
}

async function tapStart(page, gymIndex, date) {
  if (gymIndex !== undefined) page.onGymChange({ detail: { value: gymIndex } });
  if (date !== undefined) page.onDateChange({ detail: { value: date } });
  return page.startSession();
}

async function tapRoute(page, routeId) {
  return page.selectRoute({ currentTarget: { dataset: { routeId } } });
}

async function record(page, result) {
  return page.recordAttempt({ currentTarget: { dataset: { result } } });
}

function choose(page, routeId, source) {
  return page.chooseRoutePhoto({
    currentTarget: { dataset: { routeId, source } }
  });
}

function confirm(page, routeId) {
  return page.confirmRoutePhoto({
    currentTarget: { dataset: { routeId } }
  });
}

function retryPhoto(page, routeId) {
  return page.retryRoutePhoto({
    currentTarget: { dataset: { routeId } }
  });
}

function removePhoto(page, routeId) {
  return page.removeRoutePhoto({
    currentTarget: { dataset: { routeId } }
  });
}

async function savePhoto(page, routeId, source) {
  await choose(page, routeId, source || 'album');
  await confirm(page, routeId);
}

function photoIndex() {
  const raw = storage.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : null;
}

function savedState() {
  const raw = storage.get(STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function photoOfRoute(routeId, ownerId) {
  const index = photoIndex();
  if (!index) return null;
  const routes = index.routes.filter(
    item =>
      item.routeId === routeId &&
      (!ownerId || item.ownerId === ownerId)
  );
  const route = routes[routes.length - 1];
  if (!route || !route.photoId) return null;
  return index.photos.find(photo => photo.photoId === route.photoId) || null;
}

function opsOfRoute(routeId) {
  const index = photoIndex();
  if (!index) return [];
  return index.operations.filter(item => item.routeId === routeId);
}

function thumbPathOf(mainPath) {
  return mainPath.replace('/main/', '/thumb/');
}

async function serviceAdd(service, routeId, opId) {
  return service.addPhoto({
    routeId,
    sourcePath: addSourceImage(),
    opId
  });
}

// ---- PL01 计量与提醒 ----

test('PL01 逐项计量实际文件；同一照片不重复计费，低于/等于/高于提醒线', async () => {
  const policy = { budgetBytes: 1000000, warnBytes: 2 * PHOTO_BYTES, reserveBytes: 0 };
  const service = createService({ space: policy });
  await service.recover();

  const first = await serviceAdd(service, ROUTE_BLUE, 'life-measure-1');
  assert.equal(first.ok, true);
  assert.equal(first.photo.bytes.main, MAIN_BYTES);
  assert.equal(first.photo.bytes.thumb, THUMB_BYTES);

  let usage = await service.getSpaceUsage();
  assert.equal(usage.ok, true);
  assert.equal(usage.totalBytes, PHOTO_BYTES);
  assert.equal(usage.warn, false, '低于提醒线不提醒');
  assert.equal(usage.photoCount, 1);
  assert.equal(usage.fileCount, 2);
  assert.equal(
    usage.files.reduce((sum, file) => sum + file.bytes, 0),
    usage.totalBytes,
    '文件清单之和等于总占用'
  );
  for (const file of usage.files) {
    assert.equal(virtual.files.get(file.path).length, file.bytes);
  }

  // 同一线路重复读取不加倍计费。
  await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  const again = await service.getSpaceUsage();
  assert.equal(again.totalBytes, PHOTO_BYTES);
  assert.equal(again.fileCount, 2);

  await serviceAdd(service, ROUTE_RED, 'life-measure-2');
  usage = await service.getSpaceUsage();
  assert.equal(usage.totalBytes, 2 * PHOTO_BYTES);
  assert.equal(usage.warn, true, '等于提醒线即提醒（>= W）');
  assert.equal(usage.percent, 32);

  await serviceAdd(service, ROUTE_BLUE_BALANCE, 'life-measure-3');
  usage = await service.getSpaceUsage();
  assert.equal(usage.totalBytes, 3 * PHOTO_BYTES);
  assert.equal(usage.warn, true, '高于提醒线继续提醒');
  assert.equal(usage.photoCount, 3);
  assert.equal(usage.fileCount, 6);

  // 孤儿文件同样计入实际占用，并可被证明无引用后清理。
  addVirtualFile(PHOTO_ROOT + '/main/photo-999.jpg', 5000);
  usage = await service.getSpaceUsage();
  assert.equal(usage.totalBytes, 3 * PHOTO_BYTES + 5000);
  assert.equal(usage.orphanBytes, 5000);
  const cleaned = await service.cleanupOrphans();
  assert.equal(cleaned.ok, true);
  usage = await service.getSpaceUsage();
  assert.equal(usage.totalBytes, 3 * PHOTO_BYTES);
  assert.equal(usage.orphanBytes, 0);
});

test('PL01 预算检查按当前占用 + 新主图 + 新缩略图 + 更换余量计算峰值', () => {
  const meter = photoSpace.createPhotoSpaceMeter({
    files: photoFileStub(),
    policy: { budgetBytes: 1000, warnBytes: 800, reserveBytes: 100 }
  });
  assert.deepEqual(meter.policy, {
    version: 1,
    budgetBytes: 1000,
    warnBytes: 800,
    reserveBytes: 100
  });
  const ok = meter.checkSave(500, 200, 200);
  assert.equal(ok.ok, true, '500+200+200+100 = 1000，等于预算可通过');
  assert.equal(ok.peakBytes, 1000);
  const over = meter.checkSave(501, 200, 200);
  assert.equal(over.ok, false, '超过预算 1 字节即拒绝');
  assert.equal(over.reason, 'budget');
  assert.match(over.message, /超过本机试用预算/);
});

function photoFileStub() {
  return {
    async listMain() {
      return { ok: true, files: [] };
    },
    async listThumb() {
      return { ok: true, files: [] };
    },
    async stat() {
      return { ok: true, exists: false, bytes: 0 };
    },
    mainPath(photoId) {
      return PHOTO_ROOT + '/main/' + photoId + '.jpg';
    },
    thumbPath(photoId) {
      return PHOTO_ROOT + '/thumb/' + photoId + '.jpg';
    }
  };
}

// ---- PL02 空间不足可恢复 ----

test('PL02 新增超出预算保留旧照片/索引，释放空间后同一操作 ID 重试成功', async () => {
  const service = createService({
    space: { budgetBytes: 300000, warnBytes: 200000, reserveBytes: 20000 }
  });
  await service.recover();
  const first = await serviceAdd(service, ROUTE_BLUE, 'life-budget-1');
  assert.equal(first.ok, true);
  const firstPhotoId = first.photoId;
  const firstMain = first.photo.storage.location;

  const blocked = await serviceAdd(service, ROUTE_RED, 'life-budget-2');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'space-insufficient');
  assert.equal(blocked.recoverable, true);
  assert.equal(blocked.space.reason, 'budget');
  assert.match(blocked.error, /超过本机试用预算|空间不足/);
  assert.equal(photoIndex().photos.length, 1, '未写入新照片索引');
  assert.equal(photoOfRoute(ROUTE_RED), null);
  assert.equal(virtual.files.has(firstMain), true, '旧主图仍在');
  assert.equal(
    opsOfRoute(ROUTE_RED).filter(item => item.status === 'failed').length,
    1,
    '失败操作保留可重试状态'
  );

  // 释放唯一照片后再重试同一 opId：仍只有一个有效主照片。
  const removed = await service.removePhoto({ routeId: ROUTE_BLUE });
  assert.equal(removed.ok, true);
  const retried = await service.addPhoto({
    routeId: ROUTE_RED,
    sourcePath: addSourceImage(),
    opId: 'life-budget-2'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.opId, 'life-budget-2');
  assert.equal(photoIndex().photos.length, 1);
  assert.notEqual(retried.photoId, firstPhotoId);
  const usage = await service.getSpaceUsage();
  assert.equal(usage.totalBytes, PHOTO_BYTES);
});

test('PL02 更换按新旧共存峰值判断；失败保留旧图，成功后只清理旧文件', async () => {
  const small = createService({
    space: { budgetBytes: 300000, warnBytes: 200000, reserveBytes: 20000 }
  });
  await small.recover();
  const added = await serviceAdd(small, ROUTE_BLUE, 'life-replace-1');
  const oldPhotoId = added.photoId;
  const oldMain = added.photo.storage.location;
  const oldThumb = thumbPathOf(oldMain);

  const blocked = await small.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage(),
    opId: 'life-replace-2'
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'space-insufficient');
  assert.equal(photoOfRoute(ROUTE_BLUE).photoId, oldPhotoId, '旧关联不变');
  assert.equal(virtual.files.has(oldMain), true);
  assert.equal(virtual.files.has(oldThumb), true);
  assert.equal(photoIndex().photos.length, 1);

  // 注入更大预算后，用同一失败操作 ID 重试：新旧共存峰值可通过，成功后清理旧文件。
  const roomy = createService({
    space: { budgetBytes: 400000, warnBytes: 200000, reserveBytes: 20000 }
  });
  const replaced = await roomy.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage(),
    opId: 'life-replace-2'
  });
  assert.equal(replaced.ok, true);
  assert.notEqual(replaced.photoId, oldPhotoId);
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(virtual.files.has(oldMain), false, '更换成功后才删旧主图');
  assert.equal(virtual.files.has(oldThumb), false);
  assert.equal(virtual.files.has(replaced.photo.storage.location), true);
  assert.equal(
    opsOfRoute(ROUTE_BLUE).filter(item => item.opId === 'life-replace-2').length,
    1
  );
});

test('PL02 实际写入报空间不足时归为可恢复错误，旧照片与索引保留', async () => {
  const service = createService({
    space: { budgetBytes: 1000000, warnBytes: 800000, reserveBytes: 10000 }
  });
  await service.recover();
  const added = await serviceAdd(service, ROUTE_BLUE, 'life-write-1');
  assert.equal(added.ok, true);
  const oldPhotoId = added.photoId;
  const oldMain = added.photo.storage.location;

  faults.writeSpace = true;
  const failed = await service.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage(),
    opId: 'life-write-2'
  });
  faults.writeSpace = false;

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'space-insufficient');
  assert.match(failed.error, /空间不足|no space/i);
  assert.equal(photoOfRoute(ROUTE_BLUE).photoId, oldPhotoId);
  assert.equal(virtual.files.has(oldMain), true);
  assert.equal(photoIndex().photos.length, 1);

  const retried = await service.replacePhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage(),
    opId: 'life-write-2'
  });
  assert.equal(retried.ok, true);
  assert.equal(virtual.files.has(oldMain), false);
  assert.equal(photoIndex().photos.length, 1);
});

test('PL02 页面在空间不足时显示原因与管理入口，旧照片仍可预览', async () => {
  const page = await createPage({
    space: { budgetBytes: 300000, warnBytes: 100000, reserveBytes: 20000 }
  });
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_BLUE, 'album');
  assert.equal(page.data.routePhoto.status, 'saved');
  const mainPath = page.data.routePhoto.mainPath;

  await choose(page, ROUTE_BLUE, 'album');
  await confirm(page, ROUTE_BLUE);

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.equal(page.data.routePhoto.spaceIssue, true);
  assert.equal(page.data.routePhoto.manageSpaceVisible, true);
  assert.match(page.data.routePhoto.errorText, /预算|空间不足/);
  assert.match(page.data.routePhoto.statusText, /空间不足/);
  assert.equal(page.data.routePhoto.hasPhoto, true);
  assert.equal(page.data.routePhoto.mainPath, mainPath, '旧照片仍可用');
  assert.equal(page.data.attempts.length, 1, '空间不足不改动已有尝试');
  assert.equal(photoIndex().photos.length, 1);
  assert.match(page.data.photoSpace.warningText, /提醒线/);

  page.previewRoutePhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.equal(wxLog.previews[wxLog.previews.length - 1].current, mainPath);
});

// ---- PL03 普通清缓存 ----

test('PL03 页面清缓存只删缩略图：主图、索引、场次、尝试、待确认与无关数据不变', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  // 抱石首次完攀后该线不再新增，完攀留在 BLUE，待确认留在另一条仍可记录的 RED。
  await record(page, 'send');
  await savePhoto(page, ROUTE_BLUE, 'album');
  const blueMain = page.data.routePhoto.mainPath;

  await tapRoute(page, ROUTE_RED);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_RED, 'album');
  const redMain = page.data.routePhoto.mainPath;

  // 留一条待确认操作，验证普通清缓存不碰场次/尝试/待确认。
  server.armReceiptLoss();
  await record(page, 'fail');
  assert.equal(page.data.pendingAttempts.length, 1);
  const pendingOpId = page.data.pendingAttempts[0].opId;

  storage.set('climbingNote.otherFeature.v1', 'keep-me');
  addVirtualFile(USER_DATA_PATH + '/other-feature/keep.jpg', 4321);

  const indexBefore = storage.get(INDEX_KEY);
  const storeBefore = storage.get(STORE_KEY);
  const ledgerBefore = storage.get(LEDGER_KEY);
  const blueBytes = virtual.files.get(blueMain).length;
  const redBytes = virtual.files.get(redMain).length;
  const attemptsBefore = savedState().attempts.length;

  wxLog.modalConfirm = true;
  const result = await page.clearPhotoCache();

  assert.equal(result.ok, true);
  assert.equal(result.deletedCount, 2);
  assert.match(
    wxLog.modalCalls[wxLog.modalCalls.length - 1].content,
    /只删除可以重新生成的缩略图/
  );
  assert.match(wxLog.toasts[wxLog.toasts.length - 1], /已清除缓存/);

  assert.equal(virtual.files.has(blueMain), true);
  assert.equal(virtual.files.has(redMain), true);
  assert.equal(virtual.files.get(blueMain).length, blueBytes);
  assert.equal(virtual.files.get(redMain).length, redBytes);
  assert.equal(virtual.files.has(thumbPathOf(blueMain)), false);
  assert.equal(virtual.files.has(thumbPathOf(redMain)), false);
  assert.equal(storage.has(THUMB_CACHE_KEY), false);
  assert.equal(storage.get(INDEX_KEY), indexBefore, '照片索引原样保留');
  assert.equal(storage.get(STORE_KEY), storeBefore, '场次与尝试原样保留');
  assert.equal(storage.get(LEDGER_KEY), ledgerBefore, '模拟账本不动');
  assert.equal(storage.get('climbingNote.otherFeature.v1'), 'keep-me');
  assert.equal(virtual.files.has(USER_DATA_PATH + '/other-feature/keep.jpg'), true);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(savedState().pendingSaves[0].opId, pendingOpId);

  // 列表缩略图回退到主图路径，重开后仍可预览。
  const blueItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(blueItem.photoThumb, blueMain);
  assert.equal(blueItem.hasPhoto, true);
  assert.equal(page.data.photoSpace.totalBytes, blueBytes + redBytes);
  assert.equal(page.data.photoSpace.missingThumbCount, 2);

  page.onUnload();
  const reentered = await createPage();
  const redPhoto = photoOfRoute(ROUTE_RED);
  assert.equal(reentered.data.routePhoto.photoId, redPhoto.photoId);
  reentered.previewRoutePhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.equal(wxLog.previews[wxLog.previews.length - 1].current, blueMain);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(reentered.data.pendingAttempts.length, 1);

  // 从持久主图重建缩略图：开发者工具式压缩失败后走画布回退。
  const rebuilt = await reentered.rebuildPhotoThumbs();
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.rebuiltCount, 2);
  assert.equal(wxLog.previews[wxLog.previews.length - 1].current, blueMain);
  assert.equal(virtual.calls.canvasToTempFilePath.length >= 2, true);
  assert.equal(virtual.files.has(thumbPathOf(blueMain)), true);
  assert.equal(virtual.files.has(thumbPathOf(redMain)), true);
  assert.equal(virtual.files.get(blueMain).length, blueBytes, '重建不改主图');
  assert.equal(storage.has(THUMB_CACHE_KEY), true);
  assert.equal(JSON.parse(storage.get(THUMB_CACHE_KEY)).items.length, 2);
  assert.equal(storage.get(INDEX_KEY), indexBefore, '重建不改照片索引');
  assert.equal(savedState().pendingSaves.length, 1);
});

test('PL03 重建缺失缩略图覆盖同一试用用户的旧数据集照片', async () => {
  const oldService = createService({ datasetId: 'trial-dataset-local-1' });
  await oldService.recover();
  const oldAdded = await serviceAdd(oldService, ROUTE_BLUE, 'life-ds-1');
  const oldMain = oldAdded.photo.storage.location;
  const oldThumb = thumbPathOf(oldMain);

  const newService = createService({ datasetId: 'trial-dataset-local-2' });
  await newService.recover();
  const newAdded = await serviceAdd(newService, ROUTE_BLUE, 'life-ds-2');
  const newMain = newAdded.photo.storage.location;
  const newThumb = thumbPathOf(newMain);

  const cleared = await newService.clearRebuildableCache();
  assert.equal(cleared.ok, true);
  assert.equal(virtual.files.has(oldThumb), false);
  assert.equal(virtual.files.has(newThumb), false);
  assert.equal(virtual.files.has(oldMain), true);
  assert.equal(virtual.files.has(newMain), true);
  const oldMainBytes = virtual.files.get(oldMain).length;
  const newMainBytes = virtual.files.get(newMain).length;

  const rebuilt = await newService.rebuildMissingThumbnails();
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.rebuiltCount, 2, '旧数据集与当前数据集的缩略图都重建');
  assert.equal(virtual.files.has(oldThumb), true);
  assert.equal(virtual.files.has(newThumb), true);
  assert.equal(virtual.files.get(oldMain).length, oldMainBytes);
  assert.equal(virtual.files.get(newMain).length, newMainBytes);
  assert.equal(photoIndex().photos.length, 2);
});

test('PL03 照片保存中拒绝清缓存，不误删正在写入的缩略图', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');
  const mainPath = page.data.routePhoto.mainPath;
  const thumbPath = thumbPathOf(mainPath);

  const gate = createGate();
  compressHold = gate.promise;
  await choose(page, ROUTE_BLUE, 'album');
  const saving = confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saving');

  const result = await page.clearPhotoCache();
  assert.equal(result.ok, false);
  assert.match(result.error, /进行中/);
  assert.equal(virtual.files.has(thumbPath), true, '保存中的缩略图未被删除');

  compressHold = null;
  gate.release();
  await saving;
  assert.equal(page.data.routePhoto.status, 'saved');
});

// ---- PL04 失败与重置 ----

test('PL04 重置取消不动资料；写入失败恢复原账本，重试后轮换数据集且旧照片保留', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_BLUE, 'album');
  const firstDataset = page.state.datasetId;
  const firstPhoto = photoIndex().photos[0];
  const firstMain = firstPhoto.storage.location;

  const stateBefore = storage.get(STORE_KEY);
  const ledgerBefore = storage.get(LEDGER_KEY);
  const indexBefore = storage.get(INDEX_KEY);

  // 取消：所有资料与账本保持原样。
  wxLog.modalConfirm = false;
  assert.equal(await page.resetTrialData(), false);
  assert.equal(storage.get(STORE_KEY), stateBefore);
  assert.equal(storage.get(LEDGER_KEY), ledgerBefore);
  assert.equal(storage.get(INDEX_KEY), indexBefore);

  // 客户端写入失败：已重置的账本必须恢复，原有资料与照片不动。
  wxLog.modalConfirm = true;
  wxLog.failKeys.add(STORE_KEY);
  const failed = await page.resetTrialData();
  wxLog.failKeys.delete(STORE_KEY);
  assert.equal(failed, false);
  assert.match(page.data.storageError, /重置未完成/);
  assert.match(page.data.storageError, /保留/);
  assert.equal(storage.get(STORE_KEY), stateBefore);
  assert.equal(storage.get(LEDGER_KEY), ledgerBefore, '账本恢复到重置前');
  assert.equal(storage.get(INDEX_KEY), indexBefore);
  assert.equal(virtual.files.has(firstMain), true);

  // 修复后重试：轮换数据集，旧照片和索引保留，新数据集不继承旧关联。
  const reset = await page.resetTrialData();
  assert.equal(reset, true);
  const secondDataset = savedState().datasetId;
  assert.notEqual(secondDataset, firstDataset);
  assert.equal(savedState().sessions.length, 0);
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(photoIndex().photos[0].photoId, firstPhoto.photoId);
  assert.equal(photoIndex().photos[0].datasetId, firstDataset);
  assert.equal(virtual.files.has(firstMain), true);
  assert.equal(page._photoUi.getDatasetId(), secondDataset);
  await page._photoReady;
  assert.equal(page.data.photoSpace.currentDatasetPhotoCount, 0);
  assert.equal(
    page.data.photoSpace.totalBytes,
    PHOTO_BYTES,
    '旧数据集照片仍占用实际空间并如实展示'
  );
});

test('PL04 重置前发出的照片回调失效，不把旧照片写进新数据集视图', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);

  const gate = createGate();
  compressHold = gate.promise;
  await choose(page, ROUTE_BLUE, 'album');
  const saving = confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saving');

  const toastsBefore = wxLog.toasts.length;
  // 页面正常入口会阻止保存中重置；这里直接走同一重置实现，验证迟到回调。
  assert.equal(page.applyTrialReset('trial-dataset-local-2'), true);
  assert.equal(page.state.datasetId, 'trial-dataset-local-2');

  compressHold = null;
  gate.release();
  await saving;

  assert.equal(wxLog.toasts.length, toastsBefore, '重置后不再提示已保存');
  assert.equal(page.data.routePhoto, null, '新数据集没有线路照片卡片');
  const index = photoIndex();
  assert.equal(
    index.photos.filter(
      photo => photo.datasetId === 'trial-dataset-local-2'
    ).length,
    0,
    '旧回调不会把照片写进新数据集'
  );
  assert.equal(
    index.photos.filter(
      photo => photo.datasetId === trialPhotos.TRIAL_DATASET_ID
    ).length,
    0,
    '重置时新数据集服务的恢复会中止旧操作为未完成，不留下半成品照片'
  );
  const operation = opsOfRoute(ROUTE_BLUE)[0];
  assert.ok(
    operation.status === 'aborted' || operation.status === 'failed',
    '旧操作以中止/失败结束，不停留在进行中'
  );
  assert.equal(index.operations.filter(op => op.status === 'started').length, 0);

  const usage = await page.refreshPhotoSpace();
  assert.equal(usage.currentDatasetPhotoCount, 0);
  assert.equal(usage.totalBytes, 0, '被中止操作的半成品文件已清理');
});

test('PL04 重复点击确认只产生一次保存，重进页面从持久索引恢复', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await choose(page, ROUTE_BLUE, 'album');
  const first = confirm(page, ROUTE_BLUE);
  const second = await confirm(page, ROUTE_BLUE);
  assert.equal(second, null, '保存中再次确认不派发第二次');
  await first;

  assert.equal(photoIndex().photos.length, 1);
  assert.equal(opsOfRoute(ROUTE_BLUE).length, 1);
  assert.equal(page.data.routePhoto.status, 'saved');

  page.onUnload();
  const reentered = await createPage();
  assert.equal(reentered.data.routePhoto.status, 'saved');
  assert.equal(
    reentered.data.routePhoto.photoId,
    photoIndex().photos[0].photoId
  );
});

// ---- PL05 隔离与离线展示 ----

test('PL05 注入 A/B 身份：互不见、互不改，页面只读当前试用身份', async () => {
  const serviceA = createService();
  const serviceB = createService({ ownerId: 'trial-user-local-b' });
  await serviceA.recover();
  await serviceB.recover();

  const bPhoto = await serviceAdd(serviceB, ROUTE_RED, 'life-b-1');
  assert.equal(bPhoto.ok, true);
  const bPhotoId = bPhoto.photoId;

  // B 的照片对 A 页面不可见。
  let page = await createPage();
  await tapStart(page);
  assert.equal(
    page.data.routes.find(route => route.id === ROUTE_RED).hasPhoto,
    false,
    'B 的照片不进入 A 页面'
  );
  assert.equal(page._photoUi.getService().ownerId, trialPhotos.TRIAL_OWNER_ID);

  await tapRoute(page, ROUTE_RED);
  await savePhoto(page, ROUTE_RED, 'album');
  const aPhoto = photoOfRoute(ROUTE_RED, trialPhotos.TRIAL_OWNER_ID);
  assert.ok(aPhoto);
  assert.notEqual(aPhoto.photoId, bPhotoId);
  assert.equal(photoIndex().photos.length, 2, '两个身份各保留自己的记录');

  const aRead = await serviceA.getRoutePhoto({ routeId: ROUTE_RED });
  const bRead = await serviceB.getRoutePhoto({ routeId: ROUTE_RED });
  assert.equal(aRead.photo.photoId, aPhoto.photoId);
  assert.equal(bRead.photo.photoId, bPhotoId);
  assert.equal(
    (await serviceA.getPhoto({ photoId: bPhotoId })).code,
    'not-found',
    'A 不能按 photoId 读取 B 的照片'
  );
  assert.equal(
    (await serviceB.getPhoto({ photoId: aPhoto.photoId })).code,
    'not-found'
  );

  // B 移除自己的照片不影响 A。
  const removed = await serviceB.removePhoto({ routeId: ROUTE_RED });
  assert.equal(removed.ok, true);
  assert.equal((await serviceA.getRoutePhoto({ routeId: ROUTE_RED })).ok, true);
  assert.equal(virtual.files.has(aPhoto.storage.location), true);
  assert.equal(virtual.files.has(bPhoto.photo.storage.location), false);

  page.onUnload();
  page = await createPage();
  await tapStart(page);
  assert.equal(
    page.data.routes.find(route => route.id === ROUTE_RED).hasPhoto,
    true,
    '回到 A 仍看到自己的照片'
  );
});

test('PL05 A 保存途中 B 写入同一线路：只按发起时归属落盘，互不覆盖', async () => {
  const serviceA = createService();
  const serviceB = createService({ ownerId: 'trial-user-local-b' });
  await serviceA.recover();
  await serviceB.recover();

  const gate = createGate();
  compressHold = gate.promise;
  const savingA = serviceAdd(serviceA, ROUTE_BLUE, 'life-a-inflight');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opsOfRoute(ROUTE_BLUE).length, 1, 'A 操作已启动');

  // 让 B 的压缩正常完成；A 仍被阻塞在第一次压缩上。
  compressHold = null;
  const bPhoto = await serviceAdd(serviceB, ROUTE_BLUE, 'life-b-inflight');
  assert.equal(bPhoto.ok, true);

  gate.release();
  const aResult = await savingA;
  assert.equal(aResult.ok, true);

  const aRead = await serviceA.getRoutePhoto({ routeId: ROUTE_BLUE });
  const bRead = await serviceB.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(aRead.photo.photoId, aResult.photoId);
  assert.equal(bRead.photo.photoId, bPhoto.photoId);
  assert.notEqual(aResult.photoId, bPhoto.photoId);
  assert.equal(photoIndex().photos.length, 2);
  assert.equal(
    photoIndex().photos.filter(item => item.routeId === ROUTE_BLUE).length,
    2
  );
});

test('PL05 已保存照片断网仍可预览；缺文件只提示重新添加，不展示其他线路照片', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');
  const mainPath = page.data.routePhoto.mainPath;

  // 本地预览不经过网络或云接口。
  page.previewRoutePhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.equal(wxLog.previews[wxLog.previews.length - 1].current, mainPath);
  assert.equal(wxLog.navigations.length, 0);

  page.onUnload();
  virtual.files.delete(mainPath);
  virtual.files.delete(thumbPathOf(mainPath));
  const reentered = await createPage();
  assert.equal(reentered.data.routePhoto.status, 'missing');
  assert.match(reentered.data.routePhoto.statusText, /本机照片不可用，可重新添加/);
  assert.equal(
    reentered.data.routes.find(route => route.id === ROUTE_RED).hasPhoto,
    false,
    '缺文件不展示其他线路照片'
  );
  const usage = await reentered.refreshPhotoSpace();
  assert.equal(usage.missingMains.length, 1);
  assert.equal(usage.missingThumbs.length, 1);
});

// ---- PL06 整批交接 ----

test('PL06 页面提供照片空间、提醒、管理、清缓存与重建入口；文档含预算和待验边界', () => {
  const todayWxml = read(PAGE_WXML);
  const detailWxml = read(DETAIL_WXML);
  const readme = read(README_PATH);
  const sources =
    read(PAGE_JS) +
    read(DETAIL_JS) +
    read(CONTROLLER_JS) +
    read(PHOTO_SPACE_JS) +
    read(TRIAL_PHOTOS_JS);

  for (const id of [
    'photo-space-card',
    'photo-space-manage',
    'photo-space-clear-cache',
    'photo-space-rebuild',
    'photo-space-cleanup',
    'photo-space-warn',
    'photo-space-open'
  ]) {
    assert.match(todayWxml, new RegExp('id="' + id + '"'), '今日页应含 ' + id);
  }
  assert.match(todayWxml, /清除可重建缓存/);
  assert.match(todayWxml, /只删除可重建缩略图/);
  assert.match(detailWxml, /id="detail-photo-space-manage"/);
  assert.match(detailWxml, /管理照片空间/);
  assert.match(read(PAGE_JS), /openPhotoSpaceManager/);
  assert.match(read(DETAIL_JS), /openSpaceManager/);

  assert.doesNotMatch(sources, /wx\.cloud|uploadFile/);
  assert.doesNotMatch(sources, /clearStorageSync/);

  assert.match(readme, /T012/);
  assert.match(readme, /100 MiB/);
  assert.match(readme, /80 MiB/);
  assert.match(readme, /10 MiB/);
  assert.match(readme, /1 MiB = 1024 × 1024/);
  assert.match(readme, /清除可重建缓存/);
  assert.match(readme, /负责人整批验收/);
  assert.match(readme, /待验/);
});

test('PL06 文件适配器对持久主图压缩失败时回退画布，且不访问云或正式记录', () => {
  const filesSource = read(PHOTO_FILES_JS);
  const spaceSource = read(PHOTO_SPACE_JS);
  const routeSource = read(ROUTE_PHOTOS_JS);
  assert.match(filesSource, /createOffscreenCanvas/);
  assert.match(filesSource, /canvasToTempFilePath/);
  assert.doesNotMatch(
    filesSource + spaceSource + routeSource,
    /wx\.cloud|uploadFile|climbing_records|climbing_sessions/
  );
  assert.doesNotMatch(spaceSource, /clearStorageSync/);
});

// ---- PL07 并发预留、维护协调与显示口径（T012 返工复验） ----

/**
 * 给真实文件适配器包一层可控的异步边界：`arm()` 之后的下一次该方法调用会先挂起，
 * 由测试决定何时释放。文件和压缩仍是真实 wx 替身；即使目标调用没发生也不会死锁。
 */
function holdNextCall(files, method) {
  const original = files[method].bind(files);
  let gate = null;
  const state = { hit: false };
  const wrapped = Object.assign({}, files);
  wrapped[method] = async function wrappedMethod() {
    if (gate) {
      const current = gate;
      gate = null;
      state.hit = true;
      await current.promise;
    }
    return original.apply(null, arguments);
  };
  return {
    files: wrapped,
    state,
    arm() {
      let release;
      const promise = new Promise(resolve => {
        release = resolve;
      });
      gate = { promise };
      return release;
    }
  };
}

/** 有界等待挂起点生效：最多 50 个宏任务，不会死锁。 */
async function waitForHit(hold) {
  for (let tick = 0; tick < 50; tick += 1) {
    if (hold.state.hit) return true;
    await new Promise(resolve => setImmediate(resolve));
  }
  return hold.state.hit;
}

function createHookedService(options) {
  const config = options || {};
  return routePhotos.createRoutePhotoService({
    ownerId: config.ownerId || trialPhotos.TRIAL_OWNER_ID,
    datasetId: config.datasetId || trialPhotos.TRIAL_DATASET_ID,
    files: config.files || photoFiles.createWxPhotoFiles(),
    instanceId: config.instanceId || 'svc-hooked',
    runtimeId: config.runtimeId,
    space: config.space
  });
}

test('PL07 并发保存共用一份在途预留：后到者被拒绝、保旧、可重试', async () => {
  const policy = { budgetBytes: 300000, warnBytes: 200000, reserveBytes: 20000 };
  const service = createService({ space: policy });
  await service.recover();

  // 第一路停在压缩阶段（尚未登记预留）；第二路先完成整笔保存。
  const gate = createGate();
  compressHold = gate.promise;
  const first = serviceAdd(service, ROUTE_BLUE, 'life-concurrent-1');
  await new Promise(resolve => setImmediate(resolve));
  compressHold = null;
  const second = await serviceAdd(service, ROUTE_RED, 'life-concurrent-2');
  assert.equal(second.ok, true, '先完成的一路成功');
  gate.release();
  const firstResult = await first;

  assert.equal(firstResult.ok, false, '后到者不得按过期占用放行');
  assert.equal(firstResult.code, 'space-insufficient');
  assert.equal(firstResult.recoverable, true);
  const usage = await service.getSpaceUsage();
  assert.ok(
    usage.totalBytes <= policy.budgetBytes,
    '实际占用不得越过预算，实际 ' + usage.totalBytes
  );
  assert.equal(photoIndex().photos.length, 1, '只保留先完成的那张');
  assert.equal(
    photoOfRoute(ROUTE_RED, trialPhotos.TRIAL_OWNER_ID).photoId,
    second.photoId
  );
  assert.equal(
    opsOfRoute(ROUTE_BLUE).filter(op => op.status === 'started').length,
    0,
    '失败的并发保存不留下未完成操作'
  );

  // 释放空间后同一 opId 可重试成功。
  assert.equal((await service.removePhoto({ routeId: ROUTE_RED })).ok, true);
  const retried = await service.addPhoto({
    routeId: ROUTE_BLUE,
    sourcePath: addSourceImage(),
    opId: 'life-concurrent-1'
  });
  assert.equal(retried.ok, true);
  const finalUsage = await service.getSpaceUsage();
  assert.equal(finalUsage.totalBytes, PHOTO_BYTES);
});

test('PL07 缩略图重建同样受预算约束，放宽预算后可重试', async () => {
  // 预算刚好容得下两张完整照片（324000），但容不下再补两张缩略图。
  const small = createService({
    space: { budgetBytes: 340000, warnBytes: 200000, reserveBytes: 20000 }
  });
  await small.recover();
  const first = await serviceAdd(small, ROUTE_BLUE, 'life-rebuild-budget-1');
  assert.equal(first.ok, true);
  assert.equal((await small.clearRebuildableCache()).ok, true);
  const second = await serviceAdd(small, ROUTE_RED, 'life-rebuild-budget-2');
  assert.equal(second.ok, true);

  const before = await small.getSpaceUsage();
  assert.equal(before.totalBytes, MAIN_BYTES * 2 + THUMB_BYTES, '清缓存后只剩一张缩略图');
  const blocked = await small.rebuildMissingThumbnails();
  assert.equal(blocked.ok, false, '重建不得越过预算');
  assert.equal(blocked.failed.length, 1);
  assert.equal(blocked.failed[0].code, 'space-insufficient');
  const after = await small.getSpaceUsage();
  assert.ok(after.totalBytes <= 340000, '实际占用仍在预算内');
  assert.equal(virtual.files.has(first.photo.storage.location), true);
  assert.equal(virtual.files.has(second.photo.storage.location), true);

  // 放宽预算后同一重建成功：缺失缩略图补齐，主图字节不变。
  const roomy = createService({
    space: { budgetBytes: 400000, warnBytes: 200000, reserveBytes: 20000 }
  });
  const retried = await roomy.rebuildMissingThumbnails();
  assert.equal(retried.ok, true);
  assert.equal(retried.rebuiltCount, 1);
  const finalUsage = await roomy.getSpaceUsage();
  assert.equal(finalUsage.totalBytes, 2 * PHOTO_BYTES);
  assert.equal(
    virtual.files.get(first.photo.storage.location).length,
    MAIN_BYTES,
    '重建不改主图'
  );
});

test('PL07 清缓存与保存交错：新保存照片的缩略图与元数据保留', async () => {
  const hold = holdNextCall(photoFiles.createWxPhotoFiles(), 'listThumb');
  const service = createHookedService({ files: hold.files });
  await service.recover();

  const release = hold.arm();
  const clearing = service.clearRebuildableCache();
  const saved = await serviceAdd(service, ROUTE_BLUE, 'life-clear-race');
  assert.equal(saved.ok, true);
  assert.equal(hold.state.hit, true, '清缓存确实在读取缩略图清单时被挂起');
  release();
  const cleared = await clearing;
  assert.equal(cleared.ok, true);

  const thumbPath = thumbPathOf(saved.photo.storage.location);
  assert.equal(
    virtual.files.has(thumbPath),
    true,
    '清缓存期间新保存的缩略图不得被删除'
  );
  const read = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(read.status, 'ready');
  assert.equal(read.photo.thumbnail.available, true);
  const cache = JSON.parse(storage.get(THUMB_CACHE_KEY));
  assert.ok(
    cache.items.some(item => item.photoId === saved.photoId),
    '保留的缩略图仍有元数据条目'
  );
});

test('PL07 清理无引用文件与保存交错：按最新引用跳过刚提交的主图', async () => {
  const hold = holdNextCall(photoFiles.createWxPhotoFiles(), 'listMain');
  const service = createHookedService({ files: hold.files });
  await service.recover();

  const release = hold.arm();
  const cleanup = service.cleanupOrphans();
  const saved = await serviceAdd(service, ROUTE_BLUE, 'life-cleanup-race');
  assert.equal(saved.ok, true);
  assert.equal(hold.state.hit, true, '清理确实在读取主图清单时被挂起');
  release();
  const cleaned = await cleanup;

  assert.equal(cleaned.ok, true);
  assert.equal(virtual.files.has(saved.photo.storage.location), true);
  assert.equal(virtual.files.has(thumbPathOf(saved.photo.storage.location)), true);
  assert.equal(
    cleaned.deleted.indexOf(saved.photo.storage.location),
    -1,
    '删除清单不得包含刚提交的主图'
  );
  const read = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(read.ok, true);
  assert.equal(read.photo.photoId, saved.photoId);
});

test('PL07 重建与移除交错：不为已移除照片留下孤儿缩略图或缓存条目', async () => {
  const hold = holdNextCall(photoFiles.createWxPhotoFiles(), 'writeThumb');
  const service = createHookedService({ files: hold.files });
  await service.recover();
  const saved = await serviceAdd(service, ROUTE_BLUE, 'life-rebuild-remove');
  assert.equal(saved.ok, true);
  assert.equal((await service.clearRebuildableCache()).ok, true);
  const thumbPath = thumbPathOf(saved.photo.storage.location);

  const release = hold.arm();
  const rebuilding = service.rebuildMissingThumbnails();
  assert.equal(
    await waitForHit(hold),
    true,
    '重建确实在写入缩略图前被挂起'
  );
  const removed = await service.removePhoto({ routeId: ROUTE_BLUE });
  release();
  const rebuilt = await rebuilding;

  assert.equal(removed.ok, true);
  assert.equal(virtual.files.has(saved.photo.storage.location), false);
  assert.equal(virtual.files.has(thumbPath), false, '不留孤儿缩略图');
  assert.equal(
    storage.has(THUMB_CACHE_KEY),
    false,
    '不留已移除照片的缓存条目'
  );
  assert.equal(rebuilt.ok, false, '迟到重建报告失败而不是假成功');
  assert.equal(rebuilt.failed[0].photoId, saved.photoId);
  const read = await service.getRoutePhoto({ routeId: ROUTE_BLUE });
  assert.equal(read.status, 'none');
});

test('PL07 新实例初始化不中止其他归属的活跃保存，过期实例遗留仍可恢复', async () => {
  // 用 writeThumb 挂起活跃保存：真实适配器 + 可控异步边界。
  const filesWithHold = holdNextCall(photoFiles.createWxPhotoFiles(), 'writeThumb');
  const liveService = createHookedService({
    instanceId: 'svc-live',
    files: filesWithHold.files
  });
  const otherService = createHookedService({
    ownerId: 'trial-user-local-b',
    datasetId: 'trial-dataset-local-b',
    instanceId: 'svc-other',
    files: photoFiles.createWxPhotoFiles()
  });
  const releaseLive = filesWithHold.arm();
  const pending = serviceAdd(liveService, ROUTE_BLUE, 'life-live-op');
  assert.equal(
    await waitForHit(filesWithHold),
    true,
    '活跃保存确实被挂起在写缩略图前'
  );
  const mainPath = filesWithHold.files.mainPath('photo-1');
  assert.equal(virtual.files.has(mainPath), true, '活跃保存已写入主图');

  const recovered = await otherService.recover();
  assert.deepEqual(recovered.abortedOps, [], '不把活跃操作当作崩溃遗留');
  assert.equal(virtual.files.has(mainPath), true, 'B 初始化不得删除 A 的主图');
  releaseLive();
  const liveResult = await pending;
  assert.equal(liveResult.ok, true, 'A 的保存正常完成');
  assert.equal(opsOfRoute(ROUTE_BLUE)[0].status, 'committed');

  // 真正中断：旧运行期（小程序/进程已重启）的遗留操作由新运行期立即中止。
  const deadFiles = holdNextCall(photoFiles.createWxPhotoFiles(), 'writeMain');
  const dead = routePhotos.createRoutePhotoService({
    ownerId: trialPhotos.TRIAL_OWNER_ID,
    datasetId: 'trial-dataset-dead',
    instanceId: 'svc-dead',
    runtimeId: 'runtime-dead',
    files: deadFiles.files,
    now: () => '2026-11-06T10:00:00.000Z'
  });
  const releaseDead = deadFiles.arm();
  const leftover = serviceAdd(dead, ROUTE_RED, 'life-leftover');
  assert.equal(
    await waitForHit(deadFiles),
    true,
    '遗留操作确实被挂起在写主图前'
  );
  const restarted = routePhotos.createRoutePhotoService({
    ownerId: trialPhotos.TRIAL_OWNER_ID,
    datasetId: 'trial-dataset-dead',
    instanceId: 'svc-restarted',
    runtimeId: 'runtime-restarted',
    files: deadFiles.files,
    now: () => '2026-11-06T10:40:00.000Z'
  });
  const restartedResult = await restarted.recover();
  assert.deepEqual(restartedResult.abortedOps, ['life-leftover']);
  releaseDead();
  const late = await leftover;
  assert.equal(late.ok, false, '被中止的操作不得假成功');
  assert.equal(
    virtual.files.has(deadFiles.files.mainPath('photo-2')),
    false,
    '遗留半成品文件被清理'
  );
  assert.equal(virtual.files.has(mainPath), true, '已提交照片不受影响');
});

test('PL07 照片卡按当前实际缩略图字节显示，与真实文件和空间卡一致', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');
  const mainPath = page.data.routePhoto.mainPath;
  const thumbPath = thumbPathOf(mainPath);
  assert.match(page.data.routePhoto.bytesText, /缩略图/, '保存后显示缩略图字节');

  // 清缓存：不得继续显示已不存在的缩略图占用。
  assert.equal((await page.clearPhotoCache()).ok, true);
  assert.doesNotMatch(
    page.data.routePhoto.bytesText,
    /缩略图/,
    '清缓存后不得显示旧缩略图占用，实际 ' + page.data.routePhoto.bytesText
  );

  // 重开页面：仍不得回放索引里的写入时快照。
  page.onUnload();
  const reentered = await createPage();
  await tapStart(reentered);
  await tapRoute(reentered, ROUTE_BLUE);
  assert.doesNotMatch(reentered.data.routePhoto.bytesText, /缩略图/);

  // 外部把缩略图换成不同大小：照片卡必须跟随真实文件，而不是索引快照。
  addVirtualFile(thumbPath, 30000);
  const afterExternal = await createPage();
  await tapStart(afterExternal);
  await tapRoute(afterExternal, ROUTE_BLUE);
  assert.equal(
    afterExternal.data.routePhoto.bytesText,
    '主图 146 KB · 缩略图 29 KB',
    '按真实文件显示缩略图字节'
  );
  assert.equal(afterExternal.data.photoSpace.thumbBytes, 30000);

  // 真实重建后照片卡、真实文件与空间卡三者一致。
  virtual.files.delete(thumbPath);
  const reloaded = await createPage();
  await tapStart(reloaded);
  await tapRoute(reloaded, ROUTE_BLUE);
  assert.doesNotMatch(reloaded.data.routePhoto.bytesText, /缩略图/);
  const rebuilt = await reloaded.rebuildPhotoThumbs();
  assert.equal(rebuilt.ok, true);
  const realThumbBytes = virtual.files.get(thumbPath).length;
  assert.equal(
    reloaded.data.routePhoto.bytesText,
    '主图 146 KB · 缩略图 ' + Math.round(realThumbBytes / 1024) + ' KB'
  );
  assert.equal(reloaded.data.photoSpace.thumbBytes, realThumbBytes);
  const record = photoOfRoute(ROUTE_BLUE, trialPhotos.TRIAL_OWNER_ID);
  assert.equal(record.storage.location, mainPath, '重建不改主图位置');
  assert.equal(virtual.files.get(mainPath).length, MAIN_BYTES, '重建不改主图字节');
});
