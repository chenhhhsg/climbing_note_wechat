/**
 * T024 逐把视频 · 原生播放、更换与移除的离线回归测试
 *
 * 直接加载真实页面（pages/attempt-video、pages/training-attempts、pages/training-route）、
 * 真实工具模块（utils/attempt-video、utils/attempt-video-playback、utils/training-store），
 * 用隔离的微信本地存储替身、可控相册选择器、可控 videoContext 与注入的持久层接口
 * （T026 的替身，直接写测试索引）驱动真实页面处理器。
 *
 * 覆盖任务单的验收口径：
 * - 待确认与已保存片源都能播放、暂停；已保存片源按相对文件标识拼出本机路径；
 * - 缺失或损坏的文件给出可见的重选提示，原把次、备注与关联都还在；
 * - 更换先预览，取消回到同一段旧片，且不创建文件、不改索引；
 * - 保存/更换/移除的忙碌、失败、成功状态；成功以读回的索引为准（回执丢了但
 *   索引已到目标状态也算成功，回执成功而索引没变算未确认）；
 * - 迟到回执、迟到视频事件、离页与换把都不覆盖另一片源、把次或页面；
 * - 写入后返回明细与跨日历史，按已提交关联刷新。
 *
 * 真实解码、真机相册与 T026 实际写入的副本交给整项 QA 与手机复验（待验）。
 *
 * 运行：node --test tests/attempt-video-playback.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const VIDEO_DIR = path.join(ROOT, 'pages', 'attempt-video');
const VIDEO_JS = path.join(VIDEO_DIR, 'attempt-video.js');
const VIDEO_WXML = path.join(VIDEO_DIR, 'attempt-video.wxml');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const PLAYBACK_UTIL = path.join(ROOT, 'utils', 'attempt-video-playback.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const USER_DATA_PATH = 'wxfile://usr';

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

// ---- 微信替身：本地存储、相册、导航、videoContext 与调用计数 ----
const storage = new Map();
const wxLog = {
  chooseCalls: [],
  chooseArgs: [],
  chooseHandler: null,
  navigations: [],
  storageWrites: 0,
  videoContexts: [],
  fileManagerCalls: 0
};

function resetWxLog() {
  wxLog.chooseCalls = [];
  wxLog.chooseArgs = [];
  wxLog.chooseHandler = null;
  wxLog.navigations = [];
  wxLog.storageWrites = 0;
  wxLog.videoContexts = [];
  wxLog.fileManagerCalls = 0;
}

function resetDevice() {
  storage.clear();
  resetWxLog();
}

global.wx = {
  env: { USER_DATA_PATH },
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
  getFileSystemManager() {
    wxLog.fileManagerCalls += 1;
    return {};
  },
  createVideoContext(domId) {
    const context = {
      domId,
      calls: [],
      play() {
        context.calls.push('play');
      },
      pause() {
        context.calls.push('pause');
      }
    };
    wxLog.videoContexts.push(context);
    return context;
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
const playback = require(PLAYBACK_UTIL);

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

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lastVideoContext() {
  return wxLog.videoContexts[wxLog.videoContexts.length - 1] || null;
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

function seedTwoAttempts() {
  const session = startAt('2026-11-12', '同线岩馆');
  const route = newRoute(session);
  const attemptA = record(session, route, 'fail', 'A 把的备注');
  const attemptB = record(session, route, 'fail', 'B 把的备注');
  const archive = archiveOf();
  return { session, route, attemptA, attemptB, archiveId: archive.archiveId };
}

function idsOf(flow, attempt) {
  return {
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: attempt.id
  };
}

function writeClips(clips) {
  storage.set(attemptVideo.VIDEO_INDEX_KEY, JSON.stringify({ version: 1, clips }));
}

function writeClip(flow, attempt, overrides) {
  const clip = Object.assign(
    {
      clipId: 'clip-0001',
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      attemptId: attempt.id,
      rev: 1,
      fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-0001.mp4',
      bytes: 640 * 1024
    },
    overrides || {}
  );
  writeClips([clip]);
  return clip;
}

function openVideoPage(ids) {
  const page = createPage(videoDefinition);
  page.onLoad(ids);
  return page;
}

function openAttemptsPage(ids) {
  const page = createPage(attemptsDefinition);
  page.onLoad({
    archiveId: ids.archiveId,
    sessionId: ids.sessionId,
    routeId: ids.routeId
  });
  return page;
}

function openRoutePage(routeId, archiveId) {
  const page = createPage(routeDefinition);
  page.onLoad({ routeId, archiveId });
  return page;
}

// ---- 相册替身 ----
function chooseSuccess(file) {
  wxLog.chooseHandler = options => {
    options.success({ tempFiles: [file || VIDEO_A], type: 'video' });
  };
}

function choosePending() {
  wxLog.chooseHandler = () => {};
}

// ---- 持久层替身（T026 的位置，测试里直接写索引模拟已提交） ----
function installStore(handlers) {
  const config = handlers || {};
  const calls = [];
  playback.setVideoStore({
    calls,
    commit(request) {
      calls.push({ method: 'commit', request });
      return config.commit ? config.commit(request, calls) : { ok: true };
    },
    replace(request) {
      calls.push({ method: 'replace', request });
      return config.replace ? config.replace(request, calls) : { ok: true };
    },
    remove(request) {
      calls.push({ method: 'remove', request });
      return config.remove ? config.remove(request, calls) : { ok: true };
    }
  });
  return calls;
}

/** 当前播放器节点的视频事件：dataset 带当前 token。 */
function videoEvent(page, detail) {
  const instance = page.data.videoInstances[0];
  return {
    currentTarget: { dataset: { videoToken: instance ? instance.token : '' } },
    detail: detail || {}
  };
}

function staleVideoEvent(token, detail) {
  return {
    currentTarget: { dataset: { videoToken: token || '' } },
    detail: detail || {}
  };
}

beforeEach(() => {
  resetDevice();
  playback.setVideoStore(null);
});

// ------------------------------------------------------------------ *
// 播放器与路径判定
// ------------------------------------------------------------------ */

test('T024-1 已保存片源按相对文件标识拼接本机路径，拒绝逃逸写法', () => {
  const clip = {
    clipId: 'clip-0001',
    rev: 1,
    fileId: 'attempt-video/v1/archive-1/clip-0001.mp4',
    bytes: 2048
  };
  const resolved = playback.savedSourceFromClip(clip, { userDataPath: USER_DATA_PATH });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source.kind, playback.KIND_SAVED);
  assert.equal(resolved.source.src, USER_DATA_PATH + '/attempt-video/v1/archive-1/clip-0001.mp4');
  assert.equal(resolved.source.sizeText, '2.0 KB');
  assert.equal(resolved.source.fileName, 'clip-0001.mp4');

  for (const bad of [
    '/etc/passwd.mp4',
    'http://usr/clip.mp4',
    'C:/clip.mp4',
    '../outside/clip.mp4',
    'a/../../b.mp4',
    'a//b.mp4',
    ''
  ]) {
    const result = playback.savedSourceFromClip(
      { clipId: 'clip-0001', rev: 1, fileId: bad, bytes: 1 },
      { userDataPath: USER_DATA_PATH }
    );
    assert.equal(result.ok, false, '不接受的文件标识：' + bad);
    assert.ok(result.error, '拒绝时要有可见原因');
  }

  assert.equal(
    playback.savedSourceFromClip({ fileId: 'a/b.mp4' }, { userDataPath: USER_DATA_PATH }).ok,
    false,
    '缺少片段标识也无法播放'
  );

  const savedEnv = global.wx.env;
  global.wx.env = {};
  try {
    const noRoot = playback.savedSourceFromClip(clip, {});
    assert.equal(noRoot.ok, false);
    assert.match(noRoot.error, /用户目录/);
  } finally {
    global.wx.env = savedEnv;
  }

  // 预览只看临时路径。
  assert.equal(playback.previewSourceFromPreview({}).ok, false);
  const preview = playback.previewSourceFromPreview({
    tempFilePath: VIDEO_A.tempFilePath,
    sizeBytes: VIDEO_A.size,
    sizeText: '2.5 MB',
    durationText: '12.4',
    dimensionText: '1920×1080',
    fileName: 'a.mp4'
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.source.kind, playback.KIND_PREVIEW);
  assert.equal(preview.source.src, VIDEO_A.tempFilePath);
});

test('T024-1b 索引里残留多条片段时按版本号取当前片段，不播放被替换的旧副本', () => {
  const flow = seedTwoAttempts();
  const oldClip = writeClip(flow, flow.attemptB, { clipId: 'clip-old', rev: 1 });
  const newClip = {
    clipId: 'clip-new',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id,
    rev: 2,
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-new.mp4',
    bytes: 1024
  };

  writeClips([oldClip, newClip]);
  assert.equal(
    attemptVideo.videoClipView(flow.archiveId, flow.attemptB.id).clip.clipId,
    'clip-new',
    '旧条目在前、新条目在后：取版本更大的'
  );

  writeClips([newClip, oldClip]);
  const view = attemptVideo.videoClipView(flow.archiveId, flow.attemptB.id);
  assert.equal(view.clip.clipId, 'clip-new', '新条目在前、旧条目在后：仍取版本更大的');

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  assert.equal(page.data.savedVideo.clipId, 'clip-new');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + newClip.fileId);
});

test('T024-2 片源 token 与视频事件归属判定', () => {
  const token = playback.sourceToken('archive|session|route|attempt', 3);
  assert.equal(token, 'archive|session|route|attempt#3');
  assert.equal(playback.sourceToken('', 1), 'no-context#1');
  assert.equal(playback.videoDomId(3), 'attempt-video-player-3');

  assert.equal(
    playback.isCurrentVideoEvent(staleVideoEvent(token), token),
    true
  );
  assert.equal(
    playback.isCurrentVideoEvent(staleVideoEvent('old#1'), token),
    false,
    '旧节点的迟到事件必须丢弃'
  );
  assert.equal(
    playback.isCurrentVideoEvent({ currentTarget: { dataset: {} } }, ''),
    false,
    '没有 token 的事件不采用'
  );

  assert.equal(playback.toggleCommand(false), 'play');
  assert.equal(playback.toggleCommand(true), 'pause');

  const meta = playback.metadataPatch({ duration: 12.345, width: 1920, height: 1080 });
  assert.equal(meta.playerReady, true);
  assert.equal(meta.playerDurationText, '12.35');
  assert.equal(meta.playerDimensionText, '1920×1080');
  assert.equal(playback.metadataPatch({}).playerReady, false);

  assert.match(playback.playbackErrorMessage('MEDIA_ERR', playback.KIND_SAVED), /重新选择原片/);
  assert.match(playback.playbackErrorMessage('MEDIA_ERR', playback.KIND_PREVIEW), /重新选择/);
});

test('T024-3 成功以读回的索引为准：回执丢失但已提交算成功，回执成功但索引没变算未确认', () => {
  const before = { clipId: 'clip-old', rev: 1 };
  const readOld = { ok: true, clip: before };
  const readNew = { ok: true, clip: { clipId: 'clip-new', rev: 2 } };
  const readRevBump = { ok: true, clip: { clipId: 'clip-old', rev: 2 } };
  const readNone = { ok: true, clip: null };
  const readBroken = { ok: false, error: '索引不可读' };

  assert.equal(playback.evaluateOperation('commit', null, { ok: true }, readNew).ok, true);
  assert.equal(playback.evaluateOperation('commit', null, { ok: true }, readNone).code, 'unconfirmed');
  assert.equal(playback.evaluateOperation('commit', null, { ok: true }, readBroken).code, 'unconfirmed');
  assert.equal(
    playback.evaluateOperation('commit', null, { ok: false, error: '写失败' }, readBroken).code,
    'failed'
  );

  const unchanged = playback.evaluateOperation('replace', before, { ok: true }, readOld);
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, 'unconfirmed');

  const changed = playback.evaluateOperation('replace', before, { ok: true }, readNew);
  assert.equal(changed.ok, true);
  assert.equal(changed.receiptLost, false);

  const revBump = playback.evaluateOperation('replace', before, { ok: true }, readRevBump);
  assert.equal(revBump.ok, true, '同一片段标识但版本号变大也算已提交');

  const lostReceipt = playback.evaluateOperation('replace', before, { ok: false, error: '回执丢失' }, readNew);
  assert.equal(lostReceipt.ok, true, '回执失败但索引已到目标状态：按读回算成功');
  assert.equal(lostReceipt.receiptLost, true);

  const failed = playback.evaluateOperation('replace', before, { ok: false, error: '磁盘已满' }, readOld);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'failed');
  assert.match(failed.error, /磁盘已满/);

  const removed = playback.evaluateOperation('remove', before, { ok: false, error: '回执丢失' }, readNone);
  assert.equal(removed.ok, true);
  assert.equal(removed.receiptLost, true);
  assert.equal(playback.evaluateOperation('remove', before, { ok: true }, readOld).code, 'unconfirmed');
  assert.equal(playback.clipChanged(before, before), false);
  assert.equal(playback.clipChanged(before, { clipId: 'clip-old', rev: 2 }), true);
  assert.equal(playback.sameClipIdentity(before, { clipId: 'clip-old', rev: 1 }), true);
});

// ------------------------------------------------------------------ *
// 已保存片源：播放、暂停与错误重选
// ------------------------------------------------------------------ */

test('T024-4 已保存片源可播放、暂停，播放状态以播放器事件回报为准', () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, clip.clipId);
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + clip.fileId);
  assert.equal(page.data.playerTitle, '已保存视频（本机副本）');
  assert.equal(page.data.videoInstances.length, 1);
  assert.equal(page.data.playerReady, false);

  page.onVideoLoadedMetadata(videoEvent(page, { duration: 12.5, width: 1920, height: 1080 }));
  assert.equal(page.data.playerReady, true);
  assert.equal(page.data.playerDurationText, '12.50');
  assert.equal(page.data.playerDimensionText, '1920×1080');
  assert.equal(page.data.playbackError, '');

  page.togglePlay();
  const context = lastVideoContext();
  assert.ok(context, '应为当前节点创建 videoContext');
  assert.deepEqual(context.calls, ['play']);
  assert.equal(page.data.playing, false, '请求播放后仍等播放器回报');
  assert.match(page.data.playerStatus, /正在请求播放/);

  page.onVideoPlay(videoEvent(page, {}));
  assert.equal(page.data.playing, true);
  assert.equal(page.data.playerStatus, '正在播放');

  page.togglePlay();
  assert.deepEqual(context.calls, ['play', 'pause']);
  page.onVideoPause(videoEvent(page, {}));
  assert.equal(page.data.playing, false);
  assert.equal(page.data.playerStatus, '已暂停');

  // 播放与暂停不改索引，也不写 storage。
  assert.equal(wxLog.storageWrites, 0);
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw);
  assert.equal(rawArchive(), storage.get(ARCHIVE_KEY));
  assert.equal(wxLog.fileManagerCalls, 0, '本单不触碰文件系统');
});

test('T024-5 文件缺失或损坏：可见重选提示，原把次与关联都在；索引损坏不吞掉播放器', () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  const archiveRaw = rawArchive();
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  page.onVideoLoadedMetadata(videoEvent(page, { duration: 10 }));
  page.onVideoError(videoEvent(page, { errMsg: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }));

  assert.match(page.data.playbackError, /打不开/);
  assert.match(page.data.playbackError, /重新选择原片/);
  assert.equal(page.data.playing, false);
  assert.equal(page.data.playerReady, false);
  assert.equal(page.data.attempt.id, flow.attemptB.id, '原把次仍可访问');
  assert.equal(page.data.attempt.note, 'B 把的备注');
  assert.equal(page.data.hasSavedVideo, true, '播放错误不清掉关联');
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw, '播放错误不改索引');
  assert.equal(rawArchive(), archiveRaw, '播放错误不改训练档案');

  // 重选入口进入更换预览：旧关联在确认前不动。
  chooseSuccess(VIDEO_A);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.mode, 'replacement');
  assert.equal(page.data.playerSrc, VIDEO_A.tempFilePath);
  assert.equal(page.data.playbackError, '', '换片后清掉旧片的播放失败提示');

  page.cancelReplace();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + clip.fileId);
  assert.match(page.data.notice, /没有创建或删除任何文件/);
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw, '取消不改索引');

  // 索引损坏：保留当前片源，只提示关联无法确认，原把次仍可读。
  const brokenPage = openVideoPage(idsOf(flow, flow.attemptB));
  assert.equal(brokenPage.data.playerKind, 'saved');
  storage.set(attemptVideo.VIDEO_INDEX_KEY, '{');
  brokenPage.onShow();
  assert.match(brokenPage.data.indexError, /索引/);
  assert.equal(brokenPage.data.playerSrc, USER_DATA_PATH + '/' + clip.fileId, '索引读不出时不收起播放器');
  assert.equal(brokenPage.data.attempt.id, flow.attemptB.id);
});

// ------------------------------------------------------------------ *
// 更换：先预览、取消回旧片、确认后按读回切换
// ------------------------------------------------------------------ */

test('T024-6 更换先预览：确认前不改关联，取消回到同一段旧片且不创建文件', () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  const calls = installStore({});
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  const savedToken = page.data.playerToken;

  chooseSuccess(VIDEO_B);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.mode, 'replacement');
  assert.equal(page.data.preview.replacementOf, clip.clipId);
  assert.equal(page.data.playerKind, 'preview');
  assert.equal(page.data.playerSrc, VIDEO_B.tempFilePath);
  assert.notEqual(page.data.playerToken, savedToken, '换片必须换新的视频节点 token');
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, clip.clipId, '已保存信息保持原片段');

  // 待确认的新片也能播放/暂停：请求发给当前节点，状态等播放器回报。
  page.togglePlay();
  const previewContext = lastVideoContext();
  assert.deepEqual(previewContext.calls, ['play']);
  page.onVideoPlay(videoEvent(page, {}));
  assert.equal(page.data.playing, true);
  page.togglePlay();
  assert.deepEqual(previewContext.calls, ['play', 'pause']);
  page.onVideoPause(videoEvent(page, {}));
  assert.equal(page.data.playing, false);

  // 仍在预览：没有写入、没有删文件、没有调用持久层。
  assert.equal(calls.length, 0);
  assert.equal(wxLog.storageWrites, 0);
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw);
  assert.equal(wxLog.fileManagerCalls, 0);

  page.cancelReplace();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + clip.fileId);
  assert.notEqual(page.data.playerToken, savedToken, '取消后重建当前节点的 token');
  assert.equal(page.data.playing, false, '换回旧片时重置播放状态');
  assert.equal(page.data.savedVideo.clipId, clip.clipId);
  assert.match(page.data.notice, /仍使用原来那段视频/);
  assert.equal(calls.length, 0, '取消不调用持久层');
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw);
});

test('T024-7 确认更换：忙碌态可见，成功后按读回的新片段切播放器，旧片不再显示', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const deferred = makeDeferred();
  const newClip = Object.assign({}, clip, {
    clipId: 'clip-0002',
    rev: 2,
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-0002.mp4',
    bytes: VIDEO_B.size
  });
  const calls = installStore({
    replace(request) {
      assert.equal(request.action, 'replace');
      assert.equal(request.archiveId, flow.archiveId);
      assert.equal(request.sessionId, flow.session.id);
      assert.equal(request.routeId, flow.route.id);
      assert.equal(request.attemptId, flow.attemptB.id);
      assert.equal(request.clipId, clip.clipId, '请求里带上原片段标识');
      assert.equal(request.rev, 1);
      assert.equal(request.tempFilePath, VIDEO_B.tempFilePath);
      assert.equal(request.sizeBytes, VIDEO_B.size);
      return deferred.promise;
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_B);
  page.choosePreview();
  page.confirmReplace();

  assert.equal(page.data.busy, true);
  assert.equal(page.data.opKind, 'replace');
  assert.match(page.data.opStatus, /正在写入新副本并提交更换/);
  assert.equal(page.data.opError, '');

  // 忙碌时不再受理其他选择或取消。
  const chooseCallsBefore = wxLog.chooseCalls.length;
  page.choosePreview();
  page.cancelReplace();
  page.cancelPreview();
  page.commitPreview();
  page.askRemove();
  assert.equal(wxLog.chooseCalls.length, chooseCallsBefore, '忙碌时不打开相册');
  assert.equal(page.data.hasPreview, true, '忙碌时取消不受理');
  assert.equal(page.data.confirmRemove, false);

  // 持久层写入新副本并提交索引，然后回执。
  writeClips([newClip]);
  deferred.resolve({ ok: true });
  await tick();

  assert.equal(page.data.busy, false);
  assert.equal(page.data.opKind, '');
  assert.equal(page.data.opStatus, '');
  assert.equal(page.data.opError, '');
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.preview, null);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.videoStateText, '已添加视频');
  assert.equal(page.data.savedVideo.clipId, 'clip-0002');
  assert.equal(page.data.savedVideo.revText, '2');
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + newClip.fileId);
  assert.match(page.data.notice, /已更换为新的本机副本/);
  assert.equal(calls.length, 1);
});

test('T024-8 更换失败保留旧片与预览：失败原因可见，可重试', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  const calls = installStore({
    replace() {
      return { ok: false, error: '本机空间不足' };
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_B);
  page.choosePreview();
  page.confirmReplace();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.opKind, '');
  assert.match(page.data.opError, /本机空间不足/);
  assert.match(page.data.opError, /可以重试/);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, clip.clipId, '旧关联不动');
  assert.equal(page.data.hasPreview, true, '预览保留，允许重试');
  assert.equal(page.data.playerKind, 'preview');
  assert.equal(page.data.playerSrc, VIDEO_B.tempFilePath);
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw, '失败不写索引');
});

test('T024-9 回执成功但索引没变：按未确认处理，不假装已更换', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  installStore({
    replace() {
      return { ok: true };
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_B);
  page.choosePreview();
  page.confirmReplace();
  await tick();

  assert.equal(page.data.busy, false);
  assert.match(page.data.opError, /结果未确认/);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, clip.clipId);
  assert.equal(page.data.hasPreview, true, '未确认时保留预览，可重新核对');
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw);
});

test('T024-10 迟到回执不能覆盖离页或已撤回的把次，也不改另一片源', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const first = makeDeferred();
  installStore({ replace: () => first.promise });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_B);
  page.choosePreview();
  page.confirmReplace();
  const srcBefore = page.data.playerSrc;
  page.onUnload();

  writeClips([
    Object.assign({}, clip, {
      clipId: 'clip-late',
      rev: 2,
      fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-late.mp4'
    })
  ]);
  first.resolve({ ok: true });
  await tick();

  assert.equal(page.data.playerSrc, srcBefore, '离页后迟到回执不改页面');
  assert.equal(page.data.notice, '');
  assert.equal(page.data.busy, true, '页面已销毁，不再进入成功态');

  // 换一个页面：写入期间这一把被撤回，迟到回执不把视频挂回去。
  const second = makeDeferred();
  installStore({ replace: () => second.promise });
  const live = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_A);
  live.choosePreview();
  live.confirmReplace();
  assert.equal(live.data.busy, true);
  assert.equal(store.undoAttempt(flow.attemptB.id).ok, true);
  second.resolve({ ok: true });
  await tick();

  assert.match(live.data.contextError, /已经撤回/);
  assert.equal(live.data.attempt, null);
  assert.equal(live.data.hasPreview, false);
  assert.equal(live.data.busy, false, '失效归属清掉忙碌态，但不显示成功');
  assert.equal(live.data.notice, '');
});

test('T024-11 迟到的 ready / play / pause / error 不能覆盖另一片源', () => {
  const flow = seedTwoAttempts();
  writeClip(flow, flow.attemptB);
  const page = openVideoPage(idsOf(flow, flow.attemptB));
  const oldToken = page.data.playerToken;

  chooseSuccess(VIDEO_A);
  page.choosePreview();
  const newToken = page.data.playerToken;
  assert.notEqual(newToken, oldToken);

  page.onVideoPlay(staleVideoEvent(oldToken));
  page.onVideoPause(staleVideoEvent(oldToken));
  page.onVideoError(staleVideoEvent(oldToken, { errMsg: 'MEDIA_ERR_DECODE' }));
  page.onVideoLoadedMetadata(staleVideoEvent(oldToken, { duration: 4, width: 10, height: 10 }));

  assert.equal(page.data.playing, false, '旧节点的 play 不生效');
  assert.equal(page.data.playbackError, '', '旧节点的 error 不生效');
  assert.equal(page.data.playerReady, false, '旧节点的 metadata 不生效');
  assert.equal(page.data.playerSrc, VIDEO_A.tempFilePath);

  page.onVideoPlay(videoEvent(page, {}));
  assert.equal(page.data.playing, true, '当前节点的事件生效');
  page.togglePlay();
  assert.deepEqual(lastVideoContext().calls, ['pause'], '上下文跟随当前节点');
});

// ------------------------------------------------------------------ *
// 移除与首次保存
// ------------------------------------------------------------------ */

test('T024-12 移除经明确确认：成功后清关联与播放器，原把次和备注仍在', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const archiveRaw = rawArchive();
  let removedRequest = null;
  const calls = installStore({
    remove(request) {
      removedRequest = request;
      // 模拟 T026：先解除关联（旧文件回收由它负责），页面只认读回结果。
      writeClips([]);
      return { ok: true };
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  page.askRemove();
  assert.equal(page.data.confirmRemove, true);
  page.cancelRemove();
  assert.equal(page.data.confirmRemove, false);
  assert.equal(calls.length, 0, '取消不调用持久层');

  page.askRemove();
  page.confirmRemove();
  assert.equal(page.data.busy, true);
  assert.equal(page.data.opKind, 'remove');
  assert.match(page.data.opStatus, /正在移除小程序内的副本/);
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(removedRequest.action, 'remove');
  assert.equal(removedRequest.clipId, clip.clipId);
  assert.equal(removedRequest.rev, 1);
  assert.equal(removedRequest.fileId, clip.fileId);
  assert.equal(removedRequest.attemptId, flow.attemptB.id);

  assert.equal(page.data.busy, false);
  assert.equal(page.data.confirmRemove, false);
  assert.equal(page.data.hasSavedVideo, false);
  assert.equal(page.data.videoStateText, '未添加视频');
  assert.equal(page.data.savedVideo, null);
  assert.equal(page.data.playerSrc, '');
  assert.equal(page.data.videoInstances.length, 0);
  assert.match(page.data.notice, /已移除小程序内的本机副本/);
  assert.match(page.data.notice, /系统相册里的原片都还在/);
  assert.equal(page.data.attempt.id, flow.attemptB.id, '原把次仍可访问');
  assert.equal(page.data.attempt.note, 'B 把的备注');
  assert.equal(rawArchive(), archiveRaw, '移除不改训练档案');
});

test('T024-13 移除失败保留旧片；回执丢了但索引已清空按读回算成功', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  const indexRaw = storage.get(attemptVideo.VIDEO_INDEX_KEY);
  installStore({
    remove() {
      return { ok: false, error: '文件被占用' };
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  page.askRemove();
  page.confirmRemove();
  await tick();

  assert.match(page.data.opError, /文件被占用/);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + clip.fileId);
  assert.equal(storage.get(attemptVideo.VIDEO_INDEX_KEY), indexRaw);

  // 回执丢失但索引已经没有这一把的片段：按读回算成功，并标明回执不明确。
  const lostPage = openVideoPage(idsOf(flow, flow.attemptB));
  installStore({
    remove() {
      writeClips([]);
      return { ok: false, error: '回执丢失' };
    }
  });
  lostPage.askRemove();
  lostPage.confirmRemove();
  await tick();

  assert.equal(lostPage.data.busy, false);
  assert.equal(lostPage.data.hasSavedVideo, false);
  assert.equal(lostPage.data.playerSrc, '');
  assert.match(lostPage.data.notice, /回执不明确/);
});

test('T024-14 首次保存：待确认片源可播放，确认后忙碌、成功并切到本机副本', async () => {
  const flow = seedTwoAttempts();
  const archiveRaw = rawArchive();
  const deferred = makeDeferred();
  const newClip = {
    clipId: 'clip-first',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attemptB.id,
    rev: 1,
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-first.mp4',
    bytes: VIDEO_A.size
  };
  const calls = installStore({
    commit(request) {
      assert.equal(request.action, 'commit');
      assert.equal(request.tempFilePath, VIDEO_A.tempFilePath);
      assert.equal(request.sizeBytes, VIDEO_A.size);
      assert.equal(request.durationSeconds, VIDEO_A.duration);
      assert.equal(request.width, VIDEO_A.width);
      assert.equal(request.height, VIDEO_A.height);
      assert.equal(request.archiveId, flow.archiveId);
      assert.equal(request.attemptId, flow.attemptB.id);
      return deferred.promise;
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  assert.equal(page.data.hasSavedVideo, false);
  assert.equal(page.data.playerSrc, '');

  chooseSuccess(VIDEO_A);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.mode, 'initial');
  assert.equal(page.data.playerKind, 'preview');
  assert.equal(page.data.playerSrc, VIDEO_A.tempFilePath);
  assert.equal(rawArchive(), archiveRaw, '选片不改训练档案');

  page.commitPreview();
  assert.equal(page.data.busy, true);
  assert.equal(page.data.opKind, 'commit');
  assert.match(page.data.opStatus, /正在写入本机副本并提交关联/);

  const chooseCallsBefore = wxLog.chooseCalls.length;
  page.choosePreview();
  page.cancelPreview();
  assert.equal(wxLog.chooseCalls.length, chooseCallsBefore);
  assert.equal(page.data.hasPreview, true, '写入期间取消不受理');

  writeClips([newClip]);
  deferred.resolve({ ok: true });
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, 'clip-first');
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + newClip.fileId);
  assert.match(page.data.notice, /已保存到本机/);
  assert.equal(rawArchive(), archiveRaw, '保存视频不改训练档案');
});

test('T024-15 保存服务未接入：给出可见失败，不伪造成成功，已有视频仍可播放', () => {
  const flow = seedTwoAttempts();
  writeClip(flow, flow.attemptB);
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  assert.equal(page.data.storeAvailable, false);
  assert.match(page.data.storeHint, /本机保存服务未就绪/);
  assert.equal(page.data.playerKind, 'saved');

  chooseSuccess(VIDEO_B);
  page.choosePreview();
  page.confirmReplace();
  assert.equal(page.data.busy, false);
  assert.match(page.data.opError, /本机保存服务未就绪/);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.playerSrc, VIDEO_B.tempFilePath, '预览仍可播放');

  // 首次保存同样不伪造成功。
  const other = seedTwoAttempts();
  const fresh = openVideoPage(idsOf(other, other.attemptA));
  chooseSuccess(VIDEO_A);
  fresh.choosePreview();
  fresh.commitPreview();
  assert.equal(fresh.data.busy, false);
  assert.match(fresh.data.opError, /本机保存服务未就绪/);
  assert.equal(fresh.data.hasSavedVideo, false);
  assert.equal(fresh.data.hasPreview, true);
});

// ------------------------------------------------------------------ *
// 提交后的列表刷新与包边界
// ------------------------------------------------------------------ */

test('T024-16 提交后返回明细与跨日历史，按已提交关联刷新', async () => {
  const flow = seedTwoAttempts();
  const clip = writeClip(flow, flow.attemptB);
  installStore({
    replace() {
      writeClips([
        Object.assign({}, clip, {
          clipId: 'clip-after',
          rev: 2,
          fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-after.mp4'
        })
      ]);
      return { ok: true };
    }
  });
  resetWxLog();

  const page = openVideoPage(idsOf(flow, flow.attemptB));
  chooseSuccess(VIDEO_A);
  page.choosePreview();
  page.confirmReplace();
  await tick();
  assert.equal(page.data.savedVideo.clipId, 'clip-after');

  const attemptsPage = openAttemptsPage(idsOf(flow, flow.attemptB));
  const rowA = attemptsPage.data.attempts.find(item => item.id === flow.attemptA.id);
  const rowB = attemptsPage.data.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(rowA.hasVideo, false, 'A 没有因为 B 得到关联');
  assert.equal(rowB.hasVideo, true);
  assert.equal(rowB.videoStateText, '已添加视频');
  assert.equal(rowB.videoEntryText, '看视频 ›');

  const routePage = openRoutePage(flow.route.id, flow.archiveId);
  const historyRow = routePage.data.groups[0].attempts.find(
    item => item.id === flow.attemptB.id
  );
  assert.equal(historyRow.hasVideo, true);
  assert.equal(historyRow.videoEntryText, '看视频 ›');
});

test('T024-17 WXML 绑定真实处理器：原生 video 事件、播放按钮与显式操作', () => {
  const wxml = fs.readFileSync(VIDEO_WXML, 'utf8');

  for (const handler of new Set(handlersIn(wxml))) {
    assert.equal(typeof videoDefinition[handler], 'function', '缺少页面处理器：' + handler);
  }
  for (const required of [
    'togglePlay',
    'choosePreview',
    'commitPreview',
    'confirmReplace',
    'cancelPreview',
    'cancelReplace',
    'askRemove',
    'cancelRemove',
    'confirmRemove',
    'dismissOpError',
    'onVideoLoadedMetadata',
    'onVideoPlay',
    'onVideoPause',
    'onVideoError'
  ]) {
    assert.equal(typeof videoDefinition[required], 'function', required + ' 应为页面方法');
  }

  assert.match(wxml, /<video\b/);
  assert.match(wxml, /wx:for="\{\{videoInstances\}\}" wx:key="token"/);
  assert.match(wxml, /data-video-token="\{\{item\.token\}\}"/);
  assert.match(wxml, /src="\{\{playerSrc\}\}"/);
  assert.match(wxml, /bindloadedmetadata="onVideoLoadedMetadata"/);
  assert.match(wxml, /bindplay="onVideoPlay"/);
  assert.match(wxml, /bindpause="onVideoPause"/);
  assert.match(wxml, /binderror="onVideoError"/);
  assert.match(wxml, /id="toggle-play"/);
  assert.match(wxml, /id="reselect-from-player"/);
  assert.match(wxml, /id="confirm-replace"/);
  assert.match(wxml, /id="cancel-replace"/);
  assert.match(wxml, /id="commit-preview"/);
  assert.match(wxml, /id="confirm-remove"/);
  assert.match(wxml, /id="confirm-remove-yes"/);
  assert.match(wxml, /id="confirm-remove-no"/);
  assert.match(wxml, /id="video-op-status"/);
  assert.match(wxml, /id="video-op-error"/);
  assert.match(wxml, /\{\{playbackError\}\}/);
  assert.match(wxml, /\{\{savedVideo\.sizeText\}\}/);
  assert.match(wxml, /disabled="\{\{busy\}\}"/);
  assert.match(wxml, /disabled="\{\{choosing\}\}"/);
});

test('T024-18 本单仍不写 storage、不碰文件系统：持久副本只经注入接口', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(
    appJson.pages.filter(item => item === 'pages/attempt-video/attempt-video').length,
    1,
    '视频页只注册一次'
  );
  assert.ok(fs.existsSync(PLAYBACK_UTIL), '缺少 utils/attempt-video-playback.js');

  for (const file of [VIDEO_JS, VIDEO_UTIL, PLAYBACK_UTIL]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(source, /setStorageSync/, name + ' 本单不得写 storage');
    assert.doesNotMatch(
      source,
      /getFileSystemManager|writeFile|copyFile|unlink|mkdir/,
      name + ' 本单不得直接读写文件'
    );
    assert.doesNotMatch(source, /uploadFile|downloadFile|wx\.cloud/, name + ' 不得上传或调用云能力');
    assert.doesNotMatch(source, /devtools\//, name + ' 不得引用打包时被排除的 devtools 路径');
  }
});
