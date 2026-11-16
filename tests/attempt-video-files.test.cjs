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
 * 并可注入写失败、配额失败、索引写失败、删除失败与换档迟到。测试口径：
 * - 确认保存后临时路径失效，重建页面与文件服务仍读到 B 的持久文件、实际字节与原片段，
 *   A 不挂片；缺文件时 B 仍可看记录并重选；
 * - 单片、总量与替换峰值预检；真实配额失败与写入失败都不留已提交关联；
 * - 索引写失败撤销新副本；重复确认/并发保存不产生第二份副本；换档迟到不写入；
 * - 提交后回收无引用旧副本；清理失败保留文件并可再次清理；移除只处理小程序内副本；
 * - 撤回/恢复同一把后仍读到原片；
 * - 冷启动只清理本功能创建、无引用且无在途写入的文件，索引损坏时一个文件也不删。
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
  storageFail: new Set()
};
const wxLog = {
  chooseCalls: [],
  chooseHandler: null,
  storageWrites: 0,
  navigations: [],
  videoContexts: []
};

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
  wxLog.chooseCalls = [];
  wxLog.chooseHandler = null;
  wxLog.storageWrites = 0;
  wxLog.navigations = [];
  wxLog.videoContexts = [];
  tempSeq = 0;
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
      if (!virtual.files.has(options.srcPath)) {
        options.fail({ errMsg: 'copyFile:fail no such file or directory' });
        return;
      }
      virtual.files.set(
        options.destPath,
        Buffer.from(virtual.files.get(options.srcPath))
      );
      options.success({});
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
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    if (faults.storageFail.has(key)) {
      throw { errMsg: 'setStorageSync:fail mock storage error' };
    }
    wxLog.storageWrites += 1;
    storage.set(key, value);
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
    }
  };
}

function makeService(flow, options) {
  const config = options || {};
  const archiveId = config.archiveId || flow.archiveId;
  return files.createAttemptVideoStore({
    archiveId,
    files: files.createWxAttemptVideoFiles({ archiveId, wxApi: global.wx }),
    storage: makeStorage(config.failKeys),
    now: () => '2026-11-16T10:00:00.000Z',
    space: config.space,
    verifyArchive: config.verifyArchive
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

function chooseVideo(tempPath) {
  const bytes = virtual.files.has(tempPath) ? virtual.files.get(tempPath).length : 0;
  wxLog.chooseHandler = options => {
    options.success({
      tempFiles: [
        {
          tempFilePath: tempPath,
          size: bytes,
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

  // 崩溃窗口留下的无引用半成品 + 一个不属于本功能的文件。
  const orphanPath = addManagedFile(flow.archiveId, 'clip-99.mp4', 512);
  const foreignPath = addManagedFile(flow.archiveId, 'readme.txt', 64);

  files.resetAttemptVideoServices();
  const freshService = makeService(flow);
  const recovered = await freshService.recover();
  assert.equal(recovered.ok, true, recovered.error);
  assert.deepEqual(recovered.deleted, [orphanPath]);
  assert.equal(recovered.missing.length, 0);
  assert.equal(virtual.files.has(referencedPath), true, '被索引引用的副本保留');
  assert.equal(virtual.files.has(orphanPath), false, '无引用半成品被清理');
  assert.equal(virtual.files.has(foreignPath), true, '非本功能文件绝不动');

  const usage = await freshService.getSpaceUsage();
  assert.equal(usage.totalBytes, 2048, '只统计 clip-* 受管文件');
  assert.equal(usage.clipCount, 1);

  // 索引损坏：不删除任何文件（包括无引用半成品），只返回可见错误。
  const brokenOrphan = addManagedFile(flow.archiveId, 'clip-100.mp4', 128);
  storage.set(VIDEO_INDEX_KEY, '{');
  const brokenService = makeService(flow);
  const broken = await brokenService.recover();
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'index-broken');
  assert.equal(virtual.files.has(referencedPath), true);
  assert.equal(virtual.files.has(brokenOrphan), true, '索引不可读时保留无引用文件');
  assert.equal(virtual.files.has(foreignPath), true);

  // 恢复索引后清理即可继续；索引条目本身不被自动改写。
  storage.set(VIDEO_INDEX_KEY, JSON.stringify({ version: 1, nextClipSeq: 2, clips: [committed.clip] }));
  const recoveredAgain = await makeService(flow).cleanupOrphans();
  assert.equal(recoveredAgain.ok, true);
  assert.equal(recoveredAgain.deletedCount, 1);
  assert.equal(videoIndex().clips.length, 1);

  // 冷启动后继续保存：序号接着索引走，不会覆盖已有片段。
  const nextTemp = addTempVideo('next.mp4', 1024);
  const next = await makeService(flow).commit(requestFor(flow, flow.attemptA, nextTemp));
  assert.equal(next.ok, true, next.error);
  assert.match(next.clip.clipId, /^clip-2-[a-z0-9]+$/);
  assert.equal(videoIndex().clips.length, 2);
  assert.equal(
    filesInRoot(flow.archiveId).filter(name => /\/clip-.*\.mp4$/.test(name)).length,
    2,
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

  // 崩溃留下的无引用副本：刷新后计入占用并给出可执行清理入口。
  const orphanPath = addManagedFile(flow.archiveId, 'clip-77.mp4', 1024);
  page.onShow();
  await settle();
  assert.equal(page.data.canCleanupOrphans, true);
  assert.match(page.data.spaceDetailText, /无引用/);
  page.cleanupVideoOrphans();
  assert.equal(page.data.cleanupBusy, true);
  await settle();
  assert.equal(page.data.cleanupBusy, false);
  assert.match(page.data.cleanupNotice, /已清理 1 个无引用副本/);
  assert.equal(virtual.files.has(orphanPath), false);
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
