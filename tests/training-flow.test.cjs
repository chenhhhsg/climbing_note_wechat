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
// T040：有照片时的换图、移除与大图标记都在独立二级页。
const MARKS_PAGE_JS = path.join(ROOT, 'pages', 'training-photo-marks', 'training-photo-marks.js');
const MARKS_PAGE_WXML = path.join(ROOT, 'pages', 'training-photo-marks', 'training-photo-marks.wxml');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const RECORD_WXML = path.join(ROOT, 'pages', 'training-record', 'training-record.wxml');
const RECORD_WXSS = path.join(ROOT, 'pages', 'training-record', 'training-record.wxss');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');
const PROFILE_WXML = path.join(ROOT, 'pages', 'profile', 'profile.wxml');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SERVICE_JS = path.join(ROOT, 'utils', 'training-photos.js');
const CONTROLLER_JS = path.join(ROOT, 'utils', 'training-photo-controller.js');
const VIDEO_FILES_JS = path.join(ROOT, 'utils', 'attempt-video-files.js');
const VIDEO_UTIL_JS = path.join(ROOT, 'utils', 'attempt-video.js');

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
  modals: [],
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
  wxLog.modals = [];
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
    wxLog.modals.push(options);
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
const videoFilesModule = require(VIDEO_FILES_JS);
const attemptVideo = require(VIDEO_UTIL_JS);

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

/** 单线记录页（T036 / T041）：按档案、场次与长期线路打开现场记录。 */
async function openRecordPageFor(routeId, sessionId) {
  const archive = store.loadState().archive;
  const page = createPage(recordDefinition);
  page.onLoad({
    archiveId: archive.archiveId,
    sessionId: sessionId || archive.activeSessionId,
    routeId
  });
  await settle();
  return page;
}

/** 当前照片版本（照片索引里这条线的 photoId）：大图页入口带它核对归属。 */
function currentPhotoIdOf(routeId) {
  const index = photoIndex();
  if (!index) return '';
  const record = (index.routes || []).find(item => item.routeId === routeId);
  return (record && record.photoId) || '';
}

/** 打开大图标记页（T040）：带齐档案、线路与当前照片 ID。 */
async function openMarksPage(routeId) {
  const page = createPage(marksPageDefinition);
  const archive = store.loadState().archive;
  page.onLoad({
    archiveId: (archive && archive.archiveId) || '',
    routeId,
    photoId: currentPhotoIdOf(routeId)
  });
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
let recordDefinition = null;
let attemptsDefinition = null;
let routeDefinition = null;
let marksPageDefinition = null;
let profileDefinition = null;

beforeEach(() => {
  resetAll();
  // 共享照片服务实例在每个用例之间重置，不带出上一用例的登记状态。
  controllerModule.resetTrainingPhotos();
  controllerModule.setTrainingPhotoSpacePolicy(null);
  indexDefinition = capturePage(INDEX_JS);
  sessionDefinition = capturePage(SESSION_JS);
  recordDefinition = capturePage(RECORD_JS);
  attemptsDefinition = capturePage(ATTEMPTS_JS);
  routeDefinition = capturePage(ROUTE_JS);
  marksPageDefinition = capturePage(MARKS_PAGE_JS);
  profileDefinition = capturePage(PROFILE_JS);
});

// ------------------------------------------------------------------ 注册与绑定

test('FM01 三个正式页面都注册了照片绑定，WXML 上的处理器真实存在', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(appJson.pages[0], 'pages/index/index');
  ['pages/training-session/training-session', 'pages/training-route/training-route', 'pages/training-record/training-record', 'pages/profile/profile']
    .forEach(pagePath => {
      assert.ok(appJson.pages.includes(pagePath), pagePath + ' 必须注册进 app.json');
    });

  // T036：照片只在「线路资料」（training-route）里维护；场内页与单线页只提供入口。
  const cases = [
    { name: '线路资料页', definition: routeDefinition, wxml: ROUTE_WXML },
    { name: '大图标记页', definition: marksPageDefinition, wxml: MARKS_PAGE_WXML },
    { name: '单线记录页', definition: recordDefinition, wxml: RECORD_WXML },
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

  // T040：没有照片时资料页仍可直接添加（选图、预览确认、取消）。
  const routeWxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  ['route-photo-card', 'route-photo-confirm', 'route-photo-cancel', 'route-photo-album'].forEach(id => {
    assert.ok(routeWxml.indexOf('id="' + id + '"') !== -1, '资料页缺少 ' + id);
  });
  // 有照片时资料页只留缩略图与「照片动作标记 · N 个」入口。
  ['route-photo-thumb-link', 'route-photo-thumb', 'photo-marks-entry'].forEach(id => {
    assert.ok(routeWxml.indexOf('id="' + id + '"') !== -1, '资料页缺少 ' + id);
  });
  assert.ok(routeWxml.indexOf('bindtap="openPhotoMarks"') !== -1);
  assert.equal(routeWxml.indexOf('id="route-photo-remove"'), -1, '移除入口在大图页');
  assert.equal(routeWxml.indexOf('bindtap="removeRoutePhoto"'), -1, '移除入口在大图页');

  // 大图页承接主图、换图、移除与重建缩略图。
  const marksWxml = fs.readFileSync(MARKS_PAGE_WXML, 'utf8');
  [
    'route-photo-card',
    'route-photo-confirm',
    'route-photo-cancel',
    'route-photo-remove',
    'route-photo-album',
    'route-photo-rebuild-thumb',
    'route-photo-stage',
    'mark-card'
  ].forEach(id => {
    assert.ok(marksWxml.indexOf('id="' + id + '"') !== -1, '大图页缺少 ' + id);
  });
  assert.ok(marksWxml.indexOf('bindtap="rebuildRoutePhoto"') !== -1);
  // 单线页只提供紧凑的照片入口（T041）：首屏一行添加/缩略图，不铺整张照片卡，
  // 也不铺标记编辑；换图与移除仍在二级大图页。
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  // T045：现场不再有独立的「本场逐把」跳转与「线路历史」入口；缩略图仍进二级标记页。
  assert.equal(recordWxml.indexOf('id="open-route-profile"'), -1, '现场不再有线路历史跳转');
  assert.equal(recordWxml.indexOf('id="open-attempts"'), -1, '现场不再有独立逐把跳转');
  assert.match(recordWxml, /id="record-attempts"/, '本场本线把次直接排在首屏文档流');
  assert.equal(recordWxml.indexOf('id="route-photo-card"'), -1, '单线页不再铺照片卡');
  assert.match(recordWxml, /id="record-photo"/);
  assert.equal(recordWxml.indexOf('id="route-photo-stage"'), -1, '单线页不铺标记图层');
  assert.equal(recordWxml.indexOf('bindtap="removeRoutePhoto"'), -1, '移除入口在二级页');
  // 场内页不再有新建线路时的照片选择（照片统一在资料页补）。
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.equal(sessionWxml.indexOf('id="new-route-photo-album"'), -1);
  assert.equal(typeof sessionDefinition.chooseRoutePhoto, 'undefined');
  // 个人页保持 T016 的「清除缓存」入口（照片可重建缓存的清理从这里发起）。
  const profileWxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  assert.ok(profileWxml.indexOf('bindtap="clearCache"') !== -1, '个人页缺少清缓存入口');
});

test('R2 从正式首页「开始训练」进入场内页，选照片并确认（正式入口链路）', async () => {
  const home = createPage(indexDefinition);
  home.onLoad();
  home.startTraining();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(
    wxLog.navigations[0].url,
    '/pages/training-session/training-session?start=1'
  );

  // 按首页给出的目标打开场内页，建线后直达单线页，再从资料页走完一次选照片。
  const page = await openSessionPage({ start: '1' });
  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  page.startSession();
  await settle();
  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  await page.createRoute();
  await settle();
  assert.match(wxLog.navigations.at(-1).url, /^\/pages\/training-record\/training-record\?/);
  const archive = archiveOf();
  const routeId = archive.routes[0].id;

  const detail = await openRoutePage(routeId);
  assert.equal(detail.data.routePhoto.status, 'none', '新线还没有照片');
  await detail.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await detail.confirmRoutePhoto(tapDataset({ routeId }));
  await settle();
  assert.equal(detail.data.routePhoto.status, 'saved');
  const root = USER_DATA_PATH + '/training-photos/v1/' + archive.archiveId;
  assert.equal(filesUnder(root + '/main').length, 1);
  assert.equal(photoIndex().photos[0].routeId, routeId);
});

test('R2 拍照/相册按微信的选项对象回调调用，兼容首选与回退返回路径', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
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
  // T036：照片在新建后从单线记录首屏（T041）或线路历史页补；创建表单不再收集临时照片。
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  assert.equal(page.data.routePhoto.previewPath.indexOf('http://tmp/'), 0);
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();

  const archive = archiveOf();
  assert.equal(archive.routes.length, 1, '应只保留一条线路');
  const route = archive.routes[0];
  assert.equal(page.data.routePhoto.status, 'saved', '页面应显示照片已保存');

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
  const seeded = seedTraining({ routeName: '蓝色动态线' });
  const second = store.createRoute({
    sessionId: seeded.session.id,
    name: '蓝色平衡线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(second.ok, true, second.error);

  const first = await openRoutePage(seeded.route.id);
  await first.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await first.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(first.data.routePhoto.status, 'saved');
  const firstPhotoId = first.data.routePhoto.photoId;
  const firstMainPath = first.data.routePhoto.mainPath;

  // 同色同级的第二条线：没有照片，也没有前一条的把次。
  const other = await openRoutePage(second.route.id);
  assert.equal(other.data.routePhoto.status, 'none', '第二条线没有照片');
  assert.equal(other.data.routePhoto.hasPhoto, false);
  assert.equal(other.data.attemptCount, 0, '第二条线不带前一条的把次');

  const index = photoIndex();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].photoId, firstPhotoId);
  assert.equal(index.photos[0].routeId, seeded.route.id);

  // 回到第一条线仍是同一张照片。
  const reopened = await openRoutePage(seeded.route.id);
  assert.equal(reopened.data.routePhoto.status, 'saved');
  assert.equal(reopened.data.routePhoto.photoId, firstPhotoId);
  assert.equal(reopened.data.routePhoto.mainPath, firstMainPath);
});

test('R2 试选后取消可立即重选，且取消不产生任何文件或索引', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
  await settle();

  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  page.cancelRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  assert.equal(page.data.routePhoto.status, 'none', '取消后回到没有照片');
  assert.equal(filesUnder(USER_DATA_PATH + '/training-photos').length, 0);
  assert.equal(photoIndex(), null);

  // 立刻重选：仍能选到，并且确认后正常保存。
  await page.chooseRoutePhoto(tapDataset({ source: 'camera' }));
  assert.equal(page.data.routePhoto.status, 'preview');
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.routePhoto.status, 'saved');
  assert.equal(photoIndex().photos.length, 1);
});

test('R2 取消更换后仍显示原来的主图，旧文件与索引不变', async () => {
  const seeded = seedTraining();
  const page = await openMarksPage(seeded.route.id);
  await settle();
  // 先经资料页存一张主照片，再验证“取消更换保留原图”。
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

test('T031 结果旁换线：同色同级两条线各自带自己的照片，换线只切当前线与照片', async () => {
  const seeded = seedTraining({ gymName: '我自己去的岩馆', routeName: 'A 线' });
  const b = store.createRoute({
    sessionId: seeded.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(b.ok, true, b.error);

  // A 在资料页存一张照片。
  const aPage = await openRoutePage(seeded.route.id);
  await aPage.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await aPage.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const aPhotoId = aPage.data.routePhoto.photoId;
  assert.equal(aPage.data.routePhoto.status, 'saved');

  // B 同色同级、没有照片；两条线按原 routeId 各开各的资料页。
  const bPage = await openRoutePage(b.route.id);
  assert.equal(bPage.data.routePhoto.status, 'none', 'B 没有照片');
  assert.equal(photoIndex().photos.length, 1);
  assert.equal(photoIndex().photos[0].routeId, seeded.route.id);
  assert.equal(photoIndex().photos[0].photoId, aPhotoId);

  // 回到 A：同一张照片、同一个文件。
  const aAgain = await openRoutePage(seeded.route.id);
  assert.equal(aAgain.data.routePhoto.status, 'saved');
  assert.equal(aAgain.data.routePhoto.photoId, aPhotoId);
  assert.equal(aAgain.data.routePhoto.mainPath, aPage.data.routePhoto.mainPath);
});

test('T031 快速 A→B：迟到的 A 照片回执不覆盖 B，下一把只归 B', async () => {
  const seeded = seedTraining({ gymName: '我自己去的岩馆', routeName: 'A 线' });
  const b = store.createRoute({
    sessionId: seeded.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(b.ok, true, b.error);

  // A 的资料页发起照片选择，回执挂起。
  const aPage = await openRoutePage(seeded.route.id);
  const realChooseMedia = global.wx.chooseMedia;
  let pending = null;
  global.wx.chooseMedia = options => {
    pending = options;
  };
  aPage.chooseRoutePhoto(tapDataset({ source: 'album', routeId: seeded.route.id }));
  assert.ok(pending, 'A 的照片选择已经发起');
  global.wx.chooseMedia = realChooseMedia;

  // 用户已经打开 B 的资料页：B 没有照片，A 的迟到回执不得覆盖 B 的展示。
  const bPage = await openRoutePage(b.route.id);
  pending.success({ tempFiles: [{ tempFilePath: pickerFile() }] });
  await settle();
  assert.equal(bPage.data.routePhoto.status, 'none', 'B 没有照片，迟到回执不得覆盖');
  assert.equal(bPage.data.routePhoto.hasPhoto, false);
  const index = photoIndex();
  assert.equal((index && index.photos ? index.photos : []).length, 0, '只选未确认不写照片索引');
  assert.equal(aPage.data.routePhoto.status, 'preview', '回执只落在发起它的 A 页面');

  // 下一把只归 B（单线页），A 不产生把次。
  const bRecord = createPage(recordDefinition);
  bRecord.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: b.route.id
  });
  const beforeB = store.attemptsFor(archiveOf(), {
    sessionId: seeded.session.id,
    routeId: b.route.id
  }).length;
  bRecord.recordAttempt(tapDataset({ result: 'fail' }));
  await settle();
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: seeded.session.id, routeId: b.route.id }).length,
    beforeB + 1
  );
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: seeded.session.id, routeId: seeded.route.id }).length,
    0,
    'A 不产生把次'
  );
});

test('T030 复验 同日两场：切回已有照片的旧场次再选回原线，照片、把数与备注都跟着原 routeId', async () => {
  // 第一场：A 线带照片，记一把并补备注。
  const first = seedTraining({ gymName: '我自己去的岩馆', routeName: 'A 线' });
  const session1 = first.session.id;
  const aId = first.route.id;
  const aDetail = await openRoutePage(aId);
  await aDetail.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await aDetail.confirmRoutePhoto(tapDataset({ routeId: aId }));
  await settle();
  assert.equal(aDetail.data.routePhoto.status, 'saved');
  const aPhotoId = aDetail.data.routePhoto.photoId;
  const aPath = aDetail.data.routePhoto.mainPath;

  const recordA = createPage(recordDefinition);
  recordA.onLoad({ archiveId: archiveOf().archiveId, sessionId: session1, routeId: aId });
  recordA.recordAttempt(tapDataset({ result: 'fail', sessionId: session1, routeId: aId }));
  const aAttemptId = recordA.data.attempts[0].id;
  const attemptsPage = createPage(attemptsDefinition);
  attemptsPage.onLoad({ archiveId: archiveOf().archiveId, sessionId: session1, routeId: aId });
  attemptsPage.openNoteEditor(tapDataset({ attemptId: aAttemptId }));
  attemptsPage.onNoteInput({ detail: { value: 'A 的旧备注' } });
  attemptsPage.saveNote();
  await settle();

  // 同日另开第二场：只记一把，不带第一场的照片或把次。
  const second = store.startSession({ gymName: '我自己去的岩馆' });
  assert.equal(second.ok, true, second.error);
  const session2 = second.archive.activeSessionId;
  const bRoute = store.createRoute({
    sessionId: session2,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(bRoute.ok, true, bRoute.error);
  const bId = bRoute.route.id;
  const bRecord = createPage(recordDefinition);
  bRecord.onLoad({ archiveId: archiveOf().archiveId, sessionId: session2, routeId: bId });
  bRecord.recordAttempt(tapDataset({ result: 'fail', sessionId: session2, routeId: bId }));
  await settle();
  assert.equal((await openRoutePage(bId)).data.routePhoto.status, 'none', 'B 没有照片');
  assert.equal(photoIndex().photos.length, 1, '照片索引里只有 A 那一条');

  // 切回第一场：列表只改归属（当前选择被清空），本场线路仍在。
  store.selectSession(session1);
  const listPage = await openSessionPage();
  assert.equal(listPage.data.activeSession.id, session1);
  assert.equal(listPage.data.selectedRoute, null);
  assert.equal(listPage.data.routes.length, 1, '本场那一条线仍在列表里');
  assert.equal(listPage.data.routes[0].id, aId);

  // 从列表重开原线：照片、把数与备注一起回到 A（同一个 routeId）。
  const aAgain = await openRoutePage(aId);
  assert.equal(aAgain.data.routePhoto.status, 'saved');
  assert.equal(aAgain.data.routePhoto.photoId, aPhotoId);
  assert.equal(aAgain.data.routePhoto.mainPath, aPath);
  const recordAgain = createPage(recordDefinition);
  recordAgain.onLoad({ archiveId: archiveOf().archiveId, sessionId: session1, routeId: aId });
  assert.equal(recordAgain.data.routeCountText, '1 把');
  assert.equal(recordAgain.data.attempts.length, 1);
  assert.equal(recordAgain.data.attempts[0].id, aAttemptId);
  assert.equal(recordAgain.data.attempts[0].note, 'A 的旧备注');
  assert.equal(photoIndex().photos.length, 1, '重开原线不新建第二条照片记录');
  assert.equal(photoIndex().photos[0].routeId, aId);
  // 第二场的把次没有被搬过来。
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session2, routeId: bId }).length,
    1
  );
});

test('R5 页面移除照片：索引与文件释放，把次与备注不动', async () => {
  const seeded = seedTraining();
  const page = await openMarksPage(seeded.route.id);
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();

  const recordPage = createPage(recordDefinition);
  recordPage.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id
  });
  recordPage.recordAttempt(tapDataset({ result: 'fail' }));
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

  const page = await openMarksPage(seeded.route.id);
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

test('R3 跨天详情读到同一张照片，更正与再记不动照片', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const recordPage = createPage(recordDefinition);
  recordPage.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id
  });
  recordPage.recordAttempt(tapDataset({ result: 'fail' }));
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

test('R5 个人页清缓存后场次、备注、索引与仍被引用的原图都在，缩略图可重建', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const recordPage = createPage(recordDefinition);
  recordPage.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id
  });
  recordPage.recordAttempt(tapDataset({ result: 'fail' }));
  await settle();
  const attemptId = recordPage.data.attempts[0].id;
  const attemptsPage = createPage(attemptsDefinition);
  attemptsPage.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id
  });
  attemptsPage.openNoteEditor(tapDataset({ attemptId }));
  attemptsPage.onNoteInput({ detail: { value: '抓到后向右摆' } });
  attemptsPage.saveNote();
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

  // 缩略图可重建：从资料页照片卡片上的「重建缩略图」入口发起，只补缓存。
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
  const page = await openRoutePage(seeded.route.id);
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

test('R5 退出重开（重新加载模块）后照片、索引与原图仍在', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
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

  const freshRouteDefinition = capturePage(ROUTE_JS);
  const freshDetail = createPage(freshRouteDefinition);
  freshDetail.onLoad({ routeId: seeded.route.id });
  await settle();
  assert.equal(freshDetail.data.routePhoto.status, 'saved');
  assert.equal(freshDetail.data.routePhoto.photoId, photoId);
  assert.equal(freshDetail.data.routePhoto.mainPath, mainPath);
  assert.ok(virtual.files.has(mainPath), '重开后原图仍在');
});

test('R6 照片流程只落正式本机命名空间：无云调用、不写旧记录或试用工程的键', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
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

test('R7 普通清缓存保留逐把视频索引与副本（含撤回后待恢复），照片仍按既有策略清理', async () => {
  const seeded = seedTraining();
  const page = await openRoutePage(seeded.route.id);
  await settle();
  await page.chooseRoutePhoto(tapDataset({ source: 'album' }));
  await page.confirmRoutePhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  const mainPath = page.data.routePhoto.mainPath;
  const thumbPath = page.data.routePhoto.thumbnailPath;
  assert.ok(virtual.files.has(mainPath));
  assert.ok(virtual.files.has(thumbPath));

  const saved = store.saveAttempt({
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail',
    note: '带本机视频的那把'
  });
  assert.equal(saved.ok, true, saved.error);
  const attemptId = saved.attempt.id;
  const archiveId = archiveOf().archiveId;
  const tempPath = 'http://tmp/video-source.mp4';
  virtual.files.set(tempPath, Buffer.alloc(2048, 9));
  const videoService = videoFilesModule.createAttemptVideoStore({
    archiveId,
    files: videoFilesModule.createWxAttemptVideoFiles({
      archiveId,
      wxApi: global.wx
    }),
    now: () => '2026-11-16T10:00:00.000Z'
  });
  const committed = await videoService.commit({
    action: 'commit',
    archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    attemptId,
    attemptSeq: saved.attempt.seq,
    tempFilePath: tempPath,
    sizeBytes: 2048,
    durationSeconds: 6.4,
    width: 1080,
    height: 1920,
    fileName: 'video-source.mp4'
  });
  assert.equal(committed.ok, true, committed.error);
  const videoPath = USER_DATA_PATH + '/' + committed.clip.fileId;
  assert.ok(virtual.files.has(videoPath), '视频副本应写入本机目录');
  const videoIndexRaw = storage.get(store.NAMESPACE + 'attempt-video');
  assert.ok(videoIndexRaw);

  // 撤回这一把：视频索引与副本不参与把次状态，待恢复期间仍能读到原片。
  assert.equal(store.undoAttempt(attemptId).ok, true);
  assert.equal(attemptVideo.videoClipView(archiveId, attemptId).state, 'saved');
  const archiveBefore = rawArchive();

  const profile = await openProfilePage();
  profile.clearCache();
  await settle();
  assert.ok(wxLog.modals.length > 0, '清缓存应有一次确认提示');
  assert.match(wxLog.modals[0].content, /逐把视频不会被清除/);

  // 既有照片/训练缓存策略不变；视频索引与副本原样保留。
  assert.equal(
    storage.get(store.NAMESPACE + 'attempt-video'),
    videoIndexRaw,
    '视频索引逐字节不变'
  );
  assert.ok(virtual.files.has(videoPath), '已关联的视频副本仍在');
  assert.ok(virtual.files.has(mainPath), '线路主照片仍在');
  assert.equal(virtual.files.has(thumbPath), false, '缩略图仍按可重建缓存清理');
  assert.equal(rawArchive(), archiveBefore, '训练档案逐字节不变');
  assert.equal(
    store.loadState().archive.attempts.find(item => item.id === attemptId).undoneAt
      !== undefined,
    true,
    '撤回状态保持'
  );
  assert.equal(attemptVideo.videoClipView(archiveId, attemptId).state, 'saved');

  // 恢复同一把后仍读同一条片段。
  assert.equal(store.restoreAttempt(attemptId).ok, true);
  assert.equal(attemptVideo.videoClipView(archiveId, attemptId).state, 'saved');
  assert.ok(virtual.files.has(videoPath));
});

// ------------------------------------------------------------------ T041 现场照片入口

test('T041 单线首屏照片入口：无图添加、预览确认、取消与写失败都保留之前状态', async () => {
  const seeded = seedTraining({ gymName: '我自己去的岩馆', routeName: '现场 A 线' });
  const archiveId = archiveOf().archiveId;

  // 首屏真实绑定：无图给拍照 / 相册，选图后预览确认，有图整行进二级标记页；
  // 两种记把动作与本场本线把次区都还在（T045：把次直接排在同页）。
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  assert.match(recordWxml, /id="record-photo-camera"[\s\S]{0,260}bindtap="chooseRecordPhoto"/);
  assert.match(recordWxml, /id="record-photo-album"[\s\S]{0,260}bindtap="chooseRecordPhoto"/);
  assert.match(recordWxml, /id="record-photo-confirm"[\s\S]{0,160}bindtap="confirmRecordPhoto"/);
  assert.match(recordWxml, /id="record-photo-cancel"[\s\S]{0,160}bindtap="cancelRecordPhoto"/);
  assert.match(recordWxml, /id="record-photo-entry"[\s\S]{0,400}bindtap="openRoutePhotoMarks"/);
  assert.ok(recordWxml.indexOf('id="record-fail"') !== -1, '未完成按钮仍在');
  assert.ok(recordWxml.indexOf('id="record-send"') !== -1, '完攀按钮仍在');
  assert.ok(recordWxml.indexOf('id="record-attempts"') !== -1, '本场本线把次仍在本页');
  // T045：现场不再有独立逐把跳转与线路历史入口，提示也不再指向它们。
  assert.equal(recordWxml.indexOf('id="open-attempts"'), -1, '现场没有独立逐把跳转');
  assert.equal(recordWxml.indexOf('id="open-route-profile"'), -1, '现场没有线路历史入口');
  assert.equal(recordWxml.indexOf('线路历史（照片 · 卡点 · 跨天历史）›'), -1);
  assert.equal(recordWxml.indexOf('线路资料'), -1, '单线页不再写「线路资料」');
  assert.equal(
    fs.readFileSync(SESSION_WXML, 'utf8').indexOf('线路资料'),
    -1,
    '场内页新建线路提示同步为「线路历史」'
  );

  const page = await openRecordPageFor(seeded.route.id, seeded.session.id);
  assert.equal(page.data.recordPhoto.status, 'none', '新线还没有照片');
  assert.equal(page.data.recordPhoto.sourceVisible, true);
  assert.equal(page.data.attempts.length, 0);

  // 选图后先预览；取消只丢掉临时路径，不写索引也不留文件。
  await page.chooseRecordPhoto(
    tapDataset({ source: 'album', routeId: seeded.route.id, archiveId })
  );
  assert.equal(page.data.recordPhoto.status, 'preview');
  assert.equal(page.data.recordPhoto.previewPath.indexOf('http://tmp/'), 0);
  page.cancelRecordPhoto(tapDataset({ routeId: seeded.route.id }));
  assert.equal(page.data.recordPhoto.status, 'none', '取消后回到没有照片');
  assert.equal(photoIndex(), null, '取消预览不写照片索引');
  assert.equal(filesUnder(USER_DATA_PATH + '/training-photos').length, 0);

  // 取消后立刻重选并确认：照片落到本机档案目录，页面读回同一张。
  await page.chooseRecordPhoto(
    tapDataset({ source: 'camera', routeId: seeded.route.id, archiveId })
  );
  assert.equal(page.data.recordPhoto.status, 'preview');
  await page.confirmRecordPhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(page.data.recordPhoto.status, 'saved');
  let index = photoIndex();
  assert.equal(index.photos.length, 1);
  assert.equal(index.photos[0].archiveId, archiveId);
  assert.equal(index.photos[0].routeId, seeded.route.id);
  assert.equal(index.photos[0].photoId, page.data.recordPhoto.photoId);
  const mainPath = page.data.recordPhoto.mainPath;
  assert.ok(virtual.files.has(mainPath), '主图落在本机');

  // 现场、历史与重开用同一档案、线路与照片 ID。
  const reopened = await openRecordPageFor(seeded.route.id, seeded.session.id);
  assert.equal(reopened.data.recordPhoto.status, 'saved');
  assert.equal(reopened.data.recordPhoto.photoId, page.data.recordPhoto.photoId);
  assert.equal(reopened.data.recordPhoto.mainPath, mainPath);
  const history = await openRoutePage(seeded.route.id);
  assert.equal(history.data.routePhoto.photoId, page.data.recordPhoto.photoId);
  assert.equal(history.data.routePhoto.mainPath, mainPath);

  // 同名 B 线：写失败不报成功，也不动 A 的照片；重试沿用同一把操作。
  const b = store.createRoute({
    sessionId: seeded.session.id,
    name: '现场 A 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(b.ok, true, b.error);
  const bPage = await openRecordPageFor(b.route.id, seeded.session.id);
  assert.equal(bPage.data.recordPhoto.status, 'none', '同名 B 线没有 A 的照片');
  faults.copyFile = true;
  await bPage.chooseRecordPhoto(
    tapDataset({ source: 'album', routeId: b.route.id, archiveId })
  );
  await bPage.confirmRecordPhoto(tapDataset({ routeId: b.route.id }));
  await settle();
  assert.equal(bPage.data.recordPhoto.status, 'failed', '写失败不报已保存');
  assert.match(bPage.data.recordPhoto.statusText, /保存失败|空间不足/);
  assert.equal(bPage.data.recordPhoto.hasPhoto, false, '失败后回到之前的状态');
  index = photoIndex();
  assert.equal(index.photos.length, 1, '失败不新增照片记录');
  assert.equal(index.photos[0].routeId, seeded.route.id, 'A 的照片没有被改写');
  assert.ok(virtual.files.has(mainPath));

  faults.copyFile = false;
  await bPage.retryRecordPhoto(tapDataset({ routeId: b.route.id }));
  await settle();
  assert.equal(bPage.data.recordPhoto.status, 'saved');
  index = photoIndex();
  assert.equal(index.photos.length, 2);
  assert.equal(index.photos.filter(photo => photo.routeId === b.route.id).length, 1);
  assert.equal(
    index.photos.filter(photo => photo.routeId === seeded.route.id).length,
    1,
    '重试只补 B 这一条'
  );
});

test('T041 同名 B 线、切档与迟到选图回调互不改写，当前线只读自己的照片', async () => {
  const seeded = seedTraining({ gymName: '我自己去的岩馆', routeName: '同名线' });
  const b = store.createRoute({
    sessionId: seeded.session.id,
    name: '同名线',
    climbType: '抱石',
    grade: 'V3'
  });
  const archiveId = archiveOf().archiveId;

  // A 页发起选图，原生回执挂起。
  const aPage = await openRecordPageFor(seeded.route.id, seeded.session.id);
  const realChooseMedia = global.wx.chooseMedia;
  let pending = null;
  global.wx.chooseMedia = options => {
    pending = options;
  };
  aPage.chooseRecordPhoto(tapDataset({ source: 'album', routeId: seeded.route.id }));
  assert.ok(pending, 'A 的照片选择已经发起');
  global.wx.chooseMedia = realChooseMedia;

  // 用户已经打开同名 B 线的记录页：A 的迟到回执不得改到 B。
  const bPage = await openRecordPageFor(b.route.id, seeded.session.id);
  pending.success({ tempFiles: [{ tempFilePath: pickerFile() }] });
  await settle();
  assert.equal(bPage.data.recordPhoto.status, 'none', 'B 页不接收 A 的迟到回执');
  assert.equal(photoIndex(), null, '只选未确认不写照片索引');
  assert.equal(aPage.data.recordPhoto.status, 'preview', '回执只落在发起它的 A 页');

  // 串线的旧事件（带着 B 的 routeId 点到 A 页）拿不到写入入口，也不改展示。
  await aPage.chooseRecordPhoto(tapDataset({ source: 'album', routeId: b.route.id }));
  assert.equal(aPage.data.recordPhoto.status, 'preview', '不属于本页线路的入口不改状态');
  aPage.cancelRecordPhoto(tapDataset({ routeId: b.route.id }));
  assert.equal(aPage.data.recordPhoto.status, 'preview', '串线入口连取消也不受理');
  aPage.cancelRecordPhoto(tapDataset({ routeId: seeded.route.id }));
  assert.equal(aPage.data.recordPhoto.status, 'none');

  // 换档：本机档案换成另一份之后，原入口不再展示，也不再受理照片写入。
  const twin = JSON.parse(rawArchive());
  twin.archiveId = 'archive-of-another-profile';
  storage.set(ARCHIVE_KEY, JSON.stringify(twin));
  aPage.onShow();
  await settle();
  assert.ok(aPage.data.contextError, '换档后原入口不再可用');
  assert.equal(aPage.data.recordPhoto, null, '不展示另一份档案里的同名照片');
  const rawAfterSwap = storage.get(ARCHIVE_KEY);
  await aPage.chooseRecordPhoto(tapDataset({ source: 'album', routeId: seeded.route.id }));
  await aPage.confirmRecordPhoto(tapDataset({ routeId: seeded.route.id }));
  await settle();
  assert.equal(storage.get(ARCHIVE_KEY), rawAfterSwap, '换档后迟到照片操作不写档案');
  assert.equal(photoIndex(), null, '换档后迟到照片操作不写索引');
});

// ------------------------------------------------------------------ *
// T048 单线逐把紧凑布局：最新完整卡与旧把短行的原生样式与绑定
// ------------------------------------------------------------------ *

/** 去掉注释后按选择器取声明块（同一选择器多次出现按 CSS 顺序合并）。 */
function t048Declarations(wxss, selector) {
  const clean = wxss.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').map(text => text.trim()).includes(selector))
    .map(match => match[2])
    .join('\n');
}

function t048MinHeight(wxss, selector) {
  const found = t048Declarations(wxss, selector).match(/min-height\s*:\s*([^;]+)/);
  return found ? found[1].trim() : '';
}

test('T048 最新卡约 100px、旧把短行约 48px：边框、结果色与时间仍在，摘要单行省略', () => {
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');

  // 高度层级：最新一把完整卡明显高于旧把次的短行（样稿参考 100px / 48px）。
  const latestHeight = t048MinHeight(wxss, '.record-attempt-latest');
  const compactHeight = t048MinHeight(wxss, '.record-attempt-compact');
  assert.equal(latestHeight, '100px', '最新一把完整卡的最低高度');
  assert.equal(compactHeight, '48px', '旧把次短行的最低高度');
  assert.ok(parseFloat(latestHeight) > parseFloat(compactHeight), '完整卡明显高于短行');

  // 短行保留独立边框与左侧结果色边缘，仍是一行一条、不靠绝对定位叠放。
  const compact = t048Declarations(wxss, '.record-attempt-compact');
  assert.match(compact, /border-left-width:\s*4px/, '短行左侧加粗的结果色边缘');
  assert.match(compact, /display:\s*flex/);
  assert.match(compact, /min-height:\s*48px/);
  assert.doesNotMatch(compact, /position\s*:\s*(absolute|fixed)/, '短行不用绝对定位');
  // 结果文字底色仍是墨绿／岩橙，短行沿用同一套。
  assert.match(t048Declarations(wxss, '.record-attempt-result-send'), /background-color:\s*#1F5948/);
  assert.match(t048Declarations(wxss, '.record-attempt-result-fail'), /background-color:\s*#B04A1C/);

  // 最新一把的长备注摘要只占一行：不换行、超出省略；展开旧把次才看全文。
  const summary = t048Declarations(wxss, '.record-attempt-note-summary');
  assert.match(summary, /white-space:\s*nowrap/);
  assert.match(summary, /overflow:\s*hidden/);
  assert.match(summary, /text-overflow:\s*ellipsis/);
  assert.match(
    wxml,
    /id="record-attempt-note-\{\{item\.id\}\}"[\s\S]{0,160}class="record-attempt-note\{\{item\.isLatest \? ' record-attempt-note-summary' : ''\}\}"/,
    '只有最新一把的备注走单行摘要样式'
  );

  // 最新/旧把的层级由数据驱动：最新一把带 record-attempt-latest，其余是短行。
  assert.match(
    wxml,
    /class="record-attempt \{\{item\.isSend \? 'record-attempt-send' : 'record-attempt-fail'\}\}[\s\S]{0,260}\{\{item\.isLatest \? ' record-attempt-latest' : ' record-attempt-older'\}\}\{\{item\.expanded \? ' record-attempt-open' : ' record-attempt-compact'\}\}"/
  );

  // 短行整行可点：带原把次 ID 与本页归属，绑定真实处理器；最新一把没有展开标记。
  assert.match(
    wxml,
    /class="record-attempt-headline\{\{item\.canToggle \? ' record-attempt-headline-toggle' : ''\}\}"[\s\S]{0,260}data-attempt-id="\{\{item\.id\}\}"[\s\S]{0,120}data-archive-id="\{\{item\.archiveId\}\}"[\s\S]{0,120}data-session-id="\{\{item\.sessionId\}\}"[\s\S]{0,120}data-route-id="\{\{item\.routeId\}\}"[\s\S]{0,80}bindtap="toggleAttemptRow"/
  );
  assert.match(
    wxml,
    /wx:if="\{\{item\.canToggle\}\}"[\s\S]{0,160}id="record-attempt-toggle-\{\{item\.id\}\}"[\s\S]{0,120}\{\{item\.expanded \? '▾' : '›'\}\}/
  );
  assert.equal(typeof recordDefinition.toggleAttemptRow, 'function', '展开/收起有真实页面方法');
});

test('T048 展开块保留原按把入口：备注全文、编辑、视频、更正与撤回/恢复都只作用于这一把', () => {
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const attemptsAt = wxml.indexOf('id="record-attempts"');
  assert.ok(attemptsAt !== -1);
  const section = wxml.slice(attemptsAt);

  // 详情都收在「这一把展开」里：备注全文、编辑、视频、注明、更正、撤回/恢复、备注编辑器。
  const expandAt = section.indexOf('wx:if="{{item.expanded}}"');
  assert.ok(expandAt !== -1, '详情按展开态渲染');
  for (const marker of [
    'id="record-attempt-note-{{item.id}}"',
    'id="edit-note-{{item.id}}"',
    'id="record-open-video-{{item.id}}"',
    'id="correct-attempt-{{item.id}}"',
    'class="record-attempt-change"',
    'id="undo-attempt-{{item.id}}"',
    'id="restore-attempt-{{item.id}}"',
    'id="note-editor"',
    'id="save-note"',
    'id="cancel-note"'
  ]) {
    assert.ok(section.indexOf(marker) > expandAt, marker + ' 在展开块里');
  }
  // 旧详情不再渲染视频关联状态文字：有片就写「回看视频」。
  assert.equal(
    wxml.indexOf('id="record-video-state-{{item.id}}"'),
    -1,
    '不再有额外的视频状态文字'
  );
  // 行首的序号、结果与时间留在短行本身，收起时仍可辨认。
  const headlineEnd = section.indexOf(expandAt);
  const headline = section.slice(0, headlineEnd);
  assert.match(headline, /id="record-attempt-label-\{\{item\.id\}\}"/);
  assert.match(headline, /record-attempt-result-send|record-attempt-result-fail/);
  assert.match(headline, /class="record-attempt-time"/);

  // 首屏记把与照片入口不被紧凑布局挤走。
  const source = fs.readFileSync(RECORD_WXML, 'utf8');
  assert.ok(source.indexOf('id="record-photo"') < source.indexOf('id="record-fail"'));
  assert.ok(source.indexOf('id="record-send"') < attemptsAt, '结果按钮仍在把次之前');
  for (const handler of new Set(handlersIn(source))) {
    assert.equal(typeof recordDefinition[handler], 'function', '单线页绑定缺少处理器：' + handler);
  }
});

// ------------------------------------------------------------------ *
// T049 最新卡与旧把详情的视频入口
// ------------------------------------------------------------------ *

test('T049 最新卡备注右侧固定视频入口，添加与回看共用同一槽位与四个原 ID', () => {
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const attemptsAt = wxml.indexOf('id="record-attempts"');
  assert.ok(attemptsAt !== -1);
  const section = wxml.slice(attemptsAt);

  // 备注与视频入口在同一个详情行：备注在左、入口靠右；无备注时入口仍靠右。
  const detailAt = section.indexOf('class="record-attempt-detail{{');
  assert.ok(detailAt !== -1, '备注与视频入口共用一个详情行');
  const actionsAt = section.indexOf('class="record-attempt-actions"', detailAt);
  const detail = section.slice(detailAt, actionsAt > detailAt ? actionsAt : detailAt + 2400);
  assert.match(detail, /id="record-attempt-note-\{\{item\.id\}\}"/, '备注仍在详情行里');
  assert.match(
    detail,
    /id="record-open-video-\{\{item\.id\}\}"[\s\S]{0,700}catchtap="openAttemptVideo"[\s\S]{0,80}\{\{item\.videoEntryText\}\}/,
    '视频入口用数据驱动的同一处文案'
  );
  for (const match of [
    /data-attempt-id="\{\{item\.id\}\}"/,
    /data-archive-id="\{\{item\.archiveId\}\}"/,
    /data-session-id="\{\{item\.sessionId\}\}"/,
    /data-route-id="\{\{item\.routeId\}\}"/
  ]) {
    assert.match(detail, match, '入口必须带齐这一行的四个原 ID：' + match);
  }
  // 添加与回看是同一个元素，只换文案：不按 hasVideo 分成两个入口。
  const entryCount = (section.match(/id="record-open-video-\{\{item\.id\}\}"/g) || []).length;
  assert.equal(entryCount, 1, '添加与回看共用同一个入口');
  assert.doesNotMatch(detail, /wx:if="\{\{item\.hasVideo\}\}"/, '不按有片与否拆出第二个按钮');
  // 最新一把与旧把都只显示动作本身：有片就写「回看视频」，不再另挂关联状态文字。
  assert.doesNotMatch(section, /record-video-state/, '展开详情里没有多余的视频状态文字');

  // 收起态只有一个小视频图标，且只在展开块之外的整行里；入口本身只在展开块里。
  const firstExpandAt = section.indexOf('wx:if="{{item.expanded}}"');
  assert.ok(firstExpandAt > 0);
  assert.ok(detailAt > firstExpandAt, '视频入口在展开块内');
  assert.match(
    section.slice(0, firstExpandAt),
    /wx:if="\{\{item\.showVideoIcon\}\}"[\s\S]{0,120}id="record-attempt-video-icon-\{\{item\.id\}\}"[\s\S]{0,80}>▶</,
    '旧行收起态的图标由 showVideoIcon 驱动'
  );
  const iconId = section.indexOf('id="record-attempt-video-icon-{{item.id}}"');
  assert.doesNotMatch(
    section.slice(iconId - 200, iconId + 200),
    /bindtap|catchtap/,
    '图标只作提示，点按仍由整行展开原把'
  );

  // 同一行的布局：备注可压缩，入口靠右、不换行，两态位置一致。
  assert.match(t048Declarations(wxss, '.record-attempt-detail'), /display:\s*flex/);
  assert.match(
    t048Declarations(wxss, '.record-attempt-detail .record-attempt-note'),
    /min-width:\s*0/,
    '长备注在入口左侧压缩省略'
  );
  assert.match(t048Declarations(wxss, '.record-attempt-video'), /margin-left:\s*auto/);
  assert.match(t048Declarations(wxss, '.record-attempt-video'), /flex:\s*none/);
  assert.match(t048Declarations(wxss, '.record-attempt-video-icon'), /border/, '图标有可见边框');
});

// ------------------------------------------------------------------ *
// T048 返工：旧把就地备注编辑区与两行输入高度
// ------------------------------------------------------------------ *

test('T048 旧把备注：编辑区紧跟头部替换操作行，输入约两行，取消/保存紧随其后', () => {
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const attemptsAt = wxml.indexOf('id="record-attempts"');
  assert.ok(attemptsAt !== -1);
  const section = wxml.slice(attemptsAt);

  const expandAt = section.indexOf('wx:if="{{item.expanded}}"');
  const editorAt = section.indexOf('id="note-editor"');
  const detailAt = section.indexOf('class="record-attempt-detail{{');
  assert.ok(expandAt > 0, '展开块起点');
  assert.ok(editorAt > expandAt, '备注编辑区在展开块里');
  assert.ok(detailAt > editorAt, '编辑区紧接头部，排在平常态详情之前');
  // 编辑区与平常态详情互斥：同一把不会同时出现原正文、操作行与输入框。
  assert.match(
    section.slice(editorAt - 200, detailAt),
    /wx:if="\{\{noteEditor && noteEditor\.attemptId === item\.id\}\}"[\s\S]*<block wx:else>/,
    '打开编辑时替换原来的详情操作行'
  );

  // 输入框：微信原生 textarea 的 150px 默认高度由行内 height 覆盖为约两行，长内容框内滚动。
  const inputAt = section.indexOf('id="note-input"');
  assert.ok(inputAt > editorAt);
  const input = section.slice(inputAt - 320, inputAt + 520);
  assert.match(input, /class="note-input"/);
  assert.match(input, /style="height: 132rpx;"/, '行内高度覆盖原生 150px 默认值');
  assert.match(input, /cursor-spacing="24"/, '软键盘弹出时输入框与键盘留出间距');
  assert.match(input, /data-attempt-id="\{\{noteEditor\.attemptId\}\}"/, '输入框绑定打开时的那一把');
  assert.match(input, /data-edit-version="\{\{noteEditor\.version\}\}"/, '输入框绑定本次编辑代次');
  assert.match(input, /bindinput="onNoteInput"/);
  const noteCss = t048Declarations(wxss, '.note-input');
  assert.match(noteCss, /min-height:\s*0/, '旧的 140rpx 最小高度已让位给行内约两行高度');
  assert.doesNotMatch(noteCss, /min-height:\s*140rpx/);

  // 「取消」「保存备注」紧跟输入框下方，保留常用点按目标。
  const cancelAt = section.indexOf('id="cancel-note"');
  const saveAt = section.indexOf('id="save-note"');
  assert.ok(cancelAt > inputAt, '取消在输入框之后');
  assert.ok(saveAt > cancelAt, '保存备注与取消同排、紧随其后');
  assert.match(section.slice(inputAt, saveAt + 200), /class="button-row"/);
  assert.equal(
    t048MinHeight(wxss, '.primary-button'),
    '44px',
    '保存备注保留 44px 常用点按高度'
  );
  assert.equal(t048MinHeight(wxss, '.secondary-button'), '44px', '取消保留 44px 常用点按高度');

  // 旧把平常态：备注正文在上，下一行同排备注入口与视频入口，不换行也不互相覆盖。
  const olderCss = t048Declarations(wxss, '.record-attempt-detail-older');
  assert.match(olderCss, /flex-direction:\s*column/);
  const olderActionsCss = t048Declarations(
    wxss,
    '.record-attempt-detail-older .record-attempt-detail-actions'
  );
  assert.match(olderActionsCss, /width:\s*100%/);
  assert.match(olderActionsCss, /justify-content:\s*space-between/);
  assert.match(olderActionsCss, /margin-left:\s*0/);
  assert.match(olderActionsCss, /flex-wrap:\s*nowrap/);
  assert.match(
    t048Declarations(wxss, '.record-attempt-detail-older .record-attempt-edit'),
    /white-space:\s*nowrap/
  );
  // 旧行有备注才显示原正文；无备注不渲染空的备注节点。
  assert.match(
    section,
    /wx:if="\{\{item\.hasNote\}\}"\s*id="record-attempt-note-\{\{item\.id\}\}"/,
    '备注正文由 hasNote 决定是否渲染'
  );
  // 未完成旧行不留空纠错槽：整块纠错区由页面派生 showFix 控制。
  assert.match(
    section,
    /wx:if="\{\{item\.showFix\}\}"\s*class="record-attempt-fix"/,
    '纠错区只在真有内容时渲染'
  );
  assert.match(
    section,
    /wx:if="\{\{item\.showCorrectionSlot\}\}"\s*class="record-attempt-correct-slot"/,
    '更正槽只在真有动作/回读/说明时渲染'
  );
});
