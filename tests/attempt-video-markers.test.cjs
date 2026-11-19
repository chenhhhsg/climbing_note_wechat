/**
 * T025 逐把视频 · 手工时间点的离线回归测试
 *
 * 直接加载真实模块与真实页面：
 * - utils/attempt-video-markers.js（纯判定：旧索引兼容、整数毫秒、0/片尾边界、
 *   毫秒→秒跳转、seek 确认与严格就绪条件）；
 * - utils/attempt-video-files.js（时间点嵌在片段条目 markers 里的同步读改写、
 *   同身份重试、写回执丢失/读回、单点移除与不新增文件）；
 * - pages/attempt-video（真实页面处理器：原生时间回报、跳转请求、旧回调隔离）。
 *
 * 覆盖任务单与整项验收的离线口径：普通记点与单点移除、0 秒与片尾、元数据/当前
 * 时间未就绪、非法时间、跨片/换片/预览不串写、连点与失败重试、回执丢失、旧索引
 * 兼容、片段生命周期清理（另见 files / training-attempt-delete 回归）。
 *
 * 真实解码、真机 currentTime 精度、seek 画面落点与断网重开交给整项 QA 与手机复验（待验）。
 *
 * 运行：node --test tests/attempt-video-markers.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MARKERS_UTIL = path.join(ROOT, 'utils', 'attempt-video-markers.js');
const FILES_UTIL = path.join(ROOT, 'utils', 'attempt-video-files.js');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const PLAYBACK_UTIL = path.join(ROOT, 'utils', 'attempt-video-playback.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const VIDEO_PAGE_JS = path.join(ROOT, 'pages', 'attempt-video', 'attempt-video.js');
const VIDEO_PAGE_WXML = path.join(ROOT, 'pages', 'attempt-video', 'attempt-video.wxml');

const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const USER_DATA_PATH = 'wxfile://usr';

const storage = new Map();
const wxLog = { videoContexts: [], chooseHandler: null };

function resetDevice() {
  storage.clear();
  wxLog.videoContexts = [];
  wxLog.chooseHandler = null;
}

const fileManager = {
  readdir(options) {
    options.fail({ errMsg: 'readdir:fail no such file or directory' });
  },
  stat(options) {
    options.fail({ errMsg: 'stat:fail no such file or directory' });
  }
};

global.wx = {
  env: { USER_DATA_PATH },
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager() {
    return fileManager;
  },
  chooseMedia(options) {
    if (wxLog.chooseHandler) wxLog.chooseHandler(options);
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
      },
      seek(seconds) {
        context.calls.push({ type: 'seek', seconds });
      }
    };
    wxLog.videoContexts.push(context);
    return context;
  },
  navigateBack() {},
  reLaunch() {}
};

const store = require(STORE_JS);
const markers = require(MARKERS_UTIL);
const files = require(FILES_UTIL);
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

const videoDefinition = capturePage(VIDEO_PAGE_JS);

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

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

// ---- 档案夹具：经真实 store 写入 ----
function seedFlow() {
  const started = store.startSession({
    gymName: '记点岩馆',
    date: '2026-11-19',
    now: new Date('2026-11-19T09:30:00')
  });
  assert.equal(started.ok, true, started.error);
  const created = store.createRoute({
    sessionId: started.session.id,
    name: '时间点线',
    climbType: '抱石',
    grade: 'V4',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  const saved = store.saveAttempt({
    sessionId: started.session.id,
    routeId: created.route.id,
    result: 'fail',
    note: '记点备注'
  });
  assert.equal(saved.ok, true, saved.error);
  return {
    archiveId: store.loadState().archive.archiveId,
    session: started.session,
    route: created.route,
    attempt: saved.attempt
  };
}

function clipOf(flow, options) {
  const config = options || {};
  return {
    clipId: config.clipId || 'clip-1-test',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: config.attemptId || flow.attempt.id,
    attemptSeq: flow.attempt.seq,
    rev: config.rev === undefined ? 1 : config.rev,
    fileId:
      config.fileId ||
      'attempt-video/v1/' + flow.archiveId + '/' + (config.clipId || 'clip-1-test') + '.mp4',
    bytes: 4096,
    durationSeconds: config.durationSeconds === undefined ? 12.4 : config.durationSeconds,
    markers: config.markers
  };
}

function writeIndex(clips, extra) {
  storage.set(
    VIDEO_INDEX_KEY,
    JSON.stringify(
      Object.assign({ version: 1, nextClipSeq: 1, clips, pending: [] }, extra || {})
    )
  );
  return JSON.parse(storage.get(VIDEO_INDEX_KEY));
}

function readIndex() {
  return JSON.parse(storage.get(VIDEO_INDEX_KEY));
}

function markerRequest(flow, clip, overrides) {
  return Object.assign(
    {
      action: 'addMarker',
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      attemptId: clip.attemptId || flow.attempt.id,
      clipId: clip.clipId,
      rev: clip.rev,
      fileId: clip.fileId,
      markerId: 'mark-test-1',
      atMs: 5123,
      durationSeconds: 12.4
    },
    overrides || {}
  );
}

function serviceWithStorage(storeImpl, options) {
  const config = options || {};
  return files.createAttemptVideoStore({
    archiveId: config.archiveId || 'archive-test',
    files: config.files || {},
    storage: storeImpl || {
      get(key) {
        return storage.has(key) ? storage.get(key) : '';
      },
      set(key, value) {
        storage.set(key, value);
      },
      remove(key) {
        storage.delete(key);
      }
    },
    now: () => '2026-11-19T02:00:00.000Z',
    verifyArchive: config.verifyArchive || (() => true),
    verifyContext: config.verifyContext === undefined ? null : config.verifyContext
  });
}

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

function loadMetadata(page, duration) {
  page.onVideoLoadedMetadata(videoEvent(page, { duration }));
}

function reportTime(page, currentTime, duration) {
  page.onVideoTimeUpdate(
    videoEvent(page, { currentTime, duration: duration === undefined ? 12.4 : duration })
  );
}

function clickMarker(eventSource, markerId) {
  return {
    currentTarget: {
      dataset: Object.assign({ markerId }, eventSource ? eventSource : {})
    }
  };
}

beforeEach(() => {
  resetDevice();
  files.resetAttemptVideoServices();
  playback.setVideoStore(null);
});

// ------------------------------------------------------------------ *
// 纯判定：旧索引兼容、毫秒、边界与跳转
// ------------------------------------------------------------------ */

test('T025-1 旧索引缺 markers 按空列表；坏标记只丢弃自己，列表按时间升序', () => {
  const clip = { clipId: 'clip-1-a', rev: 2 };
  assert.deepEqual(markers.normalizeMarkers(undefined, clip), []);
  assert.deepEqual(markers.normalizeMarkers('not-array', clip), []);
  assert.deepEqual(markers.normalizeMarkers([], clip), []);

  const list = markers.normalizeMarkers(
    [
      { id: 'mark-b', atMs: 9000, clipId: 'clip-1-a', rev: 2 },
      { id: 'mark-a', atMs: 0, clipId: 'clip-1-a', rev: 2 },
      { id: 'mark-c', atMs: 1500, clipId: 'clip-1-a', rev: 1 },
      { id: 'mark-d', atMs: -1, clipId: 'clip-1-a', rev: 2 },
      { id: 'mark-e', atMs: 12.5, clipId: 'clip-1-a', rev: 2 },
      { id: 'mark-f', atMs: 2000, clipId: 'clip-other', rev: 2 },
      { bogus: true },
      { id: 'mark-a', atMs: 100, clipId: 'clip-1-a', rev: 2 }
    ],
    clip
  );
  assert.deepEqual(
    list.map(item => [item.id, item.atMs]),
    [
      ['mark-a', 0],
      ['mark-b', 9000]
    ],
    '只保留同一片段同一版本的合法整数毫秒，重复 ID 只留第一条并按时间排序'
  );
  assert.deepEqual(
    markers.markerViews(list).map(item => item.timeText),
    ['0:00.000', '0:09.000']
  );
});

test('T025-2 原生读数转持久毫秒：0 秒合法、片尾收口、超界/未就绪拒绝', () => {
  assert.deepEqual(markers.markTimeOf(0, 12.4), { ok: true, code: 'ready', error: '', atMs: 0 });
  assert.equal(markers.markTimeOf(5.1234, 12.4).atMs, 5123);
  assert.equal(markers.markTimeOf(12.4, 12.4).atMs, 12400);
  assert.equal(markers.markTimeOf(12.4004, 12.4).atMs, 12400, '片尾收口到时长');
  assert.equal(markers.markTimeOf(12.4, 12.4).atMs <= 12400, true);

  const beyond = markers.markTimeOf(13.2, 12.4);
  assert.equal(beyond.ok, false);
  assert.equal(beyond.code, 'out-of-range');
  assert.match(beyond.error, /超出视频时长/);
  assert.equal(markers.markTimeOf(-0.1, 12.4).ok, false);
  assert.equal(markers.markTimeOf(null, 12.4).code, 'no-current-time');
  assert.equal(markers.markTimeOf(1, null).code, 'no-duration');
});

test('T025-3 跳转用秒并在时长内收口；只有目标 ±0.5 秒的回报才算确认', () => {
  assert.deepEqual(markers.seekSecondsOf(5123, 12.4), {
    ok: true,
    code: 'ready',
    error: '',
    seconds: 5.123
  });
  assert.equal(markers.seekSecondsOf(0, 12.4).seconds, 0);
  assert.equal(markers.seekSecondsOf(12400, 12.4).seconds, 12.4);
  assert.equal(markers.seekSecondsOf(13000, 12.4).seconds, 12.4, '请求不越界');
  assert.equal(markers.seekSecondsOf(-1, 12.4).ok, false);
  assert.equal(markers.seekSecondsOf(1000, null).code, 'no-duration');

  assert.equal(markers.isSeekConfirmed(5000, 5.0), true);
  assert.equal(markers.isSeekConfirmed(5000, 5.5), true);
  assert.equal(markers.isSeekConfirmed(5000, 1.0), false, '旧画面位置不算落点');
  assert.equal(markers.isSeekConfirmed(0, 0.4), true);
});

test('T025-4 严格就绪：预览/无时长/无原生时间/跳转未确认都不能记点', () => {
  const ready = markers.markReadiness({
    hasSavedVideo: true,
    savedClip: { clipId: 'clip-1', rev: 1, fileId: 'attempt-video/v1/a/clip-1.mp4' },
    playerKind: 'saved',
    sourceCurrent: true,
    clipMatchesPlayer: true,
    durationSeconds: 12.4,
    currentTimeSeconds: 0,
    seekPending: false
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.atMs, 0);

  const base = {
    hasSavedVideo: true,
    savedClip: { clipId: 'clip-1', rev: 1, fileId: 'attempt-video/v1/a/clip-1.mp4' },
    playerKind: 'saved',
    sourceCurrent: true,
    clipMatchesPlayer: true,
    durationSeconds: 12.4,
    currentTimeSeconds: 1,
    seekPending: false
  };
  assert.equal(markers.markReadiness(Object.assign({}, base, { playerKind: 'preview' })).ok, false);
  assert.equal(markers.markReadiness(Object.assign({}, base, { durationSeconds: null })).ok, false);
  assert.equal(markers.markReadiness(Object.assign({}, base, { currentTimeSeconds: null })).ok, false);
  assert.equal(markers.markReadiness(Object.assign({}, base, { seekPending: true })).ok, false);
  assert.equal(markers.markReadiness(Object.assign({}, base, { indexError: 'x' })).ok, false);
  assert.equal(markers.markReadiness(Object.assign({}, base, { clipMatchesPlayer: false })).ok, false);
});

// ------------------------------------------------------------------ *
// 索引层：同步读改写、同身份重试、回执丢失
// ------------------------------------------------------------------ */

test('T025-5 记点与单点移除：同一 markerId 幂等，其他点与其他片段不受影响', () => {
  const flow = seedFlow();
  const clip = clipOf(flow);
  const other = clipOf(flow, {
    clipId: 'clip-2-other',
    attemptId: 'attempt-other',
    markers: [{ id: 'mark-other', atMs: 1000, clipId: 'clip-2-other', rev: 1 }]
  });
  writeIndex([clip, other]);
  const service = serviceWithStorage(undefined, { archiveId: flow.archiveId });

  const first = service.addMarker(markerRequest(flow, clip));
  assert.equal(first.ok, true, first.error);
  assert.equal(first.duplicate, false);
  assert.equal(first.clip.markers.length, 1);
  assert.equal(readIndex().clips[0].markers[0].atMs, 5123);

  const again = service.addMarker(markerRequest(flow, clip));
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, '同一操作身份重试不新增第二个点');
  assert.equal(readIndex().clips[0].markers.length, 1);

  const zero = service.addMarker(
    markerRequest(flow, clip, { markerId: 'mark-test-0', atMs: 0 })
  );
  assert.equal(zero.ok, true, zero.error);
  assert.deepEqual(
    readIndex().clips[0].markers.map(item => item.atMs),
    [0, 5123],
    '0 秒合法且列表按时间升序'
  );

  const removed = service.removeMarker(
    markerRequest(flow, clip, { action: 'removeMarker', markerId: 'mark-test-0' })
  );
  assert.equal(removed.ok, true, removed.error);
  assert.deepEqual(
    readIndex().clips[0].markers.map(item => item.id),
    ['mark-test-1'],
    '只删除指定的那一个点'
  );
  const removedAgain = service.removeMarker(
    markerRequest(flow, clip, { action: 'removeMarker', markerId: 'mark-test-0' })
  );
  assert.equal(removedAgain.ok, true);
  assert.equal(removedAgain.duplicate, true);
  assert.deepEqual(
    readIndex().clips[1].markers.map(item => item.id),
    ['mark-other'],
    '其他把次的标记不动'
  );
});

test('T025-6 跨片/换版本/非法时间拒绝；只写同一索引，不新建媒体文件', () => {
  const flow = seedFlow();
  const clip = clipOf(flow);
  writeIndex([clip]);
  const service = serviceWithStorage(undefined, { archiveId: flow.archiveId });
  const keysBefore = [...storage.keys()].sort();

  const staleRev = service.addMarker(markerRequest(flow, clip, { rev: 2 }));
  assert.equal(staleRev.ok, false);
  assert.equal(staleRev.code, 'stale-operation');
  assert.equal(readIndex().clips[0].markers, undefined);

  const wrongFile = service.addMarker(
    markerRequest(flow, clip, { fileId: 'attempt-video/v1/other/clip-1-test.mp4' })
  );
  assert.equal(wrongFile.ok, false);
  assert.equal(wrongFile.code, 'stale-operation');

  const negative = service.addMarker(markerRequest(flow, clip, { atMs: -1 }));
  assert.equal(negative.ok, false);
  assert.equal(negative.code, 'invalid-time');
  const fraction = service.addMarker(markerRequest(flow, clip, { atMs: 1000.5 }));
  assert.equal(fraction.ok, false);
  const beyond = service.addMarker(markerRequest(flow, clip, { atMs: 12401 }));
  assert.equal(beyond.ok, false);
  assert.equal(beyond.code, 'invalid-time');

  assert.equal(service.addMarker(markerRequest(flow, clip, { markerId: 'bad id' })).ok, false);
  assert.deepEqual([...storage.keys()].sort(), keysBefore, '没有新增索引键或媒体文件记录');
});

test('T025-7 索引写抛错：写前失败同身份重试只加一个点；已落盘回执丢失按读回确认', () => {
  const flow = seedFlow();
  const clip = clipOf(flow);
  writeIndex([clip]);

  // 场景 A：写前失败（索引未变），重试沿用同一个 markerId。
  let failOnce = true;
  const beforeStorage = {
    get(key) {
      return storage.has(key) ? storage.get(key) : '';
    },
    set(key, value) {
      if (failOnce) {
        failOnce = false;
        throw { errMsg: 'setStorageSync:fail before write' };
      }
      storage.set(key, value);
    },
    remove(key) {
      storage.delete(key);
    }
  };
  const serviceA = serviceWithStorage(beforeStorage, { archiveId: flow.archiveId });
  const failed = serviceA.addMarker(markerRequest(flow, clip));
  assert.equal(failed.ok, false);
  assert.equal(readIndex().clips[0].markers, undefined, '写前失败不产生点');

  const retried = serviceA.addMarker(markerRequest(flow, clip));
  assert.equal(retried.ok, true, retried.error);
  assert.equal(readIndex().clips[0].markers.length, 1, '同一次动作重试只新增一个点');

  // 场景 B：索引已落盘但回执丢失，读回确认后按成功返回。
  const flowB = seedFlow();
  resetDevice();
  writeIndex([clipOf(flowB)]);
  let throwAfterWrite = true;
  const afterStorage = {
    get(key) {
      return storage.has(key) ? storage.get(key) : '';
    },
    set(key, value) {
      storage.set(key, value);
      if (throwAfterWrite) {
        throwAfterWrite = false;
        throw { errMsg: 'setStorageSync:fail after write' };
      }
    },
    remove(key) {
      storage.delete(key);
    }
  };
  const serviceB = serviceWithStorage(afterStorage, { archiveId: flowB.archiveId });
  const lost = serviceB.addMarker(markerRequest(flowB, clipOf(flowB)));
  assert.equal(lost.ok, true, lost.error);
  assert.equal(lost.receiptLost, true);
  assert.equal(readIndex().clips[0].markers.length, 1);
  const retryLost = serviceB.addMarker(markerRequest(flowB, clipOf(flowB)));
  assert.equal(retryLost.duplicate, true);
  assert.equal(readIndex().clips[0].markers.length, 1);

  // 场景 C：写与读回都不可用：保留失败，但真实落盘的标记不会重复。
  const flowC = seedFlow();
  resetDevice();
  writeIndex([clipOf(flowC)]);
  let writeThrew = false;
  let readThrows = false;
  const unreadable = {
    get(key) {
      if (readThrows) throw { errMsg: 'getStorageSync:fail read error' };
      return storage.has(key) ? storage.get(key) : '';
    },
    set(key, value) {
      storage.set(key, value);
      if (!writeThrew) {
        writeThrew = true;
        readThrows = true;
        throw { errMsg: 'setStorageSync:fail after write' };
      }
    },
    remove(key) {
      storage.delete(key);
    }
  };
  const serviceC = serviceWithStorage(unreadable, { archiveId: flowC.archiveId });
  const unconfirmed = serviceC.addMarker(markerRequest(flowC, clipOf(flowC)));
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.markerUnconfirmed, true);
  assert.equal(readIndex().clips[0].markers.length, 1, '标记实际已落盘');
});

test('T025-8 移除最后一个点后索引恢复旧形状（不写空 markers 字段）', () => {
  const flow = seedFlow();
  const clip = clipOf(flow);
  writeIndex([clip]);
  const service = serviceWithStorage(undefined, { archiveId: flow.archiveId });
  service.addMarker(markerRequest(flow, clip));
  assert.ok(readIndex().clips[0].markers);
  service.removeMarker(
    markerRequest(flow, clip, { action: 'removeMarker', markerId: 'mark-test-1' })
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(readIndex().clips[0], 'markers'),
    false,
    '没有时间点的片段与旧版本索引同形'
  );
  assert.equal(attemptVideo.videoClipView(flow.archiveId, flow.attempt.id).clip.markers.length, 0);
});

// ------------------------------------------------------------------ *
// 页面：严格播放器状态、跳转与旧回调隔离
// ------------------------------------------------------------------ */

function openPage(flow) {
  const page = createPage(videoDefinition);
  page.onLoad({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: flow.attempt.id
  });
  return page;
}

test('T025-9 页面记点：元数据/原生时间未就绪时禁用，就绪后按毫秒保存并排序', async () => {
  const flow = seedFlow();
  writeIndex([clipOf(flow)]);
  const page = openPage(flow);
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.canAddMarker, false);
  assert.match(page.data.markerHint, /时长|当前时间/);

  loadMetadata(page, 12.4);
  assert.equal(page.data.canAddMarker, false, '只有时长还不够，必须有原生 currentTime');

  reportTime(page, 0, 12.4);
  assert.equal(page.data.canAddMarker, true);
  assert.equal(page.data.playerTimeMs, 0);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(page.data.markers.length, 1);
  assert.equal(page.data.markers[0].atMs, 0, '真实 0 秒可记');
  assert.equal(readIndex().clips[0].markers[0].atMs, 0);

  reportTime(page, 5.1234, 12.4);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [0, 5123],
    '持久整数毫秒且列表升序'
  );
  assert.equal(readIndex().clips[0].markers.length, 2);

  page.removeMarker(clickMarker({}, page.data.markers[0].id));
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [5123],
    '移除只删除该点'
  );
});

test('T025-10 换片/预览/旧回调不串写；未确认失败保留列表并可同身份重试', async () => {
  const flow = seedFlow();
  writeIndex([clipOf(flow)]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  reportTime(page, 2, 12.4);

  const staleToken = page.data.playerToken + '-old';
  page.onVideoLoadedMetadata(staleVideoEvent(staleToken, { duration: 99 }));
  page.onVideoTimeUpdate(staleVideoEvent(staleToken, { currentTime: 99, duration: 99 }));
  assert.equal(page.data.playerDurationSeconds, 12.4, '旧节点事件不改当前播放器');

  // 进入更换预览：当前播放器不是已保存片源，不能记点，也不改索引。
  wxLog.chooseHandler = options => {
    options.success({
      tempFiles: [
        {
          tempFilePath: 'wxfile://tmp/new.mp4',
          size: 1024,
          duration: 8,
          width: 1080,
          height: 1920
        }
      ]
    });
  };
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.playerKind, 'preview');
  assert.equal(page.data.canAddMarker, false);
  const indexBefore = storage.get(VIDEO_INDEX_KEY);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexBefore, '预览期间不写时间点');

  page.cancelReplace();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.markers.length, 0, '取消更换后原片列表保持原样');

  // 失败重试：写入前失败一次，列表保留，重试用同一个 markerId 只加一个点。
  loadMetadata(page, 12.4);
  reportTime(page, 3, 12.4);
  let failOnce = true;
  const realService = files.openAttemptVideoService(flow.archiveId);
  const originalAdd = realService.addMarker;
  realService.addMarker = request => {
    if (failOnce) {
      failOnce = false;
      return { ok: false, code: 'index-write-failed', error: '模拟写入前失败' };
    }
    return originalAdd.call(realService, request);
  };
  try {
    page.addMarkerAtCurrentTime();
    await tick();
    assert.equal(page.data.markers.length, 0);
    assert.equal(page.data.markerPendingRetry, true);
    assert.match(page.data.markerError, /重试/);
    page.retryMarker();
    await tick();
    assert.equal(page.data.markers.length, 1);
    assert.equal(page.data.markerPendingRetry, false);
    assert.equal(readIndex().clips[0].markers.length, 1, '同一次动作只新增一个点');
  } finally {
    realService.addMarker = originalAdd;
  }
});

test('T025-11 点回只下发秒数请求；未确认前不接受旧画面位置，确认后显示实际落点', async () => {
  const flow = seedFlow();
  writeIndex([
    clipOf(flow, {
      markers: [{ id: 'mark-saved', atMs: 8000, clipId: 'clip-1-test', rev: 1 }]
    })
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  reportTime(page, 2, 12.4);
  assert.equal(page.data.markers[0].atMs, 8000);

  page.seekToMarker(clickMarker({}, 'mark-saved'));
  const context = wxLog.videoContexts[wxLog.videoContexts.length - 1];
  const seekCall = context.calls.filter(call => call.type === 'seek')[0];
  assert.deepEqual(seekCall, { type: 'seek', seconds: 8 }, '跳转请求用秒');
  assert.equal(page.data.playerTimeMs, 2000, '请求值不回填实际落点');
  assert.equal(page.data.seekPending, true);
  assert.match(page.data.seekRequestText, /0:08\.000/);
  assert.equal(page.data.canAddMarker, false, '跳转未确认时不记新点');

  // 迟到的旧画面位置：与目标差 7 秒，不确认、不覆盖请求，也不允许记点。
  reportTime(page, 1, 12.4);
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, 1000);
  assert.match(page.data.seekActualText, /不一致/);
  assert.equal(page.data.canAddMarker, false);

  // 播放器回报落到目标附近：确认，显示实际落点（不是请求值）。
  reportTime(page, 8.2, 12.4);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /0:08\.200/);
  assert.equal(page.data.playerTimeMs, 8200);
  assert.equal(page.data.canAddMarker, true);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [8000, 8200],
    '新点来自实际回报位置'
  );
});

test('T025-12 外部换版后重开只读新片空列表；旧页面的迟到回执不改新片', async () => {
  const flow = seedFlow();
  const oldClip = clipOf(flow, {
    markers: [{ id: 'mark-old', atMs: 4000, clipId: 'clip-1-test', rev: 1 }]
  });
  writeIndex([oldClip]);
  const page = openPage(flow);
  assert.equal(page.data.markers.length, 1);

  // 另一页把这一把换成 rev 2（新条目没有继承旧标记）。
  const next = clipOf(flow, { clipId: 'clip-2-new', rev: 2 });
  writeIndex([next]);
  page.onShow();
  assert.equal(page.data.markers.length, 0, '确认换片后只读新片的时间点');
  assert.equal(page.data.savedVideo.clipId, 'clip-2-new');

  // 旧片段身份的时间点回执/操作不能写进新片。
  const service = files.openAttemptVideoService(flow.archiveId);
  const stale = service.addMarker(
    markerRequest(flow, oldClip, { markerId: 'mark-stale', atMs: 1000 })
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-operation');
  assert.equal(readIndex().clips[0].markers, undefined);
});

// ------------------------------------------------------------------ *
// 页面静态结构
// ------------------------------------------------------------------ */

test('T025-13 WXML 有记点、跳转、单点移除与原生时间回报绑定', () => {
  const wxml = fs.readFileSync(VIDEO_PAGE_WXML, 'utf8');
  assert.match(wxml, /bindtimeupdate="onVideoTimeUpdate"/);
  assert.match(wxml, /id="add-marker"[\s\S]{0,160}bindtap="addMarkerAtCurrentTime"/);
  assert.match(wxml, /id="marker-retry"[\s\S]{0,160}bindtap="retryMarker"/);
  assert.match(wxml, /data-marker-id="\{\{item\.id\}\}"[\s\S]{0,120}bindtap="seekToMarker"/);
  assert.match(wxml, /data-marker-id="\{\{item\.id\}\}"[\s\S]{0,120}bindtap="removeMarker"/);
  assert.match(wxml, /id="marker-seek-request"/);
  assert.match(wxml, /id="marker-seek-actual"/);
  assert.equal(typeof videoDefinition.addMarkerAtCurrentTime, 'function');
  assert.equal(typeof videoDefinition.seekToMarker, 'function');
  assert.equal(typeof videoDefinition.removeMarker, 'function');
});

// ------------------------------------------------------------------ *
// 实际 QA 返工：strict native 数值、时长复核、seek 无回报解锁
// ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('T025-14 原生数值严格校验：null/false/空白/数组不伪造 0，真实 0 保留', () => {
  [null, undefined, false, true, '', '   ', [], [0], {}, '0', '5'].forEach(value => {
    assert.equal(
      markers.markTimeOf(value, 12.4).code,
      'no-current-time',
      '非法 currentTime 不能变成 0：' + JSON.stringify(value)
    );
  });
  assert.deepEqual(markers.markTimeOf(0, 12.4), {
    ok: true,
    code: 'ready',
    error: '',
    atMs: 0
  });
  [null, undefined, false, '', '  ', [], '12.4', 0, -1].forEach(value => {
    assert.equal(
      markers.markTimeOf(1, value).code,
      'no-duration',
      '非法 duration 不能给出上限：' + JSON.stringify(value)
    );
  });

  assert.equal(markers.normalizeAtMs([]), null);
  assert.equal(markers.normalizeAtMs([0]), null);
  assert.equal(markers.normalizeAtMs(''), null);
  assert.equal(markers.normalizeAtMs('   '), null);
  assert.equal(markers.normalizeAtMs(false), null);
  assert.equal(markers.normalizeAtMs('0'), 0, '旧 JSON 数字文本仍按毫秒读取');
  assert.equal(markers.isSeekConfirmed(5000, null), false);
  assert.equal(markers.isSeekConfirmed(5000, []), false);
  assert.equal(markers.isSeekConfirmed(5000, '5'), false, '原生回报必须是 number');
  assert.equal(markers.isSeekConfirmed(5000, 5), true);
  assert.equal(markers.seekSecondsOf(5000, '12.4').code, 'no-duration');

  const base = {
    hasSavedVideo: true,
    savedClip: { clipId: 'clip-1', rev: 1, fileId: 'attempt-video/v1/a/clip-1.mp4' },
    playerKind: 'saved',
    sourceCurrent: true,
    clipMatchesPlayer: true,
    durationSeconds: 12.4,
    currentTimeSeconds: 0,
    seekPending: false
  };
  [null, false, '', '  ', [], {}].forEach(value => {
    assert.equal(
      markers.markReadiness(Object.assign({}, base, { currentTimeSeconds: value })).ok,
      false
    );
    assert.equal(
      markers.markReadiness(Object.assign({}, base, { durationSeconds: value })).ok,
      false
    );
  });

  // 元数据同样按原生 number 严格判定。
  assert.equal(playback.metadataPatch({ duration: null }).playerReady, false);
  assert.equal(playback.metadataPatch({ duration: false }).playerReady, false);
  assert.equal(playback.metadataPatch({ duration: '' }).playerReady, false);
  assert.equal(playback.metadataPatch({ duration: [] }).playerReady, false);
  assert.equal(playback.metadataPatch({ duration: '12.4' }).playerReady, false);
  assert.equal(playback.metadataPatch({ duration: 12.4 }).playerDurationSeconds, 12.4);
});

test('T025-15 页面非法 timeupdate 不写 0、不覆盖上一有效读数、不误报就绪', async () => {
  const flow = seedFlow();
  writeIndex([clipOf(flow)]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  assert.equal(page.data.playerDurationSeconds, 12.4);

  // 有效 metadata 之后、首次真实位置回报之前，非法读数不得伪造 0。
  [null, undefined, false, '', '   ', [], {}].forEach(value => {
    reportTime(page, value, 12.4);
    assert.equal(page.data.playerTimeMs, null, '非法读数不产生位置：' + JSON.stringify(value));
    assert.equal(page.data.playerTimeText, '');
    assert.equal(page._playerTimeSeconds, null);
    assert.equal(page.data.canAddMarker, false, '没有真实回报前不能记点');
  });
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(page.data.markers.length, 0, '首次真实回报前不写点');
  assert.equal(readIndex().clips[0].markers, undefined);

  // 真实 0 秒是有效读数，可以记点。
  reportTime(page, 0, 12.4);
  assert.equal(page.data.playerTimeMs, 0);
  assert.equal(page.data.canAddMarker, true);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(page.data.markers[0].atMs, 0);

  // 已有有效读数后，非法读数不得把它覆盖成 0。
  reportTime(page, 3, 12.4);
  assert.equal(page.data.playerTimeMs, 3000);
  reportTime(page, null, 12.4);
  reportTime(page, [], null);
  assert.equal(page.data.playerTimeMs, 3000, '保留上一有效位置');
  assert.equal(page._playerTimeSeconds, 3);
  assert.equal(page.data.playerDurationSeconds, 12.4, '非法 duration 不覆盖已知时长');
  assert.equal(page.data.canAddMarker, true);
});

test('T025-16 addMarker 按当前片段与原生回报复核时长，无有效时长拒绝', () => {
  const flow = seedFlow();
  writeIndex([clipOf(flow)]);
  const service = serviceWithStorage(undefined, { archiveId: flow.archiveId });

  // A. 请求缺时长，但索引片段有已知时长：越界拒绝，范围内接受。
  const beyondKnown = service.addMarker(
    markerRequest(flow, clipOf(flow), { markerId: 'mark-a', durationSeconds: null, atMs: 13000 })
  );
  assert.equal(beyondKnown.ok, false);
  assert.equal(beyondKnown.code, 'invalid-time');
  const edgeKnown = service.addMarker(
    markerRequest(flow, clipOf(flow), { markerId: 'mark-a', durationSeconds: null, atMs: 12400 })
  );
  assert.equal(edgeKnown.ok, true, edgeKnown.error);

  // B. 请求带伪造/过期的更长时长，仍不能超过索引已知时长。
  const forged = service.addMarker(
    markerRequest(flow, clipOf(flow), { markerId: 'mark-b', durationSeconds: 20, atMs: 13000 })
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'invalid-time');
  const forgedEdge = service.addMarker(
    markerRequest(flow, clipOf(flow), { markerId: 'mark-b', durationSeconds: 20, atMs: 12401 })
  );
  assert.equal(forgedEdge.ok, false, '已知 12.4 秒时 12401 越界');

  // C. 两处都没有有效时长：连 0 秒也拒绝（未就绪不写点）。
  writeIndex([clipOf(flow, { durationSeconds: null })]);
  const noDuration = service.addMarker(
    markerRequest(flow, clipOf(flow, { durationSeconds: null }), {
      markerId: 'mark-c',
      durationSeconds: null,
      atMs: 0
    })
  );
  assert.equal(noDuration.ok, false);
  assert.equal(noDuration.code, 'no-duration');
  assert.equal(readIndex().clips[0].markers, undefined);

  // D. 旧索引没有时长，但本次原生回报有效：接受并真实写入。
  const nativeOnly = service.addMarker(
    markerRequest(flow, clipOf(flow, { durationSeconds: null }), {
      markerId: 'mark-d',
      durationSeconds: 12.4,
      atMs: 12000
    })
  );
  assert.equal(nativeOnly.ok, true, nativeOnly.error);
  assert.deepEqual(
    readIndex().clips[0].markers.map(item => [item.id, item.atMs]),
    [['mark-d', 12000]],
    '旧索引无时长时按有效原生回报写入'
  );

  // E. 已知元数据与实际解码轻差：取较大值，不误拒片尾。
  writeIndex([clipOf(flow, { durationSeconds: 9.87 })]);
  const lightDiff = service.addMarker(
    markerRequest(flow, clipOf(flow, { durationSeconds: 9.87 }), {
      markerId: 'mark-e',
      durationSeconds: 10,
      atMs: 9950
    })
  );
  assert.equal(lightDiff.ok, true, lightDiff.error);

  // F. 差异过大仍按较小值封顶，过期/伪造时长不能越界。
  writeIndex([clipOf(flow)]);
  const staleShort = service.addMarker(
    markerRequest(flow, clipOf(flow), {
      markerId: 'mark-f',
      durationSeconds: 9,
      atMs: 12500
    })
  );
  assert.equal(staleShort.ok, false);
  assert.equal(staleShort.code, 'invalid-time');

  // G. 已知片段时长下 0 秒仍合法。
  writeIndex([clipOf(flow)]);
  const zero = service.addMarker(
    markerRequest(flow, clipOf(flow), { markerId: 'mark-g', durationSeconds: null, atMs: 0 })
  );
  assert.equal(zero.ok, true, zero.error);
  assert.equal(readIndex().clips[0].markers[0].atMs, 0);
});

test('T025-17 seek 无原生回报：短等待重发一次，仍未回报则解锁且不把请求当实际', async () => {
  const flow = seedFlow();
  writeIndex([
    clipOf(flow, {
      markers: [{ id: 'mark-saved', atMs: 8000, clipId: 'clip-1-test', rev: 1 }]
    })
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  reportTime(page, 2, 12.4);

  page._seekWaitMs = 100;
  page.seekToMarker(clickMarker({}, 'mark-saved'));
  const context = wxLog.videoContexts[wxLog.videoContexts.length - 1];
  assert.deepEqual(context.calls[0], { type: 'seek', seconds: 8 });
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, 2000, '请求值不回填实际落点');

  // 非法读数不结束等待、不覆盖位置。
  reportTime(page, null, 12.4);
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, 2000);

  // 第一次短等待：重发同一秒数请求，仍等待真实回报。
  await sleep(150);
  const firstSeeks = context.calls.filter(call => call.type === 'seek');
  assert.equal(firstSeeks.length, 2, '短等待后重试一次');
  assert.deepEqual(firstSeeks[1], { type: 'seek', seconds: 8 });
  assert.equal(page.data.seekPending, true);
  assert.match(page.data.seekActualText, /重试跳转/);
  assert.equal(page.data.playerTimeMs, 2000, '重试也不把请求当实际');

  // 第二次短等待仍无回报：解除等待，不永久锁定，但落点仍未确认。
  await sleep(120);
  assert.equal(page.data.seekPending, false, '不会永久锁定');
  assert.equal(page.data.playerTimeMs, 2000, '没有把目标值返填为实际落点');
  assert.match(page.data.seekRequestText, /0:08\.000/);
  assert.match(page.data.seekActualText, /没有回报/);
  assert.equal(page.data.canAddMarker, true, '解除等待后可继续操作');
  assert.equal(page.data.markers.length, 1, '不会自动产生新点');

  // 解锁后迟到的非目标位置不把页面锁回等待。
  reportTime(page, 1, 12.4);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /仍未确认/);

  // 旧 token 的目标位置不算确认；当前 token 真正到达目标时才确认。
  const staleToken = page.data.playerToken + '-old';
  page.onVideoTimeUpdate(staleVideoEvent(staleToken, { currentTime: 8.2, duration: 12.4 }));
  assert.doesNotMatch(page.data.seekActualText, /0:08\.200/);
  reportTime(page, 8.2, 12.4);
  assert.equal(page.data.playerTimeMs, 8200);
  assert.match(page.data.seekActualText, /播放器实际位置 0:08\.200/);
  assert.equal(page.data.seekPending, false);
});
