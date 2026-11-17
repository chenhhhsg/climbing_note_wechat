/**
 * T026 逐把视频 · 保存本机持久副本并保护在用视频的离线回归测试
 *
 * 直接加载真实模块与真实页面：
 * - utils/attempt-video-files.js（本单新增的持久层：档案专属目录、独立索引、空间预检、
 *   更换/移除、无引用清理与冷启动恢复）；
 * - utils/attempt-video-playback.js、utils/attempt-video.js、utils/training-store.js；
 * - pages/attempt-video、pages/training-attempts、pages/training-route（真实页面处理器）。
 *
 * 文件系统使用隔离的虚拟实现，记录每一次 mkdir / copyFile / stat / readdir / unlink，
 * 并可注入写失败、配额失败、索引写失败（写前/写后/读回失败）、删除失败、复制在途与
 * 换档迟到。测试口径：
 * - 确认保存后临时路径失效，重建页面与文件服务仍读到 B 的持久文件、实际字节与原片段，
 *   A 不挂片；缺文件时 B 仍可看记录并重选；
 * - 单片、总量（含其他档案副本）与替换峰值预检；真实配额失败与写入失败都不留已提交关联；
 * - 索引写抛错按读回判断：已落盘算成功，明确无引用才撤销，读不回则保留存疑副本与
 *   所有权记录，重启后安全清理；移除同样只处理明确解除关联的指定版本；
 * - 文件服务最后一次异步等待后、写索引前按四个 ID 与有效把次复核，换档/撤回在途不提交；
 * - 索引条目的文件标识严格限定当前档案视频根目录的同一片段；普通相对路径、旧绝对
 *   路径与跨档案条目都不播放、不回收；
 * - 重复确认/并发保存不产生第二份副本；提交后回收无引用旧副本；清理失败保留文件
 *   并可再次清理；过期页面不报本次成功，移除确认框固定原片段版本；
 * - 只有索引引用或本功能待清理记录能证明所有权；仅命名合法的未知文件保留不动；
 * - 撤回/恢复同一把后仍读到原片；索引损坏时一个文件也不删。
 *
 * 真实配额、真机解码、相册权限与断网冷启动播放交给整项 QA 与手机复验（待验）。
 *
 * 运行：node --test tests/attempt-video-files.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const FILES_UTIL = path.join(ROOT, 'utils', 'attempt-video-files.js');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const PLAYBACK_UTIL = path.join(ROOT, 'utils', 'attempt-video-playback.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const VIDEO_DIR = path.join(ROOT, 'pages', 'attempt-video');
const VIDEO_JS = path.join(VIDEO_DIR, 'attempt-video.js');
const VIDEO_WXML = path.join(VIDEO_DIR, 'attempt-video.wxml');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const USER_DATA_PATH = 'wxfile://usr';

// ---- 隔离虚拟文件系统与微信替身 ----
const storage = new Map();
const virtual = {
  files: new Map(),
  dirs: new Set(),
  calls: { mkdir: [], copyFile: [], unlink: [], stat: [], readdir: [], access: [] }
};
const faults = {
  mkdir: false,
  copy: '',
  unlink: false,
  stat: false,
  readdir: false,
  access: false,
  storageFail: new Set(),
  // 匹配的索引写入先落盘再抛错；随后同一键的 N 次读取抛错（写入回执与读回同时丢失）。
  storageAfter: [],
  readThrows: null
};
const wxLog = {
  chooseCalls: [],
  chooseHandler: null,
  storageWrites: 0,
  storageReadFails: 0,
  navigations: [],
  videoContexts: []
};

// 复制在途控制：测试可以卡住下一次 copyFile，模拟真实复制尚未返回时的换档/撤回。
const copyHold = { matches: null, arrived: false, release: null };

let tempSeq = 0;

function resetAll() {
  storage.clear();
  virtual.files.clear();
  virtual.dirs.clear();
  Object.keys(virtual.calls).forEach(key => {
    virtual.calls[key] = [];
  });
  faults.mkdir = false;
  faults.copy = '';
  faults.unlink = false;
  faults.stat = false;
  faults.readdir = false;
  faults.access = false;
  faults.storageFail = new Set();
  faults.storageAfter = [];
  faults.readThrows = null;
  wxLog.chooseCalls = [];
  wxLog.chooseHandler = null;
  wxLog.storageWrites = 0;
  wxLog.storageReadFails = 0;
  wxLog.navigations = [];
  wxLog.videoContexts = [];
  copyHold.matches = null;
  copyHold.arrived = false;
  copyHold.release = null;
  tempSeq = 0;
}

/** 卡住下一次满足条件的 copyFile；release() 后真实复制并回调成功。 */
function holdNextCopy(matches) {
  copyHold.matches = matches || (() => true);
  copyHold.arrived = false;
  copyHold.release = null;
  return {
    get arrived() {
      return copyHold.arrived;
    },
    release() {
      assert.equal(typeof copyHold.release, 'function', '复制没有到达可释放点');
      const release = copyHold.release;
      copyHold.release = null;
      copyHold.matches = null;
      release();
    }
  };
}

function addTempVideo(name, bytes) {
  tempSeq += 1;
  const filePath = 'wxfile://tmp/' + tempSeq + '-' + (name || 'clip.mp4');
  virtual.files.set(filePath, Buffer.alloc(bytes, 5));
  return filePath;
}

function addManagedFile(archiveId, name, bytes) {
  const filePath =
    USER_DATA_PATH + '/attempt-video/v1/' + archiveId + '/' + name;
  virtual.files.set(filePath, Buffer.alloc(bytes, 6));
  return filePath;
}

/**
 * 所有权夹具：本功能写真实文件前会先落一条待清理记录；只有记录过的文件才会被
 * 回收。仅仅命名合法（clip-*）的未知文件不算归属证据，必须保留。
 */
function addPendingOwnership(archiveId, clipId, name) {
  const fileId = 'attempt-video/v1/' + archiveId + '/' + name;
  const raw = storage.has(VIDEO_INDEX_KEY) ? storage.get(VIDEO_INDEX_KEY) : '';
  const index = raw
    ? JSON.parse(raw)
    : { version: 1, nextClipSeq: 1, clips: [], pending: [] };
  index.pending = (index.pending || []).filter(entry => entry.fileId !== fileId);
  index.pending.push({
    archiveId,
    clipId,
    fileId,
    opId: 'qa-fixture-ownership',
    createdAt: '2026-11-16T10:00:00.000Z'
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  return { fileId, path: USER_DATA_PATH + '/' + fileId };
}

function filesInRoot(archiveId) {
  const prefix = USER_DATA_PATH + '/attempt-video/v1/' + archiveId + '/';
  return Array.from(virtual.files.keys())
    .filter(key => key.indexOf(prefix) === 0)
    .sort();
}

function fileSystem() {
  return {
    mkdir(options) {
      virtual.calls.mkdir.push(options.dirPath);
      if (faults.mkdir) {
        options.fail({ errMsg: 'mkdir:fail mock mkdir failed' });
        return;
      }
      virtual.dirs.add(options.dirPath);
      options.success({});
    },
    copyFile(options) {
      virtual.calls.copyFile.push({
        srcPath: options.srcPath,
        destPath: options.destPath
      });
      if (faults.copy) {
        options.fail({ errMsg: faults.copy });
        return;
      }
      const perform = () => {
        if (!virtual.files.has(options.srcPath)) {
          options.fail({ errMsg: 'copyFile:fail no such file or directory' });
          return;
        }
        virtual.files.set(
          options.destPath,
          Buffer.from(virtual.files.get(options.srcPath))
        );
        options.success({});
      };
      if (copyHold.matches && copyHold.matches(options)) {
        copyHold.arrived = true;
        copyHold.release = perform;
        return;
      }
      perform();
    },
    unlink(options) {
      virtual.calls.unlink.push(options.filePath);
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
      virtual.calls.stat.push(options.path);
      if (faults.stat) {
        options.fail({ errMsg: 'stat:fail mock stat failed' });
        return;
      }
      if (!virtual.files.has(options.path)) {
        options.fail({ errMsg: 'stat:fail no such file or directory' });
        return;
      }
      options.success({ stats: { size: virtual.files.get(options.path).length } });
    },
    readdir(options) {
      virtual.calls.readdir.push(options.dirPath);
      if (faults.readdir) {
        options.fail({ errMsg: 'readdir:fail mock readdir failed' });
        return;
      }
      const prefix = options.dirPath + '/';
      const names = [];
      virtual.files.forEach((value, key) => {
        if (key.indexOf(prefix) !== 0) return;
        const rest = key.slice(prefix.length);
        if (rest && rest.indexOf('/') === -1) names.push(rest);
      });
      options.success({ files: names });
    },
    access(options) {
      virtual.calls.access.push(options.path);
      if (faults.access) {
        options.fail({ errMsg: 'access:fail mock access failed' });
        return;
      }
      if (!virtual.files.has(options.path)) {
        options.fail({ errMsg: 'access:fail no such file or directory' });
        return;
      }
      options.success({});
    }
  };
}

global.wx = {
  env: { USER_DATA_PATH },
  getStorageSync(key) {
    if (
      faults.readThrows &&
      faults.readThrows.key === key &&
      faults.readThrows.remaining > 0
    ) {
      faults.readThrows.remaining -= 1;
      wxLog.storageReadFails += 1;
      throw { errMsg: 'getStorageSync:fail mock read error' };
    }
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    if (faults.storageFail.has(key)) {
      throw { errMsg: 'setStorageSync:fail mock storage error' };
    }
    const index = faults.storageAfter.findIndex(
      item => item.key === key && item.matches(value)
    );
    const fault = index === -1 ? null : faults.storageAfter.splice(index, 1)[0];
    wxLog.storageWrites += 1;
    storage.set(key, value);
    if (fault) {
      faults.readThrows = { key, remaining: fault.readFailures || 0 };
      throw { errMsg: 'setStorageSync:fail mock storage error after write' };
    }
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager: fileSystem,
  chooseMedia(options) {
    wxLog.chooseCalls.push(options);
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
    wxLog.navigations.push({ type: 'toast', title: options.title });
  }
};

global.getApp = () => ({ globalData: {} });

const store = require(STORE_JS);
const attemptVideo = require(VIDEO_UTIL);
const playback = require(PLAYBACK_UTIL);
const files = require(FILES_UTIL);

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

const videoDefinition = capturePage(VIDEO_JS);
const attemptsDefinition = capturePage(ATTEMPTS_JS);
const routeDefinition = capturePage(ROUTE_JS);

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

async function settle(rounds) {
  const count = typeof rounds === 'number' ? rounds : 10;
  for (let index = 0; index < count; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
}

// ---- 正式档案夹具 ----
function startAt(date, gymName) {
  const started = store.startSession({
    gymName,
    date,
    now: new Date(date + 'T09:30:00')
  });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function newRoute(session) {
  const created = store.createRoute({
    sessionId: session.id,
    name: '蓝色动态线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function record(session, route, result, note) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note: note || ''
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function seedTwoAttempts() {
  const session = startAt('2026-11-12', '同线岩馆');
  const route = newRoute(session);
  const attemptA = record(session, route, 'fail', 'A 把的备注');
  const attemptB = record(session, route, 'fail', 'B 把的备注');
  return { session, route, attemptA, attemptB, archiveId: store.loadState().archive.archiveId };
}

function idsOf(flow, attempt) {
  return {
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: attempt.id
  };
}

function makeStorage(failKeys) {
  const failing = failKeys || new Set();
  return {
    get(key) {
      return storage.has(key) ? storage.get(key) : '';
    },
    set(key, value) {
      if (failing.has(key)) throw { errMsg: 'setStorageSync:fail mock storage error' };
      storage.set(key, value);
    },
    remove(key) {
      storage.delete(key);
    }
  };
}

/**
 * 可编排的存储替身：
 * - before：匹配的写入在落盘前抛错（索引未变）；
 * - after：匹配的写入先落盘再抛错（回执丢失但索引已变）；
 * - getThrows：写入故障发生后，接下来 N 次读取抛错（读回也失败）。
 * 每条故障只消费一次，与真实「写失败一次后重试」的窗口一致。
 */
function makeScriptedStorage(script) {
  const config = script || {};
  const before = config.before || [];
  const after = config.after || [];
  let pendingReadFails = 0;
  function take(queue, key, value) {
    const index = queue.findIndex(
      item => item.key === key && (!item.matches || item.matches(value))
    );
    if (index === -1) return null;
    return queue.splice(index, 1)[0];
  }
  return {
    get(key) {
      if (pendingReadFails > 0) {
        pendingReadFails -= 1;
        throw { errMsg: 'getStorageSync:fail mock read error' };
      }
      return storage.has(key) ? storage.get(key) : '';
    },
    set(key, value) {
      const failBefore = take(before, key, value);
      if (failBefore) {
        pendingReadFails = config.getThrows || 0;
        throw { errMsg: 'setStorageSync:fail mock storage error before write' };
      }
      storage.set(key, value);
      const failAfter = take(after, key, value);
      if (failAfter) {
        pendingReadFails = config.getThrows || 0;
        throw { errMsg: 'setStorageSync:fail mock storage error after write' };
      }
    },
    remove(key) {
      storage.delete(key);
    }
  };
}

function clipLambda(attemptId, previousFileId) {
  return value => {
    let parsed;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
      return false;
    }
    const clips = parsed && Array.isArray(parsed.clips) ? parsed.clips : [];
    return clips.some(
      clip =>
        clip &&
        clip.attemptId === attemptId &&
        (previousFileId === undefined || clip.fileId !== previousFileId)
    );
  };
}

function makeService(flow, options) {
  const config = options || {};
  const archiveId = config.archiveId || flow.archiveId;
  return files.createAttemptVideoStore({
    archiveId,
    files:
      config.files ||
      files.createWxAttemptVideoFiles({ archiveId, wxApi: global.wx }),
    storage: config.storage || makeStorage(config.failKeys),
    now: () => '2026-11-16T10:00:00.000Z',
    space: config.space,
    verifyArchive: config.verifyArchive,
    verifyContext: config.verifyContext
  });
}

function requestFor(flow, attempt, tempPath, extra) {
  const bytes =
    tempPath && virtual.files.has(tempPath) ? virtual.files.get(tempPath).length : undefined;
  return Object.assign(
    {
      action: 'commit',
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      attemptId: attempt.id,
      attemptSeq: attempt.seq,
      tempFilePath: tempPath,
      sizeBytes: bytes,
      durationSeconds: 7.5,
      width: 1920,
      height: 1080,
      fileName: 'sample.mp4'
    },
    extra || {}
  );
}

function videoIndexRaw() {
  return storage.has(VIDEO_INDEX_KEY) ? storage.get(VIDEO_INDEX_KEY) : '';
}

function videoIndex() {
  const raw = videoIndexRaw();
  return raw ? JSON.parse(raw) : null;
}

function openVideoPage(flow, attempt) {
  const page = createPage(videoDefinition);
  page.onLoad(idsOf(flow, attempt));
  return page;
}

function openAttemptsPage(flow) {
  const page = createPage(attemptsDefinition);
  page.onLoad({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  return page;
}

function openRoutePage(flow) {
  const page = createPage(routeDefinition);
  page.onLoad({ routeId: flow.route.id, archiveId: flow.archiveId });
  return page;
}

function chooseVideo(tempPath, reportedSize) {
  const bytes = virtual.files.has(tempPath) ? virtual.files.get(tempPath).length : 0;
  wxLog.chooseHandler = options => {
    options.success({
      tempFiles: [
        {
          tempFilePath: tempPath,
          // 相册回调的 size 只是提示：测试可以传一个与物理字节不符的值。
          size: reportedSize === undefined ? bytes : reportedSize,
          duration: 7.5,
          width: 1920,
          height: 1080,
          fileType: 'video'
        }
      ],
      type: 'video'
    });
  };
}

beforeEach(() => {
  resetAll();
  files.resetAttemptVideoServices();
  playback.setVideoStore(null);
});

// ------------------------------------------------------------------ *
// 持久副本、索引与两处入口
// ------------------------------------------------------------------ */

test('T026-1 确认保存写入档案专属目录与独立索引，临时路径失效后仍读到同一片段', async () => {
  const flow = seedTwoAttempts();
  const temp = addTempVideo('b.mp4', 4096);
  const service = makeService(flow);
  const result = await service.commit(requestFor(flow, flow.attemptB, temp));

  assert.equal(result.ok, true, result.error);
  assert.equal(result.duplicate, false);
  assert.match(result.clip.clipId, /^clip-1-[a-z0-9]+$/);
  assert.equal(result.clip.rev, 1);
  assert.equal(result.clip.archiveId, flow.archiveId);
  assert.equal(result.clip.sessionId, flow.session.id);
  assert.equal(result.clip.routeId, flow.route.id);
  assert.equal(result.clip.attemptId, flow.attemptB.id);
  assert.match(
    result.clip.fileId,
    new RegExp(
      '^attempt-video/v1/' + flow.archiveId + '/clip-1-[a-z0-9]+\\.mp4$'
    )
  );
  assert.equal(result.clip.bytes, 4096, '索引记录的是实际写入字节');

  const persistentPath = USER_DATA_PATH + '/' + result.clip.fileId;
  assert.equal(virtual.files.has(persistentPath), true);
  assert.equal(virtual.files.get(persistentPath).length, 4096);
  const index = videoIndex();
  assert.equal(index.version, 1);
  assert.equal(index.nextClipSeq, 2);
  assert.equal(index.clips.length, 1, '同一把只有一条关联');
  assert.equal(index.clips[0].bytes, 4096);
  assert.equal(
    files.currentClipFor(index, flow.archiveId, flow.attemptA.id),
    null,
    'A 不会因为 B 得到关联'
  );
  assert.equal(files.currentClipFor(index, flow.archiveId, 'other-attempt'), null);

  // 临时路径失效：删掉来源临时文件，重建文件服务与页面，仍定位到同一持久副本。
  virtual.files.delete(temp);
  files.resetAttemptVideoServices();
  const pageB = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(pageB.data.hasSavedVideo, true);
  assert.equal(pageB.data.savedVideo.clipId, result.clip.clipId);
  assert.equal(pageB.data.savedVideo.sizeText, '4.0 KB');
  assert.equal(pageB.data.playerKind, 'saved');
  assert.equal(pageB.data.playerSrc, persistentPath);
  assert.equal(pageB.data.playerSizeText, '4.0 KB');

  const pageA = openVideoPage(flow, flow.attemptA);
  await settle();
  assert.equal(pageA.data.hasSavedVideo, false);
  assert.equal(pageA.data.playerSrc, '');
  assert.equal(pageA.data.attempt.note, 'A 把的备注');

  // 场内明细与原场次历史都读到 B 的持久关联，A 没有。
  const attemptsPage = openAttemptsPage(flow);
  const rowA = attemptsPage.data.attempts.find(item => item.id === flow.attemptA.id);
  const rowB = attemptsPage.data.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(rowA.hasVideo, false);
  assert.equal(rowB.hasVideo, true);
  assert.equal(rowB.videoEntryText, '看视频 ›');
  const routePage = openRoutePage(flow);
  const historyB = routePage.data.groups[0].attempts.find(
    item => item.id === flow.attemptB.id
  );
  assert.equal(historyB.hasVideo, true);
  assert.equal(historyB.videoEntryText, '看视频 ›');

  // 持久文件丢失：B 仍可看记录并重新选择，索引不被清掉（恢复入口只报告缺失）。
  virtual.files.delete(persistentPath);
  const pageMissing = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(pageMissing.data.attempt.id, flow.attemptB.id);
  assert.equal(pageMissing.data.attempt.note, 'B 把的备注');
  assert.equal(pageMissing.data.hasSavedVideo, true);
  const replacement = addTempVideo('again.mp4', 1024);
  chooseVideo(replacement);
  pageMissing.choosePreview();
  assert.equal(pageMissing.data.hasPreview, true);
  assert.equal(pageMissing.data.preview.mode, 'replacement');
  assert.equal(pageMissing.data.preview.tempFilePath, replacement);

  const recovered = await makeService(flow).recover();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.missing.length, 1);
  assert.equal(recovered.missing[0].clipId, result.clip.clipId);
  assert.equal(videoIndex().clips.length, 1, '缺文件不删除原关联');
});

// ------------------------------------------------------------------ *
// 空间：单片、总量与替换峰值
// ------------------------------------------------------------------ */

test('T026-2 空间预检：单片上限、总量与替换峰值；超限不写文件不改索引', async () => {
  const flow = seedTwoAttempts();
  const space = {
    budgetBytes: 12000,
    warnBytes: 9000,
    photoReserveBytes: 2000,
    reserveBytes: 1000,
    maxClipBytes: 6000
  };
  const service = makeService(flow, { space });

  // 单片超限：6001 字节。
  const tooLarge = addTempVideo('large.mp4', 6001);
  const large = await service.commit(requestFor(flow, flow.attemptB, tooLarge));
  assert.equal(large.ok, false);
  assert.equal(large.code, 'space-insufficient');
  assert.match(large.error, /单段上限/);
  assert.equal(filesInRoot(flow.archiveId).length, 0, '预检失败不写任何文件');
  assert.equal(videoIndexRaw(), '', '预检失败不创建索引');

  // B 3000 + A 3000 = 6000，总量在 10000 可用预算内。
  const bTemp = addTempVideo('b.mp4', 3000);
  const aTemp = addTempVideo('a.mp4', 3000);
  const bCommitted = await service.commit(requestFor(flow, flow.attemptB, bTemp));
  const aCommitted = await service.commit(requestFor(flow, flow.attemptA, aTemp));
  assert.equal(bCommitted.ok, true, bCommitted.error);
  assert.equal(aCommitted.ok, true, aCommitted.error);

  // 更换 B 为 6000：旧 3000 + 新 6000 + 余量 1000 = 13000 > 10000，按预算拒绝。
  const replaceTemp = addTempVideo('new.mp4', 6000);
  const beforeIndex = videoIndexRaw();
  const peak = await service.replace(
    requestFor(flow, flow.attemptB, replaceTemp, {
      action: 'replace',
      clipId: bCommitted.clip.clipId,
      rev: bCommitted.clip.rev,
      fileId: bCommitted.clip.fileId,
      bytes: bCommitted.clip.bytes
    })
  );
  assert.equal(peak.ok, false);
  assert.equal(peak.code, 'space-insufficient');
  assert.equal(peak.space.reason, 'budget');
  assert.match(peak.error, /预计峰值/);
  assert.match(peak.error, /为照片保留/);
  assert.equal(videoIndexRaw(), beforeIndex, '预检失败不改索引');
  assert.equal(filesInRoot(flow.archiveId).length, 2, '旧片与新片都没有写入');

  // 正好踩在可用预算上：6000 + 3000 + 1000 = 10000，允许更换。
  const okTemp = addTempVideo('ok.mp4', 3000);
  const replaced = await service.replace(
    requestFor(flow, flow.attemptB, okTemp, {
      action: 'replace',
      clipId: bCommitted.clip.clipId,
      rev: bCommitted.clip.rev,
      fileId: bCommitted.clip.fileId,
      bytes: bCommitted.clip.bytes
    })
  );
  assert.equal(replaced.ok, true, replaced.error);
  assert.equal(replaced.clip.rev, 2);
  assert.equal(replaced.cleanupError, '');

  const usage = await service.getSpaceUsage();
  assert.equal(usage.ok, true);
  assert.equal(usage.totalBytes, 6000);
  assert.equal(usage.clipCount, 2);
  assert.equal(usage.usableBytes, 10000);
  assert.equal(usage.percent, 60);
  assert.equal(usage.orphanBytes, 0);
  assert.equal(usage.warn, false, '6000 未到 9000 提醒线');
});

// ------------------------------------------------------------------ *
// 写入失败、配额失败与来源不可读
// ------------------------------------------------------------------ */

test('T026-3 真实文件写入失败与真实配额失败：不提交关联，旧片保留', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);

  // 普通写入失败。
  faults.copy = 'copyFile:fail mock write failed';
  const failTemp = addTempVideo('fail.mp4', 2048);
  const failed = await service.commit(requestFor(flow, flow.attemptB, failTemp));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'file-write-failed');
  assert.match(failed.error, /mock write failed/);
  assert.equal(filesInRoot(flow.archiveId).length, 0);
  assert.equal(videoIndexRaw(), '');

  // 恢复后正常保存，再用真实配额失败更换：旧关联与旧文件都保留。
  faults.copy = '';
  const okTemp = addTempVideo('ok.mp4', 2048);
  const committed = await service.commit(requestFor(flow, flow.attemptB, okTemp));
  assert.equal(committed.ok, true, committed.error);
  const indexRaw = videoIndexRaw();
  const oldPath = USER_DATA_PATH + '/' + committed.clip.fileId;

  const quotaTemp = addTempVideo('quota.mp4', 2048);
  faults.copy = 'copyFile:fail no space left on device';
  const quota = await service.replace(
    requestFor(flow, flow.attemptB, quotaTemp, {
      action: 'replace',
      clipId: committed.clip.clipId,
      rev: committed.clip.rev,
      fileId: committed.clip.fileId,
      bytes: committed.clip.bytes
    })
  );
  assert.equal(quota.ok, false);
  assert.equal(quota.code, 'space-insufficient');
  assert.match(quota.error, /空间不足/);
  assert.equal(videoIndexRaw(), indexRaw, '配额失败不改索引');
  assert.equal(virtual.files.has(oldPath), true, '旧副本仍在');
  assert.equal(filesInRoot(flow.archiveId).length, 1, '没有留下新的半成品');

  // 来源不可读：既没有临时文件也没有大小提示，直接拒绝，不写文件。
  faults.copy = '';
  const noSource = await service.commit(
    requestFor(flow, flow.attemptA, 'wxfile://tmp/not-exist.mp4', { sizeBytes: undefined })
  );
  assert.equal(noSource.ok, false);
  assert.equal(noSource.code, 'source-unreadable');
  assert.equal(filesInRoot(flow.archiveId).length, 1);
});

// ------------------------------------------------------------------ *
// 索引写失败：撤销新副本，旧关联与旧副本不变
// ------------------------------------------------------------------ */

test('T026-4 索引写入失败：新副本撤销，旧关联与旧副本保持原样', async () => {
  const flow = seedTwoAttempts();
  const failing = new Set([VIDEO_INDEX_KEY]);

  // 首次保存索引写失败：新文件不能留在目录里冒充已保存。
  const failingService = makeService(flow, { failKeys: failing });
  const temp = addTempVideo('b.mp4', 4096);
  const failed = await failingService.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'index-write-failed');
  assert.equal(filesInRoot(flow.archiveId).length, 0, '索引失败后撤销新副本');
  assert.equal(videoIndexRaw(), '');

  // 已有旧片时更换失败：新副本撤销，旧索引与旧文件都在。
  const goodService = makeService(flow);
  const first = await goodService.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(first.ok, true, first.error);
  const indexRaw = videoIndexRaw();
  const oldPath = USER_DATA_PATH + '/' + first.clip.fileId;
  const replaceTemp = addTempVideo('new.mp4', 2048);
  const replaceFail = await failingService.replace(
    requestFor(flow, flow.attemptB, replaceTemp, {
      action: 'replace',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(replaceFail.ok, false);
  assert.equal(replaceFail.code, 'index-write-failed');
  assert.equal(videoIndexRaw(), indexRaw, '索引逐字节不变');
  assert.equal(virtual.files.has(oldPath), true, '旧副本未删除');
  assert.equal(filesInRoot(flow.archiveId).length, 1, '新副本已撤销');

  // 移除时索引写失败：关联与文件都不动。
  const removeFail = await failingService.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(removeFail.ok, false);
  assert.equal(removeFail.code, 'index-write-failed');
  assert.equal(videoIndexRaw(), indexRaw);
  assert.equal(virtual.files.has(oldPath), true);
});

// ------------------------------------------------------------------ *
// 重复确认、并发保存、换档迟到与过期版本
// ------------------------------------------------------------------ */

test('T026-5 重复确认与并发保存不产生第二份副本', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('b.mp4', 2048);
  const request = requestFor(flow, flow.attemptB, temp);

  const first = await service.commit(request);
  assert.equal(first.ok, true, first.error);
  const indexRaw = videoIndexRaw();
  const second = await service.commit(request);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, '重复确认复用已有片段');
  assert.equal(second.clip.clipId, first.clip.clipId);
  assert.equal(videoIndexRaw(), indexRaw, '重复确认不写索引');
  assert.equal(filesInRoot(flow.archiveId).length, 1, '只保留一份副本');
});

test('T026-5b 两个页面同时保存同一把：后到者可见失败，不覆盖先到者', async () => {
  const flow = seedTwoAttempts();
  const serviceOne = makeService(flow);
  const serviceTwo = makeService(flow);
  const tempOne = addTempVideo('one.mp4', 1024);
  const tempTwo = addTempVideo('two.mp4', 2048);

  const outcomes = await Promise.all([
    serviceOne.commit(requestFor(flow, flow.attemptB, tempOne)),
    serviceTwo.commit(requestFor(flow, flow.attemptB, tempTwo))
  ]);
  const wins = outcomes.filter(outcome => outcome.ok && !outcome.duplicate);
  assert.equal(wins.length, 1, '只允许一次真实提交');
  assert.equal(
    outcomes.filter(outcome => outcome.duplicate || (!outcome.ok && outcome.code === 'operation-in-progress')).length,
    1,
    '后到者只能是复用已有片段或可见地忙，不能产生第二份副本'
  );
  assert.equal(filesInRoot(flow.archiveId).length, 1, '同一把只有一份文件');
  assert.equal(videoIndex().clips.length, 1, '同一把只有一条关联');
  assert.equal(videoIndex().clips[0].attemptId, flow.attemptB.id);
});

test('T026-5c 换档迟到与过期版本不写入，原片仍可用', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('b.mp4', 2048);
  const first = await service.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(first.ok, true, first.error);
  const indexRaw = videoIndexRaw();
  const oldPath = USER_DATA_PATH + '/' + first.clip.fileId;

  // 换档迟到：服务绑定的档案已不是当前档案，任何写入都拒绝。
  let currentArchive = flow.archiveId;
  const guarded = makeService(flow, { verifyArchive: () => currentArchive === flow.archiveId });
  const lateTemp = addTempVideo('late.mp4', 1024);
  currentArchive = 'archive-of-another-profile';
  const late = await guarded.commit(
    requestFor(flow, flow.attemptA, lateTemp, { archiveId: flow.archiveId })
  );
  assert.equal(late.ok, false);
  assert.equal(late.code, 'archive-mismatch');
  assert.equal(filesInRoot(flow.archiveId).length, 1, '迟到写入没有新增文件');
  assert.equal(videoIndexRaw(), indexRaw, '迟到写入没有改索引');

  // 请求带另一份档案 ID：直接拒绝。
  const wrongArchive = await service.commit(
    requestFor(flow, flow.attemptA, lateTemp, { archiveId: 'archive-of-another-profile' })
  );
  assert.equal(wrongArchive.ok, false);
  assert.equal(wrongArchive.code, 'archive-mismatch');

  // 过期版本 / 过期片段：更换与移除都拒绝，原片不受影响。
  const staleTemp = addTempVideo('stale.mp4', 1024);
  const staleReplace = await service.replace(
    requestFor(flow, flow.attemptB, staleTemp, {
      action: 'replace',
      clipId: first.clip.clipId,
      rev: 99,
      fileId: first.clip.fileId
    })
  );
  assert.equal(staleReplace.ok, false);
  assert.equal(staleReplace.code, 'stale-operation');
  const staleRemove = await service.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: first.clip.clipId,
      rev: 99,
      fileId: first.clip.fileId
    })
  );
  assert.equal(staleRemove.ok, false);
  assert.equal(staleRemove.code, 'stale-operation');
  assert.equal(videoIndexRaw(), indexRaw);
  assert.equal(filesInRoot(flow.archiveId).length, 1);
  assert.equal(virtual.files.has(oldPath), true);
});

// ------------------------------------------------------------------ *
// 更换、移除、清理失败与撤回恢复
// ------------------------------------------------------------------ */

test('T026-6 更换提交后回收旧副本；清理失败保留文件可再清理；移除只处理小程序内副本', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const archiveRaw = storage.get(ARCHIVE_KEY);

  const firstTemp = addTempVideo('b.mp4', 4096);
  const first = await service.commit(requestFor(flow, flow.attemptB, firstTemp));
  assert.equal(first.ok, true, first.error);
  const oldPath = USER_DATA_PATH + '/' + first.clip.fileId;

  // 正常更换：新片可读，旧副本在提交完成且无引用后删除。
  const newTemp = addTempVideo('new.mp4', 2048);
  const replaced = await service.replace(
    requestFor(flow, flow.attemptB, newTemp, {
      action: 'replace',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(replaced.ok, true, replaced.error);
  assert.equal(replaced.clip.rev, 2);
  assert.equal(replaced.clip.bytes, 2048);
  assert.equal(replaced.cleanupError, '');
  assert.equal(virtual.files.has(oldPath), false, '旧副本已回收');
  assert.equal(filesInRoot(flow.archiveId).length, 1);
  assert.equal(videoIndex().clips.length, 1);

  // 清理失败：索引已提交新片，旧副本暂留；占用里如实计为无引用，干净后可再清理。
  const aTemp = addTempVideo('a.mp4', 1024);
  const aCommitted = await service.commit(requestFor(flow, flow.attemptA, aTemp));
  assert.equal(aCommitted.ok, true, aCommitted.error);
  const aOldPath = USER_DATA_PATH + '/' + aCommitted.clip.fileId;
  const aNewTemp = addTempVideo('a-new.mp4', 1536);
  faults.unlink = true;
  const cleanupFailed = await service.replace(
    requestFor(flow, flow.attemptA, aNewTemp, {
      action: 'replace',
      clipId: aCommitted.clip.clipId,
      rev: aCommitted.clip.rev,
      fileId: aCommitted.clip.fileId,
      bytes: aCommitted.clip.bytes
    })
  );
  assert.equal(cleanupFailed.ok, true, '新旧关联已提交，清理失败不虚报失败');
  assert.ok(cleanupFailed.cleanupError, '清理失败要可见');
  assert.equal(virtual.files.has(aOldPath), true, '无引用旧副本暂留');
  const dirty = await service.getSpaceUsage();
  assert.equal(dirty.orphanBytes, 1024);

  faults.unlink = false;
  const cleaned = await service.cleanupOrphans();
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.equal(cleaned.deletedCount, 1);
  const cleanUsage = await service.getSpaceUsage();
  assert.equal(cleanUsage.orphanBytes, 0);

  // 移除：只回收小程序内副本；原把次、备注与训练档案都在。
  const remove = await service.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: replaced.clip.clipId,
      rev: replaced.clip.rev,
      fileId: replaced.clip.fileId,
      bytes: replaced.clip.bytes
    })
  );
  assert.equal(remove.ok, true, remove.error);
  assert.equal(remove.removed, true);
  assert.equal(videoIndex().clips.filter(clip => clip.attemptId === flow.attemptB.id).length, 0);
  assert.equal(storage.get(ARCHIVE_KEY), archiveRaw, '移除不改训练档案');
  const attemptB = store.loadState().archive.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(attemptB.note, 'B 把的备注');
  assert.equal(attemptB.result, 'fail');

  // 重复移除幂等；再次移除不报错、不删别的文件。
  const again = await service.remove(
    requestFor(flow, flow.attemptB, '', { action: 'remove', clipId: '', rev: null })
  );
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);

  // 撤回/恢复同一把：视频索引不参与把次状态，恢复后仍读到原片。
  const undoFlow = seedTwoAttempts();
  const undoService = makeService(undoFlow);
  const undoTemp = addTempVideo('undo.mp4', 3072);
  const undoClip = await undoService.commit(requestFor(undoFlow, undoFlow.attemptB, undoTemp));
  assert.equal(undoClip.ok, true, undoClip.error);
  assert.equal(store.undoAttempt(undoFlow.attemptB.id).ok, true);
  let view = attemptVideo.videoClipView(undoFlow.archiveId, undoFlow.attemptB.id);
  assert.equal(view.state, 'saved');
  assert.equal(view.clip.clipId, undoClip.clip.clipId);
  assert.equal(store.restoreAttempt(undoFlow.attemptB.id).ok, true);
  view = attemptVideo.videoClipView(undoFlow.archiveId, undoFlow.attemptB.id);
  assert.equal(view.state, 'saved');
  assert.equal(view.clip.clipId, undoClip.clip.clipId);
  assert.equal(
    virtual.files.has(USER_DATA_PATH + '/' + undoClip.clip.fileId),
    true,
    '撤回/恢复都不删视频副本'
  );
});

// ------------------------------------------------------------------ *
// 冷启动恢复与窗口竞争
// ------------------------------------------------------------------ */

test('T026-7 冷启动恢复只清理本功能创建且无引用的文件；索引损坏时一个文件也不删', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('b.mp4', 2048);
  const committed = await service.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(committed.ok, true, committed.error);
  const referencedPath = USER_DATA_PATH + '/' + committed.clip.fileId;

  // 崩溃窗口留下的无引用半成品（有本功能所有权记录） + 一个不属于本功能的文件。
  const orphanPath = addManagedFile(flow.archiveId, 'clip-99.mp4', 512);
  addPendingOwnership(flow.archiveId, 'clip-99', 'clip-99.mp4');
  const unknownClipPath = addManagedFile(flow.archiveId, 'clip-98-unknown.mp4', 256);
  const foreignPath = addManagedFile(flow.archiveId, 'readme.txt', 64);

  files.resetAttemptVideoServices();
  const freshService = makeService(flow);
  const recovered = await freshService.recover();
  assert.equal(recovered.ok, true, recovered.error);
  assert.deepEqual(recovered.deleted, [orphanPath]);
  assert.equal(recovered.missing.length, 0);
  assert.equal(virtual.files.has(referencedPath), true, '被索引引用的副本保留');
  assert.equal(virtual.files.has(orphanPath), false, '有所有权记录的无引用半成品被清理');
  assert.equal(
    virtual.files.has(unknownClipPath),
    true,
    '仅命名合法的未知 clip 文件没有所有权证据，必须保留'
  );
  assert.equal(virtual.files.has(foreignPath), true, '非本功能文件绝不动');

  const usage = await freshService.getSpaceUsage();
  assert.equal(usage.totalBytes, 2048 + 256, '实际占用包含未知 clip 文件');
  assert.equal(usage.orphanBytes, 0, '未知文件不能报成可清理');
  assert.equal(usage.clipCount, 1);

  // 索引损坏：不删除任何文件（包括有所有权记录的无引用半成品），只返回可见错误。
  const brokenOrphan = addManagedFile(flow.archiveId, 'clip-100.mp4', 128);
  storage.set(VIDEO_INDEX_KEY, '{');
  const brokenService = makeService(flow);
  const broken = await brokenService.recover();
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'index-broken');
  assert.equal(virtual.files.has(referencedPath), true);
  assert.equal(virtual.files.has(brokenOrphan), true, '索引不可读时保留无引用文件');
  assert.equal(virtual.files.has(unknownClipPath), true);
  assert.equal(virtual.files.has(foreignPath), true);

  // 恢复索引后清理即可继续；索引条目本身不被自动改写。
  storage.set(
    VIDEO_INDEX_KEY,
    JSON.stringify({
      version: 1,
      nextClipSeq: 2,
      clips: [committed.clip],
      pending: [
        {
          archiveId: flow.archiveId,
          clipId: 'clip-100',
          fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-100.mp4',
          opId: 'qa-fixture-ownership',
          createdAt: '2026-11-16T10:00:00.000Z'
        }
      ]
    })
  );
  const recoveredAgain = await makeService(flow).cleanupOrphans();
  assert.equal(recoveredAgain.ok, true);
  assert.equal(recoveredAgain.deletedCount, 1);
  assert.equal(virtual.files.has(brokenOrphan), false);
  assert.equal(virtual.files.has(unknownClipPath), true, '未知文件仍保留');
  assert.equal(videoIndex().clips.length, 1);

  // 冷启动后继续保存：序号接着索引走，不会覆盖已有片段。
  const beforeFiles = filesInRoot(flow.archiveId).filter(name => /\/clip-.*\.mp4$/.test(name));
  const nextTemp = addTempVideo('next.mp4', 1024);
  const next = await makeService(flow).commit(requestFor(flow, flow.attemptA, nextTemp));
  assert.equal(next.ok, true, next.error);
  assert.match(next.clip.clipId, /^clip-2-[a-z0-9]+$/);
  assert.equal(videoIndex().clips.length, 2);
  assert.equal(
    filesInRoot(flow.archiveId).filter(name => /\/clip-.*\.mp4$/.test(name)).length,
    beforeFiles.length + 1,
    '只新增一个片段文件，不覆盖已有片段'
  );
});

// ------------------------------------------------------------------ *
// 页面接线：确认保存、占用显示、清理与重建
// ------------------------------------------------------------------ */

test('T026-8 页面确认保存后切到持久副本，占用与清理入口可用，重建页面仍可回看', async () => {
  const flow = seedTwoAttempts();
  const archiveRaw = storage.get(ARCHIVE_KEY);
  const temp = addTempVideo('b.mp4', 4096);

  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(page.data.storeAvailable, true, 'T026 起持久层默认可用');
  assert.equal(page.data.storeHint, '');

  chooseVideo(temp);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.mode, 'initial');
  page.commitPreview();
  assert.equal(page.data.busy, true);
  await settle();

  assert.equal(page.data.busy, false, page.data.opError);
  assert.equal(page.data.opError, '');
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.hasSavedVideo, true);
  const savedClip = videoIndex().clips[0];
  assert.match(savedClip.clipId, /^clip-1-[a-z0-9]+$/);
  assert.equal(page.data.savedVideo.clipId, savedClip.clipId);
  assert.equal(page.data.savedVideo.sizeText, '4.0 KB');
  assert.equal(page.data.playerKind, 'saved');
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + savedClip.fileId);
  assert.match(page.data.notice, /已保存到本机/);
  assert.equal(storage.get(ARCHIVE_KEY), archiveRaw, '保存视频不改训练档案');
  assert.equal(savedClip.bytes, 4096);

  // 临时路径失效不影响持久副本。
  virtual.files.delete(temp);
  assert.equal(virtual.files.has(page.data.playerSrc), true);

  // 占用卡片按实际字节显示：1 段、4.0 KB，并说明为照片保留的余量。
  assert.match(page.data.spaceUsageText, /4\.0 KB/);
  assert.match(page.data.spaceDetailText, /1 段本机视频/);
  assert.match(page.data.spaceDetailText, /已为照片保留/);
  assert.equal(page.data.canCleanupOrphans, false);

  // 崩溃留下的无引用副本（有本功能所有权记录）：刷新后计入占用并给出可执行清理入口。
  const orphanPath = addManagedFile(flow.archiveId, 'clip-77.mp4', 1024);
  addPendingOwnership(flow.archiveId, 'clip-77', 'clip-77.mp4');
  // 仅命名合法的未知文件没有所有权证据：只计入占用，不提供清理，也绝不被删除。
  const unknownPath = addManagedFile(flow.archiveId, 'clip-66-unknown.mp4', 512);
  page.onShow();
  await settle();
  assert.equal(page.data.canCleanupOrphans, true);
  assert.match(page.data.spaceDetailText, /无引用/);
  assert.equal(virtual.files.has(unknownPath), true);
  page.cleanupVideoOrphans();
  assert.equal(page.data.cleanupBusy, true);
  await settle();
  assert.equal(page.data.cleanupBusy, false);
  assert.match(page.data.cleanupNotice, /已清理 1 个无引用副本/);
  assert.equal(virtual.files.has(orphanPath), false);
  assert.equal(virtual.files.has(unknownPath), true, '未知文件保留');
  assert.equal(page.data.canCleanupOrphans, false);

  // 重建文件服务与页面：仍读到同一持久文件与原片段。
  files.resetAttemptVideoServices();
  const rebuilt = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(rebuilt.data.hasSavedVideo, true);
  assert.equal(rebuilt.data.savedVideo.clipId, savedClip.clipId);
  assert.equal(rebuilt.data.playerSrc, page.data.playerSrc);
  assert.equal(rebuilt.data.attempt.note, 'B 把的备注');
});

test('T026-8b 提交后丢回执：页面按读回的索引确认成功并标明回执不明确', async () => {
  const flow = seedTwoAttempts();
  const real = makeService(flow);
  playback.setVideoStore({
    commit(request) {
      return real.commit(request).then(result =>
        result.ok ? { ok: false, error: '回执丢失' } : result
      );
    },
    replace(request) {
      return real.replace(request);
    },
    remove(request) {
      return real.remove(request);
    }
  });

  const temp = addTempVideo('b.mp4', 2048);
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  chooseVideo(temp);
  page.choosePreview();
  page.commitPreview();
  await settle();

  assert.equal(page.data.busy, false, page.data.opError);
  assert.equal(page.data.opError, '');
  assert.equal(page.data.hasSavedVideo, true);
  assert.equal(page.data.savedVideo.clipId, videoIndex().clips[0].clipId);
  assert.match(page.data.notice, /已保存到本机/);
  assert.match(page.data.notice, /回执不明确/);
  assert.equal(videoIndex().clips.length, 1);
  assert.equal(filesInRoot(flow.archiveId).length, 1);
});

test('T026-9 页面取消更换保留旧片；确认更换只清理无引用旧副本；移除后记录仍在', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const firstTemp = addTempVideo('b.mp4', 4096);
  const first = await service.commit(requestFor(flow, flow.attemptB, firstTemp));
  assert.equal(first.ok, true, first.error);
  const oldPath = USER_DATA_PATH + '/' + first.clip.fileId;
  const indexRaw = videoIndexRaw();
  const archiveRaw = storage.get(ARCHIVE_KEY);
  const fileCountBefore = filesInRoot(flow.archiveId).length;

  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(page.data.hasSavedVideo, true);

  // 取消更换：不创建副本、不改索引、回到同一段旧片。
  const cancelTemp = addTempVideo('cancel.mp4', 2048);
  chooseVideo(cancelTemp);
  page.choosePreview();
  assert.equal(page.data.preview.mode, 'replacement');
  page.cancelReplace();
  assert.equal(page.data.hasPreview, false);
  assert.equal(page.data.playerSrc, oldPath);
  assert.match(page.data.notice, /仍使用原来那段视频/);
  assert.equal(videoIndexRaw(), indexRaw, '取消不改索引');
  assert.equal(filesInRoot(flow.archiveId).length, fileCountBefore, '取消不创建文件');

  // 确认更换：新片写入并提交后，旧副本才被回收。
  const replaceTemp = addTempVideo('new.mp4', 3072);
  chooseVideo(replaceTemp);
  page.choosePreview();
  page.confirmReplace();
  await settle();
  assert.equal(page.data.busy, false, page.data.opError);
  assert.equal(page.data.savedVideo.revText, '2');
  assert.equal(page.data.savedVideo.sizeText, '3.0 KB');
  assert.equal(virtual.files.has(oldPath), false, '旧副本已回收');
  assert.equal(filesInRoot(flow.archiveId).length, 1);
  assert.equal(videoIndex().clips.length, 1);
  assert.match(page.data.notice, /已更换为新的本机副本/);

  // 移除：明确两步；移除后播放器与关联收起，原把次、备注与训练档案都在。
  page.askRemove();
  assert.equal(page.data.confirmRemove, true);
  page.cancelRemove();
  assert.equal(page.data.confirmRemove, false);
  page.askRemove();
  page.confirmRemove();
  await settle();
  assert.equal(page.data.busy, false, page.data.opError);
  assert.equal(page.data.hasSavedVideo, false);
  assert.equal(page.data.playerSrc, '');
  assert.equal(page.data.videoInstances.length, 0);
  assert.match(page.data.notice, /已移除小程序内的本机副本/);
  assert.match(page.data.notice, /系统相册里的原片都还在/);
  assert.equal(page.data.attempt.id, flow.attemptB.id);
  assert.equal(page.data.attempt.note, 'B 把的备注');
  assert.equal(storage.get(ARCHIVE_KEY), archiveRaw, '移除不改训练档案');
  assert.equal(filesInRoot(flow.archiveId).length, 0, '小程序内副本已回收');
  assert.equal(videoIndex().clips.length, 0);

  // 移除后仍可重新选择：B 的记录与备注不受影响。
  const reselectTemp = addTempVideo('reselect.mp4', 1024);
  chooseVideo(reselectTemp);
  page.choosePreview();
  assert.equal(page.data.hasPreview, true);
  assert.equal(page.data.preview.mode, 'initial');
});

test('T026-10 WXML 与本机持久层边界：占用/清理入口可见，无上传与云调用', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(
    appJson.pages.filter(item => item === 'pages/attempt-video/attempt-video').length,
    1
  );

  const wxml = fs.readFileSync(VIDEO_WXML, 'utf8');
  assert.match(wxml, /id="video-space"/);
  assert.match(wxml, /id="video-space-usage"/);
  assert.match(wxml, /id="cleanup-video-orphans"/);
  assert.match(wxml, /bindtap="cleanupVideoOrphans"/);
  assert.match(wxml, /\{\{spaceUsageText\}\}/);
  assert.match(wxml, /\{\{spaceWarning\}\}/);
  for (const handler of new Set(
    [...wxml.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1])
  )) {
    assert.equal(typeof videoDefinition[handler], 'function', '缺少页面处理器：' + handler);
  }

  for (const file of [FILES_UTIL, VIDEO_JS, VIDEO_UTIL, PLAYBACK_UTIL]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(source, /uploadFile|downloadFile|wx\.cloud/, name + ' 不得上传或调用云能力');
    assert.doesNotMatch(source, /devtools\//, name + ' 不得引用打包时被排除的 devtools 路径');
    assert.doesNotMatch(
      source,
      /gymLogTrial|trial-save-server|trial-profile/,
      name + ' 不得引用试用工程'
    );
  }
  // 页面本身仍只经注入接口读写持久层。
  const pageSource = fs.readFileSync(VIDEO_JS, 'utf8');
  assert.doesNotMatch(pageSource, /setStorageSync/, '页面不得写 storage');
  assert.doesNotMatch(
    pageSource,
    /getFileSystemManager|copyFile|unlink|mkdir|writeFile/,
    '页面不得直接读写文件'
  );
});


// ------------------------------------------------------------------ *
// QA 返工：索引回执读回、归属复核、过期页面与所有权证据
// ------------------------------------------------------------------ */

test('T026-11 索引写入已落盘但抛错：保存与更换按读回确认成功，保留新副本并回收旧副本', async () => {
  const flow = seedTwoAttempts();
  const script = {
    after: [{ key: VIDEO_INDEX_KEY, matches: clipLambda(flow.attemptB.id) }]
  };
  const service = makeService(flow, { storage: makeScriptedStorage(script) });

  // 首次保存：写盘成功后才抛错。读回确认本次片段与真实文件都在 → 成功（回执丢失）。
  const temp = addTempVideo('b.mp4', 4096);
  const first = await service.commit(
    requestFor(flow, flow.attemptB, temp, { opId: 'op-commit-1' })
  );
  assert.equal(first.ok, true, first.error);
  assert.equal(first.receiptLost, true, '写后抛错按读回确认成功');
  const firstPath = USER_DATA_PATH + '/' + first.clip.fileId;
  assert.equal(virtual.files.has(firstPath), true, '新副本没有被误删');
  assert.equal(videoIndex().clips.length, 1);
  assert.equal(videoIndex().clips[0].clipId, first.clip.clipId);
  assert.equal(videoIndex().clips[0].opId, 'op-commit-1');
  assert.deepEqual(videoIndex().pending, [], '所有权记录已清掉');
  assert.equal(virtual.files.get(firstPath).length, 4096);

  // 更换：同样写后抛错。读回确认新版本落盘后才回收旧副本。
  script.after.push({
    key: VIDEO_INDEX_KEY,
    matches: clipLambda(flow.attemptB.id, first.clip.fileId)
  });
  const nextTemp = addTempVideo('new.mp4', 2048);
  const replaced = await service.replace(
    requestFor(flow, flow.attemptB, nextTemp, {
      action: 'replace',
      opId: 'op-replace-1',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(replaced.ok, true, replaced.error);
  assert.equal(replaced.receiptLost, true);
  assert.equal(replaced.clip.rev, 2);
  assert.equal(replaced.clip.opId, 'op-replace-1');
  assert.equal(virtual.files.has(firstPath), false, '旧副本在确认无引用后回收');
  assert.equal(filesInRoot(flow.archiveId).length, 1);
  assert.equal(videoIndex().clips.length, 1);
  assert.equal(videoIndex().clips[0].clipId, replaced.clip.clipId);
  assert.deepEqual(videoIndex().pending, []);
});

test('T026-12 索引写前抛错与读回也失败：无引用才撤销；读不回时保留存疑副本待重启安全清理', async () => {
  const flow = seedTwoAttempts();

  // 1) 写前抛错：读回明确没有本次引用 → 撤销新副本，索引不创建。
  const beforeService = makeService(flow, {
    storage: makeScriptedStorage({
      before: [{ key: VIDEO_INDEX_KEY, matches: clipLambda(flow.attemptB.id) }]
    })
  });
  const failedTemp = addTempVideo('b.mp4', 4096);
  const failed = await beforeService.commit(requestFor(flow, flow.attemptB, failedTemp));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'index-write-failed');
  assert.equal(filesInRoot(flow.archiveId).length, 0, '读回确认无引用后才撤销新副本');
  assert.equal(videoIndexRaw(), '', '失败不创建索引');

  // 2) 已有旧片时更换写前失败：旧索引逐字节不变、旧副本保留、新副本撤销。
  const goodService = makeService(flow);
  const firstTemp = addTempVideo('first.mp4', 2048);
  const first = await goodService.commit(requestFor(flow, flow.attemptB, firstTemp));
  assert.equal(first.ok, true, first.error);
  const indexRaw = videoIndexRaw();
  const oldPath = USER_DATA_PATH + '/' + first.clip.fileId;
  const replaceService = makeService(flow, {
    storage: makeScriptedStorage({
      before: [{ key: VIDEO_INDEX_KEY, matches: clipLambda(flow.attemptB.id, first.clip.fileId) }]
    })
  });
  const replaceTemp = addTempVideo('new.mp4', 1024);
  const replaceFail = await replaceService.replace(
    requestFor(flow, flow.attemptB, replaceTemp, {
      action: 'replace',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(replaceFail.ok, false);
  assert.equal(replaceFail.code, 'index-write-failed');
  assert.equal(videoIndexRaw(), indexRaw, '索引逐字节不变');
  assert.equal(virtual.files.has(oldPath), true, '旧副本未被删除');
  assert.equal(filesInRoot(flow.archiveId).length, 1, '新副本已撤销');

  // 3) 写前抛错且紧接着的读回也失败：保留存疑副本 + 所有权记录；
  //    重启后索引可读、无引用且有所有权记录 → 只清理这次操作写下的文件。
  const blindService = makeService(flow, {
    storage: makeScriptedStorage({
      before: [{ key: VIDEO_INDEX_KEY, matches: clipLambda(flow.attemptA.id) }],
      getThrows: 1
    })
  });
  const blindTemp = addTempVideo('blind.mp4', 3072);
  const blind = await blindService.commit(requestFor(flow, flow.attemptA, blindTemp));
  assert.equal(blind.ok, false);
  assert.equal(blind.keptCopy, true, '读回失败时保留存疑副本');
  const extraFiles = filesInRoot(flow.archiveId).filter(
    name => name.indexOf(first.clip.clipId + '.mp4') === -1
  );
  assert.equal(extraFiles.length, 1, '存疑新副本保留在目录里');
  assert.equal(videoIndex().pending.length, 1, '待清理记录保留（所有权证据）');
  assert.equal(videoIndex().clips.length, 1, '没有提交新关联');

  files.resetAttemptVideoServices();
  const recovered = await makeService(flow).recover();
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.deletedCount, 1);
  assert.equal(virtual.files.has(extraFiles[0]), false, '重启后清理可证明由该次操作创建的文件');
  assert.equal(virtual.files.has(oldPath), true, '被索引引用的旧副本保留');
  assert.equal(videoIndex().pending.length, 0, '所有权记录清理后移除');
});

test('T026-13 移除的索引写入丢回执：读回确认解除关联后才回收指定版本；写前失败保留原片', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('b.mp4', 2048);
  const first = await service.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(first.ok, true, first.error);
  const clipPath = USER_DATA_PATH + '/' + first.clip.fileId;
  const removeRequest = requestFor(flow, flow.attemptB, '', {
    action: 'remove',
    clipId: first.clip.clipId,
    rev: first.clip.rev,
    fileId: first.clip.fileId,
    bytes: first.clip.bytes
  });
  const clipRemoved = value => JSON.parse(value).clips.length === 0;

  // 写前抛错：读回仍是指定版本 → 失败且不删任何文件。
  const beforeService = makeService(flow, {
    storage: makeScriptedStorage({ before: [{ key: VIDEO_INDEX_KEY, matches: clipRemoved }] })
  });
  const failed = await beforeService.remove(removeRequest);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'index-write-failed');
  assert.equal(virtual.files.has(clipPath), true);
  assert.equal(videoIndex().clips.length, 1);

  // 写后抛错：读回明确显示指定版本已解除关联 → 成功（回执丢失）并只回收该版本。
  const afterService = makeService(flow, {
    storage: makeScriptedStorage({ after: [{ key: VIDEO_INDEX_KEY, matches: clipRemoved }] })
  });
  const removed = await afterService.remove(removeRequest);
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.receiptLost, true);
  assert.equal(virtual.files.has(clipPath), false);
  assert.equal(videoIndex().clips.length, 0);
});

test('T026-14 真实复制在途时换档或撤回：不提交索引，只清理本次操作的无引用副本', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);

  // 同 ID 的另一份档案在复制途中替换了本机档案。
  const temp = addTempVideo('b.mp4', 2048);
  const hold = holdNextCopy(options => options.srcPath === temp);
  const pending = service.commit(requestFor(flow, flow.attemptB, temp));
  await settle();
  assert.equal(hold.arrived, true, '真实复制已经开始');
  const switched = JSON.parse(storage.get(ARCHIVE_KEY));
  switched.archiveId = 'archive-qa-switched';
  storage.set(ARCHIVE_KEY, JSON.stringify(switched));
  hold.release();
  const lost = await pending;
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'archive-mismatch', '换档后不提交');
  assert.equal(filesInRoot(flow.archiveId).length, 0, '本次临时副本已清理');
  assert.equal(videoIndexRaw(), '', '没有为旧上下文提交索引');

  // 恢复原档案，再验证复制途中撤回同一把。
  const restored = JSON.parse(storage.get(ARCHIVE_KEY));
  restored.archiveId = flow.archiveId;
  storage.set(ARCHIVE_KEY, JSON.stringify(restored));
  const undoTemp = addTempVideo('a.mp4', 1536);
  const undoHold = holdNextCopy(options => options.srcPath === undoTemp);
  const undoPending = service.commit(requestFor(flow, flow.attemptA, undoTemp));
  await settle();
  assert.equal(undoHold.arrived, true);
  assert.equal(store.undoAttempt(flow.attemptA.id).ok, true);
  undoHold.release();
  const undone = await undoPending;
  assert.equal(undone.ok, false);
  assert.equal(undone.code, 'context-invalid', '撤回后不提交');
  assert.equal(filesInRoot(flow.archiveId).length, 0, '本次副本已清理');
  assert.equal(videoIndexRaw(), '');
});

test('T026-15 过期的更换回执不报本次成功：刷新展示他页提交的新版本', async () => {
  const flow = seedTwoAttempts();
  const pageOne = openVideoPage(flow, flow.attemptB);
  await settle();
  const firstTemp = addTempVideo('a.mp4', 2048);
  chooseVideo(firstTemp);
  pageOne.choosePreview();
  pageOne.commitPreview();
  await settle();
  assert.equal(pageOne.data.hasSavedVideo, true, pageOne.data.opError);

  // A 页选好替换预览（基准 rev1）；B 页同时完成一次更换（rev2）。
  const staleTemp = addTempVideo('stale.mp4', 1024);
  chooseVideo(staleTemp);
  pageOne.choosePreview();
  assert.equal(pageOne.data.preview.mode, 'replacement');

  const pageTwo = openVideoPage(flow, flow.attemptB);
  await settle();
  const nextTemp = addTempVideo('b.mp4', 3072);
  chooseVideo(nextTemp);
  pageTwo.choosePreview();
  pageTwo.confirmReplace();
  await settle();
  assert.equal(pageTwo.data.opError, '');
  const current = videoIndex().clips[0];
  const currentPath = USER_DATA_PATH + '/' + current.fileId;

  pageOne.confirmReplace();
  await settle();
  assert.deepEqual(videoIndex().clips[0], current, '过期操作不改索引');
  assert.doesNotMatch(pageOne.data.notice, /已更换|更换成功/, '不报本次已更换');
  assert.match(
    (pageOne.data.opError || '') + (pageOne.data.notice || ''),
    /\S/,
    '过期操作有可见结果'
  );
  assert.equal(pageOne.data.savedVideo.clipId, current.clipId, '按读回刷新他页版本');
  assert.equal(pageOne.data.playerSrc, currentPath);
  assert.equal(virtual.files.has(currentPath), true);
  assert.equal(filesInRoot(flow.archiveId).length, 1);
});

test('T026-16 移除确认框固定发起时的片段：他页更换后延迟确认不会移除新片', async () => {
  const flow = seedTwoAttempts();
  const pageOne = openVideoPage(flow, flow.attemptB);
  await settle();
  const firstTemp = addTempVideo('a.mp4', 2048);
  chooseVideo(firstTemp);
  pageOne.choosePreview();
  pageOne.commitPreview();
  await settle();
  const firstClip = videoIndex().clips[0];
  pageOne.askRemove();
  assert.equal(pageOne.data.confirmRemove, true);

  const pageTwo = openVideoPage(flow, flow.attemptB);
  await settle();
  const nextTemp = addTempVideo('b.mp4', 3072);
  chooseVideo(nextTemp);
  pageTwo.choosePreview();
  pageTwo.confirmReplace();
  await settle();
  const current = videoIndex().clips[0];
  assert.notEqual(current.clipId, firstClip.clipId);
  const currentPath = USER_DATA_PATH + '/' + current.fileId;

  // A 页 onShow 刷新：对话框仍在，但固定为发起时的旧片段版本。
  pageOne.onShow();
  await settle();
  assert.equal(pageOne.data.confirmRemove, true);
  assert.equal(pageOne.data.savedVideo.clipId, current.clipId, '展示按最新索引刷新');
  pageOne.confirmRemove();
  await settle();
  assert.deepEqual(videoIndex().clips[0], current, '新片没有被旧确认框移除');
  assert.equal(virtual.files.has(currentPath), true);
  assert.match(pageOne.data.opError, /过期|另一处|变化/);
});

test('T026-17 损坏索引里的普通相对/旧绝对/跨档案文件标识不播放也不回收', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('b.mp4', 2048);
  const committed = await service.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(committed.ok, true, committed.error);

  const protectedPath = USER_DATA_PATH + '/different-feature.mp4';
  virtual.files.set(protectedPath, Buffer.alloc(32, 7));
  const otherArchiveFileId =
    'attempt-video/v1/archive-of-another-profile/clip-1-other.mp4';
  const otherArchivePath = USER_DATA_PATH + '/' + otherArchiveFileId;
  virtual.files.set(otherArchivePath, Buffer.alloc(48, 8));

  // 严格解析：普通相对路径、旧绝对路径、跨档案目录都不算同一片段文件。
  assert.equal(
    attemptVideo.isClipFileIdFor(flow.archiveId, committed.clip.clipId, 'different-feature.mp4'),
    false
  );
  assert.equal(
    attemptVideo.parseVideoFileId(
      'wxfile://usr/attempt-video/v1/' + flow.archiveId + '/clip-1-x.mp4'
    ),
    null,
    '旧绝对路径不能解析'
  );
  assert.equal(
    attemptVideo.isClipFileIdFor(flow.archiveId, committed.clip.clipId, otherArchiveFileId),
    false,
    '跨档案目录不算同一片段'
  );
  assert.equal(
    playback.savedSourceFromClip(
      Object.assign({}, committed.clip, { fileId: 'different-feature.mp4' }),
      { userDataPath: USER_DATA_PATH }
    ).ok,
    false,
    '播放器不接受目录外的普通相对路径'
  );

  const damaged = videoIndex();
  damaged.clips[0].fileId = 'different-feature.mp4';
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(damaged));
  assert.equal(
    attemptVideo.videoClipView(flow.archiveId, flow.attemptB.id).state,
    'none',
    '视频页按无视频显示'
  );
  assert.equal(attemptVideo.videoLinkView(flow.archiveId, flow.attemptB.id).hasVideo, false);
  const attemptsPage = openAttemptsPage(flow);
  const rowB = attemptsPage.data.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(rowB.hasVideo, false, '列表无视频时正常工作');
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(page.data.hasSavedVideo, false);
  assert.equal(page.data.playerSrc, '');
  assert.equal(page.data.attempt.note, 'B 把的备注');

  // 移除只按严格解析处理：保护文件与其他档案文件都不被删除。
  const removed = await service.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: committed.clip.clipId,
      rev: committed.clip.rev,
      fileId: 'different-feature.mp4'
    })
  );
  assert.equal(removed.ok, true);
  assert.equal(virtual.files.has(protectedPath), true);
  assert.equal(virtual.files.has(otherArchivePath), true);
});

test('T026-18 总视频占用包含其他档案副本：预算各档案共用，其他档案文件不被本档案操作删除', async () => {
  const flow = seedTwoAttempts();
  const space = {
    budgetBytes: 12000,
    warnBytes: 9000,
    photoReserveBytes: 2000,
    reserveBytes: 1000,
    maxClipBytes: 6000
  };
  // 已有其他档案的副本（索引引用 + 实际文件）。视频预算在小程序内共用。
  const otherArchiveId = 'archive-other-profile';
  const otherFileId = 'attempt-video/v1/' + otherArchiveId + '/clip-1-other.mp4';
  const otherPath = USER_DATA_PATH + '/' + otherFileId;
  virtual.files.set(otherPath, Buffer.alloc(4000, 3));
  const otherClip = {
    clipId: 'clip-1-other',
    archiveId: otherArchiveId,
    sessionId: 'session-x',
    routeId: 'route-x',
    attemptId: 'attempt-x',
    rev: 1,
    fileId: otherFileId,
    bytes: 4000,
    opId: 'op-other',
    createdAt: '2026-11-15T09:00:00.000Z'
  };
  storage.set(
    VIDEO_INDEX_KEY,
    JSON.stringify({ version: 1, nextClipSeq: 2, clips: [otherClip], pending: [] })
  );

  const service = makeService(flow, { space });
  // 本档案沙箱对照：只有本档案时 5500 字节在 10000 可用预算内；
  // 计入其他档案 4000 后，4000 + 5500 + 1000 = 10500 > 10000，按预算拒绝。
  const rejectedTemp = addTempVideo('b.mp4', 5500);
  const rejected = await service.commit(requestFor(flow, flow.attemptB, rejectedTemp));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'space-insufficient');
  assert.equal(rejected.space.reason, 'budget');
  assert.match(rejected.error, /各档案当前占用/);
  assert.equal(filesInRoot(flow.archiveId).length, 0, '没有写入本档案副本');
  assert.equal(virtual.files.has(otherPath), true);

  const acceptedTemp = addTempVideo('small.mp4', 4500);
  const accepted = await service.commit(requestFor(flow, flow.attemptB, acceptedTemp));
  assert.equal(accepted.ok, true, accepted.error);

  const usage = await service.getSpaceUsage();
  assert.equal(usage.ok, true);
  assert.equal(usage.archiveBytes, 4500);
  assert.equal(usage.otherArchiveBytes, 4000);
  assert.equal(usage.totalBytes, 8500, '总占用包含其他档案副本');
  assert.equal(usage.clipCount, 1, '本档案片段数');
  assert.equal(usage.otherArchiveClips, 1);

  // 清理与移除都只处理本档案：其他档案的文件原样保留。
  const cleaned = await service.cleanupOrphans();
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.deletedCount, 0);
  assert.equal(virtual.files.has(otherPath), true);
  const removed = await service.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: accepted.clip.clipId,
      rev: accepted.clip.rev,
      fileId: accepted.clip.fileId,
      bytes: accepted.clip.bytes
    })
  );
  assert.equal(removed.ok, true, removed.error);
  assert.equal(virtual.files.has(otherPath), true, '其他档案副本不被本档案移除');
  assert.equal(videoIndex().clips.length, 1, '只剩下其他档案的关联');
  assert.equal(videoIndex().clips[0].archiveId, otherArchiveId);
});

// ------------------------------------------------------------------ *
// QA 返工：清理意图与引用切换同写、实际字节为准、四个原 ID 校验
// ------------------------------------------------------------------ */

test('T026-19 更换索引写已落盘但服务与页面读回都失败：新旧副本先保留，冷启动按持久清理意图回收旧片', async () => {
  const flow = seedTwoAttempts();
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  const firstTemp = addTempVideo('a.mp4', 4096);
  chooseVideo(firstTemp);
  page.choosePreview();
  page.commitPreview();
  await settle();
  assert.equal(page.data.hasSavedVideo, true, page.data.opError);
  const oldClip = videoIndex().clips.find(clip => clip.attemptId === flow.attemptB.id);
  const oldPath = USER_DATA_PATH + '/' + oldClip.fileId;

  // 更换的索引写：引用切换先落盘，随后抛错；服务与页面各一次读回都短暂失败。
  const nextTemp = addTempVideo('b.mp4', 2048);
  chooseVideo(nextTemp);
  page.choosePreview();
  faults.storageAfter.push({
    key: VIDEO_INDEX_KEY,
    readFailures: 2,
    matches: value => {
      const parsed = JSON.parse(value);
      return parsed.clips.some(
        clip => clip.attemptId === flow.attemptB.id && clip.fileId !== oldClip.fileId
      );
    }
  });
  page.confirmReplace();
  await settle();

  assert.equal(wxLog.storageReadFails, 2, '服务读回与页面读回都失败');
  assert.match(page.data.opError, /读回|未确认|索引/);
  assert.equal(page.data.busy, false);
  const committed = videoIndex().clips.find(clip => clip.attemptId === flow.attemptB.id);
  assert.notEqual(committed.fileId, oldClip.fileId);
  assert.equal(committed.bytes, 2048);
  assert.equal(virtual.files.has(oldPath), true, '写入结果不明时旧副本保留');
  assert.equal(virtual.files.has(USER_DATA_PATH + '/' + committed.fileId), true, '新副本保留');
  assert.deepEqual(
    videoIndex().pending.map(entry => entry.fileId),
    [oldClip.fileId],
    '旧副本的清理意图与引用切换写在同一次索引写里'
  );

  // 读恢复并冷启动：recover 依据持久 pending 回收旧副本，保留索引当前片。
  files.resetAttemptVideoServices();
  const recoveredPage = openVideoPage(flow, flow.attemptB);
  await settle(20);
  assert.equal(virtual.files.has(oldPath), false, '冷启动回收已退役旧副本');
  assert.equal(
    virtual.files.has(USER_DATA_PATH + '/' + committed.fileId),
    true,
    '索引当前片保留'
  );
  assert.equal(recoveredPage.data.hasSavedVideo, true);
  assert.equal(recoveredPage.data.playerSrc, USER_DATA_PATH + '/' + committed.fileId);
  assert.equal(recoveredPage.data.attempt.note, 'B 把的备注');
  assert.deepEqual(videoIndex().pending, [], '回收成功后对应 pending 已删除');
});

test('T026-20 移除索引写已落盘但服务与页面读回都失败：旧副本先保留，冷启动按持久清理意图回收', async () => {
  const flow = seedTwoAttempts();
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  const firstTemp = addTempVideo('a.mp4', 3072);
  chooseVideo(firstTemp);
  page.choosePreview();
  page.commitPreview();
  await settle();
  assert.equal(page.data.hasSavedVideo, true, page.data.opError);
  const oldClip = videoIndex().clips.find(clip => clip.attemptId === flow.attemptB.id);
  const oldPath = USER_DATA_PATH + '/' + oldClip.fileId;

  // 解除关联的索引写：已落盘（clips 里没有这一把），随后抛错；两次读回都失败。
  faults.storageAfter.push({
    key: VIDEO_INDEX_KEY,
    readFailures: 2,
    matches: value => {
      const parsed = JSON.parse(value);
      return !parsed.clips.some(clip => clip.attemptId === flow.attemptB.id);
    }
  });
  page.askRemove();
  page.confirmRemove();
  await settle();

  assert.equal(wxLog.storageReadFails, 2);
  assert.match(page.data.opError, /读回|未确认|索引/);
  assert.equal(page.data.hasSavedVideo, true, '读回失败时不改页面显示的关联');
  assert.equal(videoIndex().clips.length, 0, '解除关联已落盘');
  assert.equal(virtual.files.has(oldPath), true, '删除前保留旧副本');
  assert.deepEqual(
    videoIndex().pending.map(entry => entry.fileId),
    [oldClip.fileId],
    '退役副本的清理意图随解除关联同写'
  );

  files.resetAttemptVideoServices();
  const recoveredPage = openVideoPage(flow, flow.attemptB);
  await settle(20);
  assert.equal(virtual.files.has(oldPath), false, '冷启动回收旧副本');
  assert.equal(recoveredPage.data.hasSavedVideo, false);
  assert.equal(recoveredPage.data.playerSrc, '');
  assert.equal(recoveredPage.data.attempt.note, 'B 把的备注');
  assert.deepEqual(videoIndex().pending, []);
});

test('T026-21 相册提示大小与实际字节不一致不否认本次已核实的提交', async () => {
  const flow = seedTwoAttempts();
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  const temp = addTempVideo('a.mp4', 4096);
  // chooser 提示 1B，物理文件实际 4096B：以持久层核过的实际字节为准。
  chooseVideo(temp, 1);
  page.choosePreview();
  assert.equal(page.data.preview.sizeBytes, 1);
  page.commitPreview();
  await settle();

  assert.equal(page.data.opError, '', '实际字节与本次 opId 条目一致时应报成功');
  assert.equal(page.data.busy, false);
  assert.equal(page.data.hasSavedVideo, true);
  const committed = videoIndex().clips.find(clip => clip.attemptId === flow.attemptB.id);
  assert.equal(committed.bytes, 4096, '索引记录实际物理字节');
  assert.equal(page.data.savedVideo.clipId, committed.clipId);
  assert.equal(page.data.playerSrc, USER_DATA_PATH + '/' + committed.fileId);
  assert.match(page.data.notice, /已保存到本机/);
  assert.equal(virtual.files.get(USER_DATA_PATH + '/' + committed.fileId).length, 4096);
});

test('T026-22 索引条目场次/线路与实际把次不符：两处入口不播放，页内与持久服务都不移除也不删除', async () => {
  const flow = seedTwoAttempts();
  const service = makeService(flow);
  const temp = addTempVideo('a.mp4', 2048);
  const first = await service.commit(requestFor(flow, flow.attemptB, temp));
  assert.equal(first.ok, true, first.error);
  const uri = USER_DATA_PATH + '/' + first.clip.fileId;

  // 损坏索引：文件路径、档案与把次都合法，但原场次/线路被换成另一场的另一条线。
  const otherSession = startAt('2026-11-13', '另一场岩馆');
  const otherRoute = newRoute(otherSession);
  const corrupted = JSON.parse(videoIndexRaw());
  corrupted.clips[0].sessionId = otherSession.id;
  corrupted.clips[0].routeId = otherRoute.id;
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(corrupted));

  // 两处列表入口都不把这条片段认成 B 的视频。
  const attemptsPage = openAttemptsPage(flow);
  const rowB = attemptsPage.data.attempts.find(item => item.id === flow.attemptB.id);
  assert.equal(rowB.hasVideo, false, '场内明细不显示已添加视频');
  assert.equal(rowB.videoEntryText, '添加视频 ›');
  const routePage = openRoutePage(flow);
  const historyB = routePage.data.groups[0].attempts.find(
    item => item.id === flow.attemptB.id
  );
  assert.equal(historyB.hasVideo, false, '跨日历史不显示看视频入口');

  // 视频页不播放这条片段；页内移除尝试没有可移除的当前片段。
  const page = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(page.data.hasSavedVideo, false);
  assert.equal(page.data.playerSrc, '');
  assert.equal(page.data.attempt.note, 'B 把的备注');
  page.askRemove();
  page.confirmRemove();
  await settle();
  assert.equal(page.data.confirmRemove, false);
  assert.match(page.data.opError, /没有已保存/);
  assert.deepEqual(videoIndex().clips[0], corrupted.clips[0], '页内尝试不改损坏条目');

  // 持久服务按真实四个 ID 也认不到这一条：不移除、不删除文件。
  const direct = await service.remove(
    requestFor(flow, flow.attemptB, '', {
      action: 'remove',
      clipId: first.clip.clipId,
      rev: first.clip.rev,
      fileId: first.clip.fileId,
      bytes: first.clip.bytes
    })
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.duplicate, true);
  assert.equal(videoIndex().clips.length, 1, '损坏条目保留');
  assert.equal(virtual.files.has(uri), true, '对应文件保留');

  // 同档同把的合法归属恢复后，两处入口与视频页重新读到同一片段。
  corrupted.clips[0].sessionId = flow.session.id;
  corrupted.clips[0].routeId = flow.route.id;
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(corrupted));
  const fixedAttempts = openAttemptsPage(flow);
  assert.equal(
    fixedAttempts.data.attempts.find(item => item.id === flow.attemptB.id).hasVideo,
    true
  );
  const fixedPage = openVideoPage(flow, flow.attemptB);
  await settle();
  assert.equal(fixedPage.data.hasSavedVideo, true);
  assert.equal(fixedPage.data.playerSrc, uri);
  assert.deepEqual(videoIndex().clips[0], corrupted.clips[0], '合法条目原样可读');
});
