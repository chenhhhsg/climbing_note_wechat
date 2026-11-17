/**
 * T023 逐把视频 · 明细与跨日历史选片预览的离线回归测试
 *
 * 直接加载真实页面文件（pages/training-attempts、pages/training-route、
 * pages/attempt-video）与真实工具模块（utils/attempt-video、utils/training-store），
 * 捕获 Page(...) 定义，用隔离的微信本地存储替身、可控相册选择器和故障注驱动真实
 * 页面处理器，并核对 WXML 里的真实入口与导航参数。
 *
 * 覆盖任务单的验收口径：
 * - 同线 A/B 两把：入口只带当前行那一把的四个 ID；B 的视频预览不碰 A；
 * - 跨日历史用分组的**原场次**；
 * - 缺参、串档、同名异线、已撤回、待保存与旧汇总都不受理，也不写档案；
 * - 相册单选（一个选项对象）、取消与失败后的重选、连点与迟到回调、离页；
 * - 本单不创建持久文件或索引：running 期间 storage 写入为零，视频索引键不被创建；
 * - 视频索引只读：T026 写入后列表自动显示「已添加视频」，索引损坏不影响列表。
 * - T047：空态选片卡先说明「选片后先预览」与「确认后保存本机副本」，保存按钮
 *   仍是「保存到攀笔」，保存/取消、播放与移除的绑定不变。
 *
 * 真实相册、真实解码、冷启动与两处入口的可见布局交给整项 QA 与手机复验（待验）。
 *
 * 运行：node --test tests/attempt-video.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const PROJECT_JSON = path.join(ROOT, 'project.config.json');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const ATTEMPTS_WXML = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.wxml');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const VIDEO_DIR = path.join(ROOT, 'pages', 'attempt-video');
const VIDEO_JS = path.join(VIDEO_DIR, 'attempt-video.js');
const VIDEO_WXML = path.join(VIDEO_DIR, 'attempt-video.wxml');
const VIDEO_JSON = path.join(VIDEO_DIR, 'attempt-video.json');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';

const VIDEO_A = {
  tempFilePath: 'wxfile://tmp-attempt-video-a.mp4',
  size: 2.5 * 1024 * 1024,
  duration: 12.4,
  width: 1920,
  height: 1080,
  fileType: 'video'
};
const VIDEO_B = {
  tempFilePath: 'wxfile://tmp-attempt-video-b.mp4',
  size: 640 * 1024,
  duration: 7.2,
  width: 1080,
  height: 1920,
  fileType: 'video'
};

// ---- 微信替身：本地存储、相册选择器、导航与文件系统使用计数 ----
const storage = new Map();
const wxLog = {
  chooseCalls: [],
  chooseArgs: [],
  chooseHandler: null,
  navigations: [],
  storageWrites: 0,
  fileManagerCalls: 0
};

function resetWxLog() {
  wxLog.chooseCalls = [];
  wxLog.chooseArgs = [];
  wxLog.chooseHandler = null;
  wxLog.navigations = [];
  wxLog.storageWrites = 0;
  wxLog.fileManagerCalls = 0;
}

function resetDevice() {
  storage.clear();
  resetWxLog();
}

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.storageWrites += 1;
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  chooseMedia(options) {
    wxLog.chooseArgs.push(Array.from(arguments));
    wxLog.chooseCalls.push(options);
    if (wxLog.chooseHandler) wxLog.chooseHandler(options);
  },
  // 本单不应访问文件系统；这里只保证照片控制器初始化时不抛错，并记录是否真的被调用。
  getFileSystemManager() {
    wxLog.fileManagerCalls += 1;
    return {};
  },
  navigateTo(options) {
    wxLog.navigations.push({ type: 'navigateTo', url: options.url });
  },
  navigateBack() {
    wxLog.navigations.push({ type: 'navigateBack', url: '' });
  },
  reLaunch(options) {
    wxLog.navigations.push({ type: 'reLaunch', url: options.url });
  },
  redirectTo(options) {
    wxLog.navigations.push({ type: 'redirectTo', url: options.url });
  },
  showToast(options) {
    wxLog.navigations.push({ type: 'toast', url: '', title: options.title });
  }
};

const store = require(STORE_JS);
const attemptVideo = require(VIDEO_UTIL);

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

const attemptsDefinition = capturePage(ATTEMPTS_JS);
const routeDefinition = capturePage(ROUTE_JS);
const videoDefinition = capturePage(VIDEO_JS);

/** 页面实例替身：支持 wx 的 setData 数据路径写法（如 'noteEditor.text'）。 */
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
  return { currentTarget: { dataset } };
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

function queryOf(url) {
  const index = url.indexOf('?');
  assert.ok(index >= 0, '导航地址应带查询串：' + url);
  return new URLSearchParams(url.slice(index + 1));
}

function lastNavigation() {
  assert.ok(wxLog.navigations.length > 0, '应发生一次导航');
  return wxLog.navigations[wxLog.navigations.length - 1];
}

// ---- 正式档案夹具：一律经 store 写入，页面只读 ----
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

function rawArchive() {
  return storage.has(ARCHIVE_KEY) ? storage.get(ARCHIVE_KEY) : '';
}

/** 基础夹具：一场、一条线、A/B 两把。返回原 ID 与档案 ID。 */
function seedTwoAttempts() {
  const session = startAt('2026-11-12', '同线岩馆');
  const route = newRoute(session);
  const attemptA = record(session, route, 'fail', 'A 把的备注');
  const attemptB = record(session, route, 'fail', 'B 把的备注');
  const archive = archiveOf();
  return { session, route, attemptA, attemptB, archiveId: archive.archiveId };
}

function openAttemptsPage(ids) {
  const page = createPage(attemptsDefinition);
  page.onLoad({
    archiveId: ids.archiveId,
    sessionId: ids.sessionId,
    routeId: ids.routeId
  });
  assert.equal(page.data.contextError, '', '明细页应能按原归属打开');
  return page;
}

function openRoutePage(routeId, archiveId) {
  const page = createPage(routeDefinition);
  page.onLoad(archiveId ? { routeId, archiveId } : { routeId });
  return page;
}

function openVideoPage(ids) {
  const page = createPage(videoDefinition);
  page.onLoad(ids);
  return page;
}

/** 相册立刻成功；files 缺省给一段可用视频。 */
function chooseSuccess(file) {
  wxLog.chooseHandler = options => {
    options.success({ tempFiles: [file || VIDEO_A], type: 'video' });
  };
}

/** 相册立刻取消（微信的取消走 fail + errMsg 含 cancel）。 */
function chooseCancel() {
  wxLog.chooseHandler = options => {
    options.fail({ errMsg: 'chooseMedia:fail cancel' });
  };
}

/** 相册立刻失败。 */
function chooseFail(errMsg) {
  wxLog.chooseHandler = options => {
    options.fail({ errMsg });
  };
}

/** 相册挂起：只记下这次选项，回调由测试稍后手动触发（模拟迟到回调）。 */
function choosePending() {
  wxLog.chooseHandler = () => {};
}

function writeVideoIndex(clips) {
  storage.set(
    attemptVideo.VIDEO_INDEX_KEY,
    JSON.stringify({ version: 1, clips })
  );
}

beforeEach(() => {
  resetDevice();
});

// ------------------------------------------------------------------ *
// 页面注册与包边界
// ------------------------------------------------------------------ *

test('T023-1 正式包注册逐把视频页，四件套齐全，原路由与 tabBar 不变', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  const pagePath = 'pages/attempt-video/attempt-video';

  assert.equal(
    appJson.pages.filter(item => item === pagePath).length,
    1,
    '逐把视频页只注册一次'
  );
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(
      fs.existsSync(path.join(VIDEO_DIR, 'attempt-video' + ext)),
      '缺少逐把视频页文件 attempt-video' + ext
    );
  }
  for (const page of [
    'pages/training-session/training-session',
    'pages/training-route/training-route',
    'pages/training-record/training-record',
    'pages/training-attempts/training-attempts',
    'pages/training-summary/training-summary',
    'pages/training-wishlist/training-wishlist',
    'pages/fitness-test/fitness-test'
  ]) {
    assert.ok(appJson.pages.includes(page), page + ' 应保留在页面清单里');
  }

  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ],
    'tabBar 相对基线不变'
  );

  const project = JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8'));
  const ignore = project.packOptions.ignore;
  for (const value of ['devtools/media-check', 'devtools/gym-log']) {
    assert.equal(
      ignore.filter(item => item.type === 'folder' && item.value === value).length,
      1,
      '正式包继续排除 ' + value
    );
  }
  assert.equal(project.appid, 'wx9ea86e9d7aa04c2f', 'AppID 不得变更');

  const pageJson = JSON.parse(fs.readFileSync(VIDEO_JSON, 'utf8'));
  assert.equal(pageJson.navigationBarTitleText, '逐把视频');

  // T042：视频页里指向逐把页的提示统一叫「本场逐把」，不再用旧称呼。
  const hintsWxml = fs.readFileSync(VIDEO_WXML, 'utf8');
  assert.match(hintsWxml, /本场逐把/, '视频页提示使用「本场逐把」');
  assert.doesNotMatch(hintsWxml, /逐把明细/, '视频页不再用旧称呼');

  // 正式页只走本机档案层，不接云。
  for (const file of [VIDEO_JS, ATTEMPTS_JS, ROUTE_JS, VIDEO_UTIL]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(source, /devtools\//, name + ' 不得引用打包时被排除的 devtools 路径');
    assert.doesNotMatch(source, /wx\.cloud/, name + ' 不得调用云能力');
    assert.doesNotMatch(
      source,
      /gymLogTrial|trial-save-server|trial-profile/,
      name + ' 不得引用试用工程'
    );
  }
});

// ------------------------------------------------------------------ *
// 两处入口与选片预览
// ------------------------------------------------------------------ *

test('T023-2 同线 A/B 两把：只带点中那一把的四个 ID，B 的预览不碰 A', () => {
  const flow = seedTwoAttempts();
  const page = openAttemptsPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });

  assert.equal(page.data.attempts.length, 2, '两把都在明细里');
  assert.deepEqual(
    page.data.attempts.map(item => item.id),
    [flow.attemptA.id, flow.attemptB.id]
  );
  for (const row of page.data.attempts) {
    assert.equal(row.hasVideo, false);
    assert.equal(row.videoStateText, '未添加视频');
    assert.equal(row.videoEntryText, '添加视频 ›');
  }

  // 点 B 的入口：四个 ID 全部来自这一行渲染时的原归属。
  resetWxLog();
  page.openAttemptVideo(tapDataset({ attemptId: flow.attemptB.id }));
  const nav = lastNavigation();
  assert.equal(nav.type, 'navigateTo');
  assert.equal(nav.url.split('?')[0], '/pages/attempt-video/attempt-video');
  const params = queryOf(nav.url);
  assert.equal(params.get('archiveId'), flow.archiveId);
  assert.equal(params.get('sessionId'), flow.session.id);
  assert.equal(params.get('routeId'), flow.route.id);
  assert.equal(params.get('attemptId'), flow.attemptB.id);

  // 点 A 的入口只会带 A，不会因为同线同名就把两把并成一把。
  resetWxLog();
  page.openAttemptVideo(tapDataset({ attemptId: flow.attemptA.id }));
  assert.equal(queryOf(lastNavigation().url).get('attemptId'), flow.attemptA.id);

  // 按 B 的入口打开视频页：这一页只针对 B。
  const rawBefore = rawArchive();
  resetWxLog();
  const videoPage = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });
  assert.equal(videoPage.data.contextError, '');
  assert.equal(videoPage.data.attempt.id, flow.attemptB.id);
  assert.equal(videoPage.data.attempt.label, '第 2 把');
  assert.equal(videoPage.data.attempt.note, 'B 把的备注');
  assert.equal(videoPage.data.activeSession.id, flow.session.id);
  assert.equal(videoPage.data.selectedRoute.id, flow.route.id);
  assert.equal(videoPage.data.videoStateText, '未添加视频');

  chooseSuccess(VIDEO_A);
  videoPage.choosePreview();

  assert.equal(wxLog.chooseCalls.length, 1);
  assert.equal(videoPage.data.hasPreview, true);
  assert.equal(videoPage.data.preview.tempFilePath, VIDEO_A.tempFilePath);
  assert.equal(videoPage.data.chooseError, '');
  assert.equal(rawArchive(), rawBefore, '选片预览不改训练档案，A 与 B 都保持原样');
  assert.equal(
    attemptVideo.videoLinkView(flow.archiveId, flow.attemptA.id).hasVideo,
    false,
    'A 没有因为 B 的预览得到任何关联'
  );
  assert.equal(
    attemptVideo.videoLinkView(flow.archiveId, flow.attemptB.id).hasVideo,
    false,
    '本单不建立持久关联'
  );
});

test('T023-3 跨日历史按分组的原场次进入 B，不换成当天场次', () => {
  const first = startAt('2026-11-05', '跨日岩馆');
  const route = newRoute(first);
  const attemptB = record(first, route, 'fail', '跨日那把');
  const second = startAt('2026-11-14', '跨日岩馆');
  const linked = store.linkRouteToSession(second.id, route.id);
  assert.equal(linked.ok, true, linked.error);
  const attemptC = record(second, route, 'send', '最近那把', '2026-11-14T10:05:00');
  const archiveId = archiveOf().archiveId;

  const page = openRoutePage(route.id, archiveId);
  assert.equal(page.data.notFound, false);
  assert.equal(page.data.groups.length, 2, '两场各自成组');
  assert.equal(page.data.groups[0].sessionId, second.id, '新的场次在前');

  const oldGroup = page.data.groups.find(group => group.sessionId === first.id);
  assert.ok(oldGroup, '原场次分组仍在');
  const oldRow = oldGroup.attempts.find(item => item.id === attemptB.id);
  assert.ok(oldRow, 'B 按原把次留在原场次分组里');
  assert.equal(oldRow.videoStateText, '未添加视频');
  assert.equal(oldRow.videoEntryText, '添加视频 ›');
  const newRow = page.data.groups[0].attempts.find(item => item.id === attemptC.id);
  assert.ok(newRow);

  resetWxLog();
  page.openAttemptVideoFromHistory(
    tapDataset({ attemptId: oldRow.id, sessionId: oldGroup.sessionId, routeId: route.id })
  );
  const params = queryOf(lastNavigation().url);
  assert.equal(params.get('archiveId'), archiveId);
  assert.equal(params.get('sessionId'), first.id, '必须用 B 当初那一场，不能用当天场次');
  assert.equal(params.get('routeId'), route.id);
  assert.equal(params.get('attemptId'), attemptB.id);

  // 视频页按这四个 ID 打开时也落回原场次。
  const videoPage = openVideoPage({
    archiveId,
    sessionId: params.get('sessionId'),
    routeId: params.get('routeId'),
    attemptId: params.get('attemptId')
  });
  assert.equal(videoPage.data.attempt.id, attemptB.id);
  assert.equal(videoPage.data.activeSession.id, first.id);
  assert.equal(videoPage.data.activeSession.dateText, '2026-11-05');
  assert.equal(videoPage.data.activeSession.label, page.data.groups[1].sessionLabel);

  // 换成当天场次带同一个把次：归属不一致，必须拒绝（不能把原把次算进另一场）。
  resetWxLog();
  const wrongSessionPage = openVideoPage({
    archiveId,
    sessionId: second.id,
    routeId: route.id,
    attemptId: attemptB.id
  });
  assert.match(wrongSessionPage.data.contextError, /不属于这一场这一条线/);
  wrongSessionPage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0);
});

test('T023-4 相册只用一个选项对象：count 1、只允许视频、只允许相册', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });
  chooseSuccess(VIDEO_A);
  page.choosePreview();

  assert.equal(wxLog.chooseCalls.length, 1, '一次点击只调用一次选择器');
  assert.equal(wxLog.chooseArgs[0].length, 1, 'wx.chooseMedia 只收一个选项对象');
  const options = wxLog.chooseCalls[0];
  assert.equal(typeof options, 'object');
  assert.equal(options.count, 1, '只能选一段');
  assert.deepEqual(options.mediaType, ['video'], '只允许视频');
  assert.deepEqual(options.sourceType, ['album'], '只允许相册');

  assert.equal(page.data.preview.fileName, 'tmp-attempt-video-a.mp4');
  assert.equal(page.data.preview.sizeText, '2.5 MB');
  assert.equal(page.data.preview.durationText, '12.4');
  assert.equal(page.data.preview.dimensionText, '1920×1080');
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.choosing, false);
  assert.equal(page.data.chooseError, '');
  assert.equal(wxLog.storageWrites, 0, '选片预览不写任何 storage');
  assert.equal(storage.has(attemptVideo.VIDEO_INDEX_KEY), false, '本单不创建视频索引');
});

test('T023-5 相册取消与预览取消都能立刻重选，且不创建副本', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });

  // 第一次取消：没有预览、没有错误，可以立刻再选。
  chooseCancel();
  page.choosePreview();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.chooseError, '');
  assert.equal(page.data.choosing, false);

  chooseSuccess(VIDEO_A);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);

  // 取消预览：只丢临时路径，可以立刻再选另一段。
  page.cancelPreview();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.preview, null);
  assert.match(page.data.notice, /没有创建任何文件/);
  assert.equal(page.data.choosing, false);

  chooseSuccess(VIDEO_B);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.tempFilePath, VIDEO_B.tempFilePath);
  assert.equal(page.data.chooseError, '');
  assert.equal(wxLog.storageWrites, 0);
  assert.equal(storage.has(attemptVideo.VIDEO_INDEX_KEY), false);
});

test('T023-6 选择失败给出可见提示，重试成功后提示清空', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });

  chooseFail('chooseMedia:fail system error');
  page.choosePreview();

  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.choosing, false);
  assert.match(page.data.chooseError, /选择视频失败/);
  assert.match(page.data.chooseError, /system error/);
  assert.match(page.data.chooseError, /重新选择/);

  chooseSuccess(VIDEO_B);
  page.choosePreview();
  assert.equal(page.data.chooseError, '');
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.tempFilePath, VIDEO_B.tempFilePath);
});

test('T023-7 缺参、串档与同名异线都拒绝，并且不打开相册', () => {
  const flow = seedTwoAttempts();
  const full = {
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  };

  for (const key of ['archiveId', 'sessionId', 'routeId', 'attemptId']) {
    const query = Object.assign({}, full);
    delete query[key];
    resetWxLog();
    const page = openVideoPage(query);
    assert.ok(page.data.contextError, '缺少 ' + key + ' 时应显示可见原因');
    assert.equal(page.data.attempt, null);
    page.choosePreview();
    assert.equal(wxLog.chooseCalls.length, 0, '缺少 ' + key + ' 时不得打开相册');
  }

  // 串档：同名的场次/线路不能顶替原档案。
  resetWxLog();
  const otherArchivePage = openVideoPage(
    Object.assign({}, full, { archiveId: 'archive-of-another-profile' })
  );
  assert.match(otherArchivePage.data.contextError, /另一份本机档案/);
  otherArchivePage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0);

  // 同名异线：把次的 routeId 与入口不一致。
  const sameNameRoute = newRoute(flow.session, { name: '蓝色动态线' });
  const otherAttempt = record(flow.session, sameNameRoute, 'fail');
  resetWxLog();
  const sameNamePage = openVideoPage(
    Object.assign({}, full, { attemptId: otherAttempt.id })
  );
  assert.match(sameNamePage.data.contextError, /不属于这一场这一条线/);
  sameNamePage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0);
  assert.equal(attemptVideo.loadVideoContext(full).ok, true, 'B 自己的归属仍然有效');
});

test('T023-8 已撤回、还没保存与旧汇总都无法新挂片', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const undone = store.undoAttempt(flow.attemptB.id);
  assert.equal(undone.ok, true, undone.error);

  const undonePage = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });
  assert.match(undonePage.data.contextError, /已经撤回/);
  undonePage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0, '已撤回的把次不得打开相册');

  // 待保存：pendingSaves.opId 还不是已提交把次。
  const pendingOpId = 'op-pending-attempt';
  const raw = JSON.parse(storage.get(ARCHIVE_KEY));
  raw.pendingSaves.push({
    opId: pendingOpId,
    seq: raw.nextAttemptSeq,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'fail',
    note: '',
    createdAt: new Date('2026-11-12T09:45:00').toISOString()
  });
  storage.set(ARCHIVE_KEY, JSON.stringify(raw));
  resetWxLog();
  const pendingPage = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: pendingOpId
  });
  assert.match(pendingPage.data.contextError, /还没有保存成功/);
  pendingPage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0, '待保存的操作不得打开相册');

  // 旧汇总：旧云记录没有本机把次，按不在本机档案处理。
  const legacyPage = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: 'legacy-cloud-attempt-1'
  });
  assert.match(legacyPage.data.contextError, /旧汇总|不在本机训练档案/);
  legacyPage.choosePreview();
  assert.equal(wxLog.chooseCalls.length, 0);
});

test('T023-9 连点只发一次选择器，迟到回调与离页不影响其他把次', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });

  choosePending();
  page.choosePreview();
  page.choosePreview(); // 连点：选择器已经打开，不再发第二个请求
  assert.equal(wxLog.chooseCalls.length, 1, '连点只能发一次 wx.chooseMedia');
  assert.equal(page.data.choosing, true);

  const pending = wxLog.chooseCalls[0];
  page.onUnload();
  pending.success({ tempFiles: [VIDEO_A] });
  assert.equal(page.data.hasPreview, false, '离页后的迟到回调不得建立预览');
  assert.equal(page.data.choosing, true, '页面已销毁，不再改自己的状态');
  assert.equal(wxLog.storageWrites, 0);

  // 另一页给 A 选片：只影响 A 自己的页面，B 与档案都不动。
  resetWxLog();
  const pageForA = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptA.id
  });
  chooseSuccess(VIDEO_B);
  pageForA.choosePreview();
  assert.equal(pageForA.data.attempt.id, flow.attemptA.id);
  assert.equal(pageForA.data.preview.tempFilePath, VIDEO_B.tempFilePath);
  assert.equal(page.data.hasPreview, false, 'A 的选择不会出现在 B 的页面实例上');

  // 取消后新的一次选择生效，取消前发起的迟到回调不再覆盖它。
  choosePending();
  pageForA.choosePreview();
  const stale = wxLog.chooseCalls[wxLog.chooseCalls.length - 1];
  pageForA.cancelPreview();
  chooseSuccess(VIDEO_A);
  pageForA.choosePreview();
  assert.equal(pageForA.data.preview.tempFilePath, VIDEO_A.tempFilePath);
  stale.success({ tempFiles: [VIDEO_B] });
  assert.equal(
    pageForA.data.preview.tempFilePath,
    VIDEO_A.tempFilePath,
    '取消前的旧回调不能覆盖新选择'
  );
  assert.equal(wxLog.storageWrites, 0);
});

test('T023-10 选片前后都按最新档案核对：这一把被撤回就不再采用预览', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });

  choosePending();
  page.choosePreview();
  const pending = wxLog.chooseCalls[0];

  // 选择器打开期间这一把被撤回：回调到达时按最新档案拒绝。
  assert.equal(store.undoAttempt(flow.attemptB.id).ok, true);
  pending.success({ tempFiles: [VIDEO_A] });
  assert.equal(page.data.hasPreview, false);
  assert.match(page.data.contextError, /已经撤回/);
  assert.equal(page.data.attempt, null);

  // 再次点击也不会打开相册。
  const callsBefore = wxLog.chooseCalls.length;
  page.choosePreview();
  assert.equal(wxLog.chooseCalls.length, callsBefore);

  // 已有预览时被撤回：页面重新显示按最新档案收起预览。
  const other = seedTwoAttempts();
  resetWxLog();
  const previewPage = openVideoPage({
    archiveId: other.archiveId,
    sessionId: other.session.id,
    routeId: other.route.id,
    attemptId: other.attemptB.id
  });
  chooseSuccess(VIDEO_A);
  previewPage.choosePreview();
  assert.equal(previewPage.data.hasPreview, true);
  assert.equal(store.undoAttempt(other.attemptB.id).ok, true);
  previewPage.onShow();
  assert.equal(previewPage.data.hasPreview, false, '刷新后不再保留失效把次的预览');
  assert.match(previewPage.data.contextError, /已经撤回/);
});

test('T023-11 本单不创建持久文件或索引：运行期零写入，源码不触碰文件系统', () => {
  const flow = seedTwoAttempts();
  resetWxLog();
  const rawBefore = rawArchive();
  const keysBefore = [...storage.keys()].sort();

  const page = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });
  chooseSuccess(VIDEO_A);
  page.choosePreview();
  page.cancelPreview();
  page.cancelPreview();
  page.choosePreview();

  // 两处列表入口也只是读索引。
  openAttemptsPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  openRoutePage(flow.route.id, flow.archiveId);

  assert.equal(wxLog.storageWrites, 0, '运行期没有任何 storage 写入');
  assert.equal(rawArchive(), rawBefore, '训练档案逐字节不变');
  assert.deepEqual([...storage.keys()].sort(), keysBefore, '没有新增任何本机键');
  assert.equal(storage.has(attemptVideo.VIDEO_INDEX_KEY), false, '视频索引键不被创建');

  for (const file of [VIDEO_JS, VIDEO_UTIL, ATTEMPTS_JS, ROUTE_JS]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(
      source,
      /getFileSystemManager|saveFile|copyFile|writeFile|unlink|mkdir/,
      name + ' 本单不得触碰文件系统'
    );
    assert.doesNotMatch(source, /setStorageSync/, name + ' 本单不得写 storage');
    assert.doesNotMatch(
      source,
      /uploadFile|downloadFile|wx\.cloud/,
      name + ' 不得上传、下载或调用云能力'
    );
  }
});

test('T023-12 WXML 入口绑定真实处理器，状态与四个 ID 都来自渲染行', () => {
  const attemptsWxml = fs.readFileSync(ATTEMPTS_WXML, 'utf8');
  const routeWxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  const videoWxml = fs.readFileSync(VIDEO_WXML, 'utf8');

  assert.match(attemptsWxml, /catchtap="openAttemptVideo"/, '视频入口必须止住整行补备注的冒泡');
  assert.match(attemptsWxml, /data-attempt-id="\{\{item\.id\}\}"/);
  assert.match(attemptsWxml, /\{\{item\.videoStateText\}\}/);
  assert.match(attemptsWxml, /\{\{item\.videoEntryText\}\}/);
  assert.equal(typeof attemptsDefinition.openAttemptVideo, 'function');
  assert.equal(typeof attemptsDefinition.openNoteEditor, 'function', '整行补备注入口保留');

  assert.match(routeWxml, /bindtap="openAttemptVideoFromHistory"/);
  assert.match(routeWxml, /data-attempt-id="\{\{attempt\.id\}\}"/);
  assert.match(routeWxml, /data-session-id="\{\{item\.sessionId\}\}"/);
  assert.match(routeWxml, /data-route-id="\{\{route\.id\}\}"/);
  assert.match(routeWxml, /\{\{attempt\.videoStateText\}\}/);
  assert.equal(typeof routeDefinition.openAttemptVideoFromHistory, 'function');

  for (const handler of new Set(handlersIn(videoWxml))) {
    assert.equal(typeof videoDefinition[handler], 'function', '视频页绑定缺少处理器：' + handler);
  }
  for (const required of [
    'retryLoad',
    'backToList',
    'choosePreview',
    'cancelPreview',
    'dismissChooseError',
    'dismissNotice'
  ]) {
    assert.equal(typeof videoDefinition[required], 'function', required + ' 应为页面方法');
  }
  assert.match(videoWxml, /id="video-context-error"/);
  assert.match(videoWxml, /id="choose-video"/);
  assert.match(videoWxml, /id="cancel-preview"/);
  assert.match(videoWxml, /id="choose-error"/);
  assert.match(videoWxml, /\{\{chooseError\}\}/, '选择失败原因必须可见');
  assert.match(videoWxml, /\{\{videoStateText\}\}/, '关联状态必须可见');
  assert.match(videoWxml, /disabled="\{\{choosing\}\}"/);
});

test('T023-13 视频索引只读：T026 写入后列表与视频页自动显示已关联，损坏时不阻塞列表', () => {
  const flow = seedTwoAttempts();
  // 夹具修正：只有落在本档案视频根目录、且文件名就是该片段标识的条目才算已关联；
  // 用合法文件名伪装其他位置（旧夹具 video/v1/...）不再被当成有效所有权。
  const clip = {
    clipId: 'clip-0001',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id,
    rev: 1,
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-0001.mp4',
    bytes: 123456
  };
  writeVideoIndex([clip]);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  resetWxLog();

  const attemptsPage = openAttemptsPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  const rowA = attemptsPage.data.attempts.find(item => item.id === flow.attemptA.id);
  const rowB = attemptsPage.data.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(rowA.hasVideo, false);
  assert.equal(rowA.videoStateText, '未添加视频');
  assert.equal(rowB.hasVideo, true);
  assert.equal(rowB.videoStateText, '已添加视频');
  assert.equal(rowB.videoEntryText, '看视频 ›');

  const routePage = openRoutePage(flow.route.id, flow.archiveId);
  const historyRow = routePage.data.groups[0].attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(historyRow.hasVideo, true);
  assert.equal(historyRow.videoEntryText, '看视频 ›');

  const videoPage = openVideoPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id
  });
  assert.equal(videoPage.data.hasSavedVideo, true);
  assert.equal(videoPage.data.videoStateText, '已添加视频');

  assert.equal(wxLog.storageWrites, 0, '读索引不等于写索引');
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw, '索引逐字节不变');

  // 索引损坏：列表仍能打开，只把关联状态标成不可读，训练数据不受影响。
  storage.set(attemptVideo.VIDEO_INDEX_KEY, '{');
  const degraded = openAttemptsPage({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  assert.equal(degraded.data.contextError, '');
  assert.equal(degraded.data.attempts.length, 2);
  for (const row of degraded.data.attempts) {
    assert.equal(row.hasVideo, false);
    assert.equal(row.videoStateText, '视频关联不可读');
  }
  assert.equal(
    openRoutePage(flow.route.id, flow.archiveId).data.groups[0].attempts[0].videoStateText,
    '视频关联不可读'
  );
});

test('T047 视频空态：先预览、确认后保存本机副本，保存与取消维持原绑定', () => {
  const videoWxml = fs.readFileSync(VIDEO_WXML, 'utf8');
  const emptyStart = videoWxml.indexOf('wx:if="{{!hasSavedVideo && !hasPreview}}"');
  const emptyEnd = videoWxml.indexOf('video-foot-hint');
  assert.ok(emptyStart !== -1 && emptyStart < emptyEnd, '缺空态选片卡');
  const emptyCard = videoWxml.slice(emptyStart, emptyEnd);

  assert.match(emptyCard, /id="video-choose"/);
  assert.match(emptyCard, /从相册选一段视频/, '空态标题保留');
  assert.match(
    emptyCard,
    /选片后先预览。确认后在这台手机的攀笔里保存一份副本/,
    '空态先说先预览、再说确认后保存本机副本'
  );
  assert.match(emptyCard, /只选视频、单选、只从相册取/, '相册单选口径保留');
  assert.match(emptyCard, /保存前不会写入本机，也不上传/, '保存前不落盘、不上传的说明保留');
  assert.match(emptyCard, /id="choose-video"/);
  assert.match(emptyCard, /bindtap="choosePreview"/);

  // 保存按钮文案仍是「保存到攀笔」；保存、取消与播放/移除的绑定不变。
  assert.match(videoWxml, /id="commit-preview"[\s\S]{0,300}保存到攀笔/, '保存按钮仍写「保存到攀笔」');
  assert.match(videoWxml, /id="cancel-preview"/);
  assert.match(videoWxml, /bindtap="commitPreview"/);
  assert.match(videoWxml, /bindtap="cancelPreview"/);
  assert.match(videoWxml, /bindtap="togglePlay"/);
  assert.match(videoWxml, /bindtap="askRemove"/);
});

test('T049 视频页在回看、无片与保存前都写明本机保存位置与相册原片保留', () => {
  const videoWxml = fs.readFileSync(VIDEO_WXML, 'utf8');
  const savedAt = videoWxml.indexOf('id="video-saved"');
  const previewAt = videoWxml.indexOf('id="video-preview"');
  const emptyAt = videoWxml.indexOf('id="video-choose"');
  assert.ok(savedAt !== -1 && savedAt < previewAt && previewAt < emptyAt, '三段说明都在');

  // 回看已保存副本时也说明：副本只在这台手机微信的攀笔中，不上传，相册原片保留。
  assert.match(videoWxml.slice(savedAt, previewAt), /id="saved-storage-hint"[\s\S]{0,120}视频副本保存在这台手机微信里的攀笔中，不上传云端。系统相册里的原片保留。/, '已保存卡片写明本机位置');

  // 无片空态与保存前预览维持同一口径：先说预览、再说确认后保存本机副本。
  assert.match(
    videoWxml.slice(emptyAt),
    /id="choose-empty-hint"[\s\S]{0,160}确认后在这台手机的攀笔里保存一份副本/,
    '无片空态写明本机保存位置'
  );
  assert.match(
    videoWxml,
    /id="preview-save-hint"[^>]*>视频副本保存在这台手机微信里的攀笔中，不上传云端。/,
    '保存前预览写明本机保存位置'
  );

  // 移除仍是明确的两步操作，只移除这台手机上的副本，相册原片、记录与备注保留。
  assert.match(
    videoWxml,
    /只移除这台手机微信的攀笔中的视频副本；系统相册里的原片、这一把的记录与备注都保留。/,
    '移除确认沿用同一份本机与相册原片口径'
  );
  // 这些说明都是页面静态文案：不新增存储键、字段或页面方法。
  const videoJs = fs.readFileSync(VIDEO_JS, 'utf8');
  assert.doesNotMatch(videoJs, /saved-storage-hint|storageHint/, '不靠额外数据字段拼说明');
});
