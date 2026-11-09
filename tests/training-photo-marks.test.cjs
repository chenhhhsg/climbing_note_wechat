/**
 * T028「照片标记卡点」离线回归测试
 *
 * 直接加载真实的 utils/training-photo-marks.js 与正式线路详情页
 * （pages/training-route），用隔离的微信本地存储替身、显示框/图片尺寸替身与写入故障
 * 注入驱动真实处理器，并核对 WXML 里的真实绑定。
 *
 * 覆盖三条验收：
 * 1) 同一张图左右各加一条提示，保存、重开、换显示大小后仍落在原图对应点；横图、竖图
 *    与留白的坐标换算；点击留白不生成点；已知点像素对照偏差在 5 个显示逻辑像素内。
 * 2) 移动一处、改字、删除一处，另一处位置与文字保持原值；A/B 同色线路与不同照片的
 *    标记各自独立；取消更换保留原标记，确认换图后旧点不叠在新图上。
 * 3) 无图、原图缺失、写失败与迟到回调都有可见处理；离线与普通清缓存后仍能重开已保存
 *    标记；标记操作前后主图字节、把次、备注与自测原值逐字节一致。
 *
 * 刻意不提供 wx.cloud：标记层与页面都不得依赖云能力，也不上传任何照片或标记。
 * 真实手机字体、日光对比度、真实触控落点与跨天实际使用留给负责人整体验收（待验）。
 *
 * 运行：node --test tests/training-photo-marks.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const MARKS_JS = path.join(ROOT, 'utils', 'training-photo-marks.js');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const ROUTE_WXSS = path.join(ROOT, 'pages', 'training-route', 'training-route.wxss');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const MARKS_KEY = 'climbingNote.training.v1.photo-marks';
const FITNESS_KEY = 'climbingNote.fitness.v1.records';
const LEGACY_KEY = 'trialProject.records';

const STAGE = '#route-photo-stage';
const PHOTO_MAIN = '/tmp/photo-1.jpg';
const PHOTO_MAIN_2 = '/tmp/photo-2.jpg';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入写入故障 ----
const storage = new Map();
const keyWrites = new Map();
const fault = { setFailAt: 0, setAfterAt: 0, setCount: 0, getFail: false };

// ---- 显示框与图片尺寸替身：由测试按用例给出，页面只读取 ----
const geometry = {
  rects: {},
  images: {},
  deferImageInfo: false,
  pendingImage: [],
  deferModal: false,
  pendingModals: [],
  modalConfirm: true
};

function resetDevice() {
  storage.clear();
  keyWrites.clear();
  fault.setFailAt = 0;
  fault.setAfterAt = 0;
  fault.setCount = 0;
  fault.getFail = false;
  geometry.rects = { [STAGE]: { left: 20, top: 300, width: 375, height: 420 } };
  geometry.images = { [PHOTO_MAIN]: { width: 1600, height: 1200 } };
  geometry.deferImageInfo = false;
  geometry.pendingImage = [];
  geometry.deferModal = false;
  geometry.pendingModals = [];
  geometry.modalConfirm = true;
  wxLog.navigations = [];
  wxLog.toasts = [];
}

function setStageRect(rect) {
  geometry.rects[STAGE] = Object.assign({ left: 20, top: 300 }, rect);
}

function setImageSize(src, width, height) {
  geometry.images[src] = { width, height };
}

/** 从第 N 次 setStorageSync 开始失败：用于构造「落盘失败」与「写失败后重试」。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

/**
 * 从第 N 次 setStorageSync 起「先落盘、再抛错」：构造写成功但回执丢失
 * （存储层随后抛异常）的情形——这次落点其实已经持久化，页面却看到失败。
 */
function armSetFailAfter(callNumber) {
  fault.setCount = 0;
  fault.setAfterAt = callNumber;
}

function disarmSetFail() {
  fault.setCount = 0;
  fault.setFailAt = 0;
  fault.setAfterAt = 0;
}

function writesOf(key) {
  return keyWrites.get(key) || 0;
}

function rawOf(key) {
  return storage.has(key) ? storage.get(key) : '';
}

function flushModal() {
  const pending = geometry.pendingModals.shift();
  if (!pending) return false;
  if (typeof pending.options.success === 'function') pending.options.success(pending.result);
  return true;
}

function flushImageInfo() {
  const pending = geometry.pendingImage.slice();
  geometry.pendingImage = [];
  pending.forEach(deliver => deliver());
  return pending.length;
}

const wxLog = { navigations: [], toasts: [] };

global.wx = {
  getStorageSync(key) {
    if (fault.getFail) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    keyWrites.set(key, writesOf(key) + 1);
    storage.set(key, value);
    // 写成功了但回执丢失：存储层随后抛错，调用方看到的仍是失败。
    if (fault.setAfterAt && fault.setCount === fault.setAfterAt) {
      throw new Error('setStorageSync:ack-lost injected at call ' + fault.setCount);
    }
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo(options) {
    wxLog.navigations.push(options.url);
  },
  switchTab() {},
  showToast(options) {
    wxLog.toasts.push(options);
  },
  showModal(options) {
    const result = { confirm: geometry.modalConfirm, cancel: !geometry.modalConfirm };
    if (geometry.deferModal) {
      geometry.pendingModals.push({ options, result });
      return;
    }
    if (options && typeof options.success === 'function') options.success(result);
  },
  // 页面读取照片显示区矩形：与真实选择器同一形状（in / select / boundingClientRect / exec）。
  createSelectorQuery() {
    const query = {
      selector: '',
      callback: null,
      in() {
        return query;
      },
      select(selector) {
        query.selector = selector;
        return query;
      },
      boundingClientRect(callback) {
        query.callback = callback;
        return query;
      },
      exec() {
        const rect = geometry.rects[query.selector];
        if (typeof query.callback === 'function') {
          query.callback(rect ? Object.assign({}, rect) : null);
        }
      }
    };
    return query;
  },
  // 页面读取原图实际尺寸：aspectFit 用的就是这里的宽高。
  getImageInfo(options) {
    const src = options && options.src;
    const info = geometry.images[src];
    const deliver = () => {
      if (info) {
        if (typeof options.success === 'function') {
          options.success({ width: info.width, height: info.height, path: src });
        }
        return;
      }
      if (typeof options.fail === 'function') options.fail({ errMsg: 'getImageInfo:fail' });
    };
    if (geometry.deferImageInfo) {
      geometry.pendingImage.push(deliver);
      return;
    }
    deliver();
  },
  previewImage() {}
};

const store = require(STORE_JS);
const marks = require(MARKS_JS);

// 捕获原生 Page(...) 定义
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

const routeDefinition = capturePage(ROUTE_JS);

/** 页面实例替身：支持 wx 的 setData 数据路径写法。 */
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

async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function stageLocal(tap, rect) {
  return { x: tap.x - rect.left, y: tap.y - rect.top };
}

/** 以页面坐标（与 boundingClientRect 同坐标系）构造一次点击。 */
function tapAtPage(x, y) {
  return { changedTouches: [{ clientX: x, clientY: y }] };
}

function tapAt(localX, localY) {
  const rect = geometry.rects[STAGE];
  return tapAtPage(rect.left + localX, rect.top + localY);
}

// ---- 照片控制器替身：只回答当前展示状态，不改任何文件或索引 ----
function savedPhotoView(photoId, mainPath) {
  return {
    status: 'saved',
    photoId,
    mainPath,
    hasPhoto: true,
    missing: false,
    thumbnailAvailable: false,
    thumbnailPath: '',
    bytesText: '主图 100 KB',
    statusText: '照片保存在本机'
  };
}

function missingPhotoView(photoId) {
  return {
    status: 'missing',
    photoId: photoId || '',
    mainPath: '',
    hasPhoto: false,
    missing: true,
    thumbnailPath: '',
    statusText: '本机照片不可用，可重新添加'
  };
}

function noPhotoView() {
  return {
    status: 'none',
    photoId: '',
    mainPath: '',
    hasPhoto: false,
    missing: false,
    thumbnailPath: '',
    statusText: '添加线路照片（可选，可稍后添加）'
  };
}

function photoUi(initial) {
  const state = { view: initial || noPhotoView() };
  return {
    init: () => Promise.resolve({ ok: true }),
    load: () => Promise.resolve(),
    clear: () => {},
    preview: () => {},
    view: () => state.view,
    set(view) {
      state.view = view;
    }
  };
}

/**
 * 打开详情页：onLoad 会重建照片控制器，因此在 onLoad 之后换成只回答展示状态的替身，
 * 再按最新档案重算页面（含照片与卡点），与 T027 测试里的做法一致。
 */
async function openRoutePage(routeId, view) {
  const ui = photoUi(view);
  const page = createPage(routeDefinition);
  page.onLoad({ routeId });
  page._photoUi = ui;
  page.refreshView();
  page.applyPhotoView();
  await settle();
  return { page, ui };
}

// ---- 走正式档案层搭建夹具（标记只读档案，页面只读档案） ----
function startAt(date, gymName) {
  const started = store.startSession({
    gymName,
    date,
    now: new Date(date + 'T09:30:00')
  });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function newRoute(session, options = {}) {
  const created = store.createRoute({
    sessionId: session.id,
    name: options.name || '蓝色动态线',
    climbType: options.climbType || '抱石',
    grade: options.grade || 'V3',
    colorName: options.colorName || '蓝色',
    colorHex: options.colorHex || '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function record(session, route, result, note, at) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note: note || '',
    now: at ? new Date(at) : undefined
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveOf() {
  return store.loadState().archive;
}

function archiveIdOf() {
  return archiveOf().archiveId;
}

function targetOf(routeId, photoId) {
  return { archiveId: archiveIdOf(), routeId, photoId };
}

function listedMarks(routeId, photoId) {
  const listed = marks.listMarks(targetOf(routeId, photoId));
  assert.equal(listed.ok, true, listed.error);
  return listed.marks;
}

function storedMarks() {
  const raw = rawOf(MARKS_KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  resetDevice();
});

// ================================================================== *
// 一、坐标换算：横图、竖图、留白与 5 个显示逻辑像素内的偏差
// ================================================================== *

test('T028 横图在竖向显示框里：左右两条提示的往返偏差在 5 个显示逻辑像素内', () => {
  const rect = geometry.rects[STAGE];
  const image = { width: 1600, height: 1200 };
  const layout = marks.imageLayout({
    imageWidth: image.width,
    imageHeight: image.height,
    viewWidth: rect.width,
    viewHeight: rect.height
  });
  assert.equal(layout.ok, true, layout.error);
  // 横图在 375×420 的框里是整宽、上下留白。
  assert.ok(Math.abs(layout.drawWidth - 375) < 1e-9);
  assert.ok(Math.abs(layout.drawHeight - 281.25) < 1e-9);
  assert.equal(layout.offsetX, 0);
  assert.ok(Math.abs(layout.offsetY - 69.375) < 1e-9);

  // 已知岩点：原图左侧 (320,480)、右侧 (1280,720)。
  const known = [
    { name: '左侧脚点', px: 320, py: 480, local: { x: 75, y: 181.875 } },
    { name: '右侧手点', px: 1280, py: 720, local: { x: 300, y: 238.125 } }
  ];
  known.forEach(spot => {
    const outcome = marks.markPointFromTap(
      tapAt(spot.local.x, spot.local.y),
      rect,
      image
    );
    assert.equal(outcome.ok, true, spot.name + '：' + outcome.error);

    // 存下来的位置换回显示框后仍落在原点，偏差在 5 个显示逻辑像素内。
    const back = marks.imageToScreen(outcome.point, layout);
    assert.ok(
      distance(back, spot.local) <= 5,
      spot.name + ' 显示偏差 ' + distance(back, spot.local).toFixed(3) + ' 像素'
    );
    // 与原图已知像素对照同样在 5 像素内。
    const original = marks.originalPixelOf(outcome.point, image);
    assert.ok(
      distance(original, { x: spot.px, y: spot.py }) <= 5,
      spot.name + ' 原图像素偏差 ' + distance(original, { x: spot.px, y: spot.py }).toFixed(3)
    );
  });
});

test('T028 竖图在横向显示框里：左右留白也算得准，偏差在 5 个显示逻辑像素内', () => {
  setStageRect({ width: 560, height: 420 });
  const rect = geometry.rects[STAGE];
  const image = { width: 1200, height: 1600 };
  const layout = marks.imageLayout({
    imageWidth: image.width,
    imageHeight: image.height,
    viewWidth: rect.width,
    viewHeight: rect.height
  });
  assert.equal(layout.ok, true, layout.error);
  // 竖图是整高、左右留白。
  assert.ok(Math.abs(layout.drawHeight - 420) < 1e-9);
  assert.ok(Math.abs(layout.drawWidth - 315) < 1e-9);
  assert.equal(layout.offsetY, 0);
  assert.ok(Math.abs(layout.offsetX - 122.5) < 1e-9);

  const known = [
    { px: 240, py: 400 },
    { px: 960, py: 1200 }
  ];
  known.forEach(spot => {
    const rel = { x: spot.px / image.width, y: spot.py / image.height };
    const local = marks.imageToScreen(rel, layout);
    const outcome = marks.markPointFromTap(
      tapAtPage(rect.left + local.x, rect.top + local.y),
      rect,
      image
    );
    assert.equal(outcome.ok, true, outcome.error);
    const back = marks.imageToScreen(outcome.point, layout);
    assert.ok(distance(back, local) <= 5, '竖图显示偏差 ' + distance(back, local).toFixed(3));
    const original = marks.originalPixelOf(outcome.point, image);
    assert.ok(distance(original, { x: spot.px, y: spot.py }) <= 5);
  });

  // 竖图两侧的留白：点在照片外，不生成标记。
  [
    { x: 40, y: 200, where: '左侧留白' },
    { x: 500, y: 200, where: '右侧留白' }
  ].forEach(spread => {
    const outcome = marks.markPointFromTap(tapAt(spread.x, spread.y), rect, image);
    assert.equal(outcome.ok, false, spread.where + ' 不应生成标记');
    assert.equal(outcome.reason, 'letterbox');
  });
  // 留白边界恰好落在照片边缘：可以落点。
  const edge = marks.markPointFromTap(tapAt(122.5, 210), rect, image);
  assert.equal(edge.ok, true, edge.error);
  assert.ok(edge.point.x <= 1e-9, '照片左边缘对应 x=0');
});

test('T028 点击照片外的留白不生成点：上下留白与框外都算留白', () => {
  const rect = geometry.rects[STAGE];
  const image = { width: 1600, height: 1200 };
  const outside = [
    { x: 100, y: 10, where: '上方留白' },
    { x: 100, y: 400, where: '下方留白' },
    { x: 100, y: 0, where: '框上边' },
    { x: 100, y: 420, where: '框下边' }
  ];
  outside.forEach(spot => {
    const outcome = marks.markPointFromTap(tapAt(spot.x, spot.y), rect, image);
    assert.equal(outcome.ok, false, spot.where + ' 不应生成标记');
    assert.equal(outcome.reason, 'letterbox');
    assert.match(outcome.error, /留白/);
  });
  // 上下留白边界内即可落点。
  const inside = marks.markPointFromTap(tapAt(100, 69.375), rect, image);
  assert.equal(inside.ok, true, inside.error);
  assert.ok(Math.abs(inside.point.y) < 1e-9, '照片上边缘对应 y=0');
});

test('T028 换显示大小后仍落在原图同一个点（换屏、旋转、换缩略图同一份标记）', () => {
  const image = { width: 1600, height: 1200 };
  const rel = { x: 0.2, y: 0.4 };
  const known = { x: 320, y: 480 };

  const before = marks.imageLayout({ imageWidth: 1600, imageHeight: 1200, viewWidth: 375, viewHeight: 420 });
  const after = marks.imageLayout({ imageWidth: 1600, imageHeight: 1200, viewWidth: 300, viewHeight: 520 });
  assert.notEqual(before.drawHeight, after.drawHeight, '两个显示框的绘制尺寸应不同');

  const screenBefore = marks.imageToScreen(rel, before);
  const screenAfter = marks.imageToScreen(rel, after);
  // 显示框内的像素位置变了，但换回原图都是同一个已知点。
  assert.ok(distance(screenBefore, screenAfter) > 5, '换大小后显示位置应发生变化');
  assert.ok(distance(marks.originalPixelOf(rel, image), known) <= 5);
  assert.ok(distance(marks.originalPixelOf(marks.screenToImage(screenBefore, before), image), known) <= 5);
  assert.ok(distance(marks.originalPixelOf(marks.screenToImage(screenAfter, after), image), known) <= 5);
});

test('T028 读不到点击/尺寸时给出可判别原因，不生成点', () => {
  const rect = geometry.rects[STAGE];
  const image = { width: 1600, height: 1200 };

  const noPoint = marks.markPointFromTap({}, rect, image);
  assert.equal(noPoint.reason, 'no-point');

  const noImage = marks.markPointFromTap(tapAt(100, 200), rect, {});
  assert.equal(noImage.reason, 'no-image');

  const noSize = marks.markPointFromTap(tapAt(100, 200), null, image);
  assert.equal(noSize.reason, 'no-size');

  // detail 兜底：没有触摸点时用 detail.x/y，仍按同一坐标系换算。
  const viaDetail = marks.markPointFromTap({ detail: { x: rect.left + 75, y: rect.top + 181.875 } }, rect, image);
  assert.equal(viaDetail.ok, true, viaDetail.error);
  assert.ok(Math.abs(viaDetail.point.x - 0.2) < 1e-9);
  assert.ok(Math.abs(viaDetail.point.y - 0.4) < 1e-9);
});

// ================================================================== *
// 二、存储：稳定 ID、重开、损坏与写失败
// ================================================================== *

test('T028 首次没有标记键：返回空标记、不报错也不落盘', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);

  const loaded = marks.loadMarks();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.present, false);
  assert.deepEqual(loaded.state.marks, []);

  const listed = marks.listMarks(targetOf(route.id, 'photo-1'));
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.marks, []);
  assert.equal(rawOf(MARKS_KEY), '', '只读不应产生标记键');
});

test('T028 同一张图两条标记：ID 稳定、按序号升序、重开后位置一致', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);

  const first = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    kind: 'foot',
    text: '左脚踩这里',
    now: new Date('2026-11-09T10:00:00')
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.code, 'added');
  assert.equal(first.mark.markId, 'mark-1', 'ID 必须稳定可预期');

  const second = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.8,
    y: 0.6,
    kind: 'hand',
    text: '右手抓这个点',
    now: new Date('2026-11-09T10:05:00')
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.mark.markId, 'mark-2');

  const before = listedMarks(route.id, 'photo-1');
  assert.deepEqual(before.map(mark => mark.markId), ['mark-1', 'mark-2']);
  assert.deepEqual(before.map(mark => mark.kind), ['foot', 'hand']);
  assert.deepEqual(before.map(mark => [mark.x, mark.y]), [[0.2, 0.4], [0.8, 0.6]]);

  // 重新加载模块＝重新启动小程序：标记只从本机存储读取，不依赖内存状态。
  delete require.cache[require.resolve(MARKS_JS)];
  const reopened = require(MARKS_JS);
  const after = reopened.listMarks(targetOf(route.id, 'photo-1'));
  assert.equal(after.ok, true, after.error);
  assert.deepEqual(
    after.marks.map(mark => [mark.markId, mark.x, mark.y, mark.kind, mark.text]),
    before.map(mark => [mark.markId, mark.x, mark.y, mark.kind, mark.text])
  );
  assert.equal(reopened.MARKS_KEY, MARKS_KEY);
});

test('T028 标记损坏或版本不受支持：可见报错、保留原数据、写入口一律拒绝', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const broken = '{ not-json';
  storage.set(MARKS_KEY, broken);

  const loaded = marks.loadMarks();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.corrupt, true);
  assert.match(loaded.error, /损坏/);

  const listed = marks.listMarks(targetOf(route.id, 'photo-1'));
  assert.equal(listed.ok, false);
  assert.match(listed.error, /损坏/);

  const added = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.5,
    y: 0.5,
    text: '不应写进去'
  });
  assert.equal(added.ok, false);
  assert.equal(added.code, 'unreadable');
  assert.equal(marks.removeMark('mark-1').code, 'unreadable');
  assert.equal(marks.updateMark({ markId: 'mark-1', text: 'x' }).code, 'unreadable');
  assert.equal(rawOf(MARKS_KEY), broken, '损坏时不得覆盖原标记');

  const unsupported = JSON.stringify({ version: 99, nextMarkSeq: 1, marks: [] });
  storage.set(MARKS_KEY, unsupported);
  assert.equal(marks.loadMarks().ok, false);
  assert.match(marks.loadMarks().error, /版本不受支持/);
  assert.equal(marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.5,
    y: 0.5
  }).code, 'unreadable');
  assert.equal(rawOf(MARKS_KEY), unsupported);

  // 结构损坏（位置越界 / 序号重复）同样按损坏处理。
  const badPoint = JSON.stringify({
    version: 1,
    nextMarkSeq: 2,
    marks: [
      {
        markId: 'mark-1',
        seq: 1,
        archiveId: archiveIdOf(),
        routeId: route.id,
        photoId: 'photo-1',
        kind: 'foot',
        x: 1.5,
        y: 0.2,
        text: '',
        createdAt: '2026-11-09T10:00:00.000Z'
      }
    ]
  });
  storage.set(MARKS_KEY, badPoint);
  assert.equal(marks.loadMarks().ok, false);
  assert.equal(rawOf(MARKS_KEY), badPoint);
});

test('T028 读取本身失败时返回可判别错误而不是崩溃', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  fault.getFail = true;
  const loaded = marks.loadMarks();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.present, false);
  assert.match(loaded.error, /读取照片卡点标记失败/);
  assert.equal(
    marks.addMark({ archiveId: archiveIdOf(), routeId: route.id, photoId: 'photo-1', x: 0.5, y: 0.5 }).code,
    'unreadable'
  );
  fault.getFail = false;
});

test('T028 写失败不报已保存：序号不消耗，重试拿到同一个稳定 ID', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);

  armSetFailAt(1);
  const failed = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  assert.match(failed.error, /保存照片卡点标记失败/);
  assert.equal(rawOf(MARKS_KEY), '', '落盘失败时不应留下半条记录');
  assert.deepEqual(listedMarks(route.id, 'photo-1'), []);

  disarmSetFail();
  const retried = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.mark.markId, 'mark-1', '重试应复用同一个稳定 ID');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
});

test('T028 同一次落点以 opId 幂等：写成功后回执丢失的重试只留一条，同坐标的另一份草稿仍是两条', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const spot = {
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '定位同一次落点'
  };

  // 写之前就失败：不留半条，也不消耗序号。
  armSetFailAt(1);
  const beforeWrite = marks.addMark(Object.assign({ opId: 'op-lost' }, spot));
  assert.equal(beforeWrite.ok, false);
  assert.equal(beforeWrite.code, 'write-failed');
  assert.equal(rawOf(MARKS_KEY), '', '写前失败不得留下半条');
  disarmSetFail();

  // 写成功了但回执丢失：存储层随后抛错，页面看到失败；这条其实已经落盘。
  armSetFailAfter(1);
  const lostAck = marks.addMark(Object.assign({ opId: 'op-lost' }, spot));
  assert.equal(lostAck.ok, false, '回执丢失时仍如实报失败，不假报已保存');
  assert.equal(lostAck.code, 'write-failed');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '这次其实已经落盘');
  disarmSetFail();

  // 同一次落点再点一次保存：复用已落盘的那条，不新建。
  const retried = marks.addMark(Object.assign({ opId: 'op-lost' }, spot));
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.code, 'duplicate', '同一次落点重试复用已落盘的那条');
  assert.equal(retried.mark.markId, 'mark-1');
  assert.equal(retried.mark.opId, 'op-lost', '标记记下这次落点的客户端操作身份');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '重试不得把一次落点写成两条');

  // 另一份草稿：位置与文字完全相同，但它是另一次落点，成为独立的一条。
  const another = marks.addMark(Object.assign({ opId: 'op-second' }, spot));
  assert.equal(another.ok, true, another.error);
  assert.equal(another.code, 'added');
  assert.equal(another.mark.markId, 'mark-2');
  assert.equal(listedMarks(route.id, 'photo-1').length, 2, '不同草稿即使同坐标也各自成一条');

  // 同一 opId 带着别的照片归回来：按冲突拒绝，不覆盖也不新建。
  const conflict = marks.addMark(Object.assign({ opId: 'op-second' }, spot, { photoId: 'photo-2' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'op-conflict');
  assert.deepEqual(listedMarks(route.id, 'photo-2'), [], '冲突时不得写到别的照片上');
  assert.equal(listedMarks(route.id, 'photo-1').length, 2, '原照片上的两条都不受影响');
  assert.equal(storedMarks().nextMarkSeq, 3);

  // 被拒绝的写入不消耗序号，也不改已落盘的字节。
  const beforeRejected = rawOf(MARKS_KEY);
  armSetFailAt(1);
  assert.equal(marks.addMark(Object.assign({ opId: 'op-third' }, spot)).code, 'write-failed');
  disarmSetFail();
  assert.equal(rawOf(MARKS_KEY), beforeRejected, '失败与拒绝都不得改动已落盘的标记');
  assert.equal(storedMarks().nextMarkSeq, 3);
  assert.equal(listedMarks(route.id, 'photo-1').length, 2);
});

test('T028 没有 opId 的旧记录照常读回，写入时缺 opId 也不当重试', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const where = { archiveId: archiveIdOf(), routeId: route.id, photoId: 'photo-1' };

  // 旧版本写下的记录没有 opId 字段：读取时按空串补齐，位置与文字照旧。
  storage.set(
    MARKS_KEY,
    JSON.stringify({
      version: 1,
      nextMarkSeq: 2,
      marks: [
        {
          markId: 'mark-1',
          seq: 1,
          archiveId: archiveIdOf(),
          routeId: route.id,
          photoId: 'photo-1',
          kind: 'foot',
          x: 0.2,
          y: 0.4,
          text: '旧记录',
          createdAt: '2026-11-09T10:00:00.000Z'
        }
      ]
    })
  );
  const listed = listedMarks(route.id, 'photo-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].text, '旧记录');
  assert.equal(listed[0].opId, '');

  // 没有 opId 的两次新建（旧页面、直接调用）不做去重，仍是各自独立的两条。
  const first = marks.addMark(Object.assign({ x: 0.5, y: 0.5, text: 'a' }, where));
  const second = marks.addMark(Object.assign({ x: 0.5, y: 0.5, text: 'a' }, where));
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(listedMarks(route.id, 'photo-1').length, 3);
});

test('T028 位置不在照片上或归属不完整时拒绝新建，不落盘', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);

  const badPoint = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 1.4,
    y: 0.4
  });
  assert.equal(badPoint.ok, false);
  assert.equal(badPoint.code, 'invalid-point');

  const noPhoto = marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: '',
    x: 0.5,
    y: 0.5
  });
  assert.equal(noPhoto.ok, false);
  assert.equal(noPhoto.code, 'invalid-target');

  assert.equal(rawOf(MARKS_KEY), '', '被拒绝时不应落盘');
});

// ================================================================== *
// 三、编辑隔离：移动、改字、删除各只影响这一条
// ================================================================== *

test('T028 移动一处、改字、删除一处，另一处位置与文字保持原值', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const where = {
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1'
  };
  const first = marks.addMark(Object.assign({ x: 0.2, y: 0.4, kind: 'foot', text: '左脚踩这里' }, where));
  const second = marks.addMark(Object.assign({ x: 0.8, y: 0.6, kind: 'hand', text: '右手抓这个点' }, where));
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);

  // 移动第一条：只有它换位置。
  const moved = marks.moveMark({ markId: first.mark.markId, x: 0.25, y: 0.45 });
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.code, 'updated');
  assert.equal(moved.mark.text, '左脚踩这里', '移动不改文字');
  let listed = listedMarks(route.id, 'photo-1');
  assert.deepEqual([listed[0].x, listed[0].y], [0.25, 0.45]);
  assert.deepEqual([listed[1].x, listed[1].y], [0.8, 0.6], '另一处位置不变');
  assert.equal(listed[1].text, '右手抓这个点', '另一处文字不变');

  // 改字（含换手法/脚法）：只有第一条。
  const edited = marks.updateMark({ markId: first.mark.markId, text: '起步左脚踩这里', kind: 'hand' });
  assert.equal(edited.ok, true, edited.error);
  assert.equal(edited.code, 'updated');
  assert.deepEqual([edited.mark.x, edited.mark.y], [0.25, 0.45], '改字不改位置');
  listed = listedMarks(route.id, 'photo-1');
  assert.equal(listed[0].text, '起步左脚踩这里');
  assert.equal(listed[0].kind, 'hand');
  assert.equal(listed[1].text, '右手抓这个点');
  assert.equal(listed[1].kind, 'hand');

  // 内容没变时不重复写盘（迟到回调/重复保存幂等）。
  const writes = writesOf(MARKS_KEY);
  const again = marks.updateMark({ markId: second.mark.markId, text: '右手抓这个点' });
  assert.equal(again.ok, true);
  assert.equal(again.code, 'unchanged');
  assert.equal(again.duplicate, true);
  assert.equal(writesOf(MARKS_KEY), writes, '内容相同不应再次落盘');

  // 删除第一条：第二条位置与文字保持原值。
  const removed = marks.removeMark(first.mark.markId);
  assert.equal(removed.ok, true);
  assert.equal(removed.code, 'removed');
  listed = listedMarks(route.id, 'photo-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].markId, second.mark.markId);
  assert.deepEqual([listed[0].x, listed[0].y], [0.8, 0.6]);
  assert.equal(listed[0].text, '右手抓这个点');

  // 删除幂等：再删一次不写盘。
  const writesAfterRemove = writesOf(MARKS_KEY);
  const removeAgain = marks.removeMark(first.mark.markId);
  assert.equal(removeAgain.ok, true);
  assert.equal(removeAgain.code, 'absent');
  assert.equal(removeAgain.removed, false);
  assert.equal(writesOf(MARKS_KEY), writesAfterRemove);

  // 改一条已删除的：幂等拒绝，不新建。
  const missing = marks.updateMark({ markId: first.mark.markId, text: '不该出现' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);

  // 删除时落盘失败：这条还在，别的也不动。
  armSetFailAt(1);
  const failedRemove = marks.removeMark(second.mark.markId);
  assert.equal(failedRemove.ok, false);
  assert.equal(failedRemove.code, 'write-failed');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
  disarmSetFail();
});

// ================================================================== *
// 四、归属独立：同色线路、不同照片、不同档案
// ================================================================== *

test('T028 同色同级的 A、B 两条线各自保存标记，绝不互相出现', () => {
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  const sessionB = startAt('2026-11-09', 'B 馆');
  const routeB = newRoute(sessionB, { name: '蓝色动态线', grade: 'V3' });
  assert.notEqual(routeA.id, routeB.id, '同色同级也各有独立线路 ID');

  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: routeA.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: 'A 馆这条线的脚点'
  });

  assert.equal(listedMarks(routeA.id, 'photo-1').length, 1);
  assert.deepEqual(listedMarks(routeB.id, 'photo-1'), [], 'B 馆的线不应出现 A 馆的标记');
  assert.equal(listedMarks(routeB.id, 'photo-1').length, 0);

  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: routeB.id,
    photoId: 'photo-1',
    x: 0.6,
    y: 0.3,
    text: 'B 馆这条线的脚点'
  });
  assert.equal(listedMarks(routeA.id, 'photo-1').length, 1);
  assert.equal(listedMarks(routeB.id, 'photo-1').length, 1);
  assert.equal(listedMarks(routeA.id, 'photo-1')[0].text, 'A 馆这条线的脚点');
  assert.equal(listedMarks(routeB.id, 'photo-1')[0].text, 'B 馆这条线的脚点');
});

test('T028 同一条线路的不同照片各自独立：旧照片的点不叠在新照片上', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);

  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '第一张照片的脚点'
  });
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);

  // 换了主照片：照片 ID 变了，旧标记不再出现在新照片上。
  const listedNew = marks.listMarks(targetOf(route.id, 'photo-2'));
  assert.equal(listedNew.ok, true);
  assert.deepEqual(listedNew.marks, [], '旧照片的标记不得叠加到新照片');
  assert.equal(listedNew.otherPhotoCount, 1, '但要能说明另有几条属于旧照片');

  // 新照片上的标记与旧照片互不影响。
  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-2',
    x: 0.7,
    y: 0.2,
    text: '第二张照片的脚点'
  });
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
  assert.equal(listedMarks(route.id, 'photo-1')[0].text, '第一张照片的脚点');
  assert.equal(listedMarks(route.id, 'photo-2').length, 1);
  assert.equal(listedMarks(route.id, 'photo-2')[0].text, '第二张照片的脚点');
});

test('T028 归属不完整（缺档案或缺少照片 ID）时不显示任何标记', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });

  assert.deepEqual(marks.marksForTarget(storedMarks(), { archiveId: archiveIdOf(), routeId: route.id, photoId: '' }), []);
  assert.deepEqual(marks.marksForTarget(storedMarks(), { archiveId: '', routeId: route.id, photoId: 'photo-1' }), []);
  assert.deepEqual(marks.marksForTarget(storedMarks(), { archiveId: 'other-archive', routeId: route.id, photoId: 'photo-1' }), []);
  // 换档案后旧标记不显示（不伪造迁移），但原数据仍在。
  assert.equal(marks.listMarks({ archiveId: 'other-archive', routeId: route.id, photoId: 'photo-1' }).marks.length, 0);
  assert.equal(storedMarks().marks.length, 1);
});

test('T028 标记键受保护：普通清缓存不动它，也不动命名空间外的键', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });
  storage.set('climbingNote.training.v1.cache.demo', 'cache');
  storage.set('climbingNote.training.v1.thumbs.photos', 'thumbs');
  storage.set(LEGACY_KEY, 'other-namespace');
  const marksBefore = rawOf(MARKS_KEY);
  const archiveBefore = rawOf(ARCHIVE_KEY);

  assert.equal(store.isProtectedKey(MARKS_KEY), true, '标记键属于受保护的本机资料');
  assert.equal(store.isRebuildableKey(MARKS_KEY), false);

  const cleared = store.clearRebuildableStorage();
  assert.equal(cleared.ok, true, cleared.error);
  assert.deepEqual(
    cleared.removed.slice().sort(),
    ['climbingNote.training.v1.cache.demo', 'climbingNote.training.v1.thumbs.photos']
  );
  assert.equal(rawOf(MARKS_KEY), marksBefore, '清缓存后卡点仍在');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);
  assert.equal(rawOf(LEGACY_KEY), 'other-namespace');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '离线或清缓存后仍能重开已保存标记');
});

test('T028 标记操作不改训练档案、照片索引与自测记录的原始字节', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  record(session, route, 'send', '这次成了', '2026-11-09T10:30:00');
  storage.set(PHOTO_KEY, 'photo-index-sentinel');
  storage.set(FITNESS_KEY, 'fitness-records-sentinel');

  const archiveBefore = rawOf(ARCHIVE_KEY);
  const photoBefore = rawOf(PHOTO_KEY);
  const fitnessBefore = rawOf(FITNESS_KEY);
  const historyBefore = store.routeHistory(archiveOf(), route.id);

  const where = { archiveId: archiveIdOf(), routeId: route.id, photoId: 'photo-1' };
  const first = marks.addMark(Object.assign({ x: 0.2, y: 0.4, text: '左脚踩这里' }, where));
  const second = marks.addMark(Object.assign({ x: 0.8, y: 0.6, text: '右手抓这个点' }, where));
  marks.moveMark({ markId: first.mark.markId, x: 0.3, y: 0.5 });
  marks.updateMark({ markId: first.mark.markId, text: '左脚踩这里（改）' });
  marks.removeMark(second.mark.markId);

  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '把次与备注所在的训练档案逐字节一致');
  assert.equal(rawOf(PHOTO_KEY), photoBefore, '主照片索引逐字节一致（图上的点不烧进照片）');
  assert.equal(rawOf(FITNESS_KEY), fitnessBefore, '自测记录逐字节一致');
  const historyAfter = store.routeHistory(archiveOf(), route.id);
  assert.equal(historyAfter.attemptCount, historyBefore.attemptCount, '把数不变');
  assert.deepEqual(historyAfter.groups, historyBefore.groups, '备注与跨日分组不变');
});

// ================================================================== *
// 五、页面：标记模式、保存、重开、换大小与异常处理
// ================================================================== *

test('T028 详情页：左右各加一条提示并保存，重开与换大小后仍落在原图对应点', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');

  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  assert.equal(page.data.marksReady, true);
  assert.equal(page.data.markList.length, 0);

  const entered = await page.enterMarkMode();
  assert.equal(page.data.markMode, true);
  assert.equal(entered.ok, true, '进入标记模式应读到照片尺寸');

  // 左侧（脚法）：原图 (320,480)
  const leftTap = await page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(leftTap.ok, true, leftTap.error);
  assert.equal(page.data.markEditable, true);
  assert.ok(page.data.markDraft, '落点后应出现草稿点');
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  const firstSave = page.saveMarkDraft();
  assert.equal(firstSave.ok, true, firstSave.error);
  assert.equal(firstSave.code, 'added');
  assert.equal(page.data.markNotice.includes('已保存卡点'), true);

  // 右侧（手法）：原图 (1280,720)
  page.pickMarkKind(tapDataset({ kind: 'hand' }));
  const rightTap = await page.tapPhotoStage(tapAt(300, 238.125));
  assert.equal(rightTap.ok, true, rightTap.error);
  page.onMarkTextInput({ detail: { value: '右手抓这个点' } });
  const secondSave = page.saveMarkDraft();
  assert.equal(secondSave.ok, true, secondSave.error);

  assert.equal(page.data.markPoints.length, 2);
  assert.equal(page.data.markCountText, '2 条卡点');
  assert.equal(page.data.markList.length, 2);
  assert.deepEqual(page.data.markList.map(item => item.kindText), ['脚法', '手法']);
  assert.deepEqual(page.data.markList.map(item => item.textText), ['左脚踩这里', '右手抓这个点']);

  // 已知点像素位置对照：图上的点落在原图对应位置，偏差在 5 个显示逻辑像素内。
  const image = geometry.images[PHOTO_MAIN];
  const rect = geometry.rects[STAGE];
  const layout = marks.imageLayout({
    imageWidth: image.width,
    imageHeight: image.height,
    viewWidth: rect.width,
    viewHeight: rect.height
  });
  const known = [
    { local: { x: 75, y: 181.875 }, px: 320, py: 480 },
    { local: { x: 300, y: 238.125 }, px: 1280, py: 720 }
  ];
  page.data.markPoints.forEach((pin, index) => {
    assert.equal(pin.visible, true);
    assert.ok(
      distance({ x: pin.leftPx, y: pin.topPx }, known[index].local) <= 5,
      '第 ' + (index + 1) + ' 个点的显示偏差在 5 像素内'
    );
    assert.ok(
      distance(marks.originalPixelOf(pin, image), { x: known[index].px, y: known[index].py }) <= 5,
      '第 ' + (index + 1) + ' 个点落在原图已知像素上'
    );
    assert.equal(pin.index, index + 1);
  });

  // 重开：新页面实例上的标记与位置完全一致。
  const reopened = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  assert.equal(reopened.page.data.markPoints.length, 2);
  assert.deepEqual(
    reopened.page.data.markPoints.map(pin => [pin.markId, pin.kind, pin.text]),
    page.data.markPoints.map(pin => [pin.markId, pin.kind, pin.text])
  );
  reopened.page.data.markPoints.forEach((pin, index) => {
    assert.ok(distance({ x: pin.leftPx, y: pin.topPx }, known[index].local) <= 5);
  });

  // 换大小显示（旋转/换屏）：显示框变了，但换回原图还是同一批点。
  setStageRect({ width: 300, height: 520 });
  const resized = reopened.page.onResize();
  await settle();
  await resized;
  const newRect = geometry.rects[STAGE];
  const newLayout = marks.imageLayout({
    imageWidth: image.width,
    imageHeight: image.height,
    viewWidth: newRect.width,
    viewHeight: newRect.height
  });
  assert.equal(reopened.page.data.markPoints.length, 2);
  reopened.page.data.markPoints.forEach((pin, index) => {
    const expected = marks.imageToScreen({ x: pin.x, y: pin.y }, newLayout);
    assert.ok(distance({ x: pin.leftPx, y: pin.topPx }, expected) <= 1e-9, '换大小后按新框重算');
    assert.ok(
      distance(marks.originalPixelOf(pin, image), { x: known[index].px, y: known[index].py }) <= 5,
      '换大小后仍落在原图同一个岩点'
    );
  });
});

test('T028 详情页：点留白不生成点，落点后可保存、移动、改字、删除且互不影响', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();

  // 点在照片外的留白：不生成点、不落盘，并有可见提示。
  const letterbox = await page.tapPhotoStage(tapAt(100, 5));
  assert.equal(letterbox, null);
  assert.match(page.data.markNotice, /留白/);
  assert.equal(page.data.markDraft, null);
  assert.equal(rawOf(MARKS_KEY), '', '留白点击不得落盘');
  assert.equal(page.data.markPoints.length, 0);

  // 两条标记
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  assert.equal(page.saveMarkDraft().ok, true);
  await page.tapPhotoStage(tapAt(300, 238.125));
  page.onMarkTextInput({ detail: { value: '右手抓这个点' } });
  assert.equal(page.saveMarkDraft().ok, true);
  assert.equal(page.data.markPoints.length, 2);

  // 选中第一条并移动：第二条不变。
  page.selectMarkPoint(tapDataset({ markId: 'mark-1' }));
  assert.equal(page.data.markSelected.markId, 'mark-1');
  assert.equal(page.data.markText, '左脚踩这里');
  page.startMarkMove();
  assert.equal(page.data.markMoving, true);
  const moved = await page.tapPhotoStage(tapAt(110, 210));
  assert.equal(moved.ok, true, moved.error);
  assert.equal(page.data.markMoving, false);
  let listed = listedMarks(route.id, 'photo-1');
  assert.notDeepEqual([listed[0].x, listed[0].y], [0.2, 0.4], '第一条应已移动');
  assert.deepEqual([listed[1].x, listed[1].y], [0.8, 0.6], '第二条位置不变');
  assert.equal(listed[1].text, '右手抓这个点', '第二条文字不变');

  // 移动时点到留白：位置不变，有可见提示。
  const beforeMove = JSON.stringify(listedMarks(route.id, 'photo-1')[0]);
  page.startMarkMove();
  const moveToLetterbox = await page.tapPhotoStage(tapAt(100, 5));
  assert.equal(moveToLetterbox, null);
  assert.match(page.data.markNotice, /留白/);
  assert.equal(JSON.stringify(listedMarks(route.id, 'photo-1')[0]), beforeMove, '留白点击不改位置');
  page.cancelMarkMove();

  // 改字：只改第一条。
  page.onMarkTextInput({ detail: { value: '起步左脚踩这里' } });
  page.pickMarkKind(tapDataset({ kind: 'hand' }));
  const edited = page.saveMarkEdit();
  assert.equal(edited.ok, true, edited.error);
  listed = listedMarks(route.id, 'photo-1');
  assert.equal(listed[0].text, '起步左脚踩这里');
  assert.equal(listed[0].kind, 'hand');
  assert.equal(listed[1].text, '右手抓这个点');
  assert.equal(listed[1].kind, 'foot', '另一条的手法/脚法保持原值');

  // 删除第一条（确认后）：第二条位置与文字保持原值。
  const deleted = await page.deleteMarkPoint();
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(deleted.removed, true);
  listed = listedMarks(route.id, 'photo-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].markId, 'mark-2');
  assert.deepEqual([listed[0].x, listed[0].y], [0.8, 0.6]);
  assert.equal(listed[0].text, '右手抓这个点');
  assert.equal(page.data.markPoints.length, 1);
  assert.equal(page.data.markList.length, 1);

  // 取消删除：保留原标记。
  page.selectMarkPoint(tapDataset({ markId: 'mark-2' }));
  geometry.modalConfirm = false;
  const cancelledDelete = await page.deleteMarkPoint();
  assert.equal(cancelledDelete, null);
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '取消后标记仍在');
  geometry.modalConfirm = true;
});

test('T028 详情页：取消更换保留原标记，确认换图后旧点不叠在新图', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page, ui } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  page.saveMarkDraft();
  assert.equal(page.data.markPoints.length, 1);

  // 取消更换主照片：照片 ID 没变，原标记照旧显示。
  ui.set(savedPhotoView('photo-1', PHOTO_MAIN));
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.routePhoto.photoId, 'photo-1');
  assert.equal(page.data.markPoints.length, 1, '取消更换后原标记仍在');
  assert.equal(page.data.markHiddenText, '');

  // 确认换了主照片：照片 ID 变，旧点不再叠加到新照片上，但能说明另有几条。
  setImageSize(PHOTO_MAIN_2, 1200, 1600);
  ui.set(savedPhotoView('photo-2', PHOTO_MAIN_2));
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.routePhoto.photoId, 'photo-2');
  assert.equal(page.data.markPoints.length, 0, '旧照片的点不得叠在新照片上');
  assert.match(page.data.markHiddenText, /另有 1 条卡点/);
  // 旧标记仍在存储里，没被删也没被改写。
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
  assert.equal(listedMarks(route.id, 'photo-1')[0].text, '左脚踩这里');

  // 回到原照片（例如取消后再看原图）：标记照旧落在原图对应点。
  ui.set(savedPhotoView('photo-1', PHOTO_MAIN));
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.markPoints.length, 1);
  assert.ok(distance({ x: page.data.markPoints[0].leftPx, y: page.data.markPoints[0].topPx }, { x: 75, y: 181.875 }) <= 5);
});

test('T028 详情页：写失败不报已保存，序号不消耗，重试后只有一条', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });

  armSetFailAt(1);
  const failed = page.saveMarkDraft();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  assert.equal(page.data.markDraft !== null, true, '失败时应保留草稿，可再点一次');
  assert.match(page.data.markNotice, /未保存/);
  assert.match(page.data.markSaveError, /保存照片卡点标记失败/);
  assert.equal(rawOf(MARKS_KEY), '', '写失败时不应留下半条记录');
  disarmSetFail();

  const retried = page.saveMarkDraft();
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.mark.markId, 'mark-1');
  assert.equal(page.data.markSaveError, '');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
  assert.equal(page.data.markPoints.length, 1);
});

test('T028 详情页：迟到回调有可见处理，不把旧点位写到新照片上', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page, ui } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();

  // 读图片尺寸的迟到回调：期间换了主照片，这次点击必须作废。
  // 先清掉尺寸缓存，让这次点击真的去读一次图片尺寸（否则会直接用缓存，构造不出迟到）。
  page.setData({ markMode: true });
  page._imageSizes = {};
  page._markLayout = null;
  geometry.deferImageInfo = true;
  const pending = page.tapPhotoStage(tapAt(75, 181.875));
  setImageSize(PHOTO_MAIN_2, 1200, 1600);
  geometry.deferImageInfo = false;
  ui.set(savedPhotoView('photo-2', PHOTO_MAIN_2));
  page.applyPhotoView();
  assert.equal(flushImageInfo(), 1, '应有一次待返回的图片尺寸读取');
  const staleTap = await pending;
  await settle();
  assert.equal(staleTap, null);
  assert.match(page.data.markNotice, /已变化/);
  assert.equal(rawOf(MARKS_KEY), '', '迟到的点击不得落盘');
  assert.equal(page.data.markPoints.length, 0);

  // 回到原照片再正常落点并保存。
  ui.set(savedPhotoView('photo-1', PHOTO_MAIN));
  page.applyPhotoView();
  await settle();
  await page.enterMarkMode();
  const good = await page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(good.ok, true, good.error);
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  assert.equal(page.saveMarkDraft().ok, true);

  // 删除确认的迟到回调：同样按发起时的上下文校验。
  page.selectMarkPoint(tapDataset({ markId: 'mark-1' }));
  geometry.deferModal = true;
  const pendingDelete = page.deleteMarkPoint();
  ui.set(savedPhotoView('photo-2', PHOTO_MAIN_2));
  page.applyPhotoView();
  geometry.deferModal = false;
  assert.equal(flushModal(), true, '应有一次待确认的删除弹窗');
  const staleDelete = await pendingDelete;
  assert.equal(staleDelete, null);
  assert.match(page.data.markNotice, /已变化/);
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '迟到的删除不得生效');
});

test('T028 详情页：换图前落下的草稿不能在确认换图后存到新照片上，取消更换则保留', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page, ui } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();

  // 先存下一条旧照片上的标记。
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '旧照片的既有脚点' } });
  assert.equal(page.saveMarkDraft().ok, true);

  // 再落一个未保存的草稿：它属于这张旧照片。
  await page.tapPhotoStage(tapAt(300, 238.125));
  page.onMarkTextInput({ detail: { value: '旧照片的独有脚点' } });
  assert.ok(page.data.markDraft, '落点后应有未保存的草稿');

  // 取消更换：照片 ID 没变，草稿、编辑区与旧标记照旧。
  ui.set(savedPhotoView('photo-1', PHOTO_MAIN));
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.routePhoto.photoId, 'photo-1');
  assert.ok(page.data.markDraft, '取消更换后旧草稿保留');
  assert.equal(page.data.markEditable, true);
  assert.equal(page.data.markPoints.length, 2, '旧图上的标记照旧显示');

  // 确认换成另一张：归属变化，旧草稿、选中与编辑区一并失效。
  setImageSize(PHOTO_MAIN_2, 1200, 1600);
  ui.set(savedPhotoView('photo-2', PHOTO_MAIN_2));
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.routePhoto.photoId, 'photo-2');
  assert.equal(page.data.markSelected, null);
  assert.equal(page.data.markDraft, null, '换图后旧草稿必须失效');
  assert.equal(page.data.markEditable, false);
  assert.equal(page.saveMarkDraft(), null, '没有草稿时保存不落盘');

  // 即使编辑区被误恢复，保存前也会核对发起落点时的归属：旧草稿写不到新照片上。
  page.setData({
    markDraft: { x: 0.16, y: 0.6, kind: 'foot', text: '旧照片的独有脚点', opId: 'op-stale' },
    markEditable: true
  });
  const refused = page.saveMarkDraft();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'stale-draft');
  assert.equal(page.data.markDraft, null);
  assert.deepEqual(listedMarks(route.id, 'photo-2'), [], '旧草稿不得写到新照片上');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '旧照片上已保存的那条仍在');
  assert.equal(listedMarks(route.id, 'photo-1')[0].text, '旧照片的既有脚点');
});

test('T028 详情页：移除主照片后旧草稿、选中与编辑区一并失效，已保存的标记仍在存储里', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page, ui } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '移除前的标记' } });
  assert.equal(page.saveMarkDraft().ok, true);
  page.selectMarkPoint(tapDataset({ markId: 'mark-1' }));
  assert.equal(page.data.markSelected.markId, 'mark-1');

  // 移除主照片：没有照片 ID 就不猜归属，编辑区与草稿全部收回。
  ui.set(noPhotoView());
  page.applyPhotoView();
  await settle();
  assert.equal(page.data.routePhoto.status, 'none');
  assert.equal(page.data.markSelected, null);
  assert.equal(page.data.markEditable, false);
  assert.equal(page.data.markMoving, false);
  assert.equal(page.data.markPoints.length, 0);
  assert.equal(page.data.markList.length, 0, '没有照片 ID 时不猜归属');
  page.setData({ markDraft: { x: 0.2, y: 0.4, kind: 'foot', text: '移除前的标记', opId: 'op-gone' }, markEditable: true });
  assert.equal(page.saveMarkDraft().ok, false, '没有归属时保存被拒绝');
  assert.equal(page.data.markDraft, null, '被拒绝的旧草稿也被收回，不会挂在那里等下次换图');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '已保存的标记仍在存储里');
});

test('T028 详情页：移动 A 期间改选 B，A 的迟到测量不得把 B 挪走，正常移动仍能完成', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(60, 150));
  page.onMarkTextInput({ detail: { value: 'A 的提示' } });
  assert.equal(page.saveMarkDraft().ok, true);
  await page.tapPhotoStage(tapAt(240, 230));
  page.onMarkTextInput({ detail: { value: 'B 的提示' } });
  assert.equal(page.saveMarkDraft().ok, true);
  const before = listedMarks(route.id, 'photo-1');
  const aBefore = JSON.stringify(before[0]);
  const bBefore = JSON.stringify(before[1]);
  assert.deepEqual(before.map(item => item.markId), ['mark-1', 'mark-2']);

  // 选中 A 并开始移动；这次点击的显示框测量挂起不返回。
  page.selectMarkPoint(tapDataset({ markId: 'mark-1' }));
  page.startMarkMove();
  const realQuery = page.queryMarkStageRect.bind(page);
  const box = await realQuery();
  let release;
  page.queryMarkStageRect = () => new Promise(resolve => { release = resolve; });

  const pending = page.tapPhotoStage(tapAt(140, 140));
  // 测量还没回来时改选 B 并开始移动 B。
  page.selectMarkPoint(tapDataset({ markId: 'mark-2' }));
  page.startMarkMove();
  release(box);
  await pending;
  await settle();

  const afterLate = listedMarks(route.id, 'photo-1');
  assert.equal(JSON.stringify(afterLate[1]), bBefore, 'A 的迟到点击不得移动 B');
  assert.equal(JSON.stringify(afterLate[0]), aBefore, 'A 的位置也不得被这次点击改动');
  assert.equal(page.data.markSelected.markId, 'mark-2', '选中的仍是 B');

  // 恢复真实测量：B 仍能正常移动到新位置，A 保持原值。
  page.queryMarkStageRect = realQuery;
  const moved = await page.tapPhotoStage(tapAt(200, 260));
  assert.equal(moved.ok, true, moved.error);
  const expected = marks.markPointFromTap(tapAt(200, 260), geometry.rects[STAGE], geometry.images[PHOTO_MAIN]);
  assert.equal(expected.ok, true, expected.error);
  const after = listedMarks(route.id, 'photo-1');
  assert.deepEqual([after[1].x, after[1].y], [expected.point.x, expected.point.y], 'B 正常完成移动');
  assert.equal(after[1].text, 'B 的提示', '移动只改位置');
  assert.equal(JSON.stringify(after[0]), aBefore, 'A 保持原值');
});

test('T028 详情页：退出或重进标记模式后，旧点击的测量不得重新打开编辑区', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  const realQuery = page.queryMarkStageRect.bind(page);
  const box = await realQuery();
  let release;
  page.queryMarkStageRect = () => new Promise(resolve => { release = resolve; });

  // 退出标记模式：这次点击的测量还没回来。
  const afterExit = page.tapPhotoStage(tapAt(75, 181.875));
  page.exitMarkMode();
  release(box);
  await afterExit;
  await settle();
  assert.equal(page.data.markMode, false);
  assert.equal(page.data.markEditable, false, '退出后旧点击不得再打开编辑区');
  assert.equal(page.data.markDraft, null);
  assert.equal(rawOf(MARKS_KEY), '', '退出后的旧点击不得落盘');

  // 重进标记模式：上一轮模式里发起的旧点击同样作废。
  await page.enterMarkMode();
  const afterReenter = page.tapPhotoStage(tapAt(75, 181.875));
  page.exitMarkMode();
  await page.enterMarkMode();
  release(box);
  await afterReenter;
  await settle();
  assert.equal(page.data.markEditable, false, '重进模式后上一轮的旧点击不得打开编辑区');
  assert.equal(page.data.markDraft, null);
  assert.equal(rawOf(MARKS_KEY), '');

  // 当前模式下的点击照常落点并保存。
  page.queryMarkStageRect = realQuery;
  const good = await page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(good.ok, true, good.error);
  assert.ok(page.data.markDraft, '当前模式下的点击照常生成草稿');
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  assert.equal(page.saveMarkDraft().ok, true);
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
});

test('T028 详情页：换屏后较早的一次显示框测量不得把标记恢复回旧屏位置', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '左脚踩这里' } });
  assert.equal(page.saveMarkDraft().ok, true);
  const stored = listedMarks(route.id, 'photo-1')[0];
  assert.ok(Math.abs(stored.x - 0.2) < 1e-9);

  const realQuery = page.queryMarkStageRect.bind(page);
  const oldBox = await realQuery();
  let release;
  page.queryMarkStageRect = () => new Promise(resolve => { release = resolve; });

  // 主图重新加载发起的一次测量还没回来，此时换了屏幕并完成新的测量。
  const staleMeasure = page.onMarkImageLoad();
  setStageRect({ width: 180, height: 300 });
  page.queryMarkStageRect = async () => Object.assign({}, geometry.rects[STAGE]);
  page.onResize();
  await settle();

  const layout = marks.imageLayout({ imageWidth: 1600, imageHeight: 1200, viewWidth: 180, viewHeight: 300 });
  const expected = marks.imageToScreen({ x: stored.x, y: stored.y }, layout);
  const position = () => {
    const pin = page.data.markPoints.find(item => item.markId === 'mark-1');
    return pin ? { x: pin.leftPx, y: pin.topPx } : null;
  };
  const now = position();
  assert.ok(now, '换屏后标记仍应上图');
  assert.ok(distance(now, expected) <= 5, '换屏后按新显示框换算，偏差在 5 个显示逻辑像素内');

  // 迟到的那次旧框测量回来：不得把标记恢复回旧屏上的位置。
  release(Object.assign({}, oldBox));
  await staleMeasure;
  await settle();
  assert.deepEqual(position(), now, '较早的测量不得覆盖新屏的最新布局');
  assert.deepEqual(
    [listedMarks(route.id, 'photo-1')[0].x, listedMarks(route.id, 'photo-1')[0].y],
    [stored.x, stored.y],
    '已保存点的位置不变（只换显示框）'
  );
});

test('T028 详情页：写前失败与回执丢失后重试都只留一条，另一份同坐标草稿仍是两条', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  await page.enterMarkMode();
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '定位同一次落点' } });

  // 写前失败：不留半条，保留草稿可再点一次。
  armSetFailAt(1);
  const beforeWrite = page.saveMarkDraft();
  assert.equal(beforeWrite.ok, false);
  assert.equal(beforeWrite.code, 'write-failed');
  assert.equal(rawOf(MARKS_KEY), '', '写前失败不得留下半条');
  assert.ok(page.data.markDraft, '失败后草稿仍在，可再点一次');
  assert.match(page.data.markSaveError, /保存照片卡点标记失败/);
  disarmSetFail();

  // 写成功了但回执丢失：页面看到失败，其实已经落盘。
  armSetFailAfter(1);
  const lostAck = page.saveMarkDraft();
  assert.equal(lostAck.ok, false, '回执丢失时仍如实报失败');
  assert.equal(lostAck.code, 'write-failed');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '这时其实已经落盘');
  assert.ok(page.data.markDraft, '回执丢失后仍保留草稿可重试');
  disarmSetFail();

  // 同一次落点再点一次保存：复用已落盘的那条，不写第二条。
  const retried = page.saveMarkDraft();
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.code, 'duplicate');
  assert.equal(retried.mark.markId, 'mark-1');
  assert.equal(listedMarks(route.id, 'photo-1').length, 1, '同一次落点重试不得写成两条');
  assert.equal(page.data.markDraft, null);
  assert.equal(page.data.markPoints.length, 1);

  // 另一份草稿落在同一坐标：它是另一次落点，成为第二条，第一条不动。
  const firstBefore = JSON.stringify(listedMarks(route.id, 'photo-1')[0]);
  await page.tapPhotoStage(tapAt(75, 181.875));
  page.onMarkTextInput({ detail: { value: '同位置的第二条' } });
  const secondSave = page.saveMarkDraft();
  assert.equal(secondSave.ok, true, secondSave.error);
  assert.equal(secondSave.mark.markId, 'mark-2');
  const after = listedMarks(route.id, 'photo-1');
  assert.equal(after.length, 2, '不同草稿即使同坐标也各自成一条');
  assert.equal(JSON.stringify(after[0]), firstBefore, '第一条不受影响');
  assert.equal(page.data.markPoints.length, 2);
});

test('T028 详情页：无图与原图缺失都有可见处理，且不丢已写的卡点', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const where = { archiveId: archiveIdOf(), routeId: route.id, photoId: 'photo-1' };
  marks.addMark(Object.assign({ x: 0.2, y: 0.4, text: '左脚踩这里' }, where));

  // 还没有主照片：不显示点，写入口给出可见原因，原标记仍在存储里。
  const noPhoto = await openRoutePage(route.id, noPhotoView());
  assert.equal(noPhoto.page.data.markPoints.length, 0);
  assert.equal(noPhoto.page.data.markList.length, 0, '没有照片 ID 时不猜归属');
  const refusedEnter = await noPhoto.page.enterMarkMode();
  assert.equal(refusedEnter, null);
  assert.match(noPhoto.page.data.markNotice, /先添加线路主照片/);
  assert.equal(noPhoto.page.data.markMode, false);
  noPhoto.page.setData({ markMode: true });
  const refusedTap = await noPhoto.page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(refusedTap, null);
  assert.match(noPhoto.page.data.markNotice, /先添加线路主照片/);
  assert.equal(storedMarks().marks.length, 1, '原标记不得被清掉');

  // 原图缺失（文件被系统清理）：点不显示，但文字清单仍能读回，写入口被收回。
  const missing = await openRoutePage(route.id, missingPhotoView('photo-1'));
  assert.equal(missing.page.data.markPoints.length, 0, '照片不可用时不上图');
  assert.equal(missing.page.data.markList.length, 1);
  assert.equal(missing.page.data.markList[0].textText, '左脚踩这里');
  assert.equal(missing.page.data.markCountText, '1 条卡点');
  const refusedMissing = await missing.page.enterMarkMode();
  assert.equal(refusedMissing, null);
  assert.match(missing.page.data.markNotice, /重新添加后才能标记/);
  missing.page.setData({ markMode: true });
  const refusedAdd = await missing.page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(refusedAdd, null);
  assert.match(missing.page.data.markNotice, /重新添加后才能标记/);
  assert.equal(listedMarks(route.id, 'photo-1').length, 1);
  assert.equal(rawOf(MARKS_KEY) === '', false, '只读回看不得改动标记记录');
});

test('T028 详情页：读不到照片尺寸时可见提示，文字清单照常可读', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });

  delete geometry.images[PHOTO_MAIN];
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  assert.match(page.data.markLayoutError, /显示尺寸/);
  assert.equal(page.data.markPoints.length, 0, '没有布局时不上图');
  assert.equal(page.data.markList.length, 1, '文字清单照常可读');

  // 点位上不去时点击给出可见原因，不落盘。
  await page.enterMarkMode();
  const outcome = await page.tapPhotoStage(tapAt(75, 181.875));
  assert.equal(outcome, null);
  assert.match(page.data.markNotice, /照片尺寸/);

  // 尺寸恢复后可重新测量。
  setImageSize(PHOTO_MAIN, 1600, 1200);
  await page.reloadMarkImage();
  await settle();
  assert.equal(page.data.markLayoutError, '');
  assert.equal(page.data.markPoints.length, 1);
});

test('T028 详情页：首次进入显示区还没布局好，主图加载完成后补测量并上图', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  marks.addMark({
    archiveId: archiveIdOf(),
    routeId: route.id,
    photoId: 'photo-1',
    x: 0.2,
    y: 0.4,
    text: '左脚踩这里'
  });

  // 量到空矩形（主图还没渲染出来）：不上图，但有可见原因，文字清单照常。
  geometry.rects[STAGE] = { left: 20, top: 300, width: 0, height: 0 };
  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  assert.equal(page.data.markPoints.length, 0);
  assert.match(page.data.markLayoutError, /显示尺寸/);
  assert.equal(page.data.markList.length, 1);

  // 主图渲染完成：按真实矩形补测量，标记落回原图对应点。
  setStageRect({ width: 375, height: 420 });
  await page.onMarkImageLoad();
  await settle();
  assert.equal(page.data.markLayoutError, '');
  assert.equal(page.data.markPoints.length, 1);
  assert.ok(
    distance(
      { x: page.data.markPoints[0].leftPx, y: page.data.markPoints[0].topPx },
      { x: 75, y: 181.875 }
    ) <= 5
  );
});

test('T028 详情页：标记记录损坏时显示可见错误并收回写入口', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session);
  const broken = '{ not-json';
  storage.set(MARKS_KEY, broken);
  const archiveBefore = rawOf(ARCHIVE_KEY);

  const { page } = await openRoutePage(route.id, savedPhotoView('photo-1', PHOTO_MAIN));
  assert.equal(page.data.marksReady, false);
  assert.match(page.data.marksError, /损坏/);
  assert.equal(page.data.markList.length, 0);

  // 即使被误调用也不落盘、不改档案。
  await page.enterMarkMode();
  assert.match(page.data.markNotice, /损坏/);
  assert.equal(page.data.markMode, false);
  assert.equal(rawOf(MARKS_KEY), broken, '不得覆盖损坏的原标记');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);

  // 正常回看不受影响。
  assert.equal(page.data.ready, true);
  assert.equal(page.data.notFound, false);
});

test('T028 WXML 绑定核对：卡点入口绑定真实处理函数，图层与清单都在正式页面上', () => {
  const wxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  const handlers = handlersIn(wxml);
  for (const handler of [
    'tapPhotoStage',
    'selectMarkPoint',
    'enterMarkMode',
    'exitMarkMode',
    'pickMarkKind',
    'saveMarkDraft',
    'saveMarkEdit',
    'startMarkMove',
    'cancelMarkMove',
    'deleteMarkPoint',
    'dismissMarkNotice',
    'dismissMarkSaveError',
    'reloadMarkImage'
  ]) {
    assert.ok(handlers.includes(handler), '线路详情页应绑定：' + handler);
    assert.equal(typeof routeDefinition[handler], 'function', '缺少处理器：' + handler);
  }
  // 文字输入走 bindinput，图片加载完成后的补测量走 bindload，与点击事件分开核对。
  assert.match(wxml, /bindinput="onMarkTextInput"/);
  assert.equal(typeof routeDefinition.onMarkTextInput, 'function');
  assert.match(wxml, /bindload="onMarkImageLoad"/);
  assert.equal(typeof routeDefinition.onMarkImageLoad, 'function');

  // 每个绑定都必须有真实处理器（与 T018/T027 的既有约定一致）。
  handlers.forEach(handler => {
    assert.equal(typeof routeDefinition[handler], 'function', '绑定缺少处理器：' + handler);
  });

  // 图层、编辑区与文字清单的真实入口，以及按原图归一化保存的点位。
  [
    'route-photo-stage',
    'route-photo-main',
    'mark-card',
    'mark-enter',
    'mark-editor',
    'mark-text-input',
    'mark-save-draft',
    'mark-save-edit',
    'mark-move',
    'mark-delete',
    'mark-list'
  ].forEach(id => {
    assert.ok(wxml.indexOf('id="' + id + '"') !== -1, '线路详情页缺少 ' + id);
  });
  assert.match(wxml, /data-mark-id="\{\{item\.markId\}\}"/);
  assert.match(wxml, /style="left:\{\{item\.leftPx\}\}px; top:\{\{item\.topPx\}\}px;"/);

  // 页面与标记层只走正式本机模块。
  assert.match(fs.readFileSync(ROUTE_JS, 'utf8'), /utils\/training-photo-marks/);
  const wxss = fs.readFileSync(ROUTE_WXSS, 'utf8');
  assert.match(wxss, /\.photo-mark-stage\s*\{[^}]*position:\s*relative/);
  assert.match(wxss, /\.mark-pin\s*\{[^}]*position:\s*absolute/);
});

test('T028 标记层与页面不接云、不写旧记录、不烧照片也不上传', () => {
  const source = fs.readFileSync(MARKS_JS, 'utf8');
  assert.ok(!/wx\.cloud/.test(source), '标记层不应直接使用 wx.cloud');
  assert.ok(!/require\(.*db\.js/.test(source), '标记层不应依赖 utils/db.js');
  assert.ok(!/climbing_records/.test(source), '标记层不应触及旧集合');
  assert.ok(!/uploadFile|uploadImage|canvas|drawImage/.test(source), '标记不得烧进照片或上传');
  assert.ok(!/getFileSystemManager|writeFile|unlink|copyFile/.test(source), '标记不得改动主图文件');
  assert.ok(!/require\(.*training-photo/.test(source), '标记层不依赖照片服务，碰不到照片文件');
  assert.ok(!/removeStorage|clearStorage/.test(source), '标记层不得整片清理本机存储');
  assert.match(source, /store\.NAMESPACE \+ 'photo-marks'/);
  assert.equal(marks.MARKS_KEY, 'climbingNote.training.v1.photo-marks');

  const pageSource = fs.readFileSync(ROUTE_JS, 'utf8');
  assert.ok(!/wx\.cloud/.test(pageSource), '线路详情页不应直接用 wx.cloud');
  assert.ok(!/uploadFile|uploadImage/.test(pageSource), '详情页不得上传照片或标记');
});
