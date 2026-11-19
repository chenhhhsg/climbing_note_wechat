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
const wxLog = {
  videoContexts: [],
  chooseHandler: null,
  // 冷源可见位置：默认由测试显式触发原生回调，便于检查"回调前不重挂载"。
  scrollCalls: [],
  scrollMode: 'manual',
  scrollResult: 'success',
  // 播放器节点几何与视口；top/height 缺 bottom 时由 mock 补齐。
  rect: { top: 20, height: 240 },
  viewport: { top: 0, bottom: 500, width: 320, height: 500 },
  // 原生视口高度：选择器视口退化时的后备来源。
  windowHeight: 500,
  // 模拟选择器查询拿不到几何（节点尚未布局/回调延迟）。
  geometryMissing: false,
  querySelectors: []
};

function resetDevice() {
  storage.clear();
  wxLog.videoContexts = [];
  wxLog.chooseHandler = null;
  wxLog.scrollCalls = [];
  wxLog.scrollMode = 'manual';
  wxLog.scrollResult = 'success';
  wxLog.rect = { top: 20, height: 240 };
  wxLog.viewport = { top: 0, bottom: 500, width: 320, height: 500 };
  wxLog.windowHeight = 500;
  wxLog.geometryMissing = false;
  wxLog.querySelectors = [];
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
  getWindowInfo() {
    return { windowHeight: wxLog.windowHeight };
  },
  getSystemInfoSync() {
    return { windowHeight: wxLog.windowHeight };
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
  pageScrollTo(options) {
    const call = { options };
    wxLog.scrollCalls.push(call);
    if (wxLog.scrollMode === 'auto') {
      if (wxLog.scrollResult === 'success') {
        if (options && typeof options.success === 'function') options.success({});
      } else if (options && typeof options.fail === 'function') {
        options.fail({ errMsg: 'pageScrollTo:fail' });
      }
    }
  },
  createSelectorQuery() {
    const query = {
      in() {
        return query;
      },
      select(selector) {
        wxLog.querySelectors.push(selector);
        return {
          boundingClientRect() {
            return query;
          }
        };
      },
      selectViewport() {
        return {
          boundingClientRect() {
            return query;
          },
          scrollOffset() {
            return query;
          }
        };
      },
      exec(callback) {
        if (typeof callback !== 'function') return;
        if (wxLog.geometryMissing) {
          callback([null, null]);
          return;
        }
        const rect = wxLog.rect
          ? Object.assign({ width: 320 }, wxLog.rect)
          : null;
        if (rect && typeof rect.bottom !== 'number' && typeof rect.height === 'number') {
          rect.bottom = rect.top + rect.height;
        }
        callback([rect, wxLog.viewport]);
      }
    };
    return query;
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

/** 从真实 WXML 取出某个 id 的绑定处理器；测试按渲染后的绑定调用，而不是猜方法名。 */
function bindingOf(markup, id, attribute) {
  const tag = markup.match(new RegExp(`<[a-z-]+\\b[^>]*\\bid="${id}"[^>]*>`, 's'))?.[0];
  assert.ok(tag, '缺少 WXML 节点：' + id);
  const hit = tag.match(new RegExp(`(?:bind|catch):?${attribute}="([a-zA-Z][\\w]*)"`));
  assert.ok(hit, '缺少 ' + id + ' 的 ' + attribute + ' 绑定');
  return hit[1];
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
  assert.equal(page.data.playerTimeMs, null, '请求值不回填实际落点，旧位置也已作废');
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
  // 冷重挂载依赖节点自己的原生 initial-time（秒）与 autoplay 状态。
  assert.match(wxml, /initial-time="\{\{item\.initialSeconds\}\}"/);
  assert.match(wxml, /autoplay="\{\{item\.autoplay\}\}"/);
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

test('T025-15 当前源非法 timeupdate 清空捕获位置；合法新回报恢复，旧 token 仍忽略', async () => {
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

  // 已有有效读数后，当前源的不合法读数清空捕获位置与就绪态，不能保存旧位置。
  reportTime(page, 3, 12.4);
  assert.equal(page.data.playerTimeMs, 3000);
  assert.equal(page.data.canAddMarker, true);
  const beforeInvalid = storage.get(VIDEO_INDEX_KEY);
  reportTime(page, null, 12.4);
  assert.equal(page.data.playerTimeMs, null, '非法读数不保留旧位置');
  assert.equal(page.data.playerTimeText, '');
  assert.equal(page._playerTimeSeconds, null);
  assert.equal(page.data.playerDurationSeconds, 12.4, '非法 duration 不覆盖已知时长');
  assert.equal(page.data.canAddMarker, false, '未知位置不能记点');
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(storage.get(VIDEO_INDEX_KEY), beforeInvalid, '不合法读数后不写旧位置');
  assert.equal(page.data.markers.length, 1);

  // 其他片源的迟到 token 仍被忽略：既不改也不清空当前源。
  reportTime(page, 3, 12.4);
  const staleToken = page.data.playerToken + '-old';
  page.onVideoTimeUpdate(staleVideoEvent(staleToken, { currentTime: null, duration: 12.4 }));
  page.onVideoTimeUpdate(staleVideoEvent(staleToken, { currentTime: 4, duration: 12.4 }));
  assert.equal(page._playerTimeSeconds, 3, '旧 token 不改当前片源位置');
  assert.equal(page.data.canAddMarker, true);

  // 合法的新回报恢复可记点，并按新位置写入。
  reportTime(page, 5.5, 12.4);
  assert.equal(page.data.canAddMarker, true);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [0, 5500]
  );
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
  assert.equal(page.data.playerTimeMs, null, '请求值不回填实际落点，旧位置也随跳转作废');

  // 非法读数不结束等待、不重建位置。
  reportTime(page, null, 12.4);
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, null);

  // 第一次短等待：重发同一秒数请求，仍等待真实回报。
  await sleep(150);
  const firstSeeks = context.calls.filter(call => call.type === 'seek');
  assert.equal(firstSeeks.length, 2, '短等待后重试一次');
  assert.deepEqual(firstSeeks[1], { type: 'seek', seconds: 8 });
  assert.equal(page.data.seekPending, true);
  assert.match(page.data.seekActualText, /重试跳转/);
  assert.equal(page.data.playerTimeMs, null, '重试也不把请求当实际');

  // 第二次短等待仍无回报：解除等待，不永久锁定，但落点仍未确认、旧位置不能记点。
  await sleep(120);
  assert.equal(page.data.seekPending, false, '不会永久锁定');
  assert.equal(page.data.playerTimeMs, null, '没有把目标值返填为实际落点');
  assert.match(page.data.seekRequestText, /0:08\.000/);
  assert.match(page.data.seekActualText, /没有回报/);
  page.addMarkerAtCurrentTime();
  await tick();
  assert.equal(page.data.markers.length, 1, '跳转前旧画面位置没有被写成新点');
  assert.equal(page.data.canAddMarker, false, '超时后要等新的真实回报');

  // 解锁后真实播放/拖动回报重建位置；迟到的非目标回报不把页面锁回等待。
  reportTime(page, 1, 12.4);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /仍未确认/);
  assert.equal(page.data.playerTimeMs, 1000);
  assert.equal(page.data.canAddMarker, true, '新的真实回报恢复可记点');

  // 旧 token 的目标位置不算确认；当前 token 真正到达目标时才确认。
  const staleToken = page.data.playerToken + '-old';
  page.onVideoTimeUpdate(staleVideoEvent(staleToken, { currentTime: 8.2, duration: 12.4 }));
  assert.doesNotMatch(page.data.seekActualText, /0:08\.200/);
  reportTime(page, 8.2, 12.4);
  assert.equal(page.data.playerTimeMs, 8200);
  assert.match(page.data.seekActualText, /播放器实际位置 0:08\.200/);
  assert.equal(page.data.seekPending, false);
});

// ------------------------------------------------------------------ *
// 冷重开源：原生 pageScrollTo 可见位置 + initial-time 重挂载
// ------------------------------------------------------------------ *

function coldMarkerClip(flow, markers) {
  return clipOf(flow, {
    markers: markers.map(item => ({
      id: item.id,
      atMs: item.atMs,
      clipId: 'clip-1-test',
      rev: 1
    }))
  });
}

function seekCalls(context) {
  return context.calls.filter(call => call.type === 'seek');
}

function playCount(context) {
  return context.calls.filter(call => call === 'play').length;
}

function pauseCount(context) {
  return context.calls.filter(call => call === 'pause').length;
}

function lastScrollCall() {
  return wxLog.scrollCalls[wxLog.scrollCalls.length - 1] || null;
}

/** 触发最近一次 pageScrollTo 的原生回调；mode=fail 模拟滚动失败。 */
function completeScroll(mode) {
  const call = lastScrollCall();
  assert.ok(call, '应先有 pageScrollTo 请求');
  if (mode === 'fail') {
    call.options.fail({ errMsg: 'pageScrollTo:fail' });
    return;
  }
  call.options.success({});
}

function coldInstance(page) {
  return (page.data.videoInstances || [])[0] || null;
}

test('T025-18 冷重开源：先滚动可见，再按 initial-time 重挂载；新节点近目标回报才确认并恢复暂停', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-cold', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;
  const beforeDomId = coldInstance(page).domId;
  const beforeSrc = page.data.playerSrc;
  assert.equal(page._nativeEngaged, false, '只有元数据、从未播放/推进，按冷源处理');

  page.seekToMarker(clickMarker({}, 'mark-cold'));
  assert.equal(wxLog.scrollCalls.length, 1, '冷源先请求把播放器滚到可见位置');
  assert.equal(lastScrollCall().options.selector, '#video-player');
  assert.equal(lastScrollCall().options.duration, 0, '立即滚动，不靠任意延时');
  assert.equal(page._seek.phase, 'revealing');
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, null);
  assert.match(page.data.seekRequestText, /0:04\.954/);
  assert.equal(coldInstance(page).token, beforeToken, '原生滚动回调前不重挂载');
  assert.equal(coldInstance(page).autoplay, false, '旧节点不擅自播放');

  // 滚动回调前的旧节点读数属于“定位前”，不能确认落点，也不能记点。
  reportTime(page, 4.96, 12);
  assert.equal(page.data.seekPending, true);
  assert.equal(page._playerTimeSeconds, null);
  assert.equal(page.data.canAddMarker, false);

  // 原生滚动成功 + 可见几何为正：同一个本机片源换成新 DOM ID/token。
  const oldContext = page.getVideoContext();
  completeScroll();
  const instance = coldInstance(page);
  assert.notEqual(instance.token, beforeToken, '重挂载换新 token');
  assert.notEqual(instance.domId, beforeDomId, '重挂载换新 DOM ID');
  assert.equal(page.data.playerToken, instance.token);
  assert.equal(page.data.playerSrc, beforeSrc, '仍是同一本机片源');
  assert.equal(instance.initialSeconds, 4.954, '原生 initial-time 按秒');
  assert.equal(instance.autoplay, true, 'autoplay 由该节点自己的状态驱动');
  assert.equal(page._seek.token, instance.token);
  assert.equal(page._seek.domId, instance.domId);
  assert.equal(page._seek.phase, 'seeking');
  assert.equal(page.data.seekPending, true);
  assert.equal(page.data.playerTimeMs, null, '请求值不回填为实际位置');

  const context = page.getVideoContext();
  assert.deepEqual(context.calls, [], '冷源不使用 play/seek 命令');
  assert.deepEqual(oldContext.calls, []);

  // 旧节点迟到的 play/timeupdate 全部作废。
  page.onVideoPlay(staleVideoEvent(beforeToken, {}));
  page.onVideoTimeUpdate(staleVideoEvent(beforeToken, { currentTime: 4.96, duration: 12 }));
  assert.equal(page.data.playing, false, '旧 token 的 play 不采用');
  assert.equal(page.data.seekPending, true, '旧 token 不能确认新节点落点');

  // 新节点真正回报到目标附近才确认；原本暂停，因此恢复暂停一次。
  reportTime(page, 4.98, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 4980, '显示原生实际落点，不填请求值');
  assert.match(page.data.seekActualText, /播放器实际位置 0:04\.980/);
  assert.match(page.data.markerNotice, /0:04\.980 秒（请求 0:04\.954 秒）/);
  assert.equal(page._nativeEngaged, true, '确认后该片源按已推进处理');
  assert.equal(pauseCount(context), 1, '确认落点后恢复原暂停态');

  // 再来的位置回报只更新读数，不重复暂停。
  reportTime(page, 5.1, 12);
  assert.equal(pauseCount(context), 1);
  assert.equal(page.data.playerTimeMs, 5100);
});

test('T025-19 warm/已暂停源保持原直跳：不额外启动播放，也不暂停', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-warm', atMs: 8000 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  // 普通直跳路径：同一片源先播放过、再暂停，随后点回直接 seek。
  page.onVideoPlay(videoEvent(page, {}));
  page.onVideoPause(videoEvent(page, {}));
  reportTime(page, 2, 12.4);
  assert.equal(page._nativeEngaged, true);

  const context = page.getVideoContext();
  page.seekToMarker(clickMarker({}, 'mark-warm'));
  assert.deepEqual(context.calls, [{ type: 'seek', seconds: 8 }], '已有播放经历时直接 seek');
  assert.equal(wxLog.scrollCalls.length, 0, 'warm 路径不滚动、不重挂载');

  reportTime(page, 8.2, 12.4);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 8200);
  assert.equal(playCount(context), 0, 'warm 路径不额外播放');
  assert.equal(pauseCount(context), 0, 'warm 路径不擅自暂停');
});

test('T025-20 冷源 0 秒目标：initial-time 重挂载后由新节点的近目标回报确认，旧节点 0 秒不算', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-zero', atMs: 0 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;

  page.seekToMarker(clickMarker({}, 'mark-zero'));
  // 滚动回调前旧节点的 0 秒现值恰好落在目标附近，但仍是“定位前”，不能确认。
  reportTime(page, 0, 12);
  assert.equal(page.data.seekPending, true, 'revealing 阶段不确认落点');
  assert.equal(page._playerTimeSeconds, null);
  assert.equal(page.data.canAddMarker, false);

  completeScroll();
  const instance = coldInstance(page);
  assert.notEqual(instance.token, beforeToken);
  assert.equal(instance.initialSeconds, 0, '0 秒是合法的原生 initial-time');
  assert.equal(instance.autoplay, true);
  const context = page.getVideoContext();
  assert.deepEqual(context.calls, [], '冷源不额外 play/seek');

  // 新节点真实回报 0 秒附近才确认并恢复暂停。
  reportTime(page, 0, 12);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /播放器实际位置 0:00\.000/);
  assert.equal(page.data.playerTimeMs, 0);
  assert.equal(pauseCount(context), 1);
});

test('T025-21 滚动失败：明确可恢复失败、不重挂载也不填目标；再次点回可成功', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-stuck', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;
  const oldContext = page.getVideoContext();

  page.seekToMarker(clickMarker({}, 'mark-stuck'));
  completeScroll('fail');
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, null, '请求目标没有回填为实际位置');
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.match(page.data.seekActualText, /没有当作落点/);
  assert.match(page.data.markerNotice, /没有当作实际位置/);
  assert.equal(coldInstance(page).token, beforeToken, '滚动失败不重挂载');
  assert.equal(page._seek.phase, 'failed');
  assert.equal(page._coldSequenceKey, '', '滚动失败即释放冷源序列元数据');
  assert.equal(pauseCount(oldContext), 0, '没有重挂载就不暂停用户当前画面');

  // 同一个时间点可以再次发起：重新走一次“滚动 + 重挂载”，不是永久锁死。
  page.seekToMarker(clickMarker({}, 'mark-stuck'));
  completeScroll();
  assert.notEqual(coldInstance(page).token, beforeToken);
  assert.equal(coldInstance(page).initialSeconds, 4.954);
  reportTime(page, 4.96, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 4960);
  page.onUnload();
});

test('T025-21b 可见性原生回调迟迟不来：有界失败，不重挂载也不伪造落点', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-slow', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  page._seekRevealWaitMs = 40;
  const beforeToken = page.data.playerToken;

  page.seekToMarker(clickMarker({}, 'mark-slow'));
  assert.equal(coldInstance(page).token, beforeToken);
  await sleep(60);
  assert.equal(page.data.seekPending, false, '不会永久卡在等待可见位置');
  assert.equal(page.data.playerTimeMs, null);
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.equal(coldInstance(page).token, beforeToken, '超时不重挂载');
  page.onUnload();
});

test('T025-23 冷重挂载不依赖 bindplay：新节点首次近目标回报即可确认', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-progress', atMs: 8000 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);

  page.seekToMarker(clickMarker({}, 'mark-progress'));
  completeScroll();
  const context = page.getVideoContext();
  assert.equal(coldInstance(page).initialSeconds, 8);

  // 没有 play 事件，新节点的真实 timeupdate 仍是唯一确认来源。
  reportTime(page, 8.05, 12);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /0:08\.050/);
  assert.equal(page.data.playerTimeMs, 8050);
  assert.equal(pauseCount(context), 1);
  assert.equal(playCount(context), 0, '冷源不使用 play 命令');
});

test('T025-24 重挂载后无近目标回报：有界失败并恢复暂停；迟到落点仍可确认', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-silent', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  page._seekColdLandingWaitMs = 40;

  page.seekToMarker(clickMarker({}, 'mark-silent'));
  completeScroll();
  const context = page.getVideoContext();
  assert.equal(coldInstance(page).autoplay, true);

  await sleep(60);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, null);
  assert.match(page.data.seekActualText, /新的挂载节点/);
  assert.match(page.data.seekActualText, /没有当作落点/);
  assert.match(page.data.markerNotice, /没有当作实际位置/);
  assert.equal(pauseCount(context), 1, '失败收敛时恢复原暂停态');
  assert.equal(seekCalls(context).length, 0, '冷源不重发 seek');

  // 迟到但真正落到目标的同节点原生回报仍可确认；不重复暂停。
  reportTime(page, 4.97, 12);
  assert.match(page.data.seekActualText, /播放器实际位置 0:04\.970/);
  assert.equal(page.data.playerTimeMs, 4970);
  assert.equal(page.data.seekPending, false);
  assert.equal(pauseCount(context), 1);
  page.onUnload();
});

test('T025-27 已推进门槛与冷加载预算：只认同源真实推进，冷重挂载等待有界', () => {
  // 纯判定：只认同源真实进度，元数据/0/早回报都不算。
  assert.equal(markers.coldWarmupProgressSeconds(12), 1.1);
  assert.equal(markers.coldWarmupProgressSeconds(null), 1.1);
  assert.equal(markers.coldWarmupProgressSeconds(0), 1.1);
  assert.equal(markers.isColdWarmupProgress(0, 12), false);
  assert.equal(markers.isColdWarmupProgress(null, 12), false);
  assert.equal(markers.isColdWarmupProgress(0.25, 12), false);
  assert.equal(markers.isColdWarmupProgress(0.8, 12), false);
  assert.equal(markers.isColdWarmupProgress(1.09, 12), false);
  assert.equal(markers.isColdWarmupProgress(1.1, 12), true);

  // 冷重挂载后的落点等待沿用诊断中的冷加载预算（3–4 秒），可见性回调有独立上限。
  assert.ok(
    markers.SEEK_COLD_LANDING_WAIT_MS >= 3000 && markers.SEEK_COLD_LANDING_WAIT_MS <= 4000,
    '冷重挂载落点等待应在 3–4 秒内收口'
  );
  assert.ok(
    markers.SEEK_COLD_REVEAL_WAIT_MS > 0 && markers.SEEK_COLD_REVEAL_WAIT_MS <= 2000,
    '可见性回调有明确上限'
  );
  assert.equal(markers.SEEK_COLD_PLAY_WAIT_MS, undefined, '旧的 play→seek 等待常量已移除');
  assert.equal(markers.SEEK_COLD_MAX_PLAY_ATTEMPTS, undefined, '旧的重试 play 次数已移除');
});

test('T025-28 极短片按实际时长取相对门槛；冷重挂载后下一次点回走 warm seek', async () => {
  const flow = seedFlow();
  const shortClip = coldMarkerClip(flow, [
    { id: 'mark-short-a', atMs: 1000 },
    { id: 'mark-short-b', atMs: 1400 }
  ]);
  shortClip.durationSeconds = 1.6;
  writeIndex([shortClip]);
  const page = openPage(flow);
  loadMetadata(page, 1.6);

  // 1.6 秒片段按一半收口：0.8 秒即视为已推进，不再强求 1.1 秒。
  assert.equal(markers.coldWarmupProgressSeconds(1.6), 0.8);
  assert.equal(markers.isColdWarmupProgress(0.7, 1.6), false);
  assert.equal(markers.isColdWarmupProgress(0.8, 1.6), true);

  page.seekToMarker(clickMarker({}, 'mark-short-a'));
  completeScroll();
  const instance = coldInstance(page);
  assert.equal(instance.initialSeconds, 1, '毫秒目标换算成秒的 initial-time');
  assert.equal(instance.autoplay, true);
  const context = page.getVideoContext();
  reportTime(page, 1.02, 1.6);
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /播放器实际位置 0:01\.020/);
  assert.equal(pauseCount(context), 1, '短片落点确认后仍恢复暂停');
  const landedToken = page.data.playerToken;

  // 已经真实解码过：后续点回沿用当前节点的 VideoContext.seek，不重挂载。
  page.seekToMarker(clickMarker({}, 'mark-short-b'));
  assert.equal(page.data.playerToken, landedToken, 'warm 点回不换节点');
  assert.deepEqual(seekCalls(context), [{ type: 'seek', seconds: 1.4 }]);
  assert.equal(wxLog.scrollCalls.length, 1, 'warm 点回不再滚动/重挂载');
  reportTime(page, 1.4, 1.6);
  assert.equal(page.data.seekPending, false);
  assert.equal(pauseCount(context), 1, 'warm 点回不重复暂停');
});

test('T025-29 普通早期进度（0.8 秒）不把片源标记为可直跳，点回仍走冷重挂载', async () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-early-a', atMs: 6000 },
      { id: 'mark-early-b', atMs: 8000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);

  // 没有在途等待时，0.25/0.8 秒只是展示读数，不算“播起来过”。
  reportTime(page, 0.25, 12);
  assert.equal(page._nativeEngaged, false);
  reportTime(page, 0.8, 12);
  assert.equal(page._nativeEngaged, false, '0.8 秒早回报不能解锁直跳');

  page.seekToMarker(clickMarker({}, 'mark-early-a'));
  assert.equal(wxLog.scrollCalls.length, 1, '未达门槛按冷源先滚动可见');
  completeScroll();
  const context = page.getVideoContext();
  assert.equal(coldInstance(page).initialSeconds, 6);
  reportTime(page, 6.02, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page._nativeEngaged, true);
  assert.equal(pauseCount(context), 1);
  const landedToken = page.data.playerToken;

  // 达到门槛后同源状态保留：下一次点回直接 seek。
  page.seekToMarker(clickMarker({}, 'mark-early-b'));
  assert.equal(page.data.playerToken, landedToken, 'warm 点回不换节点');
  assert.deepEqual(seekCalls(context), [{ type: 'seek', seconds: 8 }], '已推进后沿用直跳');
  reportTime(page, 8.1, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(pauseCount(context), 1);
  page.onUnload();
});

test('T025-22 同源并发点回 latest-click 生效；旧可见性回调不重挂载，旧 token 不控制新片源', async () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-a', atMs: 8000 },
      { id: 'mark-b', atMs: 2000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const originToken = page.data.playerToken;

  // A 冷源点回：滚动请求已发出但还没回调。
  page.seekToMarker(clickMarker({}, 'mark-a'));
  const firstScroll = lastScrollCall();
  assert.equal(firstScroll.options.selector, '#video-player');

  // 落点确认前再点 B：旧等待被替换，只有 B 的可见性回调能重挂载。
  page.seekToMarker(clickMarker({}, 'mark-b'));
  assert.equal(wxLog.scrollCalls.length, 2);
  assert.equal(page._seek.targetMs, 2000);

  // A 的滚动回调迟到：请求已不再拥有，不能重挂载。
  firstScroll.options.success({});
  assert.equal(coldInstance(page).token, originToken, '被接替的旧请求不重挂载');
  assert.equal(page._seek.targetMs, 2000);

  completeScroll();
  const instance = coldInstance(page);
  assert.notEqual(instance.token, originToken);
  assert.equal(instance.initialSeconds, 2);
  assert.equal(instance.autoplay, true);

  // A 原来那个节点的迟到近目标回报不能确认 B。
  page.onVideoTimeUpdate(staleVideoEvent(originToken, { currentTime: 8.2, duration: 12 }));
  assert.equal(page.data.seekPending, true);

  // B 的新节点落到目标：确认并恢复冷源序列开始前的暂停态。
  const context = page.getVideoContext();
  reportTime(page, 2.05, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 2050);
  assert.equal(pauseCount(context), 1);

  // 同一把随后换了片源：旧 token 的 play/timeupdate 不能控制新节点。
  const oldToken = page.data.playerToken;
  const seqBeforeSwitch = page._sourceSeq;
  page.startSource(
    {
      kind: 'saved',
      clipId: 'clip-2-new',
      rev: 2,
      fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-2-new.mp4',
      src: 'wxfile://usr/attempt-video/v1/' + flow.archiveId + '/clip-2-new.mp4'
    },
    '新片'
  );
  const newContext = page.getVideoContext();
  assert.ok(newContext);
  assert.notEqual(page.data.playerToken, oldToken);
  assert.notEqual(newContext.domId, context.domId, '换片后 video 节点也跟着换');
  assert.equal(page._sourceSeq, seqBeforeSwitch + 1, '真实换片也让片源序号单调递增');
  assert.equal(page.data.playerToken, playback.sourceToken(page._contextToken, page._sourceSeq));
  page.onVideoPlay(staleVideoEvent(oldToken, {}));
  page.onVideoTimeUpdate(staleVideoEvent(oldToken, { currentTime: 2.05, duration: 12 }));
  assert.equal(page.data.playing, false, '旧 token 的 play 不采用');
  assert.equal(page.data.seekPending, false);
  assert.deepEqual(newContext.calls, [], '旧 token 不对新片源下发任何控制');

  // 旧等待定时器到点也不能重新对新片源发 seek/play/pause。
  await sleep(260);
  assert.deepEqual(newContext.calls, []);
  page.onUnload();
});

test('T025-30 换片或离页使在途冷源请求作废：旧可见性回调不得重挂载', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-a', atMs: 6000 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);

  page.seekToMarker(clickMarker({}, 'mark-a'));
  const staleScroll = lastScrollCall();
  page.startSource(
    {
      kind: 'saved',
      clipId: 'clip-3-new',
      rev: 1,
      fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-3-new.mp4',
      src: 'wxfile://usr/attempt-video/v1/' + flow.archiveId + '/clip-3-new.mp4'
    },
    '换片'
  );
  const switchedToken = page.data.playerToken;
  staleScroll.options.success({});
  assert.equal(page.data.playerToken, switchedToken, '换片后旧滚动回调不重挂载');
  assert.equal(coldInstance(page).initialSeconds, 0, '新片保持自己的初始节点');
  assert.equal(page.data.seekPending, false);

  // 离页后回调同样作废。
  page.seekToMarker(clickMarker({}, 'mark-a'));
  assert.equal(page.data.seekPending, false, '新片没有时间点可跳');
  const another = openPage(flow);
  loadMetadata(another, 12);
  another.seekToMarker(clickMarker({}, 'mark-a'));
  const unloadScroll = lastScrollCall();
  const unloadToken = another.data.playerToken;
  another.onUnload();
  unloadScroll.options.success({});
  assert.equal(another.data.playerToken, unloadToken, '离页后旧回调不重挂载');
  assert.notEqual(another._seek.phase, 'seeking');
});

test('T025-31 无 pageScrollTo 或可见几何非正：可恢复失败，不重挂载、不填目标', () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-a', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;

  const savedScroll = global.wx.pageScrollTo;
  delete global.wx.pageScrollTo;
  try {
    page.seekToMarker(clickMarker({}, 'mark-a'));
    assert.equal(page.data.seekPending, false);
    assert.equal(page.data.playerTimeMs, null);
    assert.match(page.data.seekActualText, /无法把播放器滚到可见位置/);
    assert.equal(coldInstance(page).token, beforeToken, '无滚动 API 不重挂载');
  } finally {
    global.wx.pageScrollTo = savedScroll;
  }

  // 几何高度非正：同样按可见性未确认处理。
  wxLog.rect = { top: -20, height: 0 };
  page.seekToMarker(clickMarker({}, 'mark-a'));
  completeScroll();
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, null);
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.equal(coldInstance(page).token, beforeToken, '几何不可见不重挂载');
  wxLog.rect = { top: 20, height: 240 };
});

test('T025-32 同一片段冷重挂载不丢弃未确认的记点重试身份', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-cold', atMs: 8000 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  reportTime(page, 0.5, 12.4);
  assert.equal(page._nativeEngaged, false, '0.5 秒未达推进门槛，仍是冷源');

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
    assert.equal(page.data.markerPendingRetry, true);
    const pendingId = page._pendingMarker.markerId;
    assert.equal(page._pendingMarker.clipId, 'clip-1-test');

    // 冷源重挂载只换节点，不清掉这次未确认的记点身份。
    page.seekToMarker(clickMarker({}, 'mark-cold'));
    assert.equal(wxLog.scrollCalls.length, 1, '冷源点回先滚动');
    completeScroll();
    const newToken = page.data.playerToken;
    assert.equal(page.data.markerPendingRetry, true, '重挂载后仍保留重试入口');
    assert.equal(page._pendingMarker.markerId, pendingId);
    assert.equal(page._pendingMarker.token, newToken, '重试身份跟随同一片段的新节点');
    assert.equal(page.data.markers.length, 1, '已有时间点不变');

    page.retryMarker();
    await tick();
    assert.equal(page.data.markerPendingRetry, false);
    assert.equal(page.data.markers.length, 2, '重试只新增本次一个点');
    assert.equal(readIndex().clips[0].markers.length, 2);
  } finally {
    realService.addMarker = originalAdd;
  }
  page.onUnload();
});

test('T025-33 片尾时间点冷重挂载：initial-time 收口到时长，近片尾回报确认且不越界', async () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-tail', atMs: 12400 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);

  page.seekToMarker(clickMarker({}, 'mark-tail'));
  completeScroll();
  const instance = coldInstance(page);
  assert.equal(instance.initialSeconds, 12.4, '片尾请求收口到可给的秒数');
  assert.equal(instance.autoplay, true);

  const context = page.getVideoContext();
  reportTime(page, 12.35, 12.4);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 12350, '实际落点来自原生回报');
  assert.match(page.data.seekActualText, /0:12\.350/);
  assert.equal(pauseCount(context), 1);
  assert.equal(seekCalls(context).length, 0);
  page.onUnload();
});

test('T025-34 被接替的旧滚动失败不清除最新请求的可见性期限', async () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-stale-a', atMs: 8000 },
      { id: 'mark-latest-b', atMs: 2000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  page._seekRevealWaitMs = 40;
  const originToken = page.data.playerToken;

  // A 请求先发滚动，随后被 B 取代；A 的失败回调迟到。
  page.seekToMarker(clickMarker({}, 'mark-stale-a'));
  const firstScroll = lastScrollCall();
  page.seekToMarker(clickMarker({}, 'mark-latest-b'));
  const latestSeek = page._seek;
  assert.equal(latestSeek.targetMs, 2000);

  firstScroll.options.fail({ errMsg: 'pageScrollTo:fail' });
  // 旧失败不得改写或清除当前请求；B 仍拥有自己的期限。
  assert.equal(page._seek, latestSeek, '当前请求没有被旧回调替换');
  assert.equal(page._seek.phase, 'revealing');
  assert.equal(page.data.seekPending, true);
  assert.equal(coldInstance(page).token, originToken, '旧失败不触发重挂载');
  assert.notEqual(page._revealTimer, null, 'B 的可见性期限仍在');

  // B 自己的滚动回调始终不来：仍按 B 的期限失败，而不是永远等待。
  await sleep(70);
  assert.equal(page._seek, latestSeek);
  assert.equal(page._seek.phase, 'failed');
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.equal(coldInstance(page).token, originToken, '没有可见回调就不重挂载');
  assert.equal(page._revealTimer, null, '期限已收口');
  page.onUnload();
});

test('T025-34b 被接替的旧滚动成功也不清除最新请求的期限', async () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-stale-a', atMs: 8000 },
      { id: 'mark-latest-b', atMs: 2000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  page._seekRevealWaitMs = 40;
  const originToken = page.data.playerToken;

  page.seekToMarker(clickMarker({}, 'mark-stale-a'));
  const firstScroll = lastScrollCall();
  page.seekToMarker(clickMarker({}, 'mark-latest-b'));
  const latestSeek = page._seek;

  firstScroll.options.success({});
  assert.equal(page._seek, latestSeek);
  assert.equal(page._seek.phase, 'revealing', '旧成功不重挂载');
  assert.equal(coldInstance(page).token, originToken);
  assert.notEqual(page._revealTimer, null, 'B 的可见性期限仍在');

  // B 的回调不来时仍会过期，不会因为旧成功回调而永久挂起。
  await sleep(70);
  assert.equal(page._seek.phase, 'failed');
  assert.equal(page.data.seekPending, false);
  assert.equal(coldInstance(page).token, originToken);
  page.onUnload();
});

test('T025-35 可见性复核当前播放器节点与视口相交：正高度但完全在视口外不算可见', () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-offscreen', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;
  const playerSelector = '#' + coldInstance(page).domId;

  // 节点高度为正，但整体位于视口下方：不能当成可见。
  wxLog.rect = { top: 620, height: 240 };
  page.seekToMarker(clickMarker({}, 'mark-offscreen'));
  completeScroll();
  assert.equal(coldInstance(page).token, beforeToken, '视口外不重挂载');
  assert.equal(page.data.seekPending, false);
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.equal(page.data.playerTimeMs, null, '请求值不回填落点');
  assert.ok(
    wxLog.querySelectors.includes(playerSelector),
    '复核的是当前播放器节点，而不是只查卡片高度'
  );

  // 几何不可用/尚未回填：不伪造成“已测得可见”，按有界回退继续原生滚动成功。
  wxLog.geometryMissing = true;
  wxLog.rect = { top: 20, height: 240 };
  page.seekToMarker(clickMarker({}, 'mark-offscreen'));
  completeScroll();
  assert.notEqual(coldInstance(page).token, beforeToken, '几何不可用时回退到原生滚动成功');
  assert.equal(coldInstance(page).initialSeconds, 4.954);
  wxLog.geometryMissing = false;
  page.onUnload();
});

test('T025-38 选择器视口为 0 高时改用原生 windowHeight：当前节点可见才重挂载', () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-zero-viewport', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;

  // 真实 SDK 的 selectViewport().boundingClientRect() 恒为 0 高。
  wxLog.viewport = { top: 0, bottom: 0, width: 0, height: 0 };
  wxLog.windowHeight = 446;
  // 滚动后当前播放器节点确实位于原视口内（108.8..270.8）。
  wxLog.rect = { top: 108.8, height: 162 };
  page.seekToMarker(clickMarker({}, 'mark-zero-viewport'));
  completeScroll();

  const instance = coldInstance(page);
  assert.notEqual(instance.token, beforeToken, '0 高视口不应把所有节点判为不可见');
  assert.equal(instance.initialSeconds, 4.954);
  assert.equal(instance.autoplay, true);
  assert.equal(page._seek.phase, 'seeking');
  reportTime(page, 4.96, 12);
  assert.equal(page.data.seekPending, false);
  page.onUnload();

  // getWindowInfo 缺失时回退 getSystemInfoSync，仍按原生有限正高度判定。
  const savedWindowInfo = global.wx.getWindowInfo;
  delete global.wx.getWindowInfo;
  try {
    const fallbackPage = openPage(flow);
    loadMetadata(fallbackPage, 12);
    const fallbackToken = fallbackPage.data.playerToken;
    fallbackPage.seekToMarker(clickMarker({}, 'mark-zero-viewport'));
    completeScroll();
    assert.notEqual(
      coldInstance(fallbackPage).token,
      fallbackToken,
      'getWindowInfo 缺失时回退 getSystemInfoSync'
    );
    fallbackPage.onUnload();
  } finally {
    global.wx.getWindowInfo = savedWindowInfo;
  }
});

test('T025-39 选择器视口为 0 高且节点确实在原生视口外：仍然阻止重挂载', () => {
  const flow = seedFlow();
  writeIndex([coldMarkerClip(flow, [{ id: 'mark-zero-offscreen', atMs: 4954 }])]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  const beforeToken = page.data.playerToken;

  wxLog.viewport = { top: 0, bottom: 0, width: 0, height: 0 };
  wxLog.windowHeight = 446;
  // 节点高度为正，但整体位于原生窗口下方。
  wxLog.rect = { top: 620, height: 240 };
  page.seekToMarker(clickMarker({}, 'mark-zero-offscreen'));
  completeScroll();

  assert.equal(coldInstance(page).token, beforeToken, '原生视口外不重挂载');
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, null, '请求值不回填落点');
  assert.match(page.data.seekActualText, /滚到可见位置/);
  assert.equal(page._seek.phase, 'failed');
  page.onUnload();
});

test('T025-36 未收口冷源序列：旧节点越过推进门槛后新点仍在该序列，保留原暂停态', () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-cold-a', atMs: 8000 },
      { id: 'mark-cold-b', atMs: 4000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  assert.equal(page._nativeEngaged, false);

  // A 冷重挂载后，新节点已经越过 1.1 秒门槛，但还没有落到 A 的目标。
  page.seekToMarker(clickMarker({}, 'mark-cold-a'));
  completeScroll();
  const tokenA = page.data.playerToken;
  const domA = coldInstance(page).domId;
  const seqA = page._sourceSeq;
  const contextA = page.getVideoContext();
  reportTime(page, 2, 12);
  assert.equal(page._nativeEngaged, false, '未确认的冷源序列不能被早到的推进解锁');
  assert.equal(page.data.seekPending, true);
  assert.equal(page._playerTimeSeconds, null, '未到目标的读数不能成为可记点位置');
  assert.equal(page.data.canAddMarker, false);

  // A 未收口时点 B：仍属于同一段冷源序列，保留最初的暂停态，不能改走直跳。
  page.seekToMarker(clickMarker({}, 'mark-cold-b'));
  assert.equal(page._seek.mode, 'cold', '未收口序列中的新点仍是冷源');
  assert.equal(page._seek.needPauseRestore, true, '保留用户最初的暂停态');
  assert.equal(wxLog.scrollCalls.length, 2, '重新走滚动可见与重挂载');
  assert.equal(seekCalls(contextA).length, 0, '不对旧节点下发 seek');
  completeScroll();

  const tokenB = page.data.playerToken;
  const domB = coldInstance(page).domId;
  assert.equal(page._sourceSeq, seqA + 1, '连续冷重挂载序号单调递增');
  assert.notEqual(tokenB, tokenA, '连续冷重挂载换新 token');
  assert.notEqual(domB, domA, '连续冷重挂载换新 DOM ID');
  assert.equal(coldInstance(page).initialSeconds, 4);

  // A 旧节点即使回报 B 的目标附近也不能确认 B。
  page.onVideoTimeUpdate(staleVideoEvent(tokenA, { currentTime: 4.02, duration: 12 }));
  assert.equal(page.data.seekPending, true, '旧节点近目标回报被拒绝');
  assert.equal(page._playerTimeSeconds, null);
  assert.equal(page.data.playerTimeMs, null, '旧节点读数没有进入新节点的展示');

  // B 自己的新节点落到目标：确认并恢复最初暂停态。
  const contextB = page.getVideoContext();
  assert.notEqual(contextB, contextA);
  reportTime(page, 4.03, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playerTimeMs, 4030);
  assert.equal(pauseCount(contextB), 1);
  assert.equal(page._nativeEngaged, true);
  assert.equal(page._coldSequenceKey, '', '确认后收口序列');
  page.onUnload();
});

test('T025-37 冷源过期释放序列元数据：之后的主动播放不被下一次落点强行暂停', async () => {
  const flow = seedFlow();
  writeIndex([
    coldMarkerClip(flow, [
      { id: 'mark-expire-a', atMs: 8000 },
      { id: 'mark-expire-b', atMs: 4000 }
    ])
  ]);
  const page = openPage(flow);
  loadMetadata(page, 12);
  page._seekColdLandingWaitMs = 40;

  page.seekToMarker(clickMarker({}, 'mark-expire-a'));
  completeScroll();
  const contextA = page.getVideoContext();
  // 新节点已越过门槛但未落到目标：仍不能结束这段未收口序列。
  reportTime(page, 2, 12);
  assert.equal(page._nativeEngaged, false);

  await sleep(60);
  assert.equal(page.data.seekPending, false);
  assert.equal(page._playerTimeSeconds, null, '过期不伪造可记点落点');
  assert.equal(page.data.canAddMarker, false);
  assert.equal(page._coldSequenceKey, '', '过期释放冷源序列元数据');
  assert.equal(pauseCount(contextA), 1, '过期时按原暂停态收口');

  // 用户在过期后主动播放：下一次点回按当前真实播放态处理，不再强行暂停。
  page.onVideoPlay(videoEvent(page, {}));
  assert.equal(page.data.playing, true);
  page.seekToMarker(clickMarker({}, 'mark-expire-b'));
  assert.equal(page._seek.mode, 'cold', '过期后节点仍未确认推进，仍走冷源');
  assert.equal(page._seek.needPauseRestore, false, '主动播放的状态被尊重');
  completeScroll();
  const contextB = page.getVideoContext();
  reportTime(page, 4.01, 12);
  assert.equal(page.data.seekPending, false);
  assert.equal(page.data.playing, true);
  assert.equal(pauseCount(contextB), 0, '不对主动播放的新节点发暂停');
  page.onUnload();
});

// ------------------------------------------------------------------ *
// 连点去重、失败重试与窄屏按钮（V3 返工）
// ------------------------------------------------------------------ */

test('T025-25 真实 WXML 绑定下快速连点同一帧只记一次；不同位置与失败重试照常保存', async () => {
  const flow = seedFlow();
  writeIndex([clipOf(flow)]);
  const page = openPage(flow);
  loadMetadata(page, 12.4);
  reportTime(page, 3.125, 12.4);
  page.onVideoPause(videoEvent(page, {}));

  const wxml = fs.readFileSync(VIDEO_PAGE_WXML, 'utf8');
  const addBinding = bindingOf(wxml, 'add-marker', 'tap');
  assert.equal(addBinding, 'addMarkerAtCurrentTime');
  const tapAdd = () =>
    page[addBinding]({ type: 'tap', currentTarget: { dataset: {} }, target: { dataset: {} } });

  tapAdd();
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [3125],
    '第一次点击必须落盘'
  );

  // 本地同步回执已结清后约 100ms 再点同一帧：不应新增第二行。
  await sleep(100);
  tapAdd();
  await tick();
  assert.deepEqual(
    page.data.markers.map(item => item.atMs),
    [3125],
    '快速连点同一帧不能重复保存'
  );
  assert.match(page.data.markerNotice, /没有重复添加/);

  // 不同位置立即再点：必须正常保存。
  reportTime(page, 3.25, 12.4);
  tapAdd();
  await tick();
  assert.deepEqual(page.data.markers.map(item => item.atMs), [3125, 3250]);

  // 失败重试不能被去重吞掉：写前失败后立即再点，沿用同一次动作并落盘。
  reportTime(page, 4.125, 12.4);
  const realService = files.openAttemptVideoService(flow.archiveId);
  const originalAdd = realService.addMarker;
  let failOnce = true;
  realService.addMarker = request => {
    if (failOnce) {
      failOnce = false;
      return { ok: false, code: 'index-write-failed', error: '模拟写入前失败' };
    }
    return originalAdd.call(realService, request);
  };
  try {
    tapAdd();
    await tick();
    assert.equal(page.data.markerPendingRetry, true);
    tapAdd();
    await tick();
    assert.deepEqual(
      page.data.markers.map(item => item.atMs),
      [3125, 3250, 4125],
      '失败后的快速重试仍然保存，没有被去重吞掉'
    );
    assert.equal(page.data.markerPendingRetry, false);
  } finally {
    realService.addMarker = originalAdd;
  }

  // 不同片段即使在窗口内、同一 atMs 也不能被上一条片段的成功记点拦住。
  const sameMs = { clipId: 'clip-1-test', rev: 1, fileId: 'a.mp4', atMs: 3125, at: Date.now() };
  assert.equal(
    markers.isRapidDuplicateMarker(sameMs, { ...sameMs, clipId: 'clip-2-other' }, Date.now()),
    false,
    '不同片段不能串用去重状态'
  );
  assert.equal(
    markers.isRapidDuplicateMarker(sameMs, { ...sameMs, fileId: 'b.mp4' }, Date.now()),
    false,
    '同一片段换文件标识也不能命中去重'
  );
});

test('T025-26 时间点行按钮在窄屏有明确受限宽度并允许换行，触控高度至少 44px', () => {
  const wxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'attempt-video', 'attempt-video.wxss'),
    'utf8'
  );
  const row = (wxss.match(/\.marker-row\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(row, /flex-wrap:\s*wrap/, '窄屏放不下时动作区应换行而不是越界');

  const actions = (wxss.match(/\.marker-actions\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(actions, /flex-wrap:\s*nowrap/, '动作按钮自身不拆行');

  const button = (wxss.match(/\.marker-button\s*\{([^}]*)\}/) || [])[1] || '';
  const width = Number((button.match(/\bwidth:\s*(\d+)px/) || [])[1]);
  assert.ok(width > 0 && width <= 100, 'marker 按钮需要明确且足够窄的宽度：' + width);
  assert.match(button, /min-width:\s*\d+px/);
  assert.match(button, /max-width:\s*\d+px/);
  assert.match(button, /box-sizing:\s*border-box/);

  const touch = (wxss.match(/\.primary-button,\s*\.secondary-button\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(touch, /min-height:\s*44px/, '动作按钮触控高度至少 44px');
});
