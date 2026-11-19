/**
 * T052 整场删除 · 视频归属、清理与重开恢复
 *
 * 直接加载真实模块：
 * - utils/training-store.js 的 T051 快照/一次提交；
 * - utils/training-session-delete.js（本单新增的协调器、独立 journal、护栏与恢复）；
 * - utils/training-attempt-delete.js、utils/attempt-video-files.js（既有单把清理与
 *   定向 removeDeletedClip，验证整场删除复用同一套所有权/版本逻辑）；
 * - 隔离微信本地存储、虚拟文件系统与可注入故障。
 *
 * 覆盖：确认范围与视频数（含已撤回）、确认取消/写前失败保持附件、独占副本删除与
 * 共享副本 kept、T025 标记保留、重复确认、旧 opId 跨场重放、同场在途保存/单把删除
 * 阻塞、回执丢失与冷开两种状态、索引/文件失败重试、等数量换片或改备注重新确认、
 * 跨档案与损坏凭据失败关闭、无待办时不扫描媒体目录。
 *
 * 真机长按确认、原生弹窗与相册原片打开另在整项 QA / 手机验收（待验）。
 *
 * 运行：node --test tests/training-session-delete-media.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SESSION_UTIL = path.join(ROOT, 'utils', 'training-session-delete.js');
const ATTEMPT_DELETE_UTIL = path.join(ROOT, 'utils', 'training-attempt-delete.js');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const FILES_UTIL = path.join(ROOT, 'utils', 'attempt-video-files.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const SESSION_DELETE_KEY = 'climbingNote.training.v1.session-delete';
const ATTEMPT_DELETE_KEY = 'climbingNote.training.v1.attempt-delete';
const USER_DATA_PATH = 'wxfile://usr';
const D1 = '2026-11-20';
const D2 = '2026-11-21';

// ---- 隔离存储、虚拟文件系统与故障注入 ----
const storage = new Map();
const virtual = {
  files: new Map(),
  dirs: new Set(),
  calls: { mkdir: [], copyFile: [], unlink: [], stat: [], readdir: [], access: [] }
};
const faults = {
  sessionSetFailAt: 0,
  sessionSetCount: 0,
  archiveSetFailAt: 0,
  archiveSetCount: 0,
  archiveLoseAt: 0,
  archiveReadFailAfterWrite: 0,
  indexSetFailAt: 0,
  indexSetCount: 0,
  indexLoseAt: 0,
  indexReadFailAfterWrite: 0,
  readFailKey: '',
  readFailRemaining: 0,
  unlinkFail: false,
  unlinkFailFor: '',
  statFail: false,
  readdirFail: false,
  copyFail: ''
};
// 复制在途控制：卡住下一次匹配的 copyFile，模拟真实文件 I/O 尚未返回的写入。
const copyGate = { matcher: null, arrived: false, release: null };

function holdNextCopy(matcher) {
  copyGate.matcher = matcher || (() => true);
  copyGate.arrived = false;
  copyGate.release = null;
}

function releaseHeldCopy() {
  assert.equal(typeof copyGate.release, 'function', '复制没有到达可释放点');
  const release = copyGate.release;
  copyGate.release = null;
  copyGate.matcher = null;
  release();
}

/** 让真实模块里的多个微任务/回调推进到下一次 await 点。 */
async function settle(rounds) {
  const count = typeof rounds === 'number' ? rounds : 10;
  for (let index = 0; index < count; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
}

let clipSeq = 0;

function resetDevice() {
  storage.clear();
  virtual.files.clear();
  virtual.dirs.clear();
  Object.keys(virtual.calls).forEach(key => {
    virtual.calls[key] = [];
  });
  faults.sessionSetFailAt = 0;
  faults.sessionSetCount = 0;
  faults.archiveSetFailAt = 0;
  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 0;
  faults.archiveReadFailAfterWrite = 0;
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  faults.indexLoseAt = 0;
  faults.indexReadFailAfterWrite = 0;
  faults.readFailKey = '';
  faults.readFailRemaining = 0;
  faults.unlinkFail = false;
  faults.unlinkFailFor = '';
  faults.statFail = false;
  faults.readdirFail = false;
  faults.copyFail = '';
  copyGate.matcher = null;
  copyGate.arrived = false;
  copyGate.release = null;
  clipSeq = 0;
}

function fileSystem() {
  return {
    mkdir(options) {
      virtual.calls.mkdir.push(options.dirPath);
      virtual.dirs.add(options.dirPath);
      options.success({});
    },
    copyFile(options) {
      virtual.calls.copyFile.push({ srcPath: options.srcPath, destPath: options.destPath });
      if (faults.copyFail) {
        options.fail({ errMsg: faults.copyFail });
        return;
      }
      const perform = () => {
        if (!virtual.files.has(options.srcPath)) {
          options.fail({ errMsg: 'copyFile:fail no such file or directory' });
          return;
        }
        virtual.files.set(options.destPath, Buffer.from(virtual.files.get(options.srcPath)));
        options.success({});
      };
      if (copyGate.matcher && copyGate.matcher(options)) {
        copyGate.arrived = true;
        copyGate.release = perform;
        return;
      }
      perform();
    },
    unlink(options) {
      virtual.calls.unlink.push(options.filePath);
      if (
        faults.unlinkFail ||
        (faults.unlinkFailFor && options.filePath === faults.unlinkFailFor)
      ) {
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
      if (faults.statFail) {
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
      if (faults.readdirFail) {
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
    if (faults.readFailKey === key && faults.readFailRemaining > 0) {
      faults.readFailRemaining -= 1;
      throw { errMsg: 'getStorageSync:fail mock read error for ' + key };
    }
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    if (key === SESSION_DELETE_KEY) {
      faults.sessionSetCount += 1;
      if (faults.sessionSetFailAt && faults.sessionSetCount === faults.sessionSetFailAt) {
        throw { errMsg: 'setStorageSync:fail mock session journal write error' };
      }
      storage.set(key, value);
      return;
    }
    if (key === ARCHIVE_KEY) {
      faults.archiveSetCount += 1;
      if (faults.archiveSetFailAt && faults.archiveSetCount === faults.archiveSetFailAt) {
        throw { errMsg: 'setStorageSync:fail mock archive write error' };
      }
      storage.set(key, value);
      if (faults.archiveLoseAt && faults.archiveSetCount === faults.archiveLoseAt) {
        faults.readFailKey = ARCHIVE_KEY;
        faults.readFailRemaining = faults.archiveReadFailAfterWrite;
        throw { errMsg: 'setStorageSync:fail mock archive error after write' };
      }
      return;
    }
    if (key === VIDEO_INDEX_KEY) {
      faults.indexSetCount += 1;
      if (faults.indexSetFailAt && faults.indexSetCount === faults.indexSetFailAt) {
        throw { errMsg: 'setStorageSync:fail mock index write error' };
      }
      storage.set(key, value);
      if (faults.indexLoseAt && faults.indexSetCount === faults.indexLoseAt) {
        faults.readFailKey = VIDEO_INDEX_KEY;
        faults.readFailRemaining = faults.indexReadFailAfterWrite;
        throw { errMsg: 'setStorageSync:fail mock index error after write' };
      }
      return;
    }
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager: fileSystem
};

const store = require(STORE_JS);
const attemptVideo = require(VIDEO_UTIL);
const videoFiles = require(FILES_UTIL);
const attemptDelete = require(ATTEMPT_DELETE_UTIL);
const sessionDelete = require(SESSION_UTIL);

beforeEach(() => {
  resetDevice();
  attemptDelete.resetRuntime();
  sessionDelete.resetRuntime();
  videoFiles.resetAttemptVideoServices();
});

// ------------------------------------------------------------------ *
// 合成档案
// ------------------------------------------------------------------ *

function startTraining(gymName, date, now) {
  const started = store.startSession({ gymName, date, now });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function addRoute(sessionId, name, climbType, grade) {
  const created = store.createRoute({ sessionId, name, climbType, grade });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function addAttempt(sessionId, routeId, result, note) {
  const saved = store.saveAttempt({ sessionId, routeId, result, note });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveRaw() {
  return storage.has(ARCHIVE_KEY) ? storage.get(ARCHIVE_KEY) : '';
}

function archiveOf() {
  const raw = archiveRaw();
  return raw ? JSON.parse(raw) : null;
}

function indexRaw() {
  return storage.has(VIDEO_INDEX_KEY) ? storage.get(VIDEO_INDEX_KEY) : '';
}

function indexOf() {
  const raw = indexRaw();
  return raw ? JSON.parse(raw) : null;
}

function sessionJournalRaw() {
  return storage.has(SESSION_DELETE_KEY) ? storage.get(SESSION_DELETE_KEY) : '';
}

function sessionJournal() {
  const raw = sessionJournalRaw();
  return raw ? JSON.parse(raw) : null;
}

/**
 * s1（目标，A 馆 D1）：两条线、四把，其中第二把已撤回；
 * s2（B 馆 D1）、s3（A 馆 D1，复用 r1）、s4（A 馆 D2）。
 */
function seedFixture() {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8, 0));
  const r1 = addRoute(s1.id, 'A顶绳线', '顶绳', '5.10a');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '第一把');
  const a2 = addAttempt(s1.id, r1.id, 'send', '第二把');
  const a3 = addAttempt(s1.id, r1.id, 'send', '第三把');
  const r2 = addRoute(s1.id, 'A抱石线', '抱石', 'V3');
  const a4 = addAttempt(s1.id, r2.id, 'fail', '第四把');

  const s2 = startTraining('B馆', D1, new Date(2026, 10, 20, 9, 0));
  const r3 = addRoute(s2.id, 'B抱石线', '抱石', 'V2');
  const a5 = addAttempt(s2.id, r3.id, 'send', 'B馆完攀');

  const s3 = startTraining('A馆', D1, new Date(2026, 10, 20, 10, 0));
  const r4 = addRoute(s3.id, 'A第二场抱石', '抱石', 'V4');
  const a6 = addAttempt(s3.id, r1.id, 'fail', '共享线路');
  const a7 = addAttempt(s3.id, r4.id, 'send', '第二场完攀');

  const s4 = startTraining('A馆', D2, new Date(2026, 10, 21, 8, 0));
  const r5 = addRoute(s4.id, '次日抱石', '抱石', 'V1');
  const a8 = addAttempt(s4.id, r5.id, 'fail', '次日');

  const undone = store.undoAttempt(a2.id, { sessionId: s1.id, routeId: r1.id });
  assert.equal(undone.ok, true, undone.error);

  return {
    archiveId: archiveOf().archiveId,
    s1,
    s2,
    s3,
    s4,
    r1,
    r2,
    r3,
    r4,
    r5,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8
  };
}

/** 单场单线单把的最小夹具：便于核对索引/文件故障与精确清理。 */
function seedSingle() {
  const session = startTraining('单场岩馆', D1, new Date(2026, 10, 20, 8, 0));
  const route = addRoute(session.id, '单线', '顶绳', '5.9');
  const attempt = addAttempt(session.id, route.id, 'fail', '唯一一把');
  return { archiveId: archiveOf().archiveId, session, route, attempt };
}

/** 写一条真实索引 + 虚拟文件；同 attempt 的旧条目先移出（模拟换片）。 */
function seedClip(flow, attempt, options) {
  const config = options || {};
  clipSeq += 1;
  const clipId = config.clipId || 'clip-' + clipSeq + '-seed';
  const rev = Number.isInteger(config.rev) ? config.rev : 1;
  const bytes = config.bytes || 4096;
  const fileId =
    config.fileId || 'attempt-video/v1/' + flow.archiveId + '/' + clipId + '.mp4';
  const filePath = USER_DATA_PATH + '/' + fileId;
  virtual.files.set(filePath, Buffer.alloc(bytes, 7));
  const index = indexOf() || { version: 1, nextClipSeq: 1, clips: [], pending: [] };
  if (!config.keepAttemptEntry) {
    index.clips = (index.clips || []).filter(
      entry => !(entry.archiveId === flow.archiveId && entry.attemptId === attempt.id)
    );
  }
  index.clips.push({
    clipId,
    archiveId: flow.archiveId,
    sessionId: config.sessionId || attempt.sessionId,
    routeId: config.routeId || attempt.routeId,
    attemptId: attempt.id,
    attemptSeq: attempt.seq,
    rev,
    bytes,
    fileId,
    markers: config.markers || [],
    createdAt: '2026-11-20T01:00:00.000Z'
  });
  index.nextClipSeq = Math.max(index.nextClipSeq || 1, clipSeq + 1);
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  return { clipId, rev, fileId, filePath };
}

function inspect(flow, overrides) {
  return sessionDelete.inspectSessionDelete(
    Object.assign({ archiveId: flow.archiveId, sessionId: flow.s1 ? flow.s1.id : flow.session.id }, overrides)
  );
}

function confirm(flow, overrides) {
  const inspected = inspect(flow, overrides);
  assert.equal(inspected.ok, true, inspected.error);
  assert.equal(inspected.canDelete, true, inspected.error);
  assert.ok(inspected.snapshot, '应有确认快照');
  return inspected;
}

function commit(flow, snapshot, overrides) {
  return sessionDelete.commitSessionDelete(
    Object.assign(
      {
        archiveId: flow.archiveId,
        sessionId: flow.s1 ? flow.s1.id : flow.session.id,
        snapshot
      },
      overrides
    )
  );
}

/** 真实视频持久层：走本文件的 wx 替身与隔离虚拟文件系统。 */
function attemptVideoService(archiveId) {
  return videoFiles.createAttemptVideoStore({
    archiveId,
    files: videoFiles.createWxAttemptVideoFiles({ archiveId, wxApi: global.wx }),
    now: () => '2026-11-20T10:00:00.000Z'
  });
}

function videoRequestFor(flow, attempt, tempFilePath) {
  const bytes = virtual.files.get(tempFilePath).length;
  return {
    archiveId: flow.archiveId,
    sessionId: attempt.sessionId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    attemptSeq: attempt.seq,
    tempFilePath,
    sizeBytes: bytes,
    durationSeconds: 12,
    width: 720,
    height: 1280,
    fileName: 'in-flight.mp4',
    opId: 'op-t052-in-flight'
  };
}

function writeSessionJournal(entry) {
  storage.set(
    SESSION_DELETE_KEY,
    JSON.stringify({ version: 1, pending: [entry], fences: [] })
  );
}

function journalEntryFor(flow, rows) {
  return {
    archiveId: flow.archiveId,
    sessionId: rows.sessionId,
    date: D1,
    gymId: rows.gymId || '',
    seq: 1,
    storeToken: 'stored-token',
    mediaToken: 'media-token',
    attempts: rows.attempts,
    state: rows.state || 'prepared',
    createdAt: '2026-11-20T02:00:00.000Z',
    updatedAt: '2026-11-20T02:00:00.000Z',
    lastError: ''
  };
}

// ------------------------------------------------------------------ *
// 确认范围
// ------------------------------------------------------------------ *

test('T052 快照含线路/有效/已撤回/完攀与按本场关联计算的视频数（含已撤回）', () => {
  const f = seedFixture();
  // a1 独占视频；a2 已撤回但仍有视频；a6 与 a2 共享同一文件与片段。
  const exclusive = seedClip(f, f.a1, { bytes: 5000 });
  const shared = seedClip(f, f.a2, { bytes: 6000, markers: [{ atSeconds: 1.5, text: '原时间点' }] });
  seedClip(f, f.a6, {
    clipId: shared.clipId,
    fileId: shared.fileId,
    bytes: 6000,
    keepAttemptEntry: true,
    markers: [{ atSeconds: 2.5, text: '共享时间点' }]
  });
  storage.set(
    ATTEMPT_DELETE_KEY,
    JSON.stringify({ version: 1, pending: [], deleted: [], barriers: {} })
  );
  const beforeArchive = archiveRaw();
  const beforeIndex = indexRaw();

  const inspected = inspect(f);
  assert.equal(inspected.ok, true, inspected.error);
  assert.equal(inspected.code, 'ready');
  assert.equal(inspected.canDelete, true);
  assert.equal(inspected.pending.total, 0);
  assert.equal(inspected.target.date, D1);
  assert.equal(inspected.target.gymName, 'A馆');
  assert.equal(inspected.target.label, '第 1 场');
  assert.equal(inspected.target.routeCount, 2);
  assert.equal(inspected.target.attemptCount, 4);
  assert.equal(inspected.target.effectiveAttemptCount, 3);
  assert.equal(inspected.target.undoneAttemptCount, 1);
  assert.equal(inspected.target.sendCount, 1);
  assert.equal(inspected.target.videoCount, 2);
  assert.equal(inspected.mediaCount, 2);
  assert.match(inspected.snapshot.token, /^[0-9a-f]{16}$/);
  assert.match(inspected.snapshot.mediaToken, /^[0-9a-f]{16}$/);
  assert.deepEqual(
    inspected.media.rows
      .filter(row => row.clip)
      .map(row => [row.attemptId, row.clip.clipId])
      .sort(),
    [
      [f.a1.id, exclusive.clipId],
      [f.a2.id, shared.clipId]
    ].sort()
  );

  // 只读：档案、索引、文件、journal 都没有变化。
  assert.equal(archiveRaw(), beforeArchive);
  assert.equal(indexRaw(), beforeIndex);
  assert.equal(sessionJournalRaw(), '');
  assert.equal(virtual.files.has(exclusive.filePath), true);
  assert.equal(virtual.calls.unlink.length, 0);
  assert.equal(sessionDelete.pendingStatus(f.archiveId).pending, 0);
});

// ------------------------------------------------------------------ *
// 写前失败 / 取消
// ------------------------------------------------------------------ *

test('T052 删除凭据落盘失败：不动档案与附件，返回可重试错误', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);
  const beforeArchive = archiveRaw();
  const beforeIndex = indexRaw();

  faults.sessionSetCount = 0;
  faults.sessionSetFailAt = 1;
  return commit(f, inspected.snapshot).then(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'journal-write-failed');
    assert.equal(outcome.removed, null);
    assert.equal(outcome.unknown, false);
    assert.equal(archiveRaw(), beforeArchive);
    assert.equal(indexRaw(), beforeIndex);
    assert.equal(virtual.files.has(video.filePath), true);
    assert.equal(virtual.calls.unlink.length, 0);
    assert.equal(sessionJournalRaw(), '');
  });
});

test('T052 档案写前失败：凭据回滚，档案、视频索引与副本保持原值', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);
  const beforeArchive = archiveRaw();
  const beforeIndex = indexRaw();

  faults.archiveSetCount = 0;
  faults.archiveSetFailAt = 1;
  const result = commit(f, inspected.snapshot);
  return result.then(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'write-failed');
    assert.equal(outcome.removed, false);
    assert.equal(outcome.unknown, false);
    assert.equal(outcome.journalPending, false);
    assert.equal(archiveRaw(), beforeArchive);
    assert.equal(indexRaw(), beforeIndex);
    assert.equal(virtual.files.has(video.filePath), true);
    assert.equal(virtual.calls.unlink.length, 0);
    assert.equal(sessionJournal().pending.length, 0);
  });
});

// ------------------------------------------------------------------ *
// 成功删除 / 共享 / 已撤回 / 标记
// ------------------------------------------------------------------ *

test('T052 确认后独占副本删除、共享副本 kept、已撤回把次也清理且保留 T025 标记', () => {
  const f = seedFixture();
  const exclusive = seedClip(f, f.a1, { bytes: 5000 });
  const shared = seedClip(f, f.a2, {
    clipId: 'clip-7-shared',
    rev: 1,
    bytes: 6000,
    markers: [
      {
        id: 'mark-target',
        atMs: 1500,
        clipId: 'clip-7-shared',
        rev: 1,
        createdAt: '2026-11-20T03:00:00.000Z'
      }
    ]
  });
  seedClip(f, f.a6, {
    clipId: shared.clipId,
    fileId: shared.fileId,
    bytes: 6000,
    keepAttemptEntry: true,
    markers: [
      {
        id: 'mark-shared',
        atMs: 2500,
        clipId: shared.clipId,
        rev: shared.rev,
        createdAt: '2026-11-20T03:05:00.000Z'
      }
    ]
  });
  const otherFile = seedClip(f, f.a5, { bytes: 7000 });
  // 让目标场就是当前场，核对接续逻辑与活动指针。
  store.selectSession(f.s1.id);
  const inspected = confirm(f);
  assert.equal(inspected.mediaCount, 2);

  return commit(f, inspected.snapshot).then(outcome => {
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.code, 'removed');
    assert.equal(outcome.removed, true);
    assert.equal(outcome.written, true);
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.removedAttemptIds.length, 4);
    assert.equal(outcome.successor.id, f.s3.id);
    assert.equal(outcome.video.status, 'kept');
    assert.equal(outcome.video.done, 1);
    assert.equal(outcome.video.kept, 1);
    assert.equal(outcome.video.pending, 0);

    const after = archiveOf();
    assert.equal(after.sessions.some(item => item.id === f.s1.id), false);
    assert.equal(after.attempts.some(item => item.sessionId === f.s1.id), false);
    assert.equal(after.sessionRoutes.some(item => item.sessionId === f.s1.id), false);
    // 其他场次的原 ID、关联与把次保持原值。
    assert.equal(after.sessions.some(item => item.id === f.s2.id), true);
    assert.equal(after.sessions.some(item => item.id === f.s3.id), true);
    assert.equal(after.sessions.some(item => item.id === f.s4.id), true);
    assert.equal(after.attempts.some(item => item.id === f.a6.id), true);
    assert.equal(after.attempts.some(item => item.id === f.a7.id), true);

    // 独占副本被回收；共享副本与其剩余引用、时间点原样保留。
    assert.equal(virtual.files.has(exclusive.filePath), false);
    assert.equal(virtual.files.has(shared.filePath), true);
    assert.equal(virtual.files.has(otherFile.filePath), true);
    const index = indexOf();
    assert.equal(
      index.clips.some(entry => entry.attemptId === f.a1.id || entry.attemptId === f.a2.id),
      false
    );
    const sharedLeft = index.clips.find(entry => entry.attemptId === f.a6.id);
    assert.ok(sharedLeft, '共享引用仍在');
    assert.equal(sharedLeft.fileId, shared.fileId);
    assert.equal(sharedLeft.markers.length, 1, 'T025 标记随剩余引用保留');
    assert.equal(sharedLeft.markers[0].id, 'mark-shared');
    assert.equal(sharedLeft.markers[0].atMs, 2500);
    assert.equal(sharedLeft.markers[0].clipId, shared.clipId);

    const journal = sessionJournal();
    assert.equal(journal.pending.length, 0);
    assert.equal(journal.fences.length, 1);
    assert.equal(journal.fences[0].sessionId, f.s1.id);
    assert.equal(journal.fences[0].attempts.length, 4);
    assert.equal(sessionDelete.pendingStatus(f.archiveId).pending, 0);
    // 定向清理：没有扫描目录。
    assert.equal(virtual.calls.readdir.length, 0);
  });
});

// ------------------------------------------------------------------ *
// 重复确认与迟到旧 opId
// ------------------------------------------------------------------ *

test('T052 重复确认只回读；旧 opId 换到另一场也不能复活，新 ID 正常可写', () => {
  const f = seedFixture();
  const video = seedClip(f, f.a1);
  const inspected = confirm(f);
  return commit(f, inspected.snapshot)
    .then(first => {
      assert.equal(first.ok, true, first.error);
      assert.equal(first.removedAttemptIds.length, 4);
      assert.equal(virtual.files.has(video.filePath), false);
      const archiveAfter = archiveRaw();
      faults.archiveSetCount = 0;

      return commit(f, inspected.snapshot).then(repeat => {
        assert.equal(repeat.ok, true);
        assert.equal(repeat.code, 'already-removed');
        assert.equal(repeat.duplicate, true);
        assert.equal(repeat.written, false);
        assert.equal(repeat.removed, true);
        assert.equal(repeat.video.status, 'none');
        assert.equal(faults.archiveSetCount, 0);
        assert.equal(archiveRaw(), archiveAfter);
        assert.equal(virtual.calls.unlink.length, 1);
      });
    })
    .then(() => {
      // 旧 opId 即使被塞进同一档另一场（s3 的场次 ID + 原线路），也必须被场次护栏挡住。
      const late = store.saveAttempt({
        archiveId: f.archiveId,
        sessionId: f.s3.id,
        routeId: f.r1.id,
        result: 'fail',
        note: '迟到回调',
        opId: f.a1.id
      });
      assert.equal(late.ok, false);
      assert.equal(late.blocked, true);
      assert.equal(late.code, 'attempt-deleted');
      assert.equal(late.pendingDeletion, false);
      assert.equal(archiveOf().attempts.some(item => item.id === f.a1.id), false);

      // 带原场次 ID 的旧 opId 同样拒绝。
      const lateOriginal = store.saveAttempt({
        archiveId: f.archiveId,
        sessionId: f.s1.id,
        routeId: f.r1.id,
        result: 'fail',
        note: '迟到回调',
        opId: f.a1.id
      });
      assert.equal(lateOriginal.ok, false);
      assert.equal(lateOriginal.blocked, true);

      // 新 ID 写入另一场照常成功，且拿到的不是被删 ID。
      const fresh = store.saveAttempt({
        archiveId: f.archiveId,
        sessionId: f.s3.id,
        routeId: f.r1.id,
        result: 'fail',
        note: '新的一把'
      });
      assert.equal(fresh.ok, true, fresh.error);
      assert.notEqual(fresh.attempt.id, f.a1.id);
      assert.equal(archiveOf().attempts.some(item => item.sessionId === f.s3.id && item.id === fresh.attempt.id), true);
    })
    .then(() => {
      // 整场删除完成后，单把删除也不能再处理同一场/同一把。
      return attemptDelete
        .deleteAttempt({
          archiveId: f.archiveId,
          sessionId: f.s1.id,
          routeId: f.r1.id,
          attemptId: f.a1.id,
          clip: { clipId: video.clipId, rev: video.rev, fileId: video.fileId }
        })
        .then(outcome => {
          assert.equal(outcome.ok, false);
          assert.equal(outcome.code, 'session-deleting');
        });
    });
});

// ------------------------------------------------------------------ *
// 在途保存 / 单把删除阻塞
// ------------------------------------------------------------------ *

test('T052 prepared 期间目标场新旧写入都被挡住，其他场次新 ID 照常可写', () => {
  const f = seedFixture();
  writeSessionJournal(
    journalEntryFor(f, {
      sessionId: f.s1.id,
      gymId: f.r1.gymId,
      attempts: [
        { attemptId: f.a1.id, routeId: f.r1.id, seq: f.a1.seq, clip: null }
      ]
    })
  );
  const before = archiveRaw();

  const oldReplay = store.saveAttempt({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    routeId: f.r1.id,
    result: 'fail',
    note: '旧 opId',
    opId: f.a1.id
  });
  assert.equal(oldReplay.ok, false);
  assert.equal(oldReplay.blocked, true);
  assert.equal(oldReplay.code, 'attempt-deleting');

  const newInTarget = store.saveAttempt({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    routeId: f.r1.id,
    result: 'fail',
    note: '同场新 ID'
  });
  assert.equal(newInTarget.ok, false);
  assert.equal(newInTarget.blocked, true);
  assert.equal(newInTarget.code, 'session-deleting');
  assert.equal(archiveRaw(), before);

  // 不相关的另一场同线路、新 ID：照常保存。
  const other = store.saveAttempt({
    archiveId: f.archiveId,
    sessionId: f.s3.id,
    routeId: f.r1.id,
    result: 'fail',
    note: '其他场次'
  });
  assert.equal(other.ok, true, other.error);
  assert.equal(
    archiveOf().attempts.some(item => item.sessionId === f.s3.id && item.id === other.attempt.id),
    true
  );
  assert.equal(archiveOf().attempts.some(item => item.sessionId === f.s1.id && item.id === other.attempt.id), false);

  // 重开核对：原场次仍在 → 撤掉 prepared，之后同场新保存恢复。
  return sessionDelete.recoverPending({ archiveId: f.archiveId }).then(recovery => {
    assert.equal(recovery.pending, 0);
    const resumed = store.saveAttempt({
      archiveId: f.archiveId,
      sessionId: f.s1.id,
      routeId: f.r1.id,
      result: 'fail',
      note: '清理后继续'
    });
    assert.equal(resumed.ok, true, resumed.error);
  });
});

test('T052 目标场有在途保存或单把删除凭据时，整场删除在任何破坏性写入前拒绝', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  // 先拿一份健康快照；待办不是快照内容，旧确认仍能走到「pending」判定。
  const healthy = confirm(f);

  // 在途保存：第一段「进行中」已落盘，第二段失败 → pendingSaves 保留。
  faults.archiveSetCount = 0;
  faults.archiveSetFailAt = 2;
  const staged = store.saveAttempt({
    sessionId: f.session.id,
    routeId: f.route.id,
    result: 'send',
    note: '还在保存'
  });
  assert.equal(staged.ok, false);
  faults.archiveSetFailAt = 0;
  assert.equal(archiveOf().pendingSaves.length, 1);
  const withPending = archiveRaw();

  const pendingInspect = inspect(f);
  assert.equal(pendingInspect.ok, true);
  assert.equal(pendingInspect.code, 'pending');
  assert.equal(pendingInspect.canDelete, false);
  assert.equal(pendingInspect.snapshot, null);

  return commit(f, healthy.snapshot).then(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'pending');
    assert.equal(archiveRaw(), withPending);
    assert.equal(indexRaw().length > 0, true);
    assert.equal(virtual.files.has(video.filePath), true);
    assert.equal(sessionJournalRaw(), '');

    // 清掉待保存，改用单把删除 journal 在途：整场删除同样拒绝。
    const archive = archiveOf();
    archive.pendingSaves = [];
    storage.set(ARCHIVE_KEY, JSON.stringify(archive));
    const withAttemptJournal = archiveRaw();
    storage.set(
      ATTEMPT_DELETE_KEY,
      JSON.stringify({
        version: 1,
        pending: [
          {
            attemptId: f.attempt.id,
            archiveId: f.archiveId,
            sessionId: f.session.id,
            routeId: f.route.id,
            seq: f.attempt.seq,
            clip: { clipId: video.clipId, rev: video.rev, fileId: video.fileId },
            state: 'prepared',
            createdAt: '2026-11-20T02:00:00.000Z',
            updatedAt: '2026-11-20T02:00:00.000Z',
            lastError: ''
          }
        ],
        deleted: [],
        barriers: {}
      })
    );

    const blockedInspect = inspect(f);
    assert.equal(blockedInspect.ok, true);
    assert.equal(blockedInspect.code, 'pending');
    assert.equal(blockedInspect.canDelete, false);
    assert.equal(blockedInspect.deletionPending, 1);
    assert.equal(blockedInspect.snapshot, null);

    return commit(f, healthy.snapshot).then(second => {
      assert.equal(second.ok, false);
      assert.equal(second.code, 'pending');
      assert.equal(archiveRaw(), withAttemptJournal);
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(sessionJournalRaw(), '');
    });
  });
});

test('T052 真实视频写入在途时：确认与提交边界都要求先完成，其他场次不受影响', async () => {
  const f = seedFixture();
  // 写入开始前的健康确认：媒体证据里还没有这一把的视频，提交边界仍需当场拦截。
  const healthy = confirm(f);
  const temp = 'wxfile://tmp/t052-held.mp4';
  virtual.files.set(temp, Buffer.alloc(2048, 9));
  const service = attemptVideoService(f.archiveId);

  holdNextCopy(options => options.srcPath === temp);
  const pendingWrite = service.commit(videoRequestFor(f, f.a1, temp));
  await settle();
  assert.equal(copyGate.arrived, true, '真实复制应停在等待文件 I/O');
  assert.equal(videoFiles.hasActiveSessionVideoMutation(f.archiveId, f.s1.id), true);

  const archiveWhile = archiveRaw();
  const indexWhile = indexRaw();
  const unlinkWhile = virtual.calls.unlink.length;
  const filesWhile = [...virtual.files.keys()].sort();

  // 确认读取：同一场在途写入 → pending，不给快照，也没有任何破坏性写入。
  const blockedInspect = inspect(f);
  assert.equal(blockedInspect.ok, true, blockedInspect.error);
  assert.equal(blockedInspect.code, 'pending');
  assert.equal(blockedInspect.canDelete, false);
  assert.equal(blockedInspect.snapshot, null);
  assert.equal(blockedInspect.videoWritePending, true);
  assert.match(blockedInspect.error, /还有视频正在保存或移除/);

  // 最终同步提交边界：用写入前的健康快照提交，必须在动档案前拒绝。
  const blockedCommit = await commit(f, healthy.snapshot);
  assert.equal(blockedCommit.ok, false);
  assert.equal(blockedCommit.code, 'pending');
  assert.equal(blockedCommit.removed, false);
  assert.equal(blockedCommit.unknown, false);
  assert.equal(blockedCommit.videoWritePending, true);
  assert.match(blockedCommit.error, /还有视频正在保存或移除/);
  assert.equal(archiveRaw(), archiveWhile, '档案未改动');
  assert.equal(indexRaw(), indexWhile, '索引未改动');
  assert.equal(sessionJournalRaw(), '', '没有落场次删除凭据');
  assert.equal(virtual.calls.unlink.length, unlinkWhile, '没有删除任何文件');
  assert.deepEqual([...virtual.files.keys()].sort(), filesWhile, '文件集合保持原样');

  // 另一场（同档案、不同场次）不被这场在途写入挡住：确认与提交都照常。
  const otherInspect = sessionDelete.inspectSessionDelete({
    archiveId: f.archiveId,
    sessionId: f.s2.id
  });
  assert.equal(otherInspect.ok, true, otherInspect.error);
  assert.equal(otherInspect.canDelete, true, otherInspect.error);
  assert.equal(otherInspect.videoWritePending, false);
  const otherCommit = await sessionDelete.commitSessionDelete({
    archiveId: f.archiveId,
    sessionId: f.s2.id,
    snapshot: otherInspect.snapshot
  });
  assert.equal(otherCommit.ok, true, otherCommit.error);
  assert.equal(otherCommit.removed, true);
  assert.equal(videoFiles.hasActiveSessionVideoMutation(f.archiveId, f.s1.id), true, '在途写仍在等 I/O');

  // 放行复制：写入按自己的归属提交，登记随 finally 释放。
  releaseHeldCopy();
  const written = await pendingWrite;
  assert.equal(written.ok, true, written.error);
  assert.equal(written.duplicate, false);
  assert.equal(videoFiles.hasActiveSessionVideoMutation(f.archiveId, f.s1.id), false);
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === f.a1.id),
    true,
    '写入已完成并提交索引'
  );

  // 在途写入完成后重新确认：拿到包含新视频的快照，再恢复整场删除。
  const resumed = confirm(f);
  assert.equal(resumed.videoWritePending, false);
  assert.equal(resumed.mediaCount, 1);
  const removed = await commit(f, resumed.snapshot);
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.removed, true);
  assert.equal(removed.video.status, 'done');
  assert.equal(archiveOf().sessions.some(item => item.id === f.s1.id), false);
});

// ------------------------------------------------------------------ *
// 回执丢失 / 冷开
// ------------------------------------------------------------------ *

test('T052 回执丢失且读回失败：保留 prepared，不先删视频；重开按档案确认后清理', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);

  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 1;
  faults.archiveReadFailAfterWrite = 1;
  return commit(f, inspected.snapshot)
    .then(outcome => {
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'write-failed-unverified');
      assert.equal(outcome.unknown, true);
      assert.equal(outcome.journalPending, true);
      // 档案其实已经移出，但本次不报成功；视频一个都没删。
      assert.equal(archiveOf().sessions.some(item => item.id === f.session.id), false);
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), true);
      const journal = sessionJournal();
      assert.equal(journal.pending.length, 1);
      assert.equal(journal.pending[0].state, 'prepared');

      // 模拟冷开：读回恢复正常后，同一份档案证明原场次已不在 → 继续清理。
      faults.archiveLoseAt = 0;
      faults.readFailRemaining = 0;
      return sessionDelete.recoverPending({ archiveId: f.archiveId });
    })
    .then(recovery => {
      assert.equal(recovery.ok, true, JSON.stringify(recovery));
      assert.equal(recovery.pending, 0);
      assert.equal(virtual.files.has(video.filePath), false);
      assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), false);
      const journal = sessionJournal();
      assert.equal(journal.pending.length, 0);
      assert.equal(journal.fences.length, 1);
    });
});

test('T052 重开时原场次仍在：撤掉未完成凭据，绝不接着做完上次未提交的删除', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const archive = archiveOf();
  writeSessionJournal(
    journalEntryFor(f, {
      sessionId: f.session.id,
      gymId: archive.gyms[0].id,
      attempts: [
        {
          attemptId: f.attempt.id,
          routeId: f.route.id,
          seq: f.attempt.seq,
          clip: { clipId: video.clipId, rev: video.rev, fileId: video.fileId }
        }
      ]
    })
  );

  return sessionDelete.recoverPending({ archiveId: f.archiveId }).then(recovery => {
    assert.equal(recovery.ok, true, JSON.stringify(recovery));
    assert.equal(recovery.processed, 1);
    assert.equal(recovery.pending, 0);
    assert.equal(sessionJournal().pending.length, 0);
    assert.equal(archiveOf().sessions.some(item => item.id === f.session.id), true);
    assert.equal(virtual.files.has(video.filePath), true);
    assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), true);
    assert.equal(virtual.calls.unlink.length, 0);
  });
});

// ------------------------------------------------------------------ *
// 索引 / 文件失败与重试
// ------------------------------------------------------------------ *

test('T052 视频索引写失败：档案已删但副本保留待清理，重试只清理一次', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);
  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;

  return commit(f, inspected.snapshot)
    .then(outcome => {
      assert.equal(outcome.ok, true, outcome.error);
      assert.equal(outcome.code, 'removed-media-pending');
      assert.equal(outcome.removed, true);
      assert.equal(outcome.video.status, 'pending');
      assert.equal(outcome.video.pending, 1);
      assert.equal(outcome.retryable, true);
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), true);
      const journal = sessionJournal();
      assert.equal(journal.pending.length, 1);
      assert.equal(journal.pending[0].state, 'removed');

      faults.indexSetFailAt = 0;
      return commit(f, inspected.snapshot);
    })
    .then(retried => {
      assert.equal(retried.ok, true, retried.error);
      assert.equal(retried.code, 'already-removed');
      assert.equal(retried.video.status, 'done');
      assert.equal(virtual.files.has(video.filePath), false);
      assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), false);
      assert.equal(sessionJournal().pending.length, 0);
      assert.equal(sessionJournal().fences.length, 1);
      assert.equal(virtual.calls.unlink.length, 1);
    });
});

test('T052 文件删除失败：保留待清理凭据，重开重试后回收且不重复处理', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);
  faults.unlinkFail = true;

  return commit(f, inspected.snapshot)
    .then(outcome => {
      assert.equal(outcome.ok, true, outcome.error);
      assert.equal(outcome.code, 'removed-media-pending');
      assert.equal(outcome.video.status, 'pending');
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), false);
      const journal = sessionJournal();
      assert.equal(journal.pending.length, 1);
      assert.equal(journal.pending[0].state, 'removed');

      faults.unlinkFail = false;
      return sessionDelete.recoverPending({ archiveId: f.archiveId });
    })
    .then(recovery => {
      assert.equal(recovery.ok, true, JSON.stringify(recovery));
      assert.equal(recovery.pending, 0);
      assert.equal(virtual.files.has(video.filePath), false);
      assert.equal(sessionJournal().fences.length, 1);
    });
});

// ------------------------------------------------------------------ *
// 等数量变化：视频换片 / 备注变化
// ------------------------------------------------------------------ *

test('T052 确认后视频换成同数量的新版本：必须重新确认，不写档案不删旧副本', () => {
  const f = seedSingle();
  const first = seedClip(f, f.attempt, { clipId: 'clip-1-old', rev: 1 });
  const inspected = confirm(f);
  const beforeArchive = archiveRaw();

  // 同数量、同把次，换一个片段版本。
  const replacement = seedClip(f, f.attempt, { clipId: 'clip-2-new', rev: 1 });
  return commit(f, inspected.snapshot).then(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'stale');
    assert.equal(outcome.removed, false);
    assert.equal(outcome.unknown, false);
    assert.equal(archiveRaw(), beforeArchive);
    assert.equal(sessionJournalRaw(), '');
    assert.equal(virtual.files.has(first.filePath), true);
    assert.equal(virtual.files.has(replacement.filePath), true);
    assert.equal(virtual.calls.unlink.length, 0);
    // 返回刷新后的范围，供页面重新确认。
    assert.ok(outcome.snapshot);
    assert.notEqual(outcome.snapshot.mediaToken, inspected.snapshot.mediaToken);
    assert.equal(outcome.snapshot.mediaCount, 1);
  });
});

test('T052 确认后备注换成同数量内容：T051 快照同样拒绝旧确认', () => {
  const f = seedSingle();
  seedClip(f, f.attempt);
  const inspected = confirm(f);
  const changed = store.setAttemptNote(f.attempt.id, { note: '换过的备注' });
  assert.equal(changed.ok, true, changed.error);
  const beforeCommit = archiveRaw();

  return commit(f, inspected.snapshot).then(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'stale');
    assert.equal(archiveRaw(), beforeCommit);
    assert.equal(sessionJournalRaw(), '');
    assert.equal(outcome.snapshot.attemptIds.length, 1);
  });
});

// ------------------------------------------------------------------ *
// 跨档案 / 损坏凭据 / 无待办
// ------------------------------------------------------------------ *

test('T052 跨档案与损坏凭据失败关闭；无待办时不扫描媒体目录', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);

  // 无 journal：恢复立即返回，不读目录、不 stat/unlink。
  return sessionDelete.recoverPending().then(empty => {
    assert.equal(empty.ok, true);
    assert.equal(empty.skipped, true);
    assert.equal(virtual.calls.readdir.length, 0);
    assert.equal(virtual.calls.stat.length, 0);
    assert.equal(virtual.calls.unlink.length, 0);

    // 档案 ID 不符：确认与提交都不写。
    const mismatch = sessionDelete.inspectSessionDelete({
      archiveId: 'archive-other',
      sessionId: f.session.id
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'archive-mismatch');
    assert.equal(sessionJournalRaw(), '');

    // 损坏的场次 journal：恢复失败关闭，不删任何文件。
    storage.set(SESSION_DELETE_KEY, '{broken');
    const blockedSave = store.saveAttempt({
      sessionId: f.session.id,
      routeId: f.route.id,
      result: 'fail',
      note: '凭据损坏时不写'
    });
    assert.equal(blockedSave.ok, false);
    assert.equal(blockedSave.code, 'delete-unreadable');
    return sessionDelete.recoverPending({ archiveId: f.archiveId }).then(broken => {
      assert.equal(broken.ok, false);
      assert.equal(broken.code, 'journal-broken');
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(virtual.calls.unlink.length, 0);

      // 旧档案的条目：在新档案流程里保留，不按旧凭据动新档案目录。
      writeSessionJournal({
        archiveId: 'archive-old',
        sessionId: 'session-old',
        date: D1,
        gymId: 'gym-old',
        seq: 1,
        storeToken: 'old-store-token',
        mediaToken: 'old-media-token',
        attempts: [
          {
            attemptId: 'attempt-old',
            routeId: 'route-old',
            seq: 1,
            clip: {
              clipId: 'clip-9-old',
              rev: 1,
              fileId: 'attempt-video/v1/archive-old/clip-9-old.mp4'
            }
          }
        ],
        state: 'removed',
        createdAt: '',
        updatedAt: '',
        lastError: ''
      });
      virtual.files.set(
        USER_DATA_PATH + '/attempt-video/v1/archive-old/clip-9-old.mp4',
        Buffer.alloc(100, 3)
      );
      const beforeCalls = {
        unlink: virtual.calls.unlink.length,
        readdir: virtual.calls.readdir.length
      };
      return sessionDelete.recoverPending().then(foreign => {
        assert.equal(foreign.pending, 1, '旧档案条目保留');
        assert.equal(foreign.errors.length, 1);
        assert.equal(virtual.calls.unlink.length, beforeCalls.unlink);
        assert.equal(virtual.calls.readdir.length, beforeCalls.readdir);
        assert.equal(
          virtual.files.has(USER_DATA_PATH + '/attempt-video/v1/archive-old/clip-9-old.mp4'),
          true
        );
        assert.equal(virtual.files.has(video.filePath), true);
      });
    });
  });
});

test('T052 清理时片段版本已变：按 exact rev 拒绝，不删文件且保留待清理', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt, { clipId: 'clip-4-version', rev: 1 });
  const archive = archiveOf();
  writeSessionJournal(
    journalEntryFor(f, {
      sessionId: f.session.id,
      gymId: archive.gyms[0].id,
      state: 'removed',
      attempts: [
        {
          attemptId: f.attempt.id,
          routeId: f.route.id,
          seq: f.attempt.seq,
          clip: { clipId: video.clipId, rev: 1, fileId: video.fileId }
        }
      ]
    })
  );
  // 模拟档案已确认删除，但视频索引在清理前换成了 rev 2（同数量、同把次）。
  const current = archiveOf();
  current.sessions = current.sessions.filter(item => item.id !== f.session.id);
  current.sessionRoutes = current.sessionRoutes.filter(
    item => item.sessionId !== f.session.id
  );
  current.attempts = current.attempts.filter(item => item.sessionId !== f.session.id);
  storage.set(ARCHIVE_KEY, JSON.stringify(current));
  const index = indexOf();
  index.clips.forEach(entry => {
    if (entry.attemptId === f.attempt.id) entry.rev = 2;
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));

  return sessionDelete.recoverPending({ archiveId: f.archiveId }).then(recovery => {
    assert.equal(recovery.pending, 1);
    assert.equal(recovery.errors.length, 1);
    assert.equal(virtual.files.has(video.filePath), true);
    assert.equal(virtual.calls.unlink.length, 0);
    assert.equal(indexOf().clips.some(entry => entry.attemptId === f.attempt.id), true);
    assert.equal(sessionJournal().pending[0].state, 'removed');
  });
});

test('T052 请求参数 coercion / 跨档案快照：不猜身份，零写入', () => {
  const f = seedSingle();
  const video = seedClip(f, f.attempt);
  const inspected = confirm(f);
  const beforeArchive = archiveRaw();
  const beforeIndex = indexRaw();

  const numeric = sessionDelete.inspectSessionDelete({
    archiveId: 42,
    sessionId: f.session.id
  });
  assert.equal(numeric.ok, false);
  assert.equal(numeric.code, 'incomplete-request');
  assert.equal(numeric.canDelete, false);

  const booleanToken = sessionDelete.commitSessionDelete({
    archiveId: f.archiveId,
    sessionId: f.session.id,
    snapshot: {
      token: true,
      mediaToken: false,
      archiveId: f.archiveId,
      sessionId: f.session.id
    }
  });
  return booleanToken
    .then(outcome => {
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'incomplete-request');
      assert.equal(archiveRaw(), beforeArchive);
      assert.equal(indexRaw(), beforeIndex);
      assert.equal(sessionJournalRaw(), '');

      const crossed = sessionDelete.commitSessionDelete({
        archiveId: f.archiveId,
        sessionId: f.session.id,
        snapshot: Object.assign({}, inspected.snapshot, { archiveId: 'archive-other' })
      });
      return crossed;
    })
    .then(crossed => {
      assert.equal(crossed.ok, false);
      assert.equal(crossed.code, 'archive-mismatch');
      assert.equal(crossed.unknown, true);
      assert.equal(archiveRaw(), beforeArchive);
      assert.equal(indexRaw(), beforeIndex);
      assert.equal(sessionJournalRaw(), '');
      assert.equal(virtual.files.has(video.filePath), true);
      assert.equal(virtual.calls.unlink.length, 0);
    });
});

test('T052 凭据指向跨档案文件或普通路径：失败关闭，保留待清理证据与文件', () => {
  const f = seedSingle();
  const archive = archiveOf();
  const foreignPath = USER_DATA_PATH + '/attempt-video/v1/other-archive/clip-3-x.mp4';
  virtual.files.set(foreignPath, Buffer.alloc(90, 5));
  writeSessionJournal(
    journalEntryFor(f, {
      sessionId: f.session.id,
      gymId: archive.gyms[0].id,
      state: 'removed',
      attempts: [
        {
          attemptId: f.attempt.id,
          routeId: f.route.id,
          seq: f.attempt.seq,
          clip: {
            clipId: 'clip-3-x',
            rev: 1,
            fileId: 'attempt-video/v1/other-archive/clip-3-x.mp4'
          }
        }
      ]
    })
  );
  // 原场次仍在：恢复只会撤掉未完成凭据，不会进入清理；先手动删档案模拟“已提交”。
  const current = archiveOf();
  current.sessions = current.sessions.filter(item => item.id !== f.session.id);
  current.sessionRoutes = current.sessionRoutes.filter(
    item => item.sessionId !== f.session.id
  );
  current.attempts = current.attempts.filter(item => item.sessionId !== f.session.id);
  storage.set(ARCHIVE_KEY, JSON.stringify(current));

  return sessionDelete.recoverPending({ archiveId: f.archiveId }).then(recovery => {
    assert.equal(recovery.pending, 1);
    assert.equal(recovery.errors.length, 1);
    assert.equal(virtual.files.has(foreignPath), true);
    assert.equal(virtual.calls.unlink.length, 0);
    assert.equal(sessionJournal().pending[0].state, 'removed');
  });
});
