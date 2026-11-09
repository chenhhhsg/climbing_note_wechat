/**
 * 岩馆快速记录 · 线路照片页面接入测试（PU01–PU05）
 *
 * 直接加载独立工程的两个真实页面、真实照片控制器与 T010 照片服务；
 * 只替换微信存储、文件系统、图片压缩、选择器与弹窗：
 * - 真实执行 route-photos.js / photo-files.js / photo-controller.js；
 * - 用可控虚拟文件验证“文件和索引完成才成功”、缺文件、移除失败与重试；
 * - 页面回调只按 routeId 更新照片展示，分别断言照片索引、线路和尝试。
 *
 * 选择器、拍照/相册权限与真机文件保留仍是模拟，不代表真机验收。
 *
 * 运行：node --test tests/gym-log-photos.test.cjs
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
const CONTROLLER_JS = path.join(DEV_PROJECT, 'utils', 'photo-controller.js');
const TRIAL_PHOTOS_JS = path.join(DEV_PROJECT, 'utils', 'trial-photos.js');

const ROUTE_BLUE = 'route-chalkbox-blue-dyn';
const ROUTE_BLUE_BALANCE = 'route-chalkbox-blue-balance';
const ROUTE_RED = 'route-chalkbox-red-overhang';

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
    chooseMedia: []
  }
};
const faults = {
  copyFile: false,
  unlink: false,
  stat: false,
  getImageInfo: false,
  compress: false
};
const wxLog = {
  getKeys: [],
  setKeys: [],
  failKeys: new Set(),
  failAfter: null,
  setShouldThrow: false,
  mediaCalls: [],
  imageCalls: [],
  // 选择器调用形状（参数个数、回调是否在选项对象里）；两个接口各自独立记录，
  // 不共享成功/失败槽位，避免一个 mock 的副作用掩盖另一个的结果。
  pickerCalls: [],
  pickerViolations: [],
  chooseBehavior: 'success',
  chooseImageBehavior: 'success',
  chooseMediaPayload: null,
  chooseImagePayload: null,
  modalCalls: [],
  toasts: [],
  previews: [],
  actionSheets: [],
  navigations: [],
  modalConfirm: true,
  actionSheetIndex: 0,
  sourceWidth: 2400,
  sourceHeight: 1600,
  sourceBytes: 500000
};

let compressHold = null;
let sourceSeq = 0;
let compressSeq = 0;

function resetVirtual() {
  virtual.files.clear();
  virtual.dirs.clear();
  virtual.imageMeta.clear();
  virtual.calls.mkdir = [];
  virtual.calls.copyFile = [];
  virtual.calls.unlink = [];
  virtual.calls.stat = [];
  virtual.calls.readdir = [];
  virtual.calls.getImageInfo = [];
  virtual.calls.compressImage = [];
  virtual.calls.chooseMedia = [];
  faults.copyFile = false;
  faults.unlink = false;
  faults.stat = false;
  faults.getImageInfo = false;
  faults.compress = false;
  compressHold = null;
  sourceSeq = 0;
  compressSeq = 0;
}

function resetWxLog() {
  wxLog.getKeys = [];
  wxLog.setKeys = [];
  wxLog.failKeys = new Set();
  wxLog.failAfter = null;
  wxLog.setShouldThrow = false;
  wxLog.mediaCalls = [];
  wxLog.imageCalls = [];
  wxLog.pickerCalls = [];
  wxLog.pickerViolations = [];
  wxLog.chooseBehavior = 'success';
  wxLog.chooseImageBehavior = 'success';
  wxLog.chooseMediaPayload = null;
  wxLog.chooseImagePayload = null;
  wxLog.modalCalls = [];
  wxLog.toasts = [];
  wxLog.previews = [];
  wxLog.actionSheets = [];
  wxLog.navigations = [];
  wxLog.modalConfirm = true;
  wxLog.actionSheetIndex = 0;
}

function addSourceImage(width, height, bytes) {
  sourceSeq += 1;
  const filePath = 'http://tmp/selected-' + sourceSeq + '.jpg';
  virtual.files.set(filePath, Buffer.alloc(bytes, 1));
  virtual.imageMeta.set(filePath, {
    width: width || wxLog.sourceWidth,
    height: height || wxLog.sourceHeight
  });
  return filePath;
}

function createGate() {
  let release;
  const promise = new Promise(resolve => {
    release = resolve;
  });
  return { promise, release };
}

// ---- 选择器契约替身 ----
// wx.chooseMedia / wx.chooseImage 官方签名只有一个选项对象，success/fail 放在对象里。
// 这里严格拒绝第 2 个及以后的参数，并立即抛错：未修复的源码会以可见错误结束，
// 而不是静静等不到回调把用例挂住。

function recordPickerCall(api, args) {
  const options = args[0];
  const record = {
    api,
    argCount: args.length,
    extraArgTypes: Array.prototype.slice.call(args, 1).map(value => typeof value),
    optionsIsObject: Boolean(options) && typeof options === 'object',
    hasSuccess: Boolean(options && typeof options.success === 'function'),
    hasFail: Boolean(options && typeof options.fail === 'function')
  };
  wxLog.pickerCalls.push(record);

  if (record.argCount !== 1 || !record.optionsIsObject) {
    wxLog.pickerViolations.push(record);
    throw new Error(
      api + ' 只接受一个官方选项对象；实际收到 ' + record.argCount +
        ' 个参数，success/fail 必须放进同一个对象里'
    );
  }
  if (!record.hasSuccess || !record.hasFail) {
    wxLog.pickerViolations.push(record);
    throw new Error(api + ' 的选项对象里应同时包含 success 与 fail 回调');
  }
  return record;
}

function pickerPayloadOf(api) {
  return api === 'chooseMedia'
    ? wxLog.chooseMediaPayload
    : wxLog.chooseImagePayload;
}

function defaultPickerResult(api, filePath) {
  if (api === 'chooseMedia') {
    return { tempFiles: [{ tempFilePath: filePath }], type: 'image' };
  }
  return {
    tempFilePaths: [filePath],
    tempFiles: [{ path: filePath, size: wxLog.sourceBytes }]
  };
}

/** 只按被测接口的配置结算回调，另一个接口的配置不参与。 */
function settlePicker(api, options) {
  const behavior =
    api === 'chooseMedia' ? wxLog.chooseBehavior : wxLog.chooseImageBehavior;
  if (behavior === 'cancel') {
    options.fail({ errMsg: api + ':fail cancel' });
    return;
  }
  if (behavior === 'deny') {
    options.fail({ errMsg: api + ':fail auth deny' });
    return;
  }
  if (behavior === 'error') {
    options.fail({ errMsg: api + ':fail mock system error' });
    return;
  }
  const payload = pickerPayloadOf(api);
  if (payload) {
    options.success(payload);
    return;
  }
  const filePath = addSourceImage(
    wxLog.sourceWidth,
    wxLog.sourceHeight,
    wxLog.sourceBytes
  );
  options.success(defaultPickerResult(api, filePath));
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

// ---- wx 模拟：必须在加载页面和 store 之前就绪 ----
global.wx = {
  env: { USER_DATA_PATH: 'http://usr' },
  getStorageSync(key) {
    wxLog.getKeys.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    if (wxLog.setShouldThrow || wxLog.failKeys.has(key)) {
      throw wxLog.setError || {
        errMsg: 'setStorageSync:fail mock storage error'
      };
    }
    if (wxLog.failAfter && wxLog.failAfter.key === key) {
      wxLog.failAfter.count += 1;
      if (wxLog.failAfter.count > wxLog.failAfter.allowed) {
        throw { errMsg: 'setStorageSync:fail mock commit error' };
      }
    }
    storage.set(key, value);
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
    options.success({
      width: meta.width,
      height: meta.height,
      type: 'jpeg'
    });
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
      const bytes = width <= 400 ? 12000 : 150000;
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
  chooseMedia(options) {
    recordPickerCall('chooseMedia', arguments);
    wxLog.mediaCalls.push({
      count: options.count,
      mediaType: options.mediaType,
      sourceType: options.sourceType
    });
    settlePicker('chooseMedia', options);
  },
  chooseImage(options) {
    recordPickerCall('chooseImage', arguments);
    wxLog.imageCalls.push({
      count: options.count,
      sizeType: options.sizeType,
      sourceType: options.sourceType
    });
    settlePicker('chooseImage', options);
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
    wxLog.previews.push({
      current: options.current,
      urls: options.urls
    });
  },
  showActionSheet(options) {
    wxLog.actionSheets.push({ itemList: options.itemList });
    if (wxLog.actionSheetIndex === null) {
      options.fail({ errMsg: 'showActionSheet:fail cancel' });
      return;
    }
    options.success({ tapIndex: wxLog.actionSheetIndex });
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

async function createPage() {
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  attachSetData(page);
  page.onLoad();
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

function photoIndex() {
  const raw = storage.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : null;
}

function savedState() {
  const raw = storage.get(STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function photoOfRoute(routeId, datasetId) {
  const index = photoIndex();
  if (!index) return null;
  const routes = index.routes.filter(
    item =>
      item.routeId === routeId &&
      (!datasetId || item.datasetId === datasetId)
  );
  const route = routes[routes.length - 1];
  if (!route || !route.photoId) return null;
  return index.photos.find(photo => photo.photoId === route.photoId) || null;
}

function opList(routeId) {
  const index = photoIndex();
  if (!index) return [];
  return index.operations.filter(item => item.routeId === routeId);
}

function localToday() {
  return store.todayLocalDate();
}

async function savePhoto(page, routeId, source) {
  await choose(page, routeId, source || 'album');
  await confirm(page, routeId);
}

// ---- PU01 ----
test('PU01 不添加照片也能建线、记两把和备注；相册/拍照参数正确，预览确认才保存', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);

  assert.equal(page.data.routePhoto.status, 'none');
  assert.match(page.data.routePhoto.statusText, /添加线路照片/);
  assert.equal(storage.has(INDEX_KEY), false, '无照片时不写照片索引');

  await record(page, 'fail');
  // 抱石首次完攀后不再新增：唯一一把完攀留到最后，照片操作仍不应锁住记尝试。
  await record(page, 'fail');
  page.openNoteEditor({
    currentTarget: { dataset: { attemptId: page.data.attempts[1].id } }
  });
  page.onNoteInput({ detail: { value: '抓到后向右摆' } });
  page.saveNote();

  assert.equal(page.data.attempts.length, 2);
  assert.equal(page.data.attempts[1].note, '抓到后向右摆');
  const attemptsBefore = JSON.stringify(savedState().attempts);

  // 相册：count=1、mediaType=image、sourceType=album
  await choose(page, ROUTE_BLUE, 'album');
  assert.deepEqual(wxLog.mediaCalls[0], {
    count: 1,
    mediaType: ['image'],
    sourceType: ['album']
  });
  assert.equal(page.data.routePhoto.status, 'preview');
  assert.equal(page.data.routePhoto.hasPhoto, false);
  assert.equal(storage.has(INDEX_KEY), false, '确认前不保存文件或索引');
  assert.equal(page.data.resultLocked, false, '照片预览不锁住记尝试');

  // 取消：原线路保持无照片
  page.cancelRoutePhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(storage.has(INDEX_KEY), false);
  assert.equal(wxLog.toasts.length, 0);

  // 拍照：sourceType=camera；确认后才保存
  await choose(page, ROUTE_BLUE, 'camera');
  assert.deepEqual(wxLog.mediaCalls[1], {
    count: 1,
    mediaType: ['image'],
    sourceType: ['camera']
  });
  assert.equal(page.data.routePhoto.status, 'preview');
  const saving = confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saving', '保存中可见');
  assert.doesNotMatch(page.data.photoNotice, /已保存到本机/);
  await saving;

  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(page.data.routePhoto.bytesText.indexOf('主图'), 0);
  assert.equal(page.data.photoNotice, '已保存到本机');
  assert.deepEqual(wxLog.toasts, ['已保存到本机']);
  assert.equal(JSON.stringify(savedState().attempts), attemptsBefore);
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(photoIndex().routes.length, 1);

  // 照片操作不锁住记尝试；已有照片不会生成第二张
  await record(page, 'send');
  assert.equal(page.data.attempts.length, 3);
  assert.equal(photoIndex().photos.length, 1);
});

test('PU01 权限拒绝与取消保持原线路可用，可改用另一种来源', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);

  wxLog.chooseBehavior = 'deny';
  await choose(page, ROUTE_BLUE, 'camera');
  assert.match(page.data.photoNotice, /未获得拍照权限/);
  assert.match(page.data.photoNotice, /改用另一种方式/);
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(storage.has(INDEX_KEY), false);

  wxLog.chooseBehavior = 'cancel';
  await choose(page, ROUTE_BLUE, 'album');
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(storage.has(INDEX_KEY), false);

  wxLog.chooseBehavior = 'success';
  await savePhoto(page, ROUTE_BLUE, 'album');
  assert.equal(page.data.routePhoto.status, 'saved');
  await record(page, 'send');
  assert.equal(page.data.attempts.length, 1, '照片失败/取消不阻止记尝试');
});

// ---- PU02 ----
test('PU01 新建线路可跳过照片；带照片创建时照片失败不回滚线路', async () => {
  const page = await createPage();
  await tapStart(page);

  // 跳过照片也能建线
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '无照片自建线' } });
  await page.createQuickRoute();
  const skipRouteId = page.data.selectedRoute.id;
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(
    savedState().routes.some(route => route.id === skipRouteId),
    true
  );

  // 带照片创建：先在表单预览，创建后立即保存
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '带照片自建线' } });
  await page.chooseQuickRoutePhoto({
    currentTarget: { dataset: { source: 'album' } }
  });
  assert.ok(page.data.quickRoutePhoto);
  assert.match(page.data.quickRoutePhoto.statusText, /创建线路后保存/);
  assert.equal(wxLog.mediaCalls.length, 1);
  assert.deepEqual(wxLog.mediaCalls[0].sourceType, ['album']);

  faults.compress = true;
  await page.createQuickRoute();
  const withPhotoRouteId = page.data.activeRouteId;
  assert.equal(page.data.selectedRoute.name, '带照片自建线');
  assert.equal(
    savedState().routes.some(route => route.name === '带照片自建线'),
    true,
    '照片失败不回滚线路'
  );
  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.errorText, /压缩/);
  await record(page, 'fail');
  assert.equal(page.data.attempts.length, 1, '照片失败不影响记尝试');

  // 清理故障后可在当前线路重新添加
  faults.compress = false;
  await savePhoto(page, withPhotoRouteId, 'camera');
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(page.data.attempts.length, 1);
});

// ---- PU02 ----
test('PU02 压缩失败显示失败与重试；旧记录可用，重试同一操作只生成一张照片', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');

  await choose(page, ROUTE_BLUE, 'album');
  faults.compress = true;
  await confirm(page, ROUTE_BLUE);

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.statusText, /照片保存失败/);
  assert.match(page.data.routePhoto.errorText, /压缩/);
  assert.equal(page.data.routePhoto.retryVisible, true);
  assert.equal(page.data.routePhoto.retryText, '重试保存');
  assert.equal(photoIndex().photos.length, 0, '未完整落盘不显示成功');
  assert.equal(wxLog.toasts.length, 0);
  assert.equal(page.data.attempts.length, 1, '照片失败不影响尝试记录');

  const failedOp = opList(ROUTE_BLUE).find(item => item.kind === 'add');
  assert.ok(failedOp);
  assert.equal(failedOp.status, 'failed');

  faults.compress = false;
  await retryPhoto(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saved');
  const operations = opList(ROUTE_BLUE);
  assert.equal(operations.filter(item => item.kind === 'add').length, 1);
  assert.equal(operations[0].opId, failedOp.opId, '重试复用同一操作 ID');
  assert.equal(operations[0].status, 'committed');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(page.data.attempts.length, 1);

  // 缺文件：重进页面显示不可用并可重新添加
  const mainPath = photoIndex().photos[0].storage.location;
  const photoId = photoIndex().photos[0].photoId;
  page.onUnload();
  virtual.files.delete(mainPath);
  const reentered = await createPage();
  assert.equal(reentered.data.routePhoto.status, 'missing');
  assert.match(reentered.data.routePhoto.statusText, /本机照片不可用，可重新添加/);
  assert.equal(photoIndex().photos.length, 1, '缺文件不删除索引');

  await savePhoto(reentered, ROUTE_BLUE, 'album');
  assert.equal(reentered.data.routePhoto.status, 'saved');
  assert.notEqual(photoIndex().photos[0].photoId, photoId, '重新添加分配新照片');
  assert.equal(photoIndex().photos.length, 1, '每条线路只保留一个主照片引用');
  assert.equal(reentered.data.attempts.length, 1);
});

test('PU02 文件写入失败与索引提交失败都不虚报成功，可重试', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);

  // 文件写入失败
  await choose(page, ROUTE_BLUE, 'album');
  faults.copyFile = true;
  await confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.errorText, /写入失败/);
  assert.equal(photoIndex().photos.length, 0);
  assert.equal(virtual.calls.copyFile.length > 0, true);

  faults.copyFile = false;
  await retryPhoto(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);

  // 索引提交失败：第一次写操作启动成功，提交时写入失败
  await tapRoute(page, ROUTE_RED);
  await choose(page, ROUTE_RED, 'album');
  const toastsBefore = wxLog.toasts.length;
  wxLog.failAfter = { key: INDEX_KEY, allowed: 1, count: 0 };
  await confirm(page, ROUTE_RED);
  wxLog.failAfter = null;

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.errorText, /索引/);
  assert.equal(photoOfRoute(ROUTE_RED), null, '索引失败不产生照片关联');
  assert.equal(wxLog.toasts.length, toastsBefore, '失败不提示已保存');

  await retryPhoto(page, ROUTE_RED);
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.ok(photoOfRoute(ROUTE_RED));
  assert.equal(photoIndex().photos.length, 2);
});

// ---- PU03 ----
test('PU03 两天三把、备注与四处主图一致；同色同级另一条线不串图', async () => {
  const page = await createPage();
  await tapStart(page, 0, '2020-04-02');
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await record(page, 'fail');
  page.openNoteEditor({
    currentTarget: { dataset: { attemptId: page.data.attempts[1].id } }
  });
  page.onNoteInput({ detail: { value: '周四第二把备注' } });
  page.saveNote();

  await savePhoto(page, ROUTE_BLUE, 'album');
  const firstPhoto = photoIndex().photos[0];
  const firstPhotoId = firstPhoto.photoId;
  const mainPath = firstPhoto.storage.location;
  const thumbPath = mainPath.replace('/main/', '/thumb/');
  assert.equal(virtual.files.has(mainPath), true);
  assert.equal(virtual.files.has(thumbPath), true);
  const thumbBytes = virtual.files.get(thumbPath).length;
  assert.ok(thumbBytes > 0);

  page.onUnload();
  const sunday = await createPage();
  assert.equal(sunday.data.activeSession.dateText, '2020-04-02');
  assert.equal(sunday.data.routePhoto.photoId, firstPhotoId);

  await tapStart(sunday, 0, '2020-04-05');
  assert.equal(sunday.data.activeSession.dateText, '2020-04-05');
  await tapRoute(sunday, ROUTE_BLUE);
  await record(sunday, 'send');

  // 今日当前线路
  assert.equal(sunday.data.routePhoto.status, 'saved');
  assert.equal(sunday.data.routePhoto.photoId, firstPhotoId);
  assert.equal(sunday.data.routePhoto.mainPath, mainPath);
  // 历史/选线路列表缩略图指向同一主图的缩略图
  const blueItem = sunday.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(blueItem.photoThumb, thumbPath);
  assert.equal(blueItem.hasPhoto, true);
  assert.equal(blueItem.photoButtonText, '换照片');
  // 同色同级 L2 不串图
  const balanceItem = sunday.data.routes.find(
    route => route.id === ROUTE_BLUE_BALANCE
  );
  assert.equal(balanceItem.photoThumb, '');
  assert.equal(balanceItem.hasPhoto, false);

  // 详情：同一主图、两天三把与备注
  const detail = await createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(detail.data.attemptCount, 3);
  assert.equal(detail.data.routePhoto.photoId, firstPhotoId);
  assert.equal(detail.data.routePhoto.mainPath, mainPath);
  const thursdayGroup = detail.data.groups.find(
    group => group.dateText === '2020-04-02'
  );
  assert.ok(thursdayGroup);
  assert.equal(thursdayGroup.attempts[1].note, '周四第二把备注');
  detail.previewDetailPhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.deepEqual(wxLog.previews[wxLog.previews.length - 1], {
    current: mainPath,
    urls: [mainPath]
  });

  const detailL2 = await createDetailPage(ROUTE_BLUE_BALANCE);
  assert.equal(detailL2.data.routePhoto.status, 'none');
  assert.equal(detailL2.data.summaryText, '0 天 · 0 场 · 0 把');
  assert.equal(detailL2.data.routePhoto.photoId, '');

  // 重进仍从持久关联恢复
  const reentered = await createPage();
  assert.equal(reentered.data.routePhoto.photoId, firstPhotoId);
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(
    virtual.files.has(mainPath) && virtual.files.has(thumbPath),
    true
  );
});

test('PU03 历史/选线路列表的照片入口先选中该线路再进入预览', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);

  wxLog.actionSheetIndex = 1; // 从相册选择
  page.openRoutePhotoPicker({
    currentTarget: { dataset: { routeId: ROUTE_RED } }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(wxLog.actionSheets.length, 1);
  assert.deepEqual(wxLog.actionSheets[0].itemList, ['拍照', '从相册选择']);
  assert.equal(page.data.selectedRoute.id, ROUTE_RED, '先选中该线路');
  assert.equal(wxLog.mediaCalls.length, 1);
  assert.deepEqual(wxLog.mediaCalls[0].sourceType, ['album']);
  assert.equal(page.data.routePhoto.status, 'preview');
  assert.equal(photoIndex(), null, '预览阶段不写照片索引');
});

// ---- PU04 ----
test('PU04 更换失败保旧并可预览，成功后各入口一致且旧文件清理', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');
  const oldPhoto = photoIndex().photos[0];
  const oldMain = oldPhoto.storage.location;
  const oldThumb = oldMain.replace('/main/', '/thumb/');

  await choose(page, ROUTE_BLUE, 'album');
  faults.compress = true;
  await confirm(page, ROUTE_BLUE);

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.statusText, /旧照片仍可用/);
  assert.equal(page.data.routePhoto.hasPhoto, true);
  assert.equal(page.data.routePhoto.mainPath, oldMain);
  assert.equal(page.data.routePhoto.canPreview, true);
  assert.equal(photoIndex().photos[0].photoId, oldPhoto.photoId);
  assert.equal(virtual.files.has(oldMain), true);
  page.previewRoutePhoto({
    currentTarget: { dataset: { routeId: ROUTE_BLUE } }
  });
  assert.equal(wxLog.previews[wxLog.previews.length - 1].current, oldMain);

  faults.compress = false;
  await retryPhoto(page, ROUTE_BLUE);
  const newPhoto = photoIndex().photos[0];
  assert.notEqual(newPhoto.photoId, oldPhoto.photoId);
  assert.equal(page.data.routePhoto.mainPath, newPhoto.storage.location);
  assert.equal(virtual.files.has(newPhoto.storage.location), true);
  assert.equal(virtual.files.has(oldMain), false, '更换成功后清理旧主图');
  assert.equal(virtual.files.has(oldThumb), false, '更换成功后清理旧缩略图');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(page.data.routes.find(route => route.id === ROUTE_BLUE).photoThumb,
    newPhoto.storage.location.replace('/main/', '/thumb/'));

  const detail = await createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routePhoto.photoId, newPhoto.photoId);
  assert.equal(detail.data.routePhoto.mainPath, newPhoto.storage.location);
});

test('PU04 移除前说明唯一副本；取消不变，确认后清理并可重新添加', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_BLUE, 'album');
  const saved = photoIndex().photos[0];
  const mainPath = saved.storage.location;

  wxLog.modalConfirm = false;
  await removePhoto(page, ROUTE_BLUE);
  assert.equal(wxLog.modalCalls.length, 1);
  assert.match(wxLog.modalCalls[0].content, /只在本机保存一份/);
  assert.match(wxLog.modalCalls[0].content, /移除后需要重新添加/);
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(virtual.files.has(mainPath), true);

  wxLog.modalConfirm = true;
  await removePhoto(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(photoIndex().photos.length, 0);
  assert.equal(photoIndex().routes[0].photoId, '');
  assert.equal(virtual.files.has(mainPath), false);
  assert.equal(wxLog.toasts.includes('已移除'), true);
  assert.equal(page.data.attempts.length, 1, '移除不改动尝试');

  await savePhoto(page, ROUTE_BLUE, 'album');
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(page.data.attempts.length, 1);
});

test('PU04 移除文件失败不虚报成功，重试清理后完成', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_BLUE, 'album');
  const saved = photoIndex().photos[0];
  const mainPath = saved.storage.location;
  const thumbPath = mainPath.replace('/main/', '/thumb/');

  faults.unlink = true;
  wxLog.modalConfirm = true;
  await removePhoto(page, ROUTE_BLUE);

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.match(page.data.routePhoto.statusText, /本机文件未清理/);
  assert.equal(page.data.routePhoto.hasPhoto, false);
  assert.equal(page.data.routePhoto.retryText, '重试清理');
  assert.equal(wxLog.toasts.includes('已移除'), false, '不虚报删除成功');
  assert.equal(photoIndex().routes[0].photoId, '', '关联已移除');
  assert.equal(virtual.files.has(mainPath), true, '文件仍在，需重试清理');
  assert.equal(page.data.attempts.length, 1);

  faults.unlink = false;
  await retryPhoto(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(virtual.files.has(mainPath), false);
  assert.equal(virtual.files.has(thumbPath), false);
  assert.equal(photoIndex().photos.length, 0);
  assert.equal(page.data.attempts.length, 1);
});

// ---- PU05 ----
test('PU05 给 L1 保存时切到 L2 并记一把备注：回调只更新 L1，不丢 L2 记录', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);

  const gate = createGate();
  compressHold = gate.promise;
  await choose(page, ROUTE_BLUE, 'album');
  const saving = confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saving');

  await tapRoute(page, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.routePhoto.status, 'none');
  await record(page, 'fail');
  page.openNoteEditor({
    currentTarget: { dataset: { attemptId: page.data.attempts[0].id } }
  });
  page.onNoteInput({ detail: { value: 'L2 的备注' } });
  page.saveNote();

  const storeWritesBefore = wxLog.setKeys.filter(
    key => key === STORE_KEY
  ).length;

  compressHold = null;
  gate.release();
  await saving;

  // L1 照片已保存，但当前仍停在 L2，照片卡片不应显示 L1 的照片
  assert.ok(photoOfRoute(ROUTE_BLUE), 'L1 照片已提交');
  assert.equal(photoOfRoute(ROUTE_BLUE_BALANCE), null);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].note, 'L2 的备注');
  const savedAttempts = savedState().attempts;
  assert.equal(savedAttempts.length, 1);
  assert.equal(savedAttempts[0].routeId, ROUTE_BLUE_BALANCE);
  assert.equal(savedAttempts[0].note, 'L2 的备注');
  assert.equal(
    wxLog.setKeys.filter(key => key === STORE_KEY).length,
    storeWritesBefore,
    '照片回调不写回场次/尝试快照'
  );
  assert.equal(
    page.data.routes.find(route => route.id === ROUTE_BLUE).photoThumb,
    photoIndex().photos[0].storage.location.replace('/main/', '/thumb/'),
    'L1 列表缩略图按自己的归属更新'
  );

  await tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(page.data.routePhoto.photoId, photoIndex().photos[0].photoId);
});

test('PU05 保存中途退出重进：旧实例不回写，页面从持久索引恢复', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');

  const gate = createGate();
  compressHold = gate.promise;
  await choose(page, ROUTE_BLUE, 'album');
  const saving = confirm(page, ROUTE_BLUE);
  assert.equal(page.data.routePhoto.status, 'saving');

  page.onUnload();
  compressHold = null;
  gate.release();
  await saving;

  assert.ok(photoOfRoute(ROUTE_BLUE));
  assert.equal(
    savedState().attempts.length,
    1,
    '照片完成回调不覆盖已保存尝试'
  );

  const reentered = await createPage();
  assert.equal(reentered.data.routePhoto.status, 'saved');
  assert.equal(
    reentered.data.routePhoto.photoId,
    photoIndex().photos[0].photoId
  );
  assert.equal(reentered.data.attempts.length, 1);
});

// ---- 重置与旧缓存 ----

test('PU05 选片期间重置：迟到结果不进入新数据集（当前线路入口）', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE_BALANCE);
  await savePhoto(page, ROUTE_BLUE_BALANCE, 'album');
  await tapRoute(page, ROUTE_BLUE);

  const realChooseMedia = global.wx.chooseMedia;
  let respond;
  global.wx.chooseMedia = function deferredChooseMedia(options) {
    recordPickerCall('chooseMedia', arguments);
    respond = options.success;
  };
  try {
    const choosing = choose(page, ROUTE_BLUE, 'album');
    const startedDataset = page.state.datasetId;
    assert.equal(await page.resetTrialData(), true, '重置成功');
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    respond({
      tempFiles: [{ tempFilePath: addSourceImage(100, 100, 500) }],
      type: 'image'
    });
    const outcome = await choosing;

    assert.equal(outcome.ok, false, '迟到选择被丢弃');
    assert.equal(outcome.staleContext, true, '标记为过期上下文');
    assert.equal(page.data.routePhoto.status, 'none', '新数据集不出现预览');
    assert.equal(await confirm(page, ROUTE_BLUE), null, '无预览时不保存');
    const index = photoIndex();
    assert.equal(
      index.photos.some(photo => photo.datasetId !== startedDataset),
      false,
      '不得把旧选择写到重置后的数据集'
    );
  } finally {
    global.wx.chooseMedia = realChooseMedia;
  }
});

test('PU05 快速新建选片期间重置：迟到结果不进入新建表单', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');

  const realChooseMedia = global.wx.chooseMedia;
  let respond;
  global.wx.chooseMedia = function deferredChooseMedia(options) {
    recordPickerCall('chooseMedia', arguments);
    respond = options.success;
  };
  try {
    const picking = page.chooseQuickRoutePhoto({
      currentTarget: { dataset: { source: 'album' } }
    });
    assert.equal(await page.resetTrialData(), true, '重置成功');
    respond({
      tempFiles: [{ tempFilePath: addSourceImage(100, 100, 500) }],
      type: 'image'
    });
    const outcome = await picking;

    assert.equal(outcome.ok, false, '迟到选择被丢弃');
    assert.equal(page._quickPhotoSource, '', '不保留旧照片源');
    assert.equal(page.data.quickRoutePhoto, null, '不显示旧照片预览');

    await tapStart(page);
    page.toggleQuickRoute();
    page.onQuickRouteNameInput({ detail: { value: '重置后新建' } });
    await page.createQuickRoute();
    assert.equal(
      photoOfRoute(page.data.selectedRoute.id, page.state.datasetId),
      null,
      '新线路不挂旧选择'
    );
  } finally {
    global.wx.chooseMedia = realChooseMedia;
  }
});

test('PU05 来源弹层与移除确认期间重置：迟到回调不作用于新数据集', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await savePhoto(page, ROUTE_BLUE, 'album');
  const savedPhoto = photoOfRoute(ROUTE_BLUE, page.state.datasetId);
  assert.ok(savedPhoto);

  // 来源 action sheet 迟到回调：不发起照片操作。
  const realActionSheet = global.wx.showActionSheet;
  let pendingSheet = null;
  global.wx.showActionSheet = options => {
    pendingSheet = options;
  };
  try {
    await tapRoute(page, ROUTE_BLUE_BALANCE);
    page.openRoutePhotoPicker({
      currentTarget: { dataset: { routeId: ROUTE_BLUE } }
    });
    assert.ok(pendingSheet, 'action sheet 已打开');
    assert.equal(await page.resetTrialData(), true, '重置成功');
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    pendingSheet.success({ tapIndex: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.routePhoto.status, 'none', '迟到来源不产生预览');
  } finally {
    global.wx.showActionSheet = realActionSheet;
  }

  // 移除确认弹窗迟到确认：不删除旧数据集照片。
  const realShowModal = global.wx.showModal;
  let pendingModal = null;
  let deferNext = true;
  global.wx.showModal = options => {
    if (deferNext) {
      deferNext = false;
      pendingModal = options;
      return;
    }
    options.success({ confirm: true, cancel: false });
  };
  try {
    await tapRoute(page, ROUTE_BLUE);
    // 新数据集还没有照片：先保存一张，再验证迟到确认不误删。
    await savePhoto(page, ROUTE_BLUE, 'album');
    const currentPhoto = photoOfRoute(ROUTE_BLUE, page.state.datasetId);
    const removing = page.removeRoutePhoto({
      currentTarget: { dataset: { routeId: ROUTE_BLUE } }
    });
    assert.ok(pendingModal, '移除确认弹窗已打开');
    assert.equal(await page.resetTrialData(), true, '重置成功');
    pendingModal.success({ confirm: true, cancel: false });
    const removed = await removing;

    assert.equal(removed, null, '迟到确认不执行移除');
    assert.ok(
      photoIndex().photos.some(photo => photo.photoId === currentPhoto.photoId),
      '照片记录保留'
    );
    assert.ok(
      photoIndex().photos.some(photo => photo.photoId === savedPhoto.photoId),
      '旧数据集照片保留'
    );
  } finally {
    global.wx.showModal = realShowModal;
  }
});

test('PU05 无照片时重置（数据集不变）也会让迟到选片失效', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  const datasetBefore = page.state.datasetId;

  const realChooseMedia = global.wx.chooseMedia;
  let respond;
  global.wx.chooseMedia = function deferredChooseMedia(options) {
    recordPickerCall('chooseMedia', arguments);
    respond = options.success;
  };
  try {
    const choosing = choose(page, ROUTE_BLUE, 'album');
    // 没有照片时重置不轮换数据集，但仍清空页面上下文。
    assert.equal(await page.resetTrialData(), true, '重置成功');
    assert.equal(page.state.datasetId, datasetBefore, '无照片重置保持同一数据集');
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    respond({
      tempFiles: [{ tempFilePath: addSourceImage(100, 100, 500) }],
      type: 'image'
    });
    const outcome = await choosing;

    assert.equal(outcome.ok, false, '迟到选择被丢弃');
    assert.equal(outcome.staleContext, true);
    assert.equal(page.data.routePhoto.status, 'none', '不出现预览');
    assert.equal(await confirm(page, ROUTE_BLUE), null, '无预览时不保存');
    assert.equal(storage.has(INDEX_KEY), false, '不写照片索引');
  } finally {
    global.wx.chooseMedia = realChooseMedia;
  }
});

test('PU05 有照片时重置需明确确认；取消保留，确认后轮换数据集且不串旧照片', async () => {
  const page = await createPage();
  await tapStart(page);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '本机自建线' } });
  await page.createQuickRoute();
  const routeId = page.data.selectedRoute.id;
  assert.equal(routeId, 'route-local-1');
  await record(page, 'fail');

  await savePhoto(page, routeId, 'album');
  const firstPhoto = photoIndex().photos[0];
  const firstPhotoId = firstPhoto.photoId;
  const firstMain = firstPhoto.storage.location;
  const firstThumb = firstMain.replace('/main/', '/thumb/');
  const firstDataset = page.state.datasetId;
  assert.equal(firstDataset, trialPhotos.TRIAL_DATASET_ID);
  const ledgerBefore = storage.get(LEDGER_KEY);
  const stateBefore = JSON.stringify(savedState());
  const indexBefore = storage.get(INDEX_KEY);

  // 取消：照片属于用户资料，保留全部资料与账本
  wxLog.modalConfirm = false;
  const canceled = await page.resetTrialData();
  assert.equal(canceled, false);
  assert.equal(wxLog.modalCalls.length, 1);
  assert.match(wxLog.modalCalls[0].content, /用户资料/);
  assert.match(wxLog.modalCalls[0].content, /仍保留在本机旧数据集/);
  assert.match(wxLog.modalCalls[0].content, /不会再挂到重置后新建的线路上/);
  assert.equal(JSON.stringify(savedState()), stateBefore, '取消不动原记录');
  assert.equal(storage.get(LEDGER_KEY), ledgerBefore, '取消不重置账本');
  assert.equal(storage.get(INDEX_KEY), indexBefore, '取消不动照片索引');
  assert.equal(virtual.files.has(firstMain), true);

  // 确认：清空场次/尝试，轮换数据集；旧照片文件和索引保留
  wxLog.modalConfirm = true;
  const reset = await page.resetTrialData();
  assert.equal(reset, true);
  const newDataset = savedState().datasetId;
  assert.notEqual(newDataset, firstDataset);
  assert.equal(newDataset, 'trial-dataset-local-2');
  assert.equal(savedState().sessions.length, 0);
  assert.equal(savedState().attempts.length, 0);
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(
    photoIndex().photos.length,
    1,
    '旧照片索引保留，不做静默删除'
  );
  assert.equal(photoIndex().photos[0].photoId, firstPhotoId);
  assert.equal(photoIndex().photos[0].datasetId, firstDataset);
  assert.equal(virtual.files.has(firstMain), true);
  assert.equal(virtual.files.has(firstThumb), true);
  assert.equal(page._photoUi.getDatasetId(), newDataset);
  await page._photoReady;

  // 新数据集复用 route-local-1：不会挂上旧数据集的照片
  await tapStart(page);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '重建后的自建线' } });
  await page.createQuickRoute();
  assert.equal(page.data.selectedRoute.id, 'route-local-1');
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(photoOfRoute('route-local-1', newDataset), null);

  await savePhoto(page, 'route-local-1', 'album');
  assert.equal(page.data.routePhoto.status, 'saved');
  const newPhoto = photoOfRoute('route-local-1', newDataset);
  assert.ok(newPhoto);
  assert.notEqual(newPhoto.photoId, firstPhotoId);
  assert.equal(photoIndex().photos.length, 2, '新旧数据集照片各自保留');
  const oldPhoto = photoIndex().photos.find(
    photo => photo.photoId === firstPhotoId
  );
  assert.equal(oldPhoto.datasetId, firstDataset);
  assert.equal(virtual.files.has(firstMain), true, '安全重置不删除旧主图');

  const currentCount = await page._photoUi.countPhotos();
  assert.equal(currentCount.ok, true);
  assert.equal(currentCount.photos.length, 1, '当前数据集只统计自己的照片');
});

test('PU05 旧试用缓存补兼容 datasetId，保留场次与尝试；身份集中在虚构常量', async () => {
  const legacy = store.createInitialState();
  delete legacy.datasetId;
  legacy.sessions.push({
    id: 'session-legacy',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2020-03-01',
    createdAt: '2020-03-01T10:00:00.000Z'
  });
  legacy.attempts.push({
    id: 'attempt-legacy',
    seq: 1,
    sessionId: 'session-legacy',
    routeId: ROUTE_BLUE,
    result: 'fail',
    note: '旧缓存备注',
    createdAt: '2020-03-01T10:05:00.000Z'
  });
  legacy.nextSessionSeq = 2;
  legacy.nextAttemptSeq = 2;
  legacy.activeSessionId = 'session-legacy';
  legacy.activeRouteId = ROUTE_BLUE;
  storage.set(STORE_KEY, JSON.stringify(legacy));

  const page = await createPage();
  assert.equal(page.data.loadError, '');
  assert.equal(page.state.datasetId, trialPhotos.TRIAL_DATASET_ID);
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].note, '旧缓存备注');
  assert.equal(savedState().datasetId, undefined, '只读取时不改写旧缓存');

  const service = page._photoUi.getService();
  assert.equal(service.ownerId, trialPhotos.TRIAL_OWNER_ID);
  assert.equal(service.datasetId, trialPhotos.TRIAL_DATASET_ID);
  assert.match(service.ownerId, /^trial-user-/);
  assert.match(service.datasetId, /^trial-dataset-/);

  await tapStart(page, 0);
  assert.equal(savedState().datasetId, trialPhotos.TRIAL_DATASET_ID);
  assert.equal(savedState().attempts.length, 1, '新写入保留旧尝试');
});

// ---- 页面入口与文案 ----
test('PU06 页面包含四处照片入口、确认/失败/缺图/移除文案且不整页清缓存', async () => {
  const todayWxml = read(PAGE_WXML);
  const detailWxml = read(DETAIL_WXML);
  const controller = read(CONTROLLER_JS);
  const pageJs = read(PAGE_JS);
  const detailJs = read(DETAIL_JS);

  // 今日页当前线路照片卡片与来源按钮
  assert.match(todayWxml, /id="route-photo-card"/);
  assert.match(todayWxml, /id="photo-camera"/);
  assert.match(todayWxml, /id="photo-album"/);
  assert.match(todayWxml, /id="photo-confirm"/);
  assert.match(todayWxml, /id="photo-cancel"/);
  assert.match(todayWxml, /id="photo-retry"/);
  assert.match(todayWxml, /id="photo-remove"/);
  assert.match(todayWxml, /id="photo-missing"/);
  // 历史选线缩略图和入口
  assert.match(todayWxml, /id="route-thumb-/);
  assert.match(todayWxml, /id="route-photo-/);
  assert.match(todayWxml, /openRoutePhotoPicker/);
  // 新建线路可选照片
  assert.match(todayWxml, /id="quick-photo-camera"/);
  assert.match(todayWxml, /id="quick-photo-album"/);
  // 详情主图、预览、移除
  assert.match(detailWxml, /id="detail-photo-main"/);
  assert.match(detailWxml, /id="detail-photo-preview"/);
  assert.match(detailWxml, /id="detail-photo-remove"/);
  assert.match(detailWxml, /id="detail-photo-confirm"/);
  assert.match(detailWxml, /id="detail-photo-missing"/);
  assert.match(detailWxml, /本机照片不可用，可重新添加/);

  // 明确文案与本地保存标识
  assert.match(todayWxml, /照片保存在本机/);
  assert.match(detailWxml, /照片保存在本机/);
  assert.match(controller, /已保存到本机/);
  assert.match(controller, /添加线路照片/);
  assert.match(controller, /本机照片不可用，可重新添加/);
  assert.match(controller, /移除后需要重新添加/);

  // 页面和控制器不使用全局清缓存；照片索引/文件只由专用服务处理
  assert.doesNotMatch(
    pageJs + detailJs + controller,
    /clearStorageSync/
  );
  assert.doesNotMatch(pageJs + detailJs + controller, /wx\.cloud/);
  assert.match(pageJs, /trialSaveServer/);
  assert.equal(typeof pageDefinition.onUnload, 'function');
  assert.equal(typeof detailDefinition.onUnload, 'function');
  assert.equal(typeof pageDefinition.confirmRoutePhoto, 'function');
  assert.equal(typeof detailDefinition.confirmDetailPhoto, 'function');
  assert.equal(THUMB_CACHE_KEY, 'climbingNote.gymLogTrial.photoThumbs.v1');
  assert.equal(localToday().length, 10);
});

// ---- 选择器契约（T012 返工）：单对象选项 + 两种官方返回形状 ----

/**
 * 同一批参数化用例：每条给一种真实的选择器返回形状。
 * picker-contract 用例把每种形状都送进真实页面的快照流程：
 * 预览并确认保存、取消后可立即重选、空路径与系统错误可见、更换时取消保留旧图。
 */
const PICKER_CASES = [
  {
    id: 'chooseMedia-tempFiles',
    api: 'chooseMedia',
    label: 'chooseMedia 只返回 tempFiles[].tempFilePath',
    build(filePath) {
      return { tempFiles: [{ tempFilePath: filePath }], type: 'image' };
    }
  },
  {
    id: 'chooseMedia-empty-tempFilePaths',
    api: 'chooseMedia',
    label: 'chooseMedia 同时返回 tempFiles[].tempFilePath 与空 tempFilePaths',
    build(filePath) {
      return {
        tempFiles: [{ tempFilePath: filePath }],
        tempFilePaths: []
      };
    }
  },
  {
    id: 'chooseImage-tempFilePaths',
    api: 'chooseImage',
    label: 'chooseImage 只返回 tempFilePaths[]',
    build(filePath) {
      return { tempFilePaths: [filePath] };
    }
  },
  {
    id: 'chooseImage-tempFiles-path',
    api: 'chooseImage',
    label: 'chooseImage tempFilePaths 为空数组、只有 tempFiles[].path',
    build(filePath) {
      return {
        tempFilePaths: [],
        tempFiles: [{ path: filePath, size: 500000 }]
      };
    }
  },
  {
    id: 'chooseImage-empty-tempFiles',
    api: 'chooseImage',
    label: 'chooseImage 同时返回 tempFilePaths[] 与空 tempFiles',
    build(filePath) {
      return { tempFilePaths: [filePath], tempFiles: [] };
    }
  }
];

// 两个字段同时出现且都是空数组：没有任何可用路径，必须报可见错误。
const EMPTY_PICKER_RESULT = { tempFiles: [], tempFilePaths: [] };

function setPickerPayload(item, payload) {
  if (item.api === 'chooseMedia') {
    wxLog.chooseMediaPayload = payload || null;
    return;
  }
  wxLog.chooseImagePayload = payload || null;
}

function setPickerBehavior(item, behavior) {
  if (item.api === 'chooseMedia') {
    wxLog.chooseBehavior = behavior;
    return;
  }
  wxLog.chooseImageBehavior = behavior;
}

/**
 * 安装某条用例：只保留被测接口的返回形状。
 * 走 chooseImage 时隐去 chooseMedia，真实覆盖回退分支；
 * 走 chooseMedia 时保留 chooseImage，用于证明取消不会被回退选择器掩盖。
 */
function installPickerCase(item, config) {
  const settings = config || {};
  const mediaBackup = global.wx.chooseMedia;
  const imageBackup = global.wx.chooseImage;
  if (item.api === 'chooseImage') delete global.wx.chooseMedia;
  wxLog.chooseBehavior = 'success';
  wxLog.chooseImageBehavior = 'success';
  wxLog.chooseMediaPayload = null;
  wxLog.chooseImagePayload = null;
  setPickerBehavior(item, settings.behavior || 'success');
  setPickerPayload(item, settings.payload || null);
  return function restorePicker() {
    global.wx.chooseMedia = mediaBackup;
    global.wx.chooseImage = imageBackup;
    wxLog.chooseBehavior = 'success';
    wxLog.chooseImageBehavior = 'success';
    wxLog.chooseMediaPayload = null;
    wxLog.chooseImagePayload = null;
  };
}

/** 选择器只能被按官方形状调用；失败信息直接给出参数格式问题。 */
function assertPickerContract(apiName, expectedCount) {
  const count = typeof expectedCount === 'number' ? expectedCount : 1;
  const calls = wxLog.pickerCalls.filter(call => call.api === apiName);
  assert.equal(calls.length, count, apiName + ' 应被调用 ' + count + ' 次');
  calls.forEach((call, index) => {
    assert.equal(
      call.argCount,
      1,
      apiName + ' 第 ' + (index + 1) + ' 次调用收到 ' + call.argCount +
        ' 个参数（第 2 个起为 ' + JSON.stringify(call.extraArgTypes) +
        '）：success/fail 必须放进同一个选项对象'
    );
    assert.equal(call.hasSuccess, true, apiName + ' 选项对象里应有 success');
    assert.equal(call.hasFail, true, apiName + ' 选项对象里应有 fail');
  });
  assert.deepEqual(wxLog.pickerViolations, [], apiName + ' 不得收到多余参数');
  return calls;
}

/** 选择器的官方选项字段仍按来源传对，两种接口各记各的。 */
function assertPickerOptions(item, source) {
  if (item.api === 'chooseMedia') {
    assert.deepEqual(wxLog.mediaCalls, [
      { count: 1, mediaType: ['image'], sourceType: [source] }
    ]);
    return;
  }
  assert.deepEqual(wxLog.imageCalls, [
    { count: 1, sizeType: ['compressed'], sourceType: [source] }
  ]);
}

for (const item of PICKER_CASES) {
  test('picker-contract ' + item.label + '：可进入预览并确认保存', async () => {
    const page = await createPage();
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    const filePath = addSourceImage(1200, 800, 400000);
    const restore = installPickerCase(item, {
      payload: item.build(filePath)
    });
    try {
      const outcome = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api);
      assertPickerOptions(item, 'album');
      assert.equal(outcome.ok, true, '返回形状应能解析出照片路径');
      assert.equal(outcome.path, filePath);
      assert.equal(page.data.routePhoto.status, 'preview');
      assert.equal(page.data.routePhoto.previewPath, filePath);
      assert.match(page.data.routePhoto.statusText, /确认后保存到本机/);
      assert.equal(storage.has(INDEX_KEY), false, '确认前不写照片索引');

      await confirm(page, ROUTE_BLUE);
      assert.equal(page.data.routePhoto.status, 'saved');
      const mainPath = page.data.routePhoto.mainPath;
      assert.equal(virtual.files.has(mainPath), true, '主图已落盘');
      assert.equal(page.data.routePhoto.bytesText.indexOf('主图'), 0);
      assert.deepEqual(wxLog.toasts, ['已保存到本机']);
      assert.equal(photoIndex().photos.length, 1);
      assert.equal(photoOfRoute(ROUTE_BLUE).storage.location, mainPath);
    } finally {
      restore();
    }
  });

  test('picker-contract ' + item.label + '：取消后可立即重新选择', async () => {
    const page = await createPage();
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    const restore = installPickerCase(item, { behavior: 'cancel' });
    try {
      const cancelled = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api);
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.cancelled, true, '取消被识别为取消而非系统错误');
      assert.equal(page.data.routePhoto.status, 'none');
      assert.equal(page.data.photoNotice, '', '取消不提示失败');
      assert.equal(storage.has(INDEX_KEY), false);
      if (item.api === 'chooseMedia') {
        assert.equal(
          wxLog.imageCalls.length,
          0,
          '取消不得回退到 chooseImage 掩盖取消'
        );
      }

      // 取消后立即重选：没有残留的进行中操作或旧回调。
      const filePath = addSourceImage(1200, 800, 400000);
      setPickerBehavior(item, 'success');
      setPickerPayload(item, item.build(filePath));
      const again = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api, 2);
      assert.equal(again.ok, true);
      assert.equal(page.data.routePhoto.status, 'preview');
      assert.equal(page.data.routePhoto.previewPath, filePath);
      await confirm(page, ROUTE_BLUE);
      assert.equal(page.data.routePhoto.status, 'saved');
      assert.equal(photoIndex().photos.length, 1);
    } finally {
      restore();
    }
  });

  test('picker-contract ' + item.label + '：空路径与系统错误都可见且可重试', async () => {
    const page = await createPage();
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    const restore = installPickerCase(item, {
      payload: EMPTY_PICKER_RESULT
    });
    try {
      const empty = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api);
      assert.equal(empty.ok, false, '两个字段都为空数组时不得算成功');
      assert.equal(empty.cancelled, false, '空路径不是取消');
      assert.equal(empty.error, '选择器没有返回照片路径');
      assert.equal(page.data.routePhoto.status, 'none');
      assert.match(page.data.photoNotice, /选择照片失败：选择器没有返回照片路径/);
      assert.equal(storage.has(INDEX_KEY), false);

      setPickerBehavior(item, 'error');
      const failed = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api, 2);
      assert.equal(failed.ok, false);
      assert.equal(failed.cancelled, false);
      assert.match(failed.error, /mock system error/);
      assert.match(page.data.photoNotice, /选择照片失败：/);
      assert.match(page.data.photoNotice, /mock system error/);
      assert.equal(page.data.routePhoto.status, 'none');

      // 出错后仍可立即重选并保存。
      const filePath = addSourceImage(1200, 800, 400000);
      setPickerBehavior(item, 'success');
      setPickerPayload(item, item.build(filePath));
      const again = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api, 3);
      assert.equal(again.ok, true);
      assert.equal(page.data.routePhoto.status, 'preview');
      assert.equal(page.data.routePhoto.previewPath, filePath);
    } finally {
      restore();
    }
  });

  test('picker-contract ' + item.label + '：更换时取消预览保留旧照片', async () => {
    const page = await createPage();
    await tapStart(page);
    await tapRoute(page, ROUTE_BLUE);
    const firstPath = addSourceImage(1200, 800, 400000);
    const restore = installPickerCase(item, {
      payload: item.build(firstPath)
    });
    try {
      await savePhoto(page, ROUTE_BLUE, 'album');
      assertPickerContract(item.api);
      assert.equal(page.data.routePhoto.status, 'saved');
      const oldPhoto = photoIndex().photos[0];
      const oldMain = oldPhoto.storage.location;
      const oldThumb = oldMain.replace('/main/', '/thumb/');

      setPickerPayload(item, item.build(addSourceImage(1600, 1200, 420000)));
      const picked = await choose(page, ROUTE_BLUE, 'album');

      assertPickerContract(item.api, 2);
      assert.equal(picked.ok, true);
      assert.equal(page.data.routePhoto.status, 'preview');
      assert.equal(page.data.routePhoto.hasPhoto, true);
      assert.match(page.data.routePhoto.statusText, /确认后替换现有照片/);

      page.cancelRoutePhoto({
        currentTarget: { dataset: { routeId: ROUTE_BLUE } }
      });

      assert.equal(page.data.routePhoto.status, 'saved', '取消预览回到已保存');
      assert.equal(page.data.routePhoto.photoId, oldPhoto.photoId);
      assert.equal(page.data.routePhoto.mainPath, oldMain);
      assert.equal(page.data.routePhoto.canPreview, true);
      assert.equal(photoIndex().photos.length, 1);
      assert.equal(photoIndex().photos[0].photoId, oldPhoto.photoId);
      assert.equal(virtual.files.has(oldMain), true, '旧主图未被删除');
      assert.equal(virtual.files.has(oldThumb), true, '旧缩略图未被删除');
      page.previewRoutePhoto({
        currentTarget: { dataset: { routeId: ROUTE_BLUE } }
      });
      assert.equal(wxLog.previews[wxLog.previews.length - 1].current, oldMain);
    } finally {
      restore();
    }
  });
}

test('picker-contract 快速新建在两种返回形状下都保留“创建并选中”流程', async () => {
  const cases = [PICKER_CASES[0], PICKER_CASES[2]];
  for (const item of cases) {
    const page = await createPage();
    await tapStart(page);
    const filePath = addSourceImage(1200, 800, 400000);
    const restore = installPickerCase(item, {
      payload: item.build(filePath)
    });
    try {
      page.toggleQuickRoute();
      page.onQuickRouteNameInput({ detail: { value: '契约新建线' } });
      const picked = await page.chooseQuickRoutePhoto({
        currentTarget: { dataset: { source: 'album' } }
      });

      assertPickerContract(item.api);
      assertPickerOptions(item, 'album');
      assert.equal(picked.ok, true);
      assert.equal(page.data.quickRoutePhoto.path, filePath);
      assert.match(page.data.quickRoutePhoto.statusText, /创建线路后保存/);

      await page.createQuickRoute();
      const routeId = page.data.selectedRoute.id;
      assert.equal(page.data.quickRouteVisible, false);
      assert.equal(page.data.quickRoutePhoto, null);
      assert.equal(page.data.selectedRoute.name, '契约新建线');
      assert.equal(page.state.activeRouteId, routeId, '新建后仍选中该线路');
      assert.equal(page.data.routePhoto.status, 'saved');
      assert.equal(virtual.files.has(page.data.routePhoto.mainPath), true);
      assert.equal(photoOfRoute(routeId).storage.location, page.data.routePhoto.mainPath);
      assert.equal(
        page.data.routes.some(route => route.id === routeId),
        true,
        '新建线路保留在列表中'
      );
    } finally {
      restore();
    }
    page.onUnload();
    resetHarness();
  }
});

// ---- PU07 ----
test('PU07 切换攀岩类型保留已选照片；带照片创建绳攀线路并绑定到新线路', async () => {
  const page = await createPage();
  await tapStart(page);

  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '顶绳带照片线' } });
  await page.chooseQuickRoutePhoto({
    currentTarget: { dataset: { source: 'album' } }
  });
  assert.ok(page.data.quickRoutePhoto);
  assert.match(page.data.quickRoutePhoto.statusText, /创建线路后保存/);

  // 抱石 → 顶绳：已选照片仍属于当前表单，等级失效清空。
  page.onQuickRouteTypeChange({
    detail: { value: page.data.quickRouteTypes.indexOf('顶绳') }
  });
  assert.ok(page.data.quickRoutePhoto, '切换类型不丢已选照片');
  assert.equal(page.data.quickRouteGrade, '');
  assert.equal(page.data.quickRouteGradeText, '请选择等级');

  // 未选等级时创建被拒绝：不建线路、不动已选照片。
  await page.createQuickRoute();
  assert.match(page.data.quickRouteError, /请选择等级/);
  assert.ok(page.data.quickRoutePhoto, '拒绝创建时保留已选照片');
  assert.equal(page.data.quickRouteVisible, true);
  assert.equal(page._quickPhotoSource !== '', true, '仍保留本地选图路径');
  assert.equal(
    savedState().routes.some(route => route.name === '顶绳带照片线'),
    false,
    '未选等级不新增线路'
  );

  // 选好 YDS 等级后创建：类型、等级正确，照片绑定到新线路。
  page.onQuickRouteGradeChange({
    detail: { value: page.data.quickRouteGrades.indexOf('5.10a') }
  });
  await page.createQuickRoute();
  const routeId = page.data.selectedRoute.id;
  assert.equal(page.data.selectedRoute.climbType, '顶绳');
  assert.equal(page.data.selectedRoute.grade, '5.10a');
  assert.equal(page.data.selectedRoute.name, '顶绳带照片线');
  assert.equal(page.data.quickRoutePhoto, null, '创建后清空表单照片预览');
  assert.equal(page.data.routePhoto.status, 'saved');

  const bound = photoOfRoute(routeId, page.state.datasetId);
  assert.ok(bound, '照片绑定到新建的顶绳线路');
  assert.equal(page.data.routePhoto.mainPath, bound.storage.location);
  assert.equal(virtual.files.has(bound.storage.location), true);
});

// ---- PU08 ----
test('PU08 缺类型的旧 V 级线路按抱石读取，照片与备注归属不变且不迁移', async () => {
  const page = await createPage();
  await tapStart(page);
  await tapRoute(page, ROUTE_BLUE);
  await record(page, 'fail');
  await savePhoto(page, ROUTE_BLUE, 'album');
  const bound = photoOfRoute(ROUTE_BLUE, page.state.datasetId);
  assert.ok(bound, '旧线路照片已保存');
  const mainPath = bound.storage.location;

  const stateBefore = JSON.stringify(savedState());
  const indexBefore = storage.get(INDEX_KEY);

  // 详情页按抱石展示这条没有 climbType 的旧 V 级线路，照片仍是同一条。
  const detail = await createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.route.climbType, '抱石');
  assert.equal(detail.data.route.grade, 'V3');
  assert.equal(detail.data.routePhoto.status, 'saved');
  assert.equal(detail.data.routePhoto.mainPath, mainPath);
  assert.equal(
    photoOfRoute(ROUTE_BLUE, page.state.datasetId).storage.location,
    mainPath
  );

  assert.equal(
    JSON.stringify(savedState()),
    stateBefore,
    '打开详情不改动线路/尝试缓存'
  );
  assert.equal(storage.get(INDEX_KEY), indexBefore, '打开详情不改动照片索引');
  assert.equal(virtual.files.has(mainPath), true, '照片文件仍在');
});
