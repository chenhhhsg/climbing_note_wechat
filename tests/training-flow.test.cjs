/**
 * T019 正式手机试用候选 · 页面链路回归测试（R1–R6 的离线部分里与照片相关的部分）
 *
 * 直接加载正式页面文件（首页、场内页、线路详情页、个人页）与正式工具模块，
 * 捕获 Page(...) 定义，用隔离的微信本地存储替身、可控虚拟文件系统与故障注驱动
 * 真实页面处理器，并核对 WXML 里的真实按钮绑定：
 * - R2：新建线路时选照片、预览确认、取消重选、取消更换保留旧图；同色另一条线路独立；
 * - R3：跨天详情读到同一张照片，更正与再记不动照片；
 * - R5：空间不足有可见提示且旧图保留；移除与个人页清缓存后场次、备注、索引、
 *       被引用原图都在；清缓存后缩略图可重建；
 * - 退出重开（重新加载模块）后照片仍在；
 * - 全程只落在正式本机命名空间，刻意不提供 wx.cloud：照片流程不含任何云调用，
 *   也不写旧 climbing_records 或独立试用工程的键。
 *
 * 手机拍照/相册权限、真机文件保留、退出重开与次日岩馆回看仍是整体验收（待验）。
 *
 * 运行：node --test tests/training-flow.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');
const PROFILE_WXML = path.join(ROOT, 'pages', 'profile', 'profile.wxml');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SERVICE_JS = path.join(ROOT, 'utils', 'training-photos.js');
const CONTROLLER_JS = path.join(ROOT, 'utils', 'training-photo-controller.js');

const USER_DATA_PATH = 'http://usr';
const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const MAIN_BYTES = 150000;
const THUMB_BYTES = 12000;

const storage = new Map();
const virtual = {
  files: new Map(),
  dirs: new Set(),
  imageMeta: new Map()
};
const faults = {
  copyFile: false,
  writeSpace: false,
  unlink: false,
  canvas: false,
  compress: false
};
const wxLog = {
  modalConfirm: true,
  navigations: [],
  switches: [],
  toasts: [],
  previews: [],
  mediaCalls: [],
  imageCalls: [],
  // 选择器调用形状：参数个数与 success/fail 是否在选项对象里。
  pickerCalls: [],
  mediaVariant: 'tempFiles',
  imageVariant: 'tempFilePaths',
  setKeys: [],
  removeKeys: []
};

let tempSeq = 0;

function resetAll() {
  storage.clear();
  virtual.files.clear();
  virtual.dirs.clear();
  virtual.imageMeta.clear();
  faults.copyFile = false;
  faults.writeSpace = false;
  faults.unlink = false;
  faults.canvas = false;
  faults.compress = false;
  wxLog.modalConfirm = true;
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.toasts = [];
  wxLog.previews = [];
  wxLog.mediaCalls = [];
  wxLog.imageCalls = [];
  wxLog.pickerCalls = [];
  wxLog.mediaVariant = 'tempFiles';
  wxLog.imageVariant = 'tempFilePaths';
  wxLog.setKeys = [];
  wxLog.removeKeys = [];
  tempSeq = 0;
}

function addVirtualFile(filePath, bytes) {
  virtual.files.set(filePath, Buffer.alloc(bytes, 7));
}

function filesUnder(prefix) {
  return Array.from(virtual.files.keys()).filter(key => key.indexOf(prefix) === 0);
}

function fileSystem() {
  return {
    mkdir(options) {
      virtual.dirs.add(options.dirPath);
      options.success({});
    },
    copyFile(options) {
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
      if (!virtual.files.has(options.path)) {
        options.fail({ errMsg: 'stat:fail no such file or directory' });
        return;
      }
      options.success({ stats: { size: virtual.files.get(options.path).length } });
    },
    readdir(options) {
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
}

function pickerFile() {
  tempSeq += 1;
  const filePath = 'http://tmp/picked-' + tempSeq + '.jpg';
  virtual.files.set(filePath, Buffer.alloc(500000, 1));
  virtual.imageMeta.set(filePath, { width: 2400, height: 1600 });
  return filePath;
}

global.wx = {
  env: { USER_DATA_PATH },
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    storage.set(key, value);
  },
  removeStorageSync(key) {
    wxLog.removeKeys.push(key);
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: Array.from(storage.keys()) };
  },
  getFileSystemManager: fileSystem,
  getImageInfo(options) {
    const meta = virtual.imageMeta.get(options.src);
    if (!meta) {
      options.fail({ errMsg: 'getImageInfo:fail no such file' });
      return;
    }
    options.success({ width: meta.width, height: meta.height, type: 'jpeg' });
  },
  compressImage(options) {
    if (faults.compress) {
      options.fail({ errMsg: 'compressImage:fail mock compress failed' });
      return;
    }
    // 复现开发者工具：持久 http://usr 路径压缩失败，缩略图走画布回退。
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
    tempSeq += 1;
    const filePath = 'http://tmp/compressed-' + tempSeq + '.jpg';
    virtual.files.set(
      filePath,
      Buffer.alloc(width <= 400 ? THUMB_BYTES : MAIN_BYTES, 2)
    );
    virtual.imageMeta.set(filePath, { width, height });
    options.success({ tempFilePath: filePath });
  },
  createOffscreenCanvas(options) {
    if (faults.canvas) return undefined;
    return {
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
  },
  canvasToTempFilePath(options) {
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
    wxLog.pickerCalls.push({ picker: 'media', argCount: arguments.length, options });
    if (wxLog.mediaVariant === 'tempFilePaths') {
      // 同一份结果也可能只给 tempFilePaths：两种字段都要能解析。
      options.success({ tempFilePaths: [pickerFile()] });
      return;
    }
    options.success({ tempFiles: [{ tempFilePath: pickerFile() }] });
  },
  chooseImage(options) {
    wxLog.imageCalls.push(options);
    wxLog.pickerCalls.push({ picker: 'image', argCount: arguments.length, options });
    if (wxLog.imageVariant === 'tempFilesPath') {
      options.success({ tempFiles: [{ path: pickerFile() }] });
      return;
    }
    options.success({ tempFilePaths: [pickerFile()] });
  },
  showModal(options) {
    options.success({ confirm: wxLog.modalConfirm, cancel: !wxLog.modalConfirm });
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  previewImage(options) {
    wxLog.previews.push(options);
  },
  navigateTo(options) {
    wxLog.navigations.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  stopPullDownRefresh() {}
};

global.getApp = () => ({ globalData: {} });

const db = require(path.join(ROOT, 'utils', 'db.js'));
const store = require(STORE_JS);
const serviceModule = require(SERVICE_JS);
const controllerModule = require(CONTROLLER_JS);

// 捕获原生 Page(...) 定义。每个用例都重新执行页面模块，避免命中 require 缓存后
// 拿不到本次注册的定义（也顺带覆盖“模块重新加载”这条路径）。
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

/**
 * 页面实例替身：支持 wx 的 setData 数据路径写法（如 'photoSpace.percent'）。
 */
function createPage(definition) {
  const page = Object.create(definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function setData(patch) {
    Object.keys(patch || {}).forEach(key => {
      const parts = key.split('.');
      let node = this.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = patch[key];
    });
  };
  return page;
}

function tapDataset(dataset) {
  return { currentTarget: { dataset: dataset || {} } };
}

/** 等待页面里发起的异步照片流程（含画布回退的定时器）落定。 */
async function settle(times) {
  const rounds = typeof times === 'number' ? times : 8;
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setImmediate(resolve));
  }
}

function archiveOf() {
  return store.loadState().archive;
}

function rawArchive() {
  return storage.get(ARCHIVE_KEY);
}

function photoIndex() {
  const raw = storage.get(store.PHOTO_INDEX_KEY);
  return raw ? JSON.parse(raw) : null;
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

async function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  await settle();
  return page;
}

async function openRoutePage(routeId) {
  const page = createPage(routeDefinition);
  page.onLoad({ routeId });
  await settle();
  return page;
}

async function openProfilePage() {
  const page = createPage(profileDefinition);
  page.onLoad();
  await settle();
  return page;
}

/** 开一场、建一条线路（走正式档案层）。 */
function seedTraining(options) {
  const config = options || {};
  const started = store.startSession({
    gymName: config.gymName || '我自己去的岩馆',
    date: config.date,
    now: config.now || new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const route = store.createRoute({
    sessionId: started.archive.activeSessionId,
    name: config.routeName || '蓝色动态线',
    climbType: config.climbType || '抱石',
    grade: config.grade || 'V3',
    colorName: config.colorName || '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(route.ok, true, route.error);
  return { session: route.archive.sessions[0], route: route.route, archive: route.archive };
}

let indexDefinition = null;
let sessionDefinition = null;
let routeDefinition = null;
let profileDefinition = null;

beforeEach(() => {
  resetAll();
  // 共享照片服务实例在每个用例之间重置，不带出上一用例的登记状态。
  controllerModule.resetTrainingPhotos();
  controllerModule.setTrainingPhotoSpacePolicy(null);
  indexDefinition = capturePage(INDEX_JS);
  sessionDefinition = capturePage(SESSION_JS);
  routeDefinition = capturePage(ROUTE_JS);
  profileDefinition = capturePage(PROFILE_JS);
});

// ------------------------------------------------------------------ 注册与绑定

test('FM01 三个正式页面都注册了照片绑定，WXML 上的处理器真实存在', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(appJson.pages[0], 'pages/index/index');
  ['pages/training-session/training-session', 'pages/training-route/training-route', 'pages/profile/profile']
    .forEach(pagePath => {
      assert.ok(appJson.pages.includes(pagePath), pagePath + ' 必须注册进 app.json');
    });

  const cases = [
    { name: '场内页', definition: sessionDefinition, wxml: SESSION_WXML },
    { name: '线路详情页', definition: routeDefinition, wxml: ROUTE_WXML },
    { name: '个人页', definition: profileDefinition, wxml: PROFILE_WXML }
  ];
  cases.forEach(entry => {
    const source = fs.readFileSync(entry.wxml, 'utf8');
    const handlers = handlersIn(source);
    assert.ok(handlers.length > 0, entry.name + ' 应有按钮绑定');
    handlers.forEach(handler => {
      assert.equal(
        typeof entry.definition[handler],
        'function',
        entry.name + ' 的 ' + handler + ' 必须有对应页面方法'
      );
    });
  });

  // 照片相关的关键入口必须在 WXML 里真实可达。
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');
  [
    'new-route-photo-album',
    'new-route-photo-camera',
    'route-photo-confirm',
    'route-photo-cancel',
    'route-photo-remove'
  ].forEach(id => {
    assert.ok(sessionWxml.indexOf('id="' + id + '"') !== -1, '场内页缺少 ' + id);
  });
  const routeWxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  ['route-photo-card', 'route-photo-confirm', 'route-photo-remove', 'route-photo-album']
    .forEach(id => {
      assert.ok(routeWxml.indexOf('id="' + id + '"') !== -1, '详情页缺少 ' + id);
    });
  // 个人页保持 T016 的「清除缓存」入口（照片可重建缓存的清理从这里发起）。
  const profileWxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  assert.ok(profileWxml.indexOf('bindtap="clearCache"') !== -1, '个人页缺少清缓存入口');
  // 缩略图重建入口放在线路照片卡片上（详情页与场内页各一处）。
  [routeWxml, sessionWxml].forEach((source, index) => {
    assert.ok(
      source.indexOf('id="route-photo-rebuild-thumb"') !== -1,
      (index === 0 ? '详情页' : '场内页') + '缺少缩略图重建入口'
    );
    assert.ok(source.indexOf('bindtap="rebuildRoutePhoto"') !== -1);
  });
});

// ------------------------------------------------------------------ R2 新建与照片

test('R2 从正式首页「开始训练」进入场内页，选照片并确认（正式入口链路）', async () => {
  const home = createPage(indexDefinition);
  home.onLoad();
  home.startTraining();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(
    wxLog.navigations[0].url,
    '/pages/training-session/training-session?start=1'
  );

  // 按首页给出的目标打开场内页并走完一次选照片。
  const page = await openSessionPage({ start: '1' });
  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  page.startSession();
  await settle();
  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  await page.chooseNewRoutePhoto(tapDataset({ source: 'album' }));
  await page.createRoute();
  await settle();

  assert.equal(page.data.routePhoto.status, 'saved');
  const archive = archiveOf();
  const root = USER_DATA_PATH + '/training-photos/v1/' + archive.archiveId;
  assert.equal(filesUnder(root + '/main').length, 1);
  assert.equal(photoIndex().photos[0].routeId, archive.routes[0].id);
});

test('R2 拍照/相册按微信的选项对象回调调用，兼容首选与回退返回路径', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();

  // 首选 wx.chooseMedia：只传一个选项对象，success/fail 都在对象里。
  await page.chooseRoutePhoto(tapDataset({ source: 'camera' }));
  const mediaCall = wxLog.pickerCalls[wxLog.pickerCalls.length - 1];
  assert.equal(mediaCall.picker, 'media');
  assert.equal(mediaCall.argCount, 1, '只能传一个选项对象');
  assert.equal(typeof mediaCall.options.success, 'function');
  assert.equal(typeof mediaCall.options.fail, 'function');
  assert.equal(mediaCall.options.count, 1);
  assert.deepEqual(mediaCall.options.sourceType, ['camera']);
  assert.deepEqual(mediaCall.options.mediaType, ['image']);
  assert.equal(page.data.routePhoto.status, 'preview', '应从 tempFiles 解析出路径');
  page.cancelRoutePhoto(tapDataset({ routeId: seeded.route.id }));

  // 结果只给 tempFilePaths 时同样能解析。
  wxLog.mediaVariant = 'tempFilePaths';
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  page.cancelRoutePhoto(tapDataset({ routeId: seeded.route.id }));

  // 回退 wx.chooseImage：仍是单对象回调，并从 tempFiles[].path 解析。
  const chooseMedia = global.wx.chooseMedia;
  delete global.wx.chooseMedia;
  wxLog.imageVariant = 'tempFilesPath';
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  const imageCall = wxLog.pickerCalls[wxLog.pickerCalls.length - 1];
  assert.equal(imageCall.picker, 'image');
  assert.equal(imageCall.argCount, 1, '只能传一个选项对象');
  assert.equal(typeof imageCall.options.success, 'function');
  assert.deepEqual(imageCall.options.sizeType, ['compressed']);
  assert.equal(page.data.routePhoto.status, 'preview');
  page.cancelRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  global.wx.chooseMedia = chooseMedia;

  // 取消选择不改任何状态：仍然是原来的照片。
  const restoreMedia = global.wx.chooseMedia;
  global.wx.chooseMedia = options => {
    wxLog.pickerCalls.push({ picker: 'media', argCount: 1, options });
    options.fail({ errMsg: 'chooseMedia:fail cancel' });
  };
  const cancelled = await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(cancelled.cancelled, true);
  global.wx.chooseMedia = restoreMedia;
  assert.equal(page.data.routePhoto.status, 'none', '取消后仍没有照片');

  // 最后确认一张，确保上面的取消与回退都没有留下半成品。
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);
});

test('R2 新建线路时从相册选一张主照片并确认，照片落到本机档案目录', async () => {
  const page = await openSessionPage({ start: '1' });
  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  page.startSession();
  await settle();

  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  await page.chooseNewRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(page.data.newRoutePhoto !== null, true, '表单里应显示已选照片');
  assert.equal(page.data.newRoutePhoto.path.indexOf('http://tmp/'), 0);

  await page.createRoute();
  await settle();

  const archive = archiveOf();
  assert.equal(archive.routes.length, 1, '应只新建一条线路');
  const route = archive.routes[0];
  assert.equal(page.data.routePhoto.status, 'saved', '页面应显示照片已保存');
  assert.equal(page.data.newRoutePhoto, null, '创建后表单里的临时照片应清掉');

  const index = photoIndex();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].archiveId, archive.archiveId);
  assert.equal(index.photos[0].routeId, route.id);
  assert.equal(index.photos[0].photoId, page.data.routePhoto.photoId);
  assert.equal(index.photos[0].storage.type, 'local');
  assert.equal(index.photos[0].storage.location, page.data.routePhoto.mainPath);

  const root = USER_DATA_PATH + '/training-photos/v1/' + archive.archiveId;
  assert.match(
    page.data.routePhoto.mainPath,
    new RegExp('^' + root.replace(/\//g, '\\/') + '\\/main\\/photo-[A-Za-z0-9_-]+\\.jpg$')
  );
  assert.equal(filesUnder(root + '/main').length, 1);
  assert.equal(filesUnder(root + '/thumb').length, 1);
  // 选择器给的是临时路径，只是本次预览来源，不能成为长期引用。
  assert.equal(JSON.stringify(index).indexOf('http://tmp/'), -1);
});

test('R2 同色同级另一条线路不带前一条的把次或照片', async () => {
  const page = await openSessionPage({ start: '1' });
  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  page.startSession();
  await settle();

  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  await page.chooseNewRoutePhoto(tapDataset({ source: 'album' }));
  await page.createRoute();
  await settle();
  const firstRouteId = page.data.selectedRoute.id;
  const firstPhotoId = page.data.routePhoto.photoId;

  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色平衡线' } });
  await page.createRoute();
  await settle();

  const secondRouteId = page.data.selectedRoute.id;
  assert.notEqual(secondRouteId, firstRouteId);
  assert.equal(page.data.routePhoto.status, 'none', '第二条线没有照片');
  assert.equal(page.data.routePhoto.hasPhoto, false);
  assert.equal(page.data.attempts.length, 0, '第二条线不带前一条的把次');

  const index = photoIndex();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].photoId, firstPhotoId);
  assert.equal(index.photos[0].routeId, firstRouteId);

  // 回到第一条线仍是同一张照片。
  page.selectRoute(tapDataset({ routeId: firstRouteId }));
  await settle();
  assert.equal(page.data.routePhoto.photoId, firstPhotoId);
  assert.equal(page.data.routePhoto.status, 'saved');

  // 新页面实例（照片视图未缓存）换到第一条线时，必须主动读取到同一张照片，
  // 不能停在上一条线的状态或一直显示读取中。
  const reopened = await openSessionPage();
  assert.equal(reopened.data.selectedRoute.id, firstRouteId);
  assert.equal(reopened.data.routePhoto.status, 'saved', '重开本页应按当前线路读回照片');
  assert.equal(reopened.data.routePhoto.photoId, firstPhotoId);
  reopened.selectRoute(tapDataset({ routeId: secondRouteId }));
  await settle();
  assert.equal(reopened.data.routePhoto.status, 'none', '换到没有照片的线路应清空展示');
  reopened.selectRoute(tapDataset({ routeId: firstRouteId }));
  await settle();
  assert.equal(reopened.data.routePhoto.status, 'saved');
  assert.equal(reopened.data.routePhoto.photoId, firstPhotoId);
  assert.equal(reopened.data.routePhoto.mainPath, page.data.routePhoto.mainPath);
});

test('R2 试选后取消可立即重选，且取消不产生任何文件或索引', async () => {
  const page = await openSessionPage({ start: '1' });
  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  page.startSession();
  await settle();
  page.toggleNewRouteForm();

  await page.chooseNewRoutePhoto(tapDataset({ source: 'album' }));
  assert.ok(page.data.newRoutePhoto);
  page.cancelNewRoutePhoto();
  assert.equal(page.data.newRoutePhoto, null, '取消后表单里的选择应清空');
  assert.equal(filesUnder(USER_DATA_PATH + '/training-photos').length, 0);
  assert.equal(photoIndex(), null);

  // 立刻重选：仍能选到，并且创建后正常保存。
  await page.chooseNewRoutePhoto(tapDataset({ source: 'camera' }));
  assert.ok(page.data.newRoutePhoto);
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  await page.createRoute();
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);
});

test('R2 取消更换后仍显示原来的主图，旧文件与索引不变', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  // 先经页面存一张主照片，再验证“取消更换保留原图”。
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  const beforePhotoId = page.data.routePhoto.photoId;
  const beforePath = page.data.routePhoto.mainPath;
  const beforeIndex = JSON.stringify(photoIndex());

  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  assert.equal(page.data.routePhoto.previewPath.indexOf('http://tmp/'), 0);

  page.cancelRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(page.data.routePhoto.photoId, beforePhotoId);
  assert.equal(page.data.routePhoto.mainPath, beforePath);
  assert.ok(virtual.files.has(beforePath), '旧主图仍然存在');
  assert.equal(JSON.stringify(photoIndex()), beforeIndex, '取消不应改动照片索引');

  // 取消后可以立刻重选，并确认更换。
  await page.chooseRoutePhoto(tapDataset({ source: 'camera' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.notEqual(page.data.routePhoto.photoId, beforePhotoId);
  assert.equal(virtual.files.has(beforePath), false, '更换成功后旧主图应释放');
  assert.equal(photoIndex().photos.length, 1);
});

// ------------------------------------------------------------------ R5 移除与失败

test('R5 页面移除照片：索引与文件释放，把次与备注不动', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();

  page.recordAttempt(tapDataset({ result: 'fail' }));
  await settle();
  const archiveBefore = JSON.parse(rawArchive());
  const mainPath = page.data.routePhoto.mainPath;

  wxLog.modalConfirm = true;
  await page.removeRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();

  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(virtual.files.has(mainPath), false, '主图文件应被释放');
  assert.equal(photoIndex().photos.length, 0);
  // 场次、线路与把次没有被照片操作改写：逐项对照，只有照片相关键会变。
  const archiveAfter = JSON.parse(rawArchive());
  assert.deepEqual(archiveAfter.routes, archiveBefore.routes);
  assert.deepEqual(archiveAfter.attempts, archiveBefore.attempts);
  assert.deepEqual(archiveAfter.sessions, archiveBefore.sessions);
  assert.deepEqual(archiveAfter.gyms, archiveBefore.gyms);
  assert.equal(archiveAfter.archiveId, archiveBefore.archiveId);
});

test('R5 空间不足时页面提示原因并保留旧照片', async () => {
  const seeded = seedTraining();
  // 注入小预算：第一张刚好放得下，第二张（含更换余量）放不下。
  controllerModule.setTrainingPhotoSpacePolicy({
    budgetBytes: 300000,
    warnBytes: 200000,
    reserveBytes: 50000
  });
  controllerModule.resetTrainingPhotos();

  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  const keptPhotoId = page.data.routePhoto.photoId;
  const keptPath = page.data.routePhoto.mainPath;

  // 再换一张会超过预算：页面显示失败原因与「管理照片空间」入口，旧图保留。
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();

  assert.equal(page.data.routePhoto.status, 'failed');
  assert.equal(page.data.routePhoto.spaceIssue, true);
  assert.equal(page.data.routePhoto.manageSpaceVisible, true);
  assert.match(page.data.routePhoto.errorText, /空间不足|预算/);
  assert.equal(page.data.routePhoto.hasPhoto, true, '旧照片仍可用');
  assert.equal(virtual.files.has(keptPath), true, '旧主图保留');
  assert.equal(photoIndex().photos[0].photoId, keptPhotoId);

  // 页面上的出口指向「我的」的照片空间管理。
  page.goToClearCache();
  assert.equal(wxLog.switches[0].url, '/pages/profile/profile');

  controllerModule.setTrainingPhotoSpacePolicy(null);
  controllerModule.resetTrainingPhotos();
});

// ------------------------------------------------------------------ R3 跨天回看

test('R3 跨天详情读到同一张照片，更正与再记不动照片', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  page.recordAttempt(tapDataset({ result: 'fail' }));
  await settle();
  const photoId = page.data.routePhoto.photoId;
  const mainPath = page.data.routePhoto.mainPath;

  // 第二天：新场次、复用原线、记一把完攀。
  const day2 = store.startSession({ gymName: '我自己去的岩馆', date: '2026-11-10' });
  assert.equal(day2.ok, true, day2.error);
  const sessionId = day2.archive.activeSessionId;
  assert.equal(store.linkRouteToSession(sessionId, seeded.route.id).ok, true);
  assert.equal(store.selectRoute(seeded.route.id).ok, true);
  const send = store.saveAttempt({
    sessionId: sessionId,
    routeId: seeded.route.id,
    result: 'send'
  });
  assert.equal(send.ok, true, send.error);

  const detail = await openRoutePage(seeded.route.id);
  assert.equal(detail.data.routePhoto.status, 'saved', '跨天详情应读到同一张图');
  assert.equal(detail.data.routePhoto.photoId, photoId);
  assert.equal(detail.data.routePhoto.mainPath, mainPath);
  assert.equal(detail.data.groups.length, 2, '两天两场都应在详情里');

  // 更正那把完攀：只翻 result，照片与文件不变。
  const lastAttempt = send.attempt;
  detail.correctSend(tapDataset({
    attemptId: lastAttempt.id,
    routeId: seeded.route.id,
    sessionId: sessionId
  }));
  await settle();
  assert.equal(detail.data.routePhoto.photoId, photoId);
  assert.equal(detail.data.routePhoto.mainPath, mainPath);
  assert.ok(virtual.files.has(mainPath));
  const index = photoIndex();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].photoId, photoId);
});

// ------------------------------------------------------------------ R5 个人页清缓存

test('R5 个人页清缓存后场次、备注、索引与仍被引用的原图都在，缩略图可重建', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  page.recordAttempt(tapDataset({ result: 'fail' }));
  await settle();
  const attemptId = page.data.attempts[0].id;
  page.openNoteEditor(tapDataset({ attemptId }));
  page.onNoteInput({ detail: { value: '抓到后向右摆' } });
  page.saveNote();
  await settle();

  const mainPath = page.data.routePhoto.mainPath;
  const thumbPath = page.data.routePhoto.thumbnailPath;
  const archiveBefore = rawArchive();
  assert.ok(virtual.files.has(thumbPath), '清缓存前应有缩略图文件');

  const profile = await openProfilePage();
  await profile.clearCacheConfirmed();
  await settle();

  // 主图、索引、档案与备注保留；缩略图文件与元数据被清掉。
  assert.equal(virtual.files.has(mainPath), true, '被引用的原图必须保留');
  assert.equal(virtual.files.has(thumbPath), false, '缩略图应被清掉');
  assert.equal(rawArchive(), archiveBefore, '本机档案（含备注）必须逐字节不变');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(photoIndex().photos[0].storage.location, mainPath);
  assert.equal(storage.has(serviceModule.THUMB_CACHE_KEY), false);

  // 缩略图可重建：从详情页照片卡片上的「重建缩略图」入口发起，只补缓存。
  const beforeRebuild = await openRoutePage(seeded.route.id);
  assert.equal(beforeRebuild.data.routePhoto.thumbnailAvailable, false);
  await beforeRebuild.rebuildRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(beforeRebuild.data.routePhoto.thumbnailAvailable, true);
  const detail = await openRoutePage(seeded.route.id);
  assert.equal(detail.data.routePhoto.status, 'saved', '重建后详情仍显示已保存');
  assert.ok(
    detail.data.routePhoto.thumbnailPath.indexOf('/thumb/photo-') !== -1,
    '缩略图应已重建'
  );
  assert.ok(virtual.files.has(detail.data.routePhoto.thumbnailPath));
  assert.equal(detail.data.routePhoto.photoId, photoIndex().photos[0].photoId);
  assert.ok(virtual.files.has(mainPath));
  assert.equal(rawArchive(), archiveBefore, '重建缩略图不改动档案');
});

test('R5 照片操作未落定时不顺手清缓存，也不删正在写的文件', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  const profile = await openProfilePage();

  // 让照片控制器处于“保存中”：直接构造一次失败的保存，再检查 busy 判断。
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  const saving = page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  const result = await profile.clearCacheConfirmed();
  assert.equal(result && result.busy, true, '照片进行中时清缓存应被拒绝');
  await saving;
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.ok(virtual.files.has(page.data.routePhoto.mainPath));
});

// ------------------------------------------------------------------ 退出重开与命名空间

test('R5 退出重开（重新加载模块）后照片、索引与原图仍在', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const photoId = page.data.routePhoto.photoId;
  const mainPath = page.data.routePhoto.mainPath;

  // 模拟小程序退出重开：丢掉共享服务实例与模块缓存，重新加载页面与服务。
  controllerModule.resetTrainingPhotos();
  Object.keys(require.cache)
    .filter(key => key.indexOf(ROOT + path.sep + 'utils') === 0 ||
      key.indexOf(ROOT + path.sep + 'pages') === 0)
    .forEach(key => {
      delete require.cache[key];
    });

  const freshSessionDefinition = capturePage(SESSION_JS);
  const freshRouteDefinition = capturePage(ROUTE_JS);
  const freshPage = createPage(freshSessionDefinition);
  freshPage.onLoad({});
  await settle();

  assert.equal(freshPage.data.routePhoto.status, 'saved', '重开后场内页仍显示照片');
  assert.equal(freshPage.data.routePhoto.photoId, photoId);

  const freshDetail = createPage(freshRouteDefinition);
  freshDetail.onLoad({ routeId: seeded.route.id });
  await settle();
  assert.equal(freshDetail.data.routePhoto.status, 'saved');
  assert.equal(freshDetail.data.routePhoto.mainPath, mainPath);
  assert.ok(virtual.files.has(mainPath), '重开后原图仍在');
});

test('R6 照片流程只落正式本机命名空间：无云调用、不写旧记录或试用工程的键', async () => {
  const seeded = seedTraining();
  const page = await openSessionPage();
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const profile = await openProfilePage();
  await profile.clearCacheConfirmed();
  await settle();

  // 本 harness 刻意不提供 wx.cloud：任何云调用都会在这里抛错。
  assert.equal(typeof global.wx.cloud, 'undefined');

  const keys = Array.from(storage.keys());
  assert.ok(keys.length > 0);
  keys.forEach(key => {
    assert.equal(
      key.indexOf('climbingNote.training.v1.') === 0,
      true,
      '照片流程不得写入命名空间外的键：' + key
    );
    assert.equal(key.indexOf('climbingNote.gymLogTrial') === -1, true);
    assert.equal(key.indexOf('climbing_records') === -1, true);
  });
  // 独立试用工程的照片目录没有被创建。
  assert.equal(filesUnder(USER_DATA_PATH + '/gym-log-trial-photos').length, 0);
  // 旧云记录接口没有被本流程使用。
  assert.equal(typeof db.getRecentRecords, 'function');
});
