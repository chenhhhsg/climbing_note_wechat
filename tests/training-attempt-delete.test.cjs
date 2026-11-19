/**
 * T048–T050 追加返工 · 长按删除把次与视频
 *
 * 直接加载真实模块与真实页面：
 * - pages/training-record（长按序号框的确认、迟到确认、页码刷新）；
 * - utils/training-store.js（物理移出把次、版本/备注/结果核对、写失败回执）；
 * - utils/training-attempt-delete.js（持久删除凭据 journal、三阶段协调、重开恢复）；
 * - utils/attempt-video-files.js（记录删除后的定向视频索引/文件回收）。
 *
 * 用隔离的本机存储替身、虚拟文件系统与可注入故障核对：
 * - 只有已保存有效把次能长按，收起旧行也可；短按仍展开；取消不写、不清备注草稿；
 *   有/无视频的确认文案不同；原生手势补发 tap 不会同时展开；
 * - 7 把删除第 5 把后剩 6 把，原第 6、7 把显示第 5、6 把，其他把次 ID/seq/备注/
 *   视频归属不变；历史、场次小结、统计与抱石完攀解锁按剩余有效集合；
 * - 删除最新一把后前一把不新增撤销；删除较早一把时原最新一把仍可撤销；冷开一致；
 *   新记的一把拿新 ID 与新内部序号；
 * - 档案写前失败回滚凭据；写成功但回执丢失按读回确认；首次读回失败保留待核对；
 *   视频索引写失败/文件删除失败都保留副本并可见待清理，手动重试只清理一次；
 * - 重开（重建服务）只处理 journal 里的 pending；没有 journal 时不扫描文件系统；
 *   换档、共享引用、错误路径与损坏索引一律谨慎不删；普通清缓存不动删除凭据。
 *
 * 真机长按手势、原生确认框与从相册选择的实际文件另在整项 QA / 手机验收（待验）。
 *
 * 运行：node --test tests/training-attempt-delete.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const DELETE_UTIL = path.join(ROOT, 'utils', 'training-attempt-delete.js');
const VIDEO_UTIL = path.join(ROOT, 'utils', 'attempt-video.js');
const FILES_UTIL = path.join(ROOT, 'utils', 'attempt-video-files.js');
const SUMMARY_UTIL = path.join(ROOT, 'utils', 'training-session-summary.js');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const DELETE_KEY = 'climbingNote.training.v1.attempt-delete';
const USER_DATA_PATH = 'wxfile://usr';

// ---- 隔离存储、虚拟文件系统与故障注入 ----
const storage = new Map();
const virtual = {
  files: new Map(),
  dirs: new Set(),
  calls: { mkdir: [], copyFile: [], unlink: [], stat: [], readdir: [], access: [] }
};
const faults = {
  archiveSetFailAt: 0,
  archiveSetCount: 0,
  archiveLoseAt: 0,
  archiveReadFailAfterWrite: 0,
  indexSetFailAt: 0,
  indexSetCount: 0,
  indexLoseAt: 0,
  indexReadFailAfterWrite: 0,
  pendingReadFails: 0,
  readFailKey: '',
  readFailRemaining: 0,
  unlinkFail: false,
  unlinkFailFor: '',
  statFail: false,
  readdirFail: false,
  copyFail: ''
};
const modal = { current: null, calls: 0, history: [], failNext: 0, throwNext: 0 };
// 非阻塞 toast 的文本：只用于断言「拒绝/弹窗失败时视口内有可见反馈」。
const toasts = [];
let clipSeq = 0;
let tempSeq = 0;

function resetDevice() {
  storage.clear();
  virtual.files.clear();
  virtual.dirs.clear();
  Object.keys(virtual.calls).forEach(key => {
    virtual.calls[key] = [];
  });
  faults.archiveSetFailAt = 0;
  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 0;
  faults.archiveReadFailAfterWrite = 0;
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  faults.indexLoseAt = 0;
  faults.indexReadFailAfterWrite = 0;
  faults.pendingReadFails = 0;
  faults.readFailKey = '';
  faults.readFailRemaining = 0;
  faults.unlinkFail = false;
  faults.unlinkFailFor = '';
  faults.statFail = false;
  faults.readdirFail = false;
  faults.copyFail = '';
  modal.current = null;
  modal.calls = 0;
  modal.history = [];
  modal.failNext = 0;
  modal.throwNext = 0;
  toasts.length = 0;
  clipSeq = 0;
  tempSeq = 0;
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
      if (!virtual.files.has(options.srcPath)) {
        options.fail({ errMsg: 'copyFile:fail no such file or directory' });
        return;
      }
      virtual.files.set(options.destPath, Buffer.from(virtual.files.get(options.srcPath)));
      options.success({});
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
    if (faults.pendingReadFails > 0) {
      faults.pendingReadFails -= 1;
      throw { errMsg: 'getStorageSync:fail mock read error' };
    }
    if (faults.readFailKey && faults.readFailKey === key && faults.readFailRemaining > 0) {
      faults.readFailRemaining -= 1;
      throw { errMsg: 'getStorageSync:fail mock read error for ' + key };
    }
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    if (key === ARCHIVE_KEY) {
      faults.archiveSetCount += 1;
      if (faults.archiveSetFailAt && faults.archiveSetCount === faults.archiveSetFailAt) {
        throw { errMsg: 'setStorageSync:fail mock archive write error' };
      }
      storage.set(key, value);
      if (faults.archiveLoseAt && faults.archiveSetCount === faults.archiveLoseAt) {
        faults.pendingReadFails = faults.archiveReadFailAfterWrite;
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
        faults.pendingReadFails = faults.indexReadFailAfterWrite;
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
  getFileSystemManager: fileSystem,
  showModal(options) {
    modal.calls += 1;
    // 故障注入：弹窗同步抛异常、或调 fail 回调（真实设备上确认框没弹出来）。
    if (modal.throwNext > 0) {
      modal.throwNext -= 1;
      throw { errMsg: 'showModal:fail mock synchronous failure' };
    }
    if (modal.failNext > 0) {
      modal.failNext -= 1;
      modal.current = null;
      options.fail({ errMsg: 'showModal:fail mock dialog failure' });
      return;
    }
    modal.current = options;
    modal.history.push(options);
  },
  navigateTo() {},
  navigateBack() {},
  redirectTo() {},
  reLaunch() {},
  showToast(options) {
    toasts.push((options && options.title) || '');
  }
};

const store = require(STORE_JS);
const attemptVideo = require(VIDEO_UTIL);
const videoFiles = require(FILES_UTIL);
const attemptDelete = require(DELETE_UTIL);
const summary = require(SUMMARY_UTIL);

let definition = null;
global.Page = def => {
  definition = def;
};
delete require.cache[require.resolve(RECORD_JS)];
require(RECORD_JS);
assert.ok(definition, 'training-record 应注册 Page 定义');

function createPage() {
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

function startFlow(options) {
  const config = options || {};
  const started = store.startSession({
    gymName: config.gymName || '长按删除岩馆',
    date: config.date || '2026-11-18',
    now: new Date(2026, 10, 18, 9, 0)
  });
  assert.equal(started.ok, true, started.error);
  const created = store.createRoute({
    sessionId: started.session.id,
    name: config.routeName || '长按删除顶绳线',
    climbType: config.climbType || '顶绳',
    grade: config.climbType === '抱石' ? 'V3' : '5.10a',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return {
    session: started.session,
    route: created.route,
    archiveId: store.loadState().archive.archiveId
  };
}

function addAttempt(flow, result, note, minute) {
  const saved = store.saveAttempt({
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result,
    note: note || '',
    now: new Date(2026, 10, 18, 9, 5 + (minute || 0))
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function addOtherRouteAttempt(flow) {
  const created = store.createRoute({
    sessionId: flow.session.id,
    name: '别的线',
    climbType: '顶绳',
    grade: '5.9',
    colorName: '红色'
  });
  assert.equal(created.ok, true, created.error);
  const saved = store.saveAttempt({
    sessionId: flow.session.id,
    routeId: created.route.id,
    result: 'fail',
    note: '别的线备注',
    now: new Date(2026, 10, 18, 10, 0)
  });
  assert.equal(saved.ok, true, saved.error);
  return { route: created.route, attempt: saved.attempt };
}

/** 给一把写入一条真实索引 + 虚拟文件（与 T026 的索引形状一致）。 */
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
  index.clips = (index.clips || []).filter(
    entry => !(entry.archiveId === flow.archiveId && entry.attemptId === attempt.id)
  );
  index.clips.push({
    clipId,
    archiveId: flow.archiveId,
    sessionId: config.sessionId || flow.session.id,
    routeId: config.routeId || flow.route.id,
    attemptId: attempt.id,
    attemptSeq: attempt.seq,
    rev,
    bytes,
    fileId,
    createdAt: '2026-11-18T01:00:00.000Z'
  });
  index.nextClipSeq = Math.max(index.nextClipSeq || 1, clipSeq + 1);
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  return { clipId, rev, fileId, filePath };
}

function clipEvidenceOf(file) {
  return { clipId: file.clipId, rev: file.rev, fileId: file.fileId };
}

function openRecord(flow) {
  const page = createPage();
  page.onLoad({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  assert.equal(page.data.contextError, '', '单线页应能按原归属打开');
  return page;
}

function rowOf(page, attempt) {
  return page.data.attemptCards.find(row => row.id === attempt.id) || null;
}

function rowEvent(row, overrides) {
  const dataset = Object.assign(
    {
      attemptId: row.id || row.attemptId,
      archiveId: row.archiveId,
      sessionId: row.sessionId,
      routeId: row.routeId,
      deleteRev: row.deleteRev,
      pageToken: row.pageToken
    },
    overrides || {}
  );
  return { currentTarget: { dataset } };
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

/** 打开确认（不回答），返回 Promise 与已捕获的弹窗参数。 */
function openPrompt(page, row, overrides) {
  const promise = page.requestDeleteAttempt(rowEvent(row, overrides));
  assert.ok(modal.current, '应打开删除确认');
  return promise;
}

function answerPrompt(confirm) {
  const current = modal.current;
  modal.current = null;
  assert.ok(current, '没有待回答的确认框');
  current.success({ confirm, cancel: !confirm });
}

async function confirmDelete(page, row, overrides) {
  const promise = openPrompt(page, row, overrides);
  const options = modal.current;
  answerPrompt(true);
  const outcome = await promise;
  return { outcome, options };
}

function pendingJournal() {
  const raw = storage.has(DELETE_KEY) ? storage.get(DELETE_KEY) : '';
  if (!raw) return null;
  return JSON.parse(raw);
}

beforeEach(() => {
  resetDevice();
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
});

// ------------------------------------------------------------------ *
// 交互：长按序号框、确认文案、取消与短按
// ------------------------------------------------------------------ *

test('T048-删除1 长按仅序号区且折叠旧行可用；有/无视频文案不同；取消不写不清草稿；短按仍展开', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '第一把备注', 0);
  const second = addAttempt(flow, 'fail', '第二把备注', 5);
  const third = addAttempt(flow, 'fail', '第三把备注', 10);
  const video = seedClip(flow, second);
  const page = openRecord(flow);

  const firstRow = rowOf(page, first);
  assert.equal(firstRow.expanded, false, '前置：旧行收起');
  assert.equal(page.data.attemptCards[0].id, third.id, '最新在前');

  // 短按仍是原来的展开/收起。
  page.toggleAttemptRow(tapDataset({ attemptId: first.id }));
  assert.equal(page.data.expandedAttemptId, first.id);
  page.toggleAttemptRow(tapDataset({ attemptId: first.id }));
  assert.equal(page.data.expandedAttemptId, '');

  // 打开一条备注草稿，取消删除时草稿必须保留。
  page.openNoteEditor(tapDataset({ attemptId: third.id }));
  page.onNoteInput({ detail: { value: '还没保存的草稿' } });

  const rawBefore = archiveRaw();
  const indexBefore = indexRaw();

  // 无视频：文案只说记录和备注。
  const cancelled = openPrompt(page, firstRow);
  assert.equal(modal.current.title, '删除第 1 把？');
  assert.equal(modal.current.content, '将删除这把记录和备注。');
  assert.equal(modal.current.confirmText, '删除');
  assert.equal(modal.current.cancelText, '取消');
  answerPrompt(false);
  assert.deepEqual(await cancelled, { ok: false, code: 'cancelled' });
  assert.equal(archiveRaw(), rawBefore, '取消不写档案');
  assert.equal(indexRaw(), indexBefore, '取消不写视频索引');
  assert.equal(page.data.noteEditor.text, '还没保存的草稿', '取消不清备注草稿');

  // 长按后部分基础库还会补一个 tap：同一行不再展开。
  assert.equal(page.data.expandedAttemptId, '', '长按没有顺带展开');
  page.toggleAttemptRow(tapDataset({ attemptId: first.id }));
  assert.equal(page.data.expandedAttemptId, '', '长按后的短窗口内 tap 不展开');

  // 有视频：确认文案写明攀笔保存的视频副本。
  const withVideo = openPrompt(page, rowOf(page, second));
  assert.equal(modal.current.title, '删除第 2 把？');
  assert.match(modal.current.content, /攀笔保存的视频副本/);
  answerPrompt(false);
  assert.deepEqual(await withVideo, { ok: false, code: 'cancelled' });
  assert.equal(archiveRaw(), rawBefore);
  assert.equal(virtual.files.has(video.filePath), true, '取消不删视频副本');
  assert.equal(page.data.noteEditor.text, '还没保存的草稿');

  // 同一把重复长按不再叠第二个弹窗，回答一次即可。
  const callsBefore = modal.calls;
  const p1 = page.requestDeleteAttempt(rowEvent(rowOf(page, first)));
  const p2 = page.requestDeleteAttempt(rowEvent(rowOf(page, first)));
  assert.equal(modal.calls, callsBefore + 1, '同一把只弹一次确认');
  answerPrompt(false);
  assert.deepEqual(await Promise.all([p1, p2]), [
    { ok: false, code: 'cancelled' },
    { ok: false, code: 'cancelled' }
  ]);
  assert.equal(archiveRaw(), rawBefore);
});

// ------------------------------------------------------------------ *
// 7 → 6：编号、身份、历史/小结/统计与媒体归属
// ------------------------------------------------------------------ *

test('T048-删除2 7 把删除旧第 5 把：剩 6 把、原 6/7 变 5/6，ID/seq/备注/视频不转移，历史/小结/统计同步', async () => {
  const flow = startFlow({ routeName: '七把顶绳线' });
  const other = addOtherRouteAttempt(flow);
  const notes = ['一', '二', '三', '四', '五', '六', '七'].map(value => value + '号备注');
  const attempts = notes.map((note, index) => addAttempt(flow, 'fail', note, index * 3));
  const video5 = seedClip(flow, attempts[4], { bytes: 5000 });
  const video6 = seedClip(flow, attempts[5], { bytes: 6000 });
  const video7 = seedClip(flow, attempts[6], { bytes: 7000 });
  storage.set(PHOTO_KEY, JSON.stringify({ keep: 'photo-index-unchanged' }));

  const page = openRecord(flow);
  assert.equal(page.data.attemptCards.length, 7);
  assert.equal(page.data.attemptCards[0].label, '第 7 把');
  const targetRow = page.data.attemptCards.find(row => row.id === attempts[4].id);
  assert.equal(targetRow.label, '第 5 把');

  const { outcome, options } = await confirmDelete(page, targetRow);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.recordDeleted, true);
  assert.equal(outcome.video.status, 'done');
  assert.match(options.content, /视频副本/);

  // 现场：6 把，原第 6、7 把依次显示第 5、6 把，其他行 ID 不变。
  assert.equal(page.data.routeCountText, '6 把');
  assert.deepEqual(
    page.data.attemptCards.map(row => row.label),
    ['第 6 把', '第 5 把', '第 4 把', '第 3 把', '第 2 把', '第 1 把']
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [attempts[6].id, attempts[5].id, attempts[3].id, attempts[2].id, attempts[1].id, attempts[0].id]
  );

  // 档案：被删记录（含结果、备注、时间）不再存在，其他把次逐项保持。
  const archive = archiveOf();
  assert.equal(
    store.attemptsFor(archive, { sessionId: flow.session.id, routeId: flow.route.id }).length,
    6
  );
  assert.equal(archive.attempts.some(item => item.id === attempts[4].id), false);
  [attempts[5], attempts[6]].forEach(original => {
    const kept = archive.attempts.find(item => item.id === original.id);
    assert.equal(kept.seq, original.seq, '内部 seq 不变');
    assert.equal(kept.note, original.note, '备注跟随各自记录');
    assert.equal(kept.result, original.result);
  });
  assert.equal(archive.attempts.find(item => item.id === other.attempt.id).note, '别的线备注');

  // 视频：第 5 把的索引与文件删除；第 6、7 把仍指向各自的原片。
  const index = indexOf();
  assert.equal(index.clips.some(entry => entry.attemptId === attempts[4].id), false);
  assert.equal(virtual.files.has(video5.filePath), false, '被删把次的本机副本已回收');
  assert.equal(virtual.files.has(video6.filePath), true);
  assert.equal(virtual.files.has(video7.filePath), true);
  assert.equal(
    attemptVideo.videoClipView(flow.archiveId, attempts[5].id, {
      sessionId: flow.session.id,
      routeId: flow.route.id
    }).clip.clipId,
    video6.clipId
  );
  assert.equal(
    page.data.attemptCards.find(row => row.id === attempts[5].id).videoEntryText,
    '回看视频'
  );
  assert.equal(
    page.data.attemptCards.find(row => row.id === attempts[6].id).videoEntryText,
    '回看视频'
  );

  // 历史、原场小结、统计与路线历史都按剩余有效集合。
  assert.equal(store.routeHistory(archive, flow.route.id).attemptCount, 6);
  assert.deepEqual(
    store.routeHistory(archive, flow.route.id).groups[0].attempts.map(item => item.label),
    ['第 1 把', '第 2 把', '第 3 把', '第 4 把', '第 5 把', '第 6 把']
  );
  const built = summary.buildSessionSummary(archive, flow.session.id);
  const routeRow = built.routes.find(row => row.routeId === flow.route.id);
  assert.equal(routeRow.attemptCount, 6);
  assert.equal(routeRow.latestNote, '七号备注');
  assert.equal(
    store.routesWithHistory(archive).find(row => row.id === flow.route.id).attemptCount,
    6
  );
  assert.equal(storage.get(PHOTO_KEY), JSON.stringify({ keep: 'photo-index-unchanged' }));
  // 别的线路完全没动。
  assert.equal(
    store.attemptsFor(archive, { sessionId: flow.session.id, routeId: other.route.id }).length,
    1
  );

  // 新记的一把：新 ID、新的更大内部序号，不复用被删把次的 ID/seq。
  const fresh = store.saveAttempt({
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'fail',
    note: '新的一把',
    now: new Date(2026, 10, 18, 10, 30)
  });
  assert.equal(fresh.ok, true, fresh.error);
  assert.notEqual(fresh.attempt.id, attempts[4].id);
  attempts.forEach(item => assert.notEqual(fresh.attempt.id, item.id));
  assert.ok(fresh.attempt.seq > attempts[6].seq, '内部序号单调，不回收被删序号');
  const reopened = openRecord(flow);
  assert.equal(reopened.data.attemptCards[0].label, '第 7 把');
  assert.equal(reopened.data.attemptCards[0].id, fresh.attempt.id);
});

// ------------------------------------------------------------------ *
// 撤销资格：删除较早保持、删除最新不补给前一把
// ------------------------------------------------------------------ *

test('T048-删除3 删除较早一把保留原最新撤销；删除最新后前一把不新增撤销，冷开一致，新记后恢复入口', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const third = addAttempt(flow, 'fail', '三', 10);
  const page = openRecord(flow);
  assert.equal(rowOf(page, third).showWithdraw, true);

  // 删除较早的第 1 把：原最新一把仍是最近一把，撤销入口保持。
  await confirmDelete(page, rowOf(page, first));
  assert.equal(page.data.routeCountText, '2 把');
  const latestAfterOldDelete = page.data.attemptCards[0];
  assert.equal(latestAfterOldDelete.id, third.id);
  assert.equal(latestAfterOldDelete.showWithdraw, true, '删除较早一把不影响原最新撤销');

  // 删除最新一把：前一把只补位，不再给撤销入口。
  await confirmDelete(page, latestAfterOldDelete);
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.attemptCards[0].id, second.id);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);

  // 冷开同样：门槛来自持久删除凭据，不靠页面内存。
  const reopened = openRecord(flow);
  assert.equal(reopened.data.attemptCards[0].id, second.id);
  assert.equal(reopened.data.attemptCards[0].showWithdraw, false);
  assert.equal(reopened.data.recentAttempt.canUndo, false);

  // 即使有人把补位前一把的事件再送进来，也不能把它撤掉。
  const before = archiveRaw();
  const outcome = reopened.undoLatestAttempt(
    tapDataset({
      attemptId: second.id,
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      expected: 'effective',
      expectedRev: 0
    })
  );
  assert.equal(outcome.changed, false);
  assert.match(reopened.data.notice, /不是刚记入的最新一把/);
  assert.equal(archiveRaw(), before, '补位前一把没有被撤销');

  // 新记一把：内部 seq 大于被删最新一把，撤销入口重新出现。
  reopened.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(reopened.data.storageError, '');
  const freshRow = reopened.data.attemptCards[0];
  assert.equal(freshRow.showWithdraw, true);
  assert.notEqual(freshRow.id, third.id);
  assert.equal(
    archiveOf().attempts.find(item => item.id === freshRow.id).seq > third.seq,
    true
  );
});

test('T048-删除3b 删除较早一把时，原已撤回那一把的「恢复」资格仍按原逻辑保留', () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const undone = store.undoAttempt(second.id, { sessionId: flow.session.id, routeId: flow.route.id });
  assert.equal(undone.ok, true, undone.error);

  const page = openRecord(flow);
  assert.equal(page.data.recentAttempt.canRestore, true);
  return confirmDelete(page, rowOf(page, first)).then(() => {
    const reopened = openRecord(flow);
    assert.equal(reopened.data.attemptCards.length, 0, '有效把次只剩已撤回那一把，不占现场');
    assert.equal(reopened.data.recentAttempt.canRestore, true, '已撤回那把的恢复入口保留');
  });
});

// ------------------------------------------------------------------ *
// 抱石唯一完攀删除后解锁
// ------------------------------------------------------------------ *

test('T048-删除4 删除唯一有效抱石完攀后恢复记把入口，历史/小结回到 0 把', async () => {
  const flow = startFlow({ climbType: '抱石', routeName: '抱石唯一完攀' });
  const send = addAttempt(flow, 'send', '唯一完攀', 0);
  const page = openRecord(flow);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeClosed, true);

  const { outcome } = await confirmDelete(page, rowOf(page, send));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.video.status, 'none');
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.hasAttemptCards, false);
  assert.equal(page.data.routeCountText, '0 把');

  const archive = archiveOf();
  assert.equal(archive.attempts.length, 0);
  assert.equal(store.routeCompletion(archive, flow.route.id).completed, false);
  assert.equal(store.routeHistory(archive, flow.route.id).attemptCount, 0);
  const built = summary.buildSessionSummary(archive, flow.session.id);
  assert.equal(built.routes.length, 0);
  assert.equal(built.sendCount, 0);

  // 记把入口重新可用（唯一完攀已删除），新记一把拿新 ID。
  page.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '1 把');
  assert.notEqual(page.data.attemptCards[0].id, send.id);
});

// ------------------------------------------------------------------ *
// 三阶段失败：档案写前、回执丢失、首次读回失败
// ------------------------------------------------------------------ *

test('T048-删除5 档案写前失败：记录与视频都不动、凭据回滚；重试成功只删一次', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, first);
  const page = openRecord(flow);
  const rawBefore = archiveRaw();
  const indexBefore = indexRaw();

  faults.archiveSetCount = 0;
  faults.archiveSetFailAt = 1;
  const { outcome } = await confirmDelete(page, rowOf(page, first));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'archive-write-failed');
  assert.match(page.data.notice, /没有删除/);
  assert.equal(archiveRaw(), rawBefore, '写前失败不改档案');
  assert.equal(indexRaw(), indexBefore, '写前失败不改视频索引');
  assert.equal(virtual.files.has(video.filePath), true, '视频副本保留');
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0, '坏写入回滚删除凭据');

  // 删除意图已随写前失败撤回：同一把的迟到重复保存仍按正常幂等复用原记录。
  const duplicate = store.saveAttempt({
    opId: first.id,
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: first.result,
    note: first.note
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attempt.id, first.id);
  assert.equal(archiveRaw(), rawBefore, '正常重复保存不写盘');

  // 清掉故障后按同一把重试：记录、索引、文件各只处理一次。
  faults.archiveSetFailAt = 0;
  faults.archiveSetCount = 0;
  const retryRow = rowOf(page, first);
  const retried = await confirmDelete(page, retryRow);
  assert.equal(retried.outcome.ok, true, retried.outcome.error);
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.attemptCards[0].id, second.id);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), false);
  assert.equal(virtual.files.has(video.filePath), false);
  assert.equal(indexOf().clips.some(entry => entry.attemptId === first.id), false);
  assert.equal(indexOf().clips.some(entry => entry.attemptId === second.id), false);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);
  assert.equal(archiveOf().attempts.length, 1);
});

test('T048-删除6 档案写成功但回执丢失：按读回确认结果；首次读回失败：保留凭据并在重开时核对', async () => {
  // 场景 A：写已生效、回执丢失，读回成功。
  const flowA = startFlow({ routeName: '回执丢失线' });
  const a1 = addAttempt(flowA, 'fail', '一', 0);
  const a2 = addAttempt(flowA, 'fail', '二', 5);
  const videoA = seedClip(flowA, a2);
  const pageA = openRecord(flowA);
  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 1;
  const lost = await confirmDelete(pageA, rowOf(pageA, a2));
  assert.equal(lost.outcome.ok, true, lost.outcome.error);
  assert.equal(lost.outcome.receiptLost, true);
  assert.match(pageA.data.notice, /回执丢失/);
  assert.equal(pageA.data.routeCountText, '1 把');
  assert.equal(pageA.data.attemptCards[0].id, a1.id);
  assert.equal(archiveOf().attempts.some(item => item.id === a2.id), false);
  assert.equal(virtual.files.has(videoA.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flowA.archiveId).pending, 0);

  // 场景 B：写已生效，但第一次读回也失败 → 不报成功、保留凭据。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowB = startFlow({ routeName: '读回失败线' });
  const b1 = addAttempt(flowB, 'fail', '一', 0);
  const b2 = addAttempt(flowB, 'fail', '二', 5);
  const videoB = seedClip(flowB, b2);
  const pageB = openRecord(flowB);
  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 1;
  faults.archiveReadFailAfterWrite = 3;
  const unverified = await confirmDelete(pageB, rowOf(pageB, b2));
  assert.equal(unverified.outcome.ok, false);
  assert.equal(unverified.outcome.code, 'archive-unverified');
  assert.match(pageB.data.notice, /暂未确认/);
  // 档案其实已经删掉；凭据还在等重开核对。
  assert.equal(archiveOf().attempts.some(item => item.id === b2.id), false);
  const pendingBefore = pendingJournal();
  assert.equal(pendingBefore.pending.length, 1);
  assert.equal(pendingBefore.pending[0].state, 'prepared');
  assert.equal(virtual.files.has(videoB.filePath), true, '读回失败时不贸然删视频');

  // 模拟重开：重建视频服务，按持久凭据重新核对档案并清理。
  faults.archiveLoseAt = 0;
  faults.pendingReadFails = 0;
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const recovered = await attemptDelete.recoverPending({ archiveId: flowB.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  assert.equal(virtual.files.has(videoB.filePath), false);
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === b2.id),
    false
  );
  assert.equal(
    store.attemptsFor(archiveOf(), {
      sessionId: flowB.session.id,
      routeId: flowB.route.id
    }).length,
    1
  );
  assert.equal(
    store.attemptsFor(archiveOf(), {
      sessionId: flowB.session.id,
      routeId: flowB.route.id
    })[0].id,
    b1.id
  );
});

// ------------------------------------------------------------------ *
// 三阶段失败：视频索引与文件
// ------------------------------------------------------------------ *

test('T048-删除7 视频索引写失败：记录已删、副本保留且可见；手动重试后只清理一次', async () => {
  const flow = startFlow();
  addAttempt(flow, 'fail', '一', 0);
  const target = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, target);
  const page = openRecord(flow);

  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const { outcome } = await confirmDelete(page, rowOf(page, target));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.recordDeleted, true);
  assert.equal(outcome.video.status, 'pending');
  assert.match(page.data.notice, /视频副本未清理/);
  assert.match(page.data.cleanupNotice, /待清理/);
  assert.equal(page.data.cleanupRetryVisible, true);

  // 记录已移出，但索引引用与文件都在：不谎报「记录和视频都完成」。
  assert.equal(archiveOf().attempts.some(item => item.id === target.id), false);
  assert.equal(indexOf().clips.some(entry => entry.attemptId === target.id), true);
  assert.equal(virtual.files.has(video.filePath), true);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 1);

  // 手动重试：索引与文件都清掉，凭据收尾。
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  const retried = await page.retryVideoCleanup();
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(page.data.cleanupNotice, '');
  assert.equal(page.data.cleanupRetryVisible, false);
  assert.match(page.data.notice, /已清理/);
  assert.equal(indexOf().clips.some(entry => entry.attemptId === target.id), false);
  assert.equal(virtual.files.has(video.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);
});

test('T048-删除8 文件删除失败：索引已清、文件保留为待清理；重试后回收，且不重复删', async () => {
  const flow = startFlow();
  addAttempt(flow, 'fail', '一', 0);
  const target = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, target);
  const page = openRecord(flow);

  faults.unlinkFail = true;
  const { outcome } = await confirmDelete(page, rowOf(page, target));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.recordDeleted, true);
  assert.equal(outcome.video.status, 'pending');
  assert.match(page.data.cleanupNotice, /待清理/);
  assert.equal(archiveOf().attempts.some(item => item.id === target.id), false);
  assert.equal(indexOf().clips.some(entry => entry.attemptId === target.id), false);
  assert.equal(virtual.files.has(video.filePath), true, '文件删除失败时保留副本');
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 1);

  faults.unlinkFail = false;
  const retried = await page.retryVideoCleanup();
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(virtual.files.has(video.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);

  // 已收尾后再次手动重试：没有文件可删，也不报错。
  const again = await page.retryVideoCleanup();
  assert.equal(again.ok, true);
  assert.equal(page.data.cleanupRetryVisible, false);
});

// ------------------------------------------------------------------ *
// 迟到确认、视频换版、跨线与重复确认
// ------------------------------------------------------------------ *

test('T048-删除9 迟到确认不删错误项：列表变化、视频换版、跨线事件与重复确认', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const third = addAttempt(flow, 'fail', '三', 10);
  const video = seedClip(flow, third);
  const page = openRecord(flow);

  // (a) 确认期间这条线新增了一把：整条拒绝，被点的那把还在。
  let pending = openPrompt(page, rowOf(page, first));
  const fourth = addAttempt(flow, 'fail', '四', 15);
  answerPrompt(true);
  let outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'stale');
  assert.match(page.data.notice, /把次已经变化/);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
  assert.equal(archiveOf().attempts.some(item => item.id === fourth.id), true);

  // (b) 确认期间视频换版：不删除记录，也不删新的视频副本。
  pending = openPrompt(page, rowOf(page, third));
  clipSeq += 1;
  const replaced = {
    clipId: 'clip-' + clipSeq + '-replaced',
    rev: 2,
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-' + clipSeq + '-replaced.mp4'
  };
  virtual.files.set(USER_DATA_PATH + '/' + replaced.fileId, Buffer.alloc(2222, 3));
  const index = indexOf();
  index.clips = index.clips.filter(entry => entry.attemptId !== third.id);
  index.clips.push({
    clipId: replaced.clipId,
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: third.id,
    rev: replaced.rev,
    bytes: 2222,
    fileId: replaced.fileId
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  answerPrompt(true);
  outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'media-changed');
  assert.equal(archiveOf().attempts.some(item => item.id === third.id), true);
  assert.equal(virtual.files.has(USER_DATA_PATH + '/' + replaced.fileId), true);
  assert.equal(virtual.files.has(USER_DATA_PATH + '/' + video.fileId), true, '旧副本也不在这一步删');

  // (c) 别的线路/场次的迟到事件：页面归属核对直接拒绝，不弹确认。
  const other = addOtherRouteAttempt(flow);
  const callsBefore = modal.calls;
  const cross = await page.requestDeleteAttempt(
    rowEvent(rowOf(page, second), { routeId: other.route.id })
  );
  assert.equal(cross, null);
  assert.equal(modal.calls, callsBefore, '跨线事件不弹删除确认');
  assert.equal(archiveOf().attempts.some(item => item.id === second.id), true);
  assert.match(page.data.notice, /这一行已经变化/);

  // (d) 重复确认：同一把只产生一次删除结果。
  const targetRow = rowOf(page, second);
  const p1 = page.requestDeleteAttempt(rowEvent(targetRow));
  const p2 = page.requestDeleteAttempt(rowEvent(targetRow));
  assert.equal(modal.calls, callsBefore + 1, '同一把只弹一次');
  answerPrompt(true);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(
    archiveOf().attempts.filter(item => item.id === second.id).length,
    0,
    '记录已删除一次'
  );
  assert.equal(
    store.attemptsFor(archiveOf(), {
      sessionId: flow.session.id,
      routeId: flow.route.id
    }).length,
    3,
    '没有多删或复活别的把次'
  );
  // 再长按已删除的一行：页面只剩最新数据，不再弹确认。
  const callsAfter = modal.calls;
  await page.requestDeleteAttempt(rowEvent(targetRow));
  assert.equal(modal.calls, callsAfter, '已删除行的旧事件不再弹确认');
});

// ------------------------------------------------------------------ *
// 真实待保存与异常覆盖
// ------------------------------------------------------------------ *

test('T048-删除10 真实待保存时不允许长按删除；待保存操作不会变成删除目标', () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  // 在档案里留一条真实的「进行中」保存标记。
  const archive = archiveOf();
  archive.pendingSaves.push({
    opId: 'op-pending-real',
    seq: archive.nextAttemptSeq,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'send',
    note: '待保存那一把',
    createdAt: '2026-11-18T02:00:00.000Z'
  });
  storage.set(ARCHIVE_KEY, JSON.stringify(archive));

  const page = openRecord(flow);
  assert.equal(page.data.pendingRows.length, 1);
  assert.equal(
    page.data.attemptCards.some(row => row.id === 'op-pending-real'),
    false,
    '待保存操作不生成可删除的伪行'
  );

  const rawBefore = archiveRaw();
  const callsBefore = modal.calls;
  const result = page.requestDeleteAttempt(rowEvent(rowOf(page, first)));
  return Promise.resolve(result).then(outcome => {
    assert.equal(outcome, null);
    assert.equal(modal.calls, callsBefore, '有待保存时不弹删除确认');
    assert.match(page.data.notice, /先在「待保存」行重试保存/);
    assert.equal(archiveRaw(), rawBefore, '没有改动档案');
    assert.equal(archiveOf().attempts.length, 2);
    assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
    assert.equal(archiveOf().attempts.some(item => item.id === second.id), true);
  });
});

// ------------------------------------------------------------------ *
// 重开恢复、无 journal 不扫盘、换档与清缓存
// ------------------------------------------------------------------ *

test('T048-删除11 重开恢复：无 journal 不扫盘；pending 才处理；换档不清理旧档案；清缓存不动凭据', async () => {
  // 没有 journal：一次文件系统也不碰。
  const beforeCalls = JSON.stringify(
    Object.keys(virtual.calls).reduce((acc, key) => {
      acc[key] = virtual.calls[key].length;
      return acc;
    }, {})
  );
  const none = await attemptDelete.recoverPending();
  assert.equal(none.ok, true);
  assert.equal(none.skipped, true);
  const afterCalls = JSON.stringify(
    Object.keys(virtual.calls).reduce((acc, key) => {
      acc[key] = virtual.calls[key].length;
      return acc;
    }, {})
  );
  assert.equal(afterCalls, beforeCalls, '没有 journal 时不扫描目录/文件');

  // 产生一个真实的 pending：索引写失败后模拟重开。
  const flow = startFlow();
  addAttempt(flow, 'fail', '一', 0);
  const target = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, target);
  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const direct = await attemptDelete.deleteAttempt({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: target.id,
    expectedRev: 0,
    expectedNote: target.note,
    expectedResult: target.result,
    clip: clipEvidenceOf(video)
  });
  assert.equal(direct.ok, true, direct.error);
  assert.equal(direct.video.status, 'pending');
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 1);

  // 普通清缓存不删删除凭据。
  assert.equal(store.isProtectedKey(DELETE_KEY), true);
  const cleared = store.clearRebuildableStorage();
  assert.equal(cleared.ok, true);
  assert.equal(storage.has(DELETE_KEY), true, '清理可重建缓存不动删除凭据');

  // 重开：清故障、重建服务，恢复只处理 pending 并收尾。
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const recovered = await attemptDelete.recoverPending();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  assert.equal(virtual.files.has(video.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);

  // 换档：另一份档案当前生效时，旧档案的 pending 不凭旧凭据清理文件。
  const flow2 = startFlow({ gymName: '第二档案岩馆', routeName: '第二档案线' });
  addAttempt(flow2, 'fail', '一', 0);
  const target2 = addAttempt(flow2, 'fail', '二', 5);
  const video2 = seedClip(flow2, target2);
  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const direct2 = await attemptDelete.deleteAttempt({
    archiveId: flow2.archiveId,
    sessionId: flow2.session.id,
    routeId: flow2.route.id,
    attemptId: target2.id,
    expectedRev: 0,
    expectedNote: target2.note,
    expectedResult: target2.result,
    clip: clipEvidenceOf(video2)
  });
  assert.equal(direct2.ok, true, direct2.error);
  assert.equal(attemptDelete.pendingStatus(flow2.archiveId).pending, 1);
  // 模拟换档：把当前档案改成另一份（只改 archiveId，其余结构保持）。
  const switched = archiveOf();
  const archivedId = switched.archiveId;
  switched.archiveId = 'archive-switched-other';
  storage.set(ARCHIVE_KEY, JSON.stringify(switched));
  faults.indexSetFailAt = 0;
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const switchedResult = await attemptDelete.recoverPending();
  assert.equal(switchedResult.ok, false);
  assert.equal(switchedResult.pending, 1);
  assert.equal(virtual.files.has(video2.filePath), true, '换档后不清理旧档案的视频副本');
  assert.equal(attemptDelete.pendingStatus(archivedId).pending, 1);
});

// ------------------------------------------------------------------ *
// 共享引用、错误路径与损坏索引
// ------------------------------------------------------------------ *

test('T048-删除12 共享引用与错误路径谨慎：仍被别的条目引用的文件不删，跨档案/非法路径不删，索引损坏不删记录', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  // 两个索引条目指向同一个文件（损坏/共享引用场景）。
  const shared = seedClip(flow, first, { bytes: 3000 });
  const index = indexOf();
  index.clips.push({
    clipId: 'clip-shared-second',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: second.id,
    rev: 1,
    bytes: 3000,
    fileId: shared.fileId
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));

  const page = openRecord(flow);
  const { outcome } = await confirmDelete(page, rowOf(page, first));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.video.status, 'kept', '共享引用按保留完成，不谎报已删文件');
  assert.equal(outcome.video.reason, 'shared');
  assert.match(page.data.notice, /其他记录.*保留/);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), false);
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === first.id),
    false,
    '只解除被删这一把的引用'
  );
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === second.id),
    true,
    '别的引用保留'
  );
  assert.equal(virtual.files.has(shared.filePath), true, '共享引用的文件不删');
  // 收尾时服务仍把共享引用记为待清理吗？不能：文件还在被引用。
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);

  // 跨档案/非法路径：即使凭据被篡改，服务也拒绝，不删任何文件。
  const service = videoFiles.createAttemptVideoStore({
    archiveId: flow.archiveId,
    files: videoFiles.createWxAttemptVideoFiles({ archiveId: flow.archiveId })
  });
  const foreign = await service.removeDeletedClip({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: second.id,
    clipId: 'clip-shared-second',
    rev: 1,
    fileId: 'attempt-video/v1/archive-other/clip-shared-second.mp4'
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'foreign-file');
  const relative = await service.removeDeletedClip({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: second.id,
    clipId: 'clip-shared-second',
    rev: 1,
    fileId: 'not-our-feature/clip-shared-second.mp4'
  });
  assert.equal(relative.ok, false);
  assert.equal(relative.code, 'foreign-file');
  assert.equal(virtual.files.has(shared.filePath), true);

  // 索引损坏：不猜有没有视频，记录也不删。
  storage.set(VIDEO_INDEX_KEY, '{broken-json');
  const rawBefore = archiveRaw();
  const callsBefore = modal.calls;
  const result = await page.requestDeleteAttempt(rowEvent(rowOf(page, second)));
  assert.equal(result, null);
  assert.equal(modal.calls, callsBefore, '视频关联读不出来时不打开删除确认');
  assert.match(page.data.notice, /视频关联暂时读取失败/);
  assert.equal(archiveRaw(), rawBefore);
  assert.equal(storage.get(VIDEO_INDEX_KEY), '{broken-json', '损坏索引保持原样');
  assert.equal(virtual.files.has(shared.filePath), true);
});

// ------------------------------------------------------------------ *
// 页面静态绑定：序号区长按、清理重试入口
// ------------------------------------------------------------------ */

test('T048-删除13 WXML 把长按绑在序号 view 框上（同容器 + 最小命中区），并有可见的清理重试入口', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxml'),
    'utf8'
  );
  const wxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxss'),
    'utf8'
  );
  assert.match(
    wxml,
    /id="record-attempt-label-\{\{item\.id\}\}"[\s\S]{0,600}data-delete-rev="\{\{item\.deleteRev\}\}"[\s\S]{0,120}catchlongpress="requestDeleteAttempt"/
  );
  assert.match(wxml, /id="video-cleanup"[\s\S]{0,260}id="video-cleanup-retry"[\s\S]{0,80}bindtap="retryVideoCleanup"/);

  // 手机试用返工：长按不能再挂在只包住文字的 text 上，序号必须是明确的原生 view 框，
  // 绑定与六项 data 都在同一个容器里（框内文字、内边距与空白命中同一目标）。
  const labelAt = wxml.indexOf('id="record-attempt-label-{{item.id}}"');
  assert.ok(labelAt > 0, '保留 #record-attempt-label-原ID 选择器');
  const boxOpen = wxml.lastIndexOf('<view', labelAt);
  const boxClose = wxml.indexOf('</view>', labelAt);
  assert.ok(boxOpen > -1 && boxClose > labelAt, '序号框应是一个 view 容器');
  assert.doesNotMatch(
    wxml.slice(boxOpen, labelAt),
    /<\/?text/,
    '序号不是 text 上的绑定，而是 view 容器上的绑定'
  );
  const labelBox = wxml.slice(boxOpen, boxClose + '</view>'.length);
  assert.match(labelBox, /class="record-attempt-label"/);
  const required = [
    'data-attempt-id="{{item.id}}"',
    'data-archive-id="{{item.archiveId}}"',
    'data-session-id="{{item.sessionId}}"',
    'data-route-id="{{item.routeId}}"',
    'data-delete-rev="{{item.deleteRev}}"',
    'data-page-token="{{pageToken}}"',
    'catchlongpress="requestDeleteAttempt"'
  ];
  for (const attr of required) {
    assert.ok(labelBox.includes(attr), '同一个序号容器必须带 ' + attr);
  }
  // 序号文字只是框里的内容：不另挂长按，避免同一触点重复触发（短按照旧冒泡到整行）。
  assert.match(
    labelBox,
    /<text class="record-attempt-label-text">\{\{item\.label\}\}<\/text>/
  );
  assert.equal(
    (labelBox.match(/longpress/g) || []).length,
    1,
    '整框只有一个长按绑定'
  );
  assert.equal(
    (labelBox.match(/catchtap|bindtap/g) || []).length,
    0,
    '序号框不劫持短按，短按照旧由父行展开'
  );

  // 命中区与收缩：最小约 44×44 px，宽度按内容收缩且不折行，内层文字不再单独接手势。
  const ruleOf = selector => {
    const start = wxss.indexOf(selector + ' {');
    assert.ok(start > -1, '缺少样式 ' + selector);
    return wxss.slice(start, wxss.indexOf('}', start));
  };
  const labelStyle = ruleOf('.record-attempt-label');
  assert.match(labelStyle, /display:\s*flex;/);
  assert.match(labelStyle, /flex:\s*0 0 auto;/);
  assert.match(labelStyle, /box-sizing:\s*border-box;/);
  assert.match(labelStyle, /min-width:\s*44px;/);
  assert.match(labelStyle, /min-height:\s*44px;/);
  assert.match(labelStyle, /white-space:\s*nowrap;/);
  assert.match(labelStyle, /user-select:\s*none;/);
  // 框内边缘验收：用既有卡片色系给序号框浅底、轻边线和小圆角，手机上看得见框；
  // border-box 不变，边线画在 44×44 命中区内，不另占撤销槽的宽度。
  assert.match(labelStyle, /border:\s*1px solid #D7DED9;/);
  assert.match(labelStyle, /border-radius:\s*6rpx;/);
  assert.match(labelStyle, /background-color:\s*#FFFFFF;/);
  assert.match(labelStyle, /padding:\s*0 6rpx;/);
  assert.match(ruleOf('.record-attempt-label-text'), /pointer-events:\s*none;/);

  assert.equal(typeof definition.requestDeleteAttempt, 'function');
  assert.equal(typeof definition.askDeleteConfirm, 'function');
  assert.equal(typeof definition.notifyDeleteGuard, 'function');
  assert.equal(typeof definition.retryVideoCleanup, 'function');
});

// ------------------------------------------------------------------ *
// 视频索引回执丢失 / 读回失败
// ------------------------------------------------------------------ *

test('T048-删除14 视频索引写成功但回执丢失按读回确认；读回也失败时保留副本，重开继续清理', async () => {
  // 场景 A：索引已落盘、回执丢失，读回确认已解除关联 → 文件照常回收。
  const flowA = startFlow({ routeName: '索引回执丢失线' });
  addAttempt(flowA, 'fail', '一', 0);
  const targetA = addAttempt(flowA, 'fail', '二', 5);
  const videoA = seedClip(flowA, targetA);
  const pageA = openRecord(flowA);
  faults.indexSetCount = 0;
  faults.indexLoseAt = 1;
  const lost = await confirmDelete(pageA, rowOf(pageA, targetA));
  assert.equal(lost.outcome.ok, true, lost.outcome.error);
  assert.equal(lost.outcome.video.status, 'done');
  assert.equal(indexOf().clips.some(entry => entry.attemptId === targetA.id), false);
  assert.equal(virtual.files.has(videoA.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flowA.archiveId).pending, 0);

  // 场景 B：索引已落盘但读回也失败 → 不删文件、保留待清理；重开后按持久凭据回收。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowB = startFlow({ gymName: '索引读回失败岩馆', routeName: '索引读回失败线' });
  addAttempt(flowB, 'fail', '一', 0);
  const targetB = addAttempt(flowB, 'fail', '二', 5);
  const videoB = seedClip(flowB, targetB);
  const pageB = openRecord(flowB);
  faults.indexSetCount = 0;
  faults.indexLoseAt = 1;
  faults.indexReadFailAfterWrite = 2;
  const unverified = await confirmDelete(pageB, rowOf(pageB, targetB));
  assert.equal(unverified.outcome.ok, true, unverified.outcome.error);
  assert.equal(unverified.outcome.recordDeleted, true);
  assert.equal(unverified.outcome.video.status, 'pending');
  assert.equal(virtual.files.has(videoB.filePath), true, '读不回索引时不删文件');
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === targetB.id),
    false,
    '索引其实已经解除关联'
  );
  assert.equal(attemptDelete.pendingStatus(flowB.archiveId).pending, 1);

  faults.indexLoseAt = 0;
  faults.pendingReadFails = 0;
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const recovered = await attemptDelete.recoverPending({ archiveId: flowB.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  assert.equal(virtual.files.has(videoB.filePath), false);
  assert.equal(archiveOf().attempts.some(item => item.id === targetB.id), false);
});

// ------------------------------------------------------------------ *
// 追加返工：并发 journal、pending 门槛、陈旧待清理与页面令牌
// ------------------------------------------------------------------ *

function deleteInput(flow, attempt, clip, routeId) {
  return {
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: routeId || flow.route.id,
    attemptId: attempt.id,
    expectedRev: store.attemptRev(attempt),
    expectedNote: attempt.note || '',
    expectedResult: attempt.result,
    clip: clip ? clipEvidenceOf(clip) : null
  };
}

function conditionJournal() {
  return pendingJournal() || { version: 1, pending: [], deleted: [], barriers: {} };
}

test('T048-删除15 并发删除不同把次：同一队列串行、晚到的清理不覆盖另一条线的凭据与门槛，新模块实例可续清', async () => {
  const flow = startFlow({ routeName: '并发删除主线' });
  const first = addAttempt(flow, 'fail', '主线一', 0);
  const latest = addAttempt(flow, 'fail', '主线二', 5);
  const other = addOtherRouteAttempt(flow);
  const latestVideo = seedClip(flow, latest, { bytes: 5000 });
  const otherVideo = seedClip(flow, other.attempt, {
    bytes: 6000,
    routeId: other.route.id
  });

  // 可暂停的删除服务：A 在清理视频前挂起，B 必须在同一队列里等待。
  let releaseA = () => {};
  let arrivedA = () => {};
  const arrived = new Promise(resolve => {
    arrivedA = resolve;
  });
  const gate = new Promise(resolve => {
    releaseA = resolve;
  });
  let paused = false;
  attemptDelete.configure({
    createService(archiveId) {
      const real = videoFiles.createAttemptVideoStore({
        archiveId,
        files: videoFiles.createWxAttemptVideoFiles({ archiveId })
      });
      return {
        removeDeletedClip(evidence) {
          if (!paused && evidence.attemptId === latest.id) {
            paused = true;
            arrivedA();
            return gate.then(() => real.removeDeletedClip(evidence));
          }
          return real.removeDeletedClip(evidence);
        }
      };
    }
  });

  const taskA = attemptDelete.deleteAttempt(deleteInput(flow, latest, latestVideo));
  await arrived;
  const duringA = conditionJournal();
  assert.equal(duringA.pending.length, 1);
  assert.equal(duringA.pending[0].attemptId, latest.id, 'A 的持久凭据已落盘');
  assert.equal(
    archiveOf().attempts.some(item => item.id === latest.id),
    false,
    'A 的档案删除已提交，正等待视频清理'
  );

  faults.unlinkFailFor = USER_DATA_PATH + '/' + otherVideo.fileId;
  const taskB = attemptDelete.deleteAttempt(
    deleteInput(flow, other.attempt, otherVideo, other.route.id)
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(
    archiveOf().attempts.some(item => item.id === other.attempt.id),
    true,
    'B 在 A 的清理窗口内排队，不并发写档案'
  );

  releaseA();
  const outcomeA = await taskA;
  const outcomeB = await taskB;
  assert.equal(outcomeA.ok, true, outcomeA.error);
  assert.equal(outcomeA.video.status, 'done');
  assert.equal(outcomeB.ok, true, outcomeB.error);
  assert.equal(outcomeB.video.status, 'pending');
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
  assert.equal(archiveOf().attempts.some(item => item.id === latest.id), false);
  assert.equal(
    archiveOf().attempts.some(item => item.id === other.attempt.id),
    false
  );

  // A 已收尾，B 的 pending 条目必须仍在；两条线的墓碑门槛都保留。
  const afterBoth = conditionJournal();
  assert.deepEqual(afterBoth.pending.map(entry => entry.attemptId), [other.attempt.id]);
  assert.equal(
    afterBoth.deleted.some(item => item.attemptId === latest.id),
    true,
    'A 的墓碑没有被 B 的写入覆盖'
  );
  assert.equal(
    afterBoth.deleted.some(item => item.attemptId === other.attempt.id),
    false,
    'B 尚未完成，不提前写墓碑'
  );
  assert.equal(
    afterBoth.barriers[[flow.archiveId, flow.session.id, flow.route.id].join('/')],
    latest.seq
  );
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, other.route.id),
    other.attempt.seq
  );
  assert.equal(virtual.files.has(otherVideo.filePath), true, 'B 的文件按失败语义保留');

  // 从新模块实例只按已落盘凭据继续 B 的清理；A 的墓碑与门槛不受影响。
  faults.unlinkFailFor = '';
  videoFiles.resetAttemptVideoServices();
  delete require.cache[require.resolve(DELETE_UTIL)];
  const freshDelete = require(DELETE_UTIL);
  const recovered = await freshDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  assert.equal(virtual.files.has(otherVideo.filePath), false);
  assert.equal(virtual.files.has(latestVideo.filePath), false);
  assert.equal(conditionJournal().pending.length, 0);
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    latest.seq,
    '新实例完成后门槛仍是 A 的最新删除序号'
  );
});

test('T048-删除16 最新一把删除但视频待清理：门槛立即生效、冷开与重放旧手势都不撤、新记一把后开放', async () => {
  const flow = startFlow({ routeName: '待清理门槛线' });
  const first = addAttempt(flow, 'fail', '一', 0);
  const oldPage = openRecord(flow);
  assert.equal(rowOf(oldPage, first).showWithdraw, true);
  // 先在「first 是最近一把」时捕获旧手势，稍后删除 newer 后重放。
  const oldUndoEvent = tapDataset({
    attemptId: first.id,
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    expected: 'effective',
    expectedRev: 0
  });

  const latest = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, latest);
  const page = openRecord(flow);
  faults.unlinkFail = true;
  const { outcome } = await confirmDelete(page, rowOf(page, latest));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.recordDeleted, true);
  assert.equal(outcome.video.status, 'pending');
  assert.equal(virtual.files.has(video.filePath), true);

  // 现场立即：前一把只补位，不获得撤销；持久门槛来自 pending 条目本身。
  assert.equal(page.data.attemptCards[0].id, first.id);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);
  assert.equal(page.data.recentAttempt.canUndo, false);
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    latest.seq
  );

  // 冷开（视频仍待清理）一致：靠档案实态 + pending 凭据，不靠页面 data。
  const reopened = openRecord(flow);
  assert.equal(reopened.data.attemptCards[0].id, first.id);
  assert.equal(reopened.data.attemptCards[0].showWithdraw, false);

  // 重放旧页面在删除前捕获的手势：即使绕过画面也不能撤销补位的前一把。
  const beforeReplay = archiveRaw();
  const replay = oldPage.undoLatestAttempt(oldUndoEvent);
  assert.equal(replay.changed, false);
  assert.match(oldPage.data.notice, /不是刚记入的最新一把/);
  assert.equal(archiveRaw(), beforeReplay, '旧手势没有改动档案');

  // 新记一把（内部 seq 更大）后撤销入口重新开放。
  page.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(page.data.storageError, '');
  const freshRow = page.data.attemptCards[0];
  assert.equal(freshRow.showWithdraw, true);
  assert.equal(freshRow.id !== latest.id, true);
  assert.equal(archiveOf().attempts.find(item => item.id === freshRow.id).seq > latest.seq, true);
});

test('T048-删除17 门槛读取失败保守禁撤销；pending 里的原把仍在档案时按实际状态保留撤销', () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  // 模拟「档案写失败/未确认」留下的 prepared 条目：记录其实还在档案里。
  storage.set(
    DELETE_KEY,
    JSON.stringify({
      version: 1,
      pending: [
        {
          attemptId: second.id,
          archiveId: flow.archiveId,
          sessionId: flow.session.id,
          routeId: flow.route.id,
          seq: second.seq,
          clip: null,
          state: 'prepared',
          createdAt: '',
          updatedAt: '',
          lastError: ''
        }
      ],
      deleted: [],
      barriers: {}
    })
  );
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    0,
    '未删掉的原把不计入门槛'
  );
  const page = openRecord(flow);
  assert.equal(rowOf(page, second).showWithdraw, true, '未删的原最新一把仍可撤销');
  assert.equal(rowOf(page, first).showWithdraw, false);

  // journal 读不出来：门槛取安全哨兵，不能误给撤销。
  faults.pendingReadFails = 1;
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    attemptDelete.BARRIER_BLOCKED
  );

  // journal 可读但档案读不出来：同样保守。
  faults.pendingReadFails = 0;
  let reads = 0;
  const realGet = global.wx.getStorageSync;
  global.wx.getStorageSync = function getStorageSync(key) {
    reads += 1;
    if (reads === 2) throw { errMsg: 'getStorageSync:fail mock archive read error' };
    return realGet.call(this, key);
  };
  try {
    assert.equal(
      attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
      attemptDelete.BARRIER_BLOCKED
    );
  } finally {
    global.wx.getStorageSync = realGet;
  }
});

test('T048-删除18 文件 unlink 已成功但回执丢失：重开只结清同身份陈旧待清理，其余标记保留', async () => {
  const flow = startFlow();
  const target = addAttempt(flow, 'fail', '待结清', 0);
  const video = seedClip(flow, target);
  const removal = store.deleteAttempt(target.id, {
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id
  });
  assert.equal(removal.ok, true, removal.error);

  // 索引已经分离，文件已经不在了；但同一 fileId 的待清理标记还留着（回执丢失）。
  const index = indexOf();
  index.clips = index.clips.filter(entry => entry.attemptId !== target.id);
  index.pending = (index.pending || []).filter(entry => entry.fileId !== video.fileId);
  index.pending.push({
    archiveId: flow.archiveId,
    clipId: video.clipId,
    fileId: video.fileId,
    opId: 'cleanup',
    createdAt: '2026-11-18T01:00:00.000Z'
  });
  index.pending.push({
    archiveId: flow.archiveId,
    clipId: 'clip-other-owner',
    fileId: 'attempt-video/v1/' + flow.archiveId + '/clip-other-owner.mp4',
    opId: 'cleanup',
    createdAt: '2026-11-18T01:00:00.000Z'
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  virtual.files.delete(video.filePath);
  storage.set(
    DELETE_KEY,
    JSON.stringify({
      version: 1,
      pending: [
        {
          attemptId: target.id,
          archiveId: flow.archiveId,
          sessionId: flow.session.id,
          routeId: flow.route.id,
          seq: target.seq,
          clip: clipEvidenceOf(video),
          state: 'removed',
          createdAt: '',
          updatedAt: '',
          lastError: ''
        }
      ],
      deleted: [],
      barriers: {}
    })
  );

  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const recovered = await attemptDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  // 同身份标记被结清，外层 journal 才收尾；别的片段/文件的标记不越权删除。
  const after = indexOf();
  assert.equal(
    after.pending.some(entry => entry.clipId === video.clipId && entry.fileId === video.fileId),
    false
  );
  assert.equal(
    after.pending.some(entry => entry.clipId === 'clip-other-owner'),
    true,
    '只清凭据同身份的标记'
  );
  assert.equal(conditionJournal().pending.length, 0);
  assert.equal(
    conditionJournal().deleted.some(item => item.attemptId === target.id),
    true
  );
  assert.equal(virtual.files.has(video.filePath), false);

  // 再重开一次：不会重复删除，也不会让陈旧标记挡住收尾。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const again = await attemptDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.pending, 0);
});

test('T048-删除19 成功重新清理后同样结清同身份陈旧标记；共享引用完成态如实说「其他记录仍使用，已保留」', async () => {
  // A：索引已分离、文件还在、标记陈旧 → 重开重新清理成功后结清标记。
  const flowA = startFlow({ routeName: '重新清理线' });
  const targetA = addAttempt(flowA, 'fail', '再清理', 0);
  const videoA = seedClip(flowA, targetA);
  const removalA = store.deleteAttempt(targetA.id, {
    archiveId: flowA.archiveId,
    sessionId: flowA.session.id,
    routeId: flowA.route.id
  });
  assert.equal(removalA.ok, true, removalA.error);
  const indexA = indexOf();
  indexA.clips = indexA.clips.filter(entry => entry.attemptId !== targetA.id);
  indexA.pending.push({
    archiveId: flowA.archiveId,
    clipId: videoA.clipId,
    fileId: videoA.fileId,
    opId: 'cleanup',
    createdAt: '2026-11-18T01:00:00.000Z'
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(indexA));
  storage.set(
    DELETE_KEY,
    JSON.stringify({
      version: 1,
      pending: [
        {
          attemptId: targetA.id,
          archiveId: flowA.archiveId,
          sessionId: flowA.session.id,
          routeId: flowA.route.id,
          seq: targetA.seq,
          clip: clipEvidenceOf(videoA),
          state: 'removed',
          createdAt: '',
          updatedAt: '',
          lastError: ''
        }
      ],
      deleted: [],
      barriers: {}
    })
  );
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const recovered = await attemptDelete.recoverPending({ archiveId: flowA.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.pending, 0);
  assert.equal(virtual.files.has(videoA.filePath), false, '文件确实被重新清理');
  assert.equal(
    indexOf().pending.some(entry => entry.fileId === videoA.fileId),
    false,
    '成功清理后标记结清'
  );

  // B：共享引用只分离原把关联，文件保留且完成态如实。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowB = startFlow({ gymName: '共享完成态岩馆', routeName: '共享完成态线' });
  const firstB = addAttempt(flowB, 'fail', '一', 0);
  const secondB = addAttempt(flowB, 'fail', '二', 5);
  const shared = seedClip(flowB, firstB, { bytes: 3000 });
  const indexB = indexOf();
  indexB.clips.push({
    clipId: 'clip-shared-kept',
    archiveId: flowB.archiveId,
    sessionId: flowB.session.id,
    routeId: flowB.route.id,
    attemptId: secondB.id,
    rev: 1,
    bytes: 3000,
    fileId: shared.fileId
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(indexB));

  const page = openRecord(flowB);
  const { outcome } = await confirmDelete(page, rowOf(page, firstB));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.video.status, 'kept');
  assert.equal(outcome.video.reason, 'shared');
  assert.match(page.data.notice, /其他记录.*保留/);
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === firstB.id),
    false,
    '原把关联已分离'
  );
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === secondB.id),
    true,
    '共享条目保持原样'
  );
  assert.equal(virtual.files.has(shared.filePath), true);
  assert.equal(attemptDelete.pendingStatus(flowB.archiveId).pending, 0);

  // 冷开重试与原共享条目一致：不删文件、不再补清理入口。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const reopened = openRecord(flowB);
  await attemptDelete.recoverPending({ archiveId: flowB.archiveId });
  assert.equal(attemptDelete.pendingStatus(flowB.archiveId).pending, 0);
  assert.equal(virtual.files.has(shared.filePath), true);
  assert.equal(reopened.data.cleanupRetryVisible, false);
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === secondB.id),
    true
  );
});

test('T048-删除20 长按事件必须带当前页面令牌与 deleteRev；过期事件不弹确认也不删除', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const page = openRecord(flow);
  assert.equal(typeof page.data.pageToken, 'string');
  assert.ok(page.data.pageToken.length > 0);
  const row = rowOf(page, second);
  assert.equal(row.pageToken, page.data.pageToken);

  const callsBefore = modal.calls;
  const wrongRev = await page.requestDeleteAttempt(
    rowEvent(row, { deleteRev: Number(row.deleteRev) + 1 })
  );
  assert.equal(wrongRev, null);
  assert.equal(modal.calls, callsBefore, '版本不一致不弹确认');
  assert.match(page.data.notice, /这一行已经变化/);

  const staleToken = await page.requestDeleteAttempt(
    rowEvent(row, { pageToken: 'page-stale' })
  );
  assert.equal(staleToken, null);
  assert.equal(modal.calls, callsBefore, '页面令牌不一致不弹确认');

  const missingRev = await page.requestDeleteAttempt(
    rowEvent(row, { deleteRev: undefined })
  );
  assert.equal(missingRev, null);
  assert.equal(modal.calls, callsBefore, '缺少 deleteRev 不弹确认');

  const missingToken = await page.requestDeleteAttempt(
    rowEvent(row, { pageToken: undefined })
  );
  assert.equal(missingToken, null);
  assert.equal(modal.calls, callsBefore, '缺少页面令牌不弹确认');

  // 正确事件（原行/令牌/版本一致）能走完原生回调并只删除这一把。
  const retryRow = rowOf(page, second);
  const { outcome } = await confirmDelete(page, retryRow);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(archiveOf().attempts.some(item => item.id === second.id), false);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
});

test('T048-删除21 最新一把删除时视频索引写失败：门槛同样立即生效，清理完成与冷开后都不补位撤销', async () => {
  const flow = startFlow({ routeName: '索引失败门槛线' });
  const first = addAttempt(flow, 'fail', '一', 0);
  const latest = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, latest);
  const page = openRecord(flow);

  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const { outcome } = await confirmDelete(page, rowOf(page, latest));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.recordDeleted, true);
  assert.equal(outcome.video.status, 'pending');
  assert.equal(indexOf().clips.some(entry => entry.attemptId === latest.id), true);
  assert.equal(virtual.files.has(video.filePath), true);

  // 索引没清掉也不影响撤销门槛：pending 条目 + 档案已移出 → 前一把只补位。
  assert.equal(page.data.attemptCards[0].id, first.id);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    latest.seq
  );
  const reopenedWhilePending = openRecord(flow);
  assert.equal(reopenedWhilePending.data.attemptCards[0].showWithdraw, false);

  // 清掉故障后重试成功：墓碑接替 pending，补位前一把仍然没有撤销。
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  const retried = await page.retryVideoCleanup();
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(indexOf().clips.some(entry => entry.attemptId === latest.id), false);
  assert.equal(virtual.files.has(video.filePath), false);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);

  const reopenedAfter = openRecord(flow);
  assert.equal(reopenedAfter.data.attemptCards[0].id, first.id);
  assert.equal(reopenedAfter.data.attemptCards[0].showWithdraw, false);

  // 新记一把后重新开放。
  reopenedAfter.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(reopenedAfter.data.attemptCards[0].showWithdraw, true);
  assert.equal(
    archiveOf().attempts.find(item => item.id === reopenedAfter.data.attemptCards[0].id).seq >
      latest.seq,
    true
  );
});

// ------------------------------------------------------------------ *
// 追加返工：删除后的迟到旧保存 opId 不得把记录写回来
// ------------------------------------------------------------------ *

function lateSave(flow, attempt, overrides) {
  return store.saveAttempt(
    Object.assign(
      {
        opId: attempt.id,
        archiveId: flow.archiveId,
        sessionId: flow.session.id,
        routeId: flow.route.id,
        result: attempt.result,
        note: attempt.note
      },
      overrides || {}
    )
  );
}

function reloadStoreModule() {
  delete require.cache[require.resolve(STORE_JS)];
  return require(STORE_JS);
}

// 唯一的删除占用判断入口（严格读）：pending / 墓碑都算占用。
function retiredState(archiveId, attemptId) {
  const guard = attemptDelete.attemptDeletionGuard(archiveId);
  assert.equal(guard.ok, true, guard.error);
  return guard.stateOf(attemptId);
}

test('T048-删除22 删除完成后的迟到保存：同 opId 换内容/换归属都不复活，零写入且无幻影待保存', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, first);

  const deleted = await attemptDelete.deleteAttempt(deleteInput(flow, first, video));
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(deleted.recordDeleted, true);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0, '清理完成留下墓碑');
  assert.equal(retiredState(flow.archiveId, first.id), 'deleted');

  const before = archiveRaw();
  const indexBefore = indexRaw();
  const idsBefore = archiveOf().attempts.map(item => item.id);
  const replays = [
    lateSave(flow, first),
    lateSave(flow, first, { result: 'send', note: '完全不同的内容' }),
    lateSave(flow, first, { sessionId: 'other-session', routeId: 'other-route' }),
    lateSave(flow, first, { archiveId: '' })
  ];
  replays.forEach(outcome => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.code, 'attempt-deleted');
    assert.equal(outcome.deleted, true);
    assert.match(outcome.error, /已经删除/);
  });
  assert.equal(archiveRaw(), before, '迟到保存一个字都没写');
  assert.equal(indexRaw(), indexBefore);
  assert.deepEqual(archiveOf().attempts.map(item => item.id), idsBefore);
  assert.equal(archiveOf().pendingSaves.length, 0, '没有幻影待保存');
  assert.equal(archiveOf().attempts.find(item => item.id === second.id).note, '二');

  // 独立的新 opId 仍是正常的新一把：只新增它，不复活已删记录。
  const independent = store.saveAttempt({
    opId: 'op-independent-late-save',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'fail',
    note: '独立的新一把'
  });
  assert.equal(independent.ok, true, independent.error);
  assert.equal(independent.attempt.id, 'op-independent-late-save');
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), false);
  assert.equal(archiveOf().attempts.some(item => item.id === independent.attempt.id), true);
});

test('T048-删除23 删除处于 prepared 或记录已移出但仍待清理：同一 opId 一律不能写回', async () => {
  // A. 档案写成功但首次读回失败：记录其实已移出，journal 仍是 prepared。
  const flowA = startFlow({ routeName: '读回失败迟到保存线' });
  const a1 = addAttempt(flowA, 'fail', '一', 0);
  const a2 = addAttempt(flowA, 'fail', '二', 5);
  faults.archiveSetCount = 0;
  faults.archiveLoseAt = 1;
  faults.archiveReadFailAfterWrite = 3;
  const unverified = await attemptDelete.deleteAttempt(deleteInput(flowA, a2));
  assert.equal(unverified.ok, false);
  assert.equal(unverified.code, 'archive-unverified');
  faults.pendingReadFails = 0;
  faults.archiveLoseAt = 0;
  assert.equal(archiveOf().attempts.some(item => item.id === a2.id), false);
  const beforeA = archiveRaw();
  const replayA = lateSave(flowA, a2);
  assert.equal(replayA.ok, false);
  assert.equal(replayA.code, 'attempt-deleting');
  assert.equal(replayA.pendingDeletion, true);
  assert.equal(archiveRaw(), beforeA, 'prepared 阶段也不写回');
  assert.equal(pendingJournal().pending.length, 1);

  // 重开核对后写成墓碑，迟到保存仍被拒绝。
  const recoveredA = await attemptDelete.recoverPending({ archiveId: flowA.archiveId });
  assert.equal(recoveredA.ok, true, JSON.stringify(recoveredA));
  assert.equal(pendingJournal().pending.length, 0);
  const afterRecoverA = archiveRaw();
  const stillGoneA = lateSave(flowA, a2);
  assert.equal(stillGoneA.ok, false);
  assert.equal(stillGoneA.code, 'attempt-deleted');
  assert.equal(archiveRaw(), afterRecoverA);

  // B. 记录已移出、视频索引清理失败：journal 是 removed + 待清理。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowB = startFlow({ routeName: '索引失败迟到保存线' });
  const b1 = addAttempt(flowB, 'fail', '一', 0);
  const b2 = addAttempt(flowB, 'fail', '二', 5);
  const bVideo = seedClip(flowB, b2);
  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const pendingDelete = await attemptDelete.deleteAttempt(deleteInput(flowB, b2, bVideo));
  assert.equal(pendingDelete.ok, true, pendingDelete.error);
  assert.equal(pendingDelete.video.status, 'pending');
  const beforeB = archiveRaw();
  const replayB = lateSave(flowB, b2);
  assert.equal(replayB.ok, false);
  assert.equal(replayB.code, 'attempt-deleting');
  assert.equal(replayB.pendingDeletion, true);
  assert.equal(archiveRaw(), beforeB, '视频待清理阶段也不写回');
  assert.equal(virtual.files.has(bVideo.filePath), true);
  assert.equal(archiveOf().pendingSaves.length, 0);

  // 清理完成后墓碑仍在，仍拒绝。
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  const retried = await attemptDelete.deleteAttempt(deleteInput(flowB, b2, bVideo));
  assert.equal(retried.ok, true, retried.error);
  assert.equal(attemptDelete.pendingStatus(flowB.archiveId).pending, 0);
  const afterCleanupB = archiveRaw();
  const stillGoneB = lateSave(flowB, b2);
  assert.equal(stillGoneB.ok, false);
  assert.equal(stillGoneB.code, 'attempt-deleted');
  assert.equal(archiveRaw(), afterCleanupB);

  // D. 记录已移出、只有本机副本文件删除失败：removed + 待清理阶段同样不能写回。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowD = startFlow({ routeName: '文件失败迟到保存线' });
  const d1 = addAttempt(flowD, 'fail', '一', 0);
  const d2 = addAttempt(flowD, 'fail', '二', 5);
  const dVideo = seedClip(flowD, d2);
  faults.unlinkFail = true;
  const filePending = await attemptDelete.deleteAttempt(deleteInput(flowD, d2, dVideo));
  assert.equal(filePending.ok, true, filePending.error);
  assert.equal(filePending.video.status, 'pending');
  const beforeD = archiveRaw();
  const replayD = lateSave(flowD, d2);
  assert.equal(replayD.ok, false);
  assert.equal(replayD.code, 'attempt-deleting');
  assert.equal(archiveRaw(), beforeD, '文件待清理阶段不写回');
  assert.equal(virtual.files.has(dVideo.filePath), true);

  faults.unlinkFail = false;
  const cleanedD = await attemptDelete.deleteAttempt(deleteInput(flowD, d2, dVideo));
  assert.equal(cleanedD.ok, true, cleanedD.error);
  assert.equal(attemptDelete.pendingStatus(flowD.archiveId).pending, 0);
  const afterCleanupD = archiveRaw();
  const stillGoneD = lateSave(flowD, d2);
  assert.equal(stillGoneD.ok, false);
  assert.equal(stillGoneD.code, 'attempt-deleted');
  assert.equal(archiveRaw(), afterCleanupD);

  // C. 删除意图仍是 pending/prepared（档案写前并发窗口）：同一 opId 也不能写回；
  //    意图撤回后恢复正常的既存重复保存。
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  const flowC = startFlow({ routeName: '意图撤回线' });
  const c1 = addAttempt(flowC, 'fail', '一', 0);
  storage.set(
    DELETE_KEY,
    JSON.stringify({
      version: 1,
      pending: [
        {
          attemptId: c1.id,
          archiveId: flowC.archiveId,
          sessionId: flowC.session.id,
          routeId: flowC.route.id,
          seq: c1.seq,
          clip: null,
          state: 'prepared',
          createdAt: '2026-11-18T01:00:00.000Z',
          updatedAt: '2026-11-18T01:00:00.000Z',
          lastError: ''
        }
      ],
      deleted: [],
      barriers: {}
    })
  );
  const beforeC = archiveRaw();
  const pendingReplayC = lateSave(flowC, c1);
  assert.equal(pendingReplayC.ok, false);
  assert.equal(pendingReplayC.code, 'attempt-deleting');
  assert.equal(pendingReplayC.pendingDeletion, true);
  assert.equal(archiveRaw(), beforeC);

  storage.set(DELETE_KEY, JSON.stringify({ version: 1, pending: [], deleted: [], barriers: {} }));
  const withdrawnC = lateSave(flowC, c1);
  assert.equal(withdrawnC.ok, true);
  assert.equal(withdrawnC.duplicate, true);
  assert.equal(withdrawnC.attempt.id, c1.id);
  assert.equal(archiveRaw(), beforeC, '撤回删除意图后只复用原记录、不写盘');
});

test('T048-删除24 无显式 ID 的生成器避开已删除 ID；同一字符串可用于另一份档案，显式旧档仍拒绝', async () => {
  const realNow = Date.now;
  const realRandom = Math.random;
  try {
    Date.now = () => new Date(2026, 10, 18, 10, 0, 0).getTime();
    Math.random = () => 0.625;

    const flow = startFlow({ routeName: '生成器避让线' });
    // 第一把也用刚重载的实例生成：opId 计数器从 0 起步，后面「重开」才能用同样的
    // 时钟与熵复现同一个候选 ID，真正逼出「生成器撞上已删除 ID」。
    const firstStore = reloadStoreModule();
    const firstSaved = firstStore.saveAttempt({
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '一'
    });
    assert.equal(firstSaved.ok, true, firstSaved.error);
    const first = firstSaved.attempt;
    assert.equal(retiredState(flow.archiveId, first.id), '');

    // journal 走正式的收尾路径：没有视频时直接落墓碑。
    const deleted = await attemptDelete.deleteAttempt(deleteInput(flow, first));
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(retiredState(flow.archiveId, first.id), 'deleted');

    // 「重开」：本层 opId 计数器归零，固定时钟与熵会再次给出 first.id。
    const freshStore = reloadStoreModule();
    const created = freshStore.saveAttempt({
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '重开后的新一把'
    });
    assert.equal(created.ok, true, created.error);
    assert.notEqual(created.attempt.id, first.id, '生成器不能复用已删除的 ID');
    assert.equal(retiredState(flow.archiveId, created.attempt.id), '');
    assert.equal(
      archiveOf().attempts.filter(item => item.id === created.attempt.id).length,
      1
    );

    // 换档后同一字符串是另一份档案的 ID：允许保存。
    const switched = archiveOf();
    const originalArchiveId = switched.archiveId;
    switched.archiveId = 'archive-late-save-second';
    storage.set(ARCHIVE_KEY, JSON.stringify(switched));
    const cross = store.saveAttempt({
      opId: first.id,
      archiveId: switched.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '另一份档案的同名操作'
    });
    assert.equal(cross.ok, true, cross.error);
    assert.equal(cross.attempt.id, first.id);
    assert.equal(
      archiveOf().attempts.filter(item => item.id === first.id).length,
      1
    );

    // 显式带旧档案 ID 的迟到保存仍整条拒绝，不能写进新档案。
    const beforeOld = archiveRaw();
    const oldArchive = store.saveAttempt({
      opId: 'op-from-old-archive',
      archiveId: originalArchiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '旧档迟到保存'
    });
    assert.equal(oldArchive.ok, false);
    assert.equal(oldArchive.code, 'archive-mismatch');
    assert.equal(archiveRaw(), beforeOld);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    delete require.cache[require.resolve(STORE_JS)];
    require(STORE_JS);
  }
});

test('T048-删除25 未知 journal 或档案读取失败都不当作未删除：零写入、可重试，恢复后新 ID 正常保存', () => {
  const flow = startFlow({ routeName: '读取失败迟到保存线' });
  const first = addAttempt(flow, 'fail', '一', 0);

  // 档案读取失败：先于任何写与删除凭据判断。
  const beforeArchiveReadFail = archiveRaw();
  faults.pendingReadFails = 1;
  const archiveReadFail = lateSave(flow, first);
  assert.equal(archiveReadFail.ok, false);
  assert.equal(archiveRaw(), beforeArchiveReadFail, '档案读失败不写盘');
  assert.equal(archiveOf().pendingSaves.length, 0);

  // journal 读取失败：不能把它当成「没有删除证据」。
  faults.readFailKey = DELETE_KEY;
  faults.readFailRemaining = 1;
  const beforeJournalReadFail = archiveRaw();
  const journalReadFail = lateSave(flow, first);
  assert.equal(journalReadFail.ok, false);
  assert.equal(journalReadFail.code, 'delete-unreadable');
  assert.match(journalReadFail.error, /读取本机删除凭据失败/);
  assert.equal(archiveRaw(), beforeJournalReadFail, 'journal 读失败不写盘');
  assert.equal(archiveOf().pendingSaves.length, 0);

  // 损坏的 journal 同样不能当作未删除。
  storage.set(DELETE_KEY, '{broken-json');
  const beforeBroken = archiveRaw();
  const broken = lateSave(flow, first);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'delete-unreadable');
  assert.equal(archiveRaw(), beforeBroken, 'journal 损坏不写盘');

  // 读恢复后：既存重复保存与不带 opId 的新一把都恢复正常。
  storage.delete(DELETE_KEY);
  const recoveredDuplicate = lateSave(flow, first);
  assert.equal(recoveredDuplicate.ok, true);
  assert.equal(recoveredDuplicate.duplicate, true);
  assert.equal(archiveRaw(), beforeBroken, '恢复后重复保存仍不写盘');

  const fresh = store.saveAttempt({
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'fail',
    note: '读恢复后的新一把'
  });
  assert.equal(fresh.ok, true, fresh.error);
  assert.notEqual(fresh.attempt.id, first.id);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
  assert.equal(archiveOf().attempts.some(item => item.id === fresh.attempt.id), true);
});

test('T048-删除26 完成删除超过 200 把后冷开仍挡最早 ID：墓碑不按条截断', () => {
  const flow = startFlow({ routeName: '长期墓碑线' });
  const total = 205;
  const removed = [];
  for (let index = 0; index < total; index += 1) {
    removed.push(addAttempt(flow, 'fail', '第' + (index + 1) + '把', index));
  }
  const run = async () => {
    for (const attempt of removed) {
      const outcome = await attemptDelete.deleteAttempt(deleteInput(flow, attempt));
      assert.equal(outcome.ok, true, outcome.error);
    }
    assert.equal(archiveOf().attempts.length, 0);

    const journal = pendingJournal();
    assert.equal(journal.pending.length, 0);
    assert.equal(journal.deleted.length, total, '墓碑不再按 200 条截断');
    assert.equal(journal.deleted[0].attemptId, removed[0].id);

    // 冷开：重建服务与队列，只按盘上 journal 核对。
    attemptDelete.resetRuntime();
    const before = archiveRaw();
    const earliest = store.saveAttempt({
      opId: removed[0].id,
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '最早被删那把的迟到保存'
    });
    assert.equal(earliest.ok, false);
    assert.equal(earliest.blocked, true);
    assert.equal(earliest.code, 'attempt-deleted');
    assert.equal(archiveRaw(), before, '冷开后仍一个字都不写');
    assert.equal(archiveOf().attempts.length, 0);

    // 原本会落在旧 200 条窗口之外的一把同样仍被挡住。
    const beyondWindow = store.saveAttempt({
      opId: removed[4].id,
      archiveId: flow.archiveId,
      sessionId: flow.session.id,
      routeId: flow.route.id,
      result: 'fail',
      note: '窗口外那把的迟到保存'
    });
    assert.equal(beyondWindow.ok, false);
    assert.equal(beyondWindow.code, 'attempt-deleted');
  };
  return run();
});

test('T048-删除27 有值但容器或墓碑身份不完整：严格读拒绝保存，零写入且可重试', () => {
  const flow = startFlow({ routeName: '严格删除凭据线' });
  const first = addAttempt(flow, 'fail', '原把', 0);
  const before = archiveRaw();
  const cases = [
    {
      name: 'pending 容器不是数组',
      // 独立 QA LS06 journal-collections
      journal: { version: 1, pending: {}, deleted: [], barriers: {} },
      reason: 'journal-incomplete'
    },
    {
      name: 'deleted 容器不是数组',
      journal: { version: 1, pending: [], deleted: {}, barriers: {} },
      reason: 'journal-incomplete'
    },
    {
      name: 'pending 容器整个缺失',
      journal: { version: 1, deleted: [], barriers: {} },
      reason: 'journal-incomplete'
    },
    {
      name: 'deleted 容器整个缺失',
      journal: { version: 1, pending: [], barriers: {} },
      reason: 'journal-incomplete'
    },
    {
      name: '旧格式墓碑缺少场次/线路/序号',
      // 独立 QA LS10：坏墓碑不能被 normalizeDeleted 丢掉后当成没有删除证据。
      journal: {
        version: 1,
        pending: [],
        deleted: [{ archiveId: flow.archiveId, attemptId: first.id }],
        barriers: {}
      },
      reason: 'journal-incomplete'
    },
    {
      name: 'pending 记录 seq 无效',
      journal: {
        version: 1,
        pending: [
          {
            attemptId: first.id,
            archiveId: flow.archiveId,
            sessionId: flow.session.id,
            routeId: flow.route.id,
            seq: 0,
            clip: null,
            state: 'prepared'
          }
        ],
        deleted: [],
        barriers: {}
      },
      reason: 'journal-incomplete'
    },
    {
      name: 'barriers 容器不是对象',
      journal: { version: 1, pending: [], deleted: [], barriers: [] },
      reason: 'journal-incomplete'
    },
    {
      name: 'barriers 值不是正整数',
      // 门槛归一化会静默丢掉不认识的值并压低撤销门槛，同样不能写回。
      journal: {
        version: 1,
        pending: [],
        deleted: [],
        barriers: { [[flow.archiveId, flow.session.id, flow.route.id].join('/')]: 'oops' }
      },
      reason: 'journal-incomplete'
    },
    {
      name: 'journal 是 JSON null',
      raw: 'null',
      reason: 'journal-unsupported'
    },
    {
      name: 'journal 版本不受支持',
      journal: { version: 999, pending: [], deleted: [], barriers: {} },
      reason: 'journal-unsupported'
    }
  ];

  cases.forEach(item => {
    storage.set(DELETE_KEY, item.raw !== undefined ? item.raw : JSON.stringify(item.journal));
    const guard = attemptDelete.attemptDeletionGuard(flow.archiveId);
    assert.equal(guard.ok, false, item.name);
    assert.equal(guard.code, item.reason, item.name);

    const denied = lateSave(flow, first);
    assert.equal(denied.ok, false, item.name);
    assert.equal(denied.blocked, false, item.name);
    assert.equal(denied.code, 'delete-unreadable', item.name);
    assert.equal(denied.reason, item.reason, item.name);
    assert.match(denied.error, /删除凭据/, item.name);
    assert.match(denied.error, /重试/, item.name);
    assert.equal(archiveRaw(), before, item.name + '：不写档案');
    assert.equal(archiveOf().pendingSaves.length, 0, item.name + '：不生成待保存行');
    assert.equal(archiveOf().attempts.length, 1, item.name);
  });

  // 缺整个键（微信对不存在键的返回）仍是兼容路径：恢复为既存重复保存。
  storage.delete(DELETE_KEY);
  const restored = lateSave(flow, first);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.duplicate, true);
  assert.equal(restored.attempt.id, first.id);
  assert.equal(archiveRaw(), before, '恢复后重复保存仍不写盘');
});

test('T048-删除28 清理/删除写回与保存共用严格读：坏凭据整份保持、原 ID 不复活，完整凭据仍可清理', async () => {
  const flow = startFlow({ routeName: '严格读回写线' });
  const live = addAttempt(flow, 'fail', '在册把', 0);
  const victim = addAttempt(flow, 'fail', '墓碑把', 5);
  const before = archiveRaw();
  const barrierKeyOf = [flow.archiveId, flow.session.id, flow.route.id].join('/');
  const tomb = {
    attemptId: victim.id,
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    seq: victim.seq,
    at: '2026-11-18T01:00:00.000Z'
  };
  // 与档案无关、只差分两步就能清理完的一条合法 pending（clip 为空，不碰文件系统）。
  const cleanablePending = {
    attemptId: 'stale-pending',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    seq: 2,
    clip: null,
    state: 'removed',
    createdAt: '2026-11-18T01:00:00.000Z',
    updatedAt: '2026-11-18T01:00:00.000Z',
    lastError: ''
  };

  // A. 坏墓碑（旧格式缺场次/线路/序号）+ 一条无关的完整待清理：整份凭据一个字节都不重写。
  const cutA = {
    version: 1,
    pending: [cleanablePending],
    deleted: [{ archiveId: flow.archiveId, attemptId: 'malformed-original' }],
    barriers: {}
  };
  const rawA = JSON.stringify(cutA);
  storage.set(DELETE_KEY, rawA);
  const recoveryA = await attemptDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recoveryA.ok, false);
  assert.equal(recoveryA.code, 'journal-incomplete');
  assert.equal(recoveryA.processed, 0);
  assert.equal(storage.get(DELETE_KEY), rawA, '恢复遇坏凭据不重写整份 journal');
  // 坏墓碑保护的原 opId 仍被拒绝；恢复没有顺手把这条坏证据归一化掉。
  const malformed = lateSave(flow, {
    id: 'malformed-original',
    result: 'fail',
    note: '迟到保存'
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'delete-unreadable');
  assert.equal(malformed.reason, 'journal-incomplete');
  assert.equal(archiveRaw(), before, '坏凭据下保存零写入');
  assert.equal(archiveOf().attempts.length, 2);
  // 长按删除同样不凭坏凭据动手，也不重写这份 journal。
  const deniedDelete = await attemptDelete.deleteAttempt(deleteInput(flow, live));
  assert.equal(deniedDelete.ok, false);
  assert.equal(deniedDelete.code, 'journal-read-failed');
  assert.equal(storage.get(DELETE_KEY), rawA, '删除被拒也不重写坏凭据');
  assert.equal(archiveRaw(), before, '删除被拒不动档案');
  // 可见状态与撤销门槛同样保守，不把坏 journal 当成「没有删除证据」。
  const statusA = attemptDelete.pendingStatus(flow.archiveId);
  assert.equal(statusA.pending, 0);
  assert.match(statusA.error, /删除凭据不完整/);
  assert.equal(
    attemptDelete.deletedSeqBarrier(flow.archiveId, flow.session.id, flow.route.id),
    attemptDelete.BARRIER_BLOCKED
  );

  // B. 坏 pending + 另一把的完整墓碑：坏行不能连带把有效墓碑一起抹掉。
  const cutB = {
    version: 1,
    pending: [{ archiveId: flow.archiveId, attemptId: 'malformed-pending' }],
    deleted: [tomb],
    barriers: { [barrierKeyOf]: victim.seq }
  };
  const rawB = JSON.stringify(cutB);
  storage.set(DELETE_KEY, rawB);
  const recoveryB = await attemptDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recoveryB.ok, false);
  assert.equal(recoveryB.code, 'journal-incomplete');
  assert.equal(storage.get(DELETE_KEY), rawB, '坏 pending 也不抹掉同一份凭据里的墓碑');
  const tombReplay = lateSave(flow, victim);
  assert.equal(tombReplay.ok, false);
  assert.equal(tombReplay.code, 'delete-unreadable');
  assert.equal(tombReplay.reason, 'journal-incomplete');
  assert.equal(archiveRaw(), before);
  // 去掉坏 pending、只留墓碑（合法 journal）：同一原 ID 仍按墓碑拒绝，墓碑没有被连带抹掉。
  const tombOnly = { version: 1, pending: [], deleted: [tomb], barriers: { [barrierKeyOf]: victim.seq } };
  storage.set(DELETE_KEY, JSON.stringify(tombOnly));
  const tombOnlyReplay = lateSave(flow, victim);
  assert.equal(tombOnlyReplay.ok, false);
  assert.equal(tombOnlyReplay.code, 'attempt-deleted', '原 ID 不复活');
  assert.equal(archiveRaw(), before);

  // C. 完整凭据仍可清理：同样的 pending 换成合法 journal 后正常收尾落墓碑。
  storage.set(
    DELETE_KEY,
    JSON.stringify({ version: 1, pending: [cleanablePending], deleted: [], barriers: {} })
  );
  const recoveredC = await attemptDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recoveredC.ok, true, recoveredC.error);
  assert.equal(recoveredC.processed, 1);
  assert.equal(recoveredC.pending, 0);
  const afterC = JSON.parse(storage.get(DELETE_KEY));
  assert.deepEqual(afterC.pending, []);
  assert.equal(afterC.deleted.length, 1);
  assert.equal(afterC.deleted[0].attemptId, 'stale-pending');
  assert.equal(afterC.deleted[0].archiveId, flow.archiveId);
  assert.equal(afterC.deleted[0].sessionId, flow.session.id);
  assert.equal(afterC.deleted[0].routeId, flow.route.id);
  assert.equal(afterC.deleted[0].seq, cleanablePending.seq);
  assert.equal(afterC.barriers[barrierKeyOf], cleanablePending.seq);
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 0);
  assert.equal(archiveRaw(), before, '清理只动 journal，不改档案');
});

test('T048-删除29 共享副本删除时索引单次失败：重开恢复按 kept 结清，保留文件与他人引用，迟到保存仍拒绝', async () => {
  const flow = startFlow({ routeName: '共享恢复线' });
  const target = addAttempt(flow, 'fail', '要删的一把', 0);
  const holder = addAttempt(flow, 'fail', '仍引用的一把', 5);
  const shared = seedClip(flow, target, { bytes: 3000 });
  const sharedBytes = Buffer.from(virtual.files.get(shared.filePath));

  // 另一把合法引用同一文件：同一本机副本被两条索引共用。
  const index = indexOf();
  index.clips.push({
    clipId: 'clip-shared-holder',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: holder.id,
    attemptSeq: holder.seq,
    rev: 1,
    bytes: 3000,
    fileId: shared.fileId,
    createdAt: '2026-11-18T01:00:00.000Z'
  });
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));

  // 目标删除时注入一次索引写失败：记录已移出，索引引用与本机副本保留为 pending。
  faults.indexSetCount = 0;
  faults.indexSetFailAt = 1;
  const direct = await attemptDelete.deleteAttempt(deleteInput(flow, target, shared));
  assert.equal(direct.ok, true, direct.error);
  assert.equal(direct.recordDeleted, true);
  assert.equal(direct.video.status, 'pending');
  assert.equal(attemptDelete.pendingStatus(flow.archiveId).pending, 1);
  assert.equal(archiveOf().attempts.some(item => item.id === target.id), false);
  assert.equal(
    indexOf().clips.some(item => item.attemptId === target.id),
    true,
    '索引写失败后目标引用仍在'
  );
  assert.equal(virtual.files.has(shared.filePath), true);
  assert.equal(virtual.calls.unlink.length, 0, '索引失败阶段不动共享副本');

  // 断开模块运行态重新加载：清故障、重建视频服务，并重载删除模块自己的队列/缓存。
  faults.indexSetFailAt = 0;
  faults.indexSetCount = 0;
  videoFiles.resetAttemptVideoServices();
  attemptDelete.resetRuntime();
  delete require.cache[require.resolve(DELETE_UTIL)];
  const reopenedDelete = require(DELETE_UTIL);

  const recovered = await reopenedDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.processed, 1);
  assert.equal(recovered.pending, 0);
  assert.deepEqual(recovered.errors, []);

  // journal 结清：目标只落一次墓碑，pending 清空。
  const journal = pendingJournal();
  assert.deepEqual(journal.pending, []);
  assert.equal(journal.deleted.length, 1);
  assert.equal(journal.deleted[0].attemptId, target.id);
  assert.equal(journal.deleted[0].archiveId, flow.archiveId);
  assert.equal(journal.deleted[0].sessionId, flow.session.id);
  assert.equal(journal.deleted[0].routeId, flow.route.id);
  assert.equal(journal.deleted[0].seq, target.seq);

  // 共享副本原字节不变、只解除目标关联、剩余归属不变，且没有 unlink。
  assert.equal(virtual.files.has(shared.filePath), true);
  assert.deepEqual(Buffer.from(virtual.files.get(shared.filePath)), sharedBytes);
  const afterIndex = indexOf();
  assert.equal(afterIndex.clips.some(item => item.attemptId === target.id), false);
  const remaining = afterIndex.clips.filter(item => item.fileId === shared.fileId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attemptId, holder.id);
  assert.equal(remaining[0].clipId, 'clip-shared-holder');
  assert.equal(remaining[0].rev, 1);
  assert.equal(virtual.calls.unlink.length, 0, '共享副本一次 unlink 都不发');
  assert.equal(reopenedDelete.pendingStatus(flow.archiveId).pending, 0);

  // 再冷开：无 pending 时是 no-op，一次文件系统也不碰。
  videoFiles.resetAttemptVideoServices();
  reopenedDelete.resetRuntime();
  const callsBefore = JSON.stringify(
    Object.keys(virtual.calls).reduce((acc, key) => {
      acc[key] = virtual.calls[key].length;
      return acc;
    }, {})
  );
  const cold = await reopenedDelete.recoverPending({ archiveId: flow.archiveId });
  assert.equal(cold.ok, true);
  assert.equal(cold.skipped, true);
  assert.equal(cold.processed, 0);
  assert.equal(cold.pending, 0);
  const callsAfter = JSON.stringify(
    Object.keys(virtual.calls).reduce((acc, key) => {
      acc[key] = virtual.calls[key].length;
      return acc;
    }, {})
  );
  assert.equal(callsAfter, callsBefore, '无 pending 的冷开不扫描文件系统');

  // 迟到原保存 opId 被拒且零写入；独立新 ID 正常记录。
  const archiveBefore = archiveRaw();
  const indexBefore = indexRaw();
  const replay = lateSave(flow, target);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'attempt-deleted');
  assert.equal(archiveRaw(), archiveBefore, '迟到保存一个字都没写');
  assert.equal(indexRaw(), indexBefore, '迟到保存不动视频索引');
  assert.equal(archiveOf().pendingSaves.length, 0, '没有幻影待保存');
  assert.equal(archiveOf().attempts.some(item => item.id === holder.id), true);

  const fresh = store.saveAttempt({
    opId: 'op-fresh-after-shared-kept',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    result: 'send',
    note: '新记一把'
  });
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.attempt.id, 'op-fresh-after-shared-kept');
  assert.equal(archiveOf().attempts.some(item => item.id === target.id), false);
  assert.equal(archiveOf().attempts.some(item => item.id === fresh.attempt.id), true);
});

// ------------------------------------------------------------------ *
// 手机试用返工：确认框打不开、rev 0 与原身份核对
// ------------------------------------------------------------------ *

test('T048-删除30 确认框 fail/缺失/同步异常都不当取消：不写盘、草稿保留、可见重试提示、解锁后重试只删一次', async () => {
  const flow = startFlow({ routeName: '确认框失败线' });
  const first = addAttempt(flow, 'fail', '一', 0);
  const latest = addAttempt(flow, 'fail', '二', 5);
  const video = seedClip(flow, latest);
  const page = openRecord(flow);
  const row = rowOf(page, latest);

  // 开着备注草稿：确认框没弹出来时不能丢。
  page.openNoteEditor(tapDataset({ attemptId: latest.id }));
  page.onNoteInput({ detail: { value: '还没保存的草稿' } });
  const rawBefore = archiveRaw();
  const indexBefore = indexRaw();

  // (a) showModal 调 fail：当作「确认框没打开」，不是用户取消；给视口内可见的重试提示。
  modal.failNext = 1;
  const failed = await page.requestDeleteAttempt(rowEvent(row));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'modal-unavailable');
  assert.equal(failed.reason, 'failed');
  assert.match(failed.error, /mock dialog failure/, '只带非敏感错误码');
  assert.match(page.data.notice, /确认框没有打开/);
  assert.match(toasts[toasts.length - 1], /未删除/);
  assert.equal(archiveRaw(), rawBefore, '弹窗失败不写档案');
  assert.equal(indexRaw(), indexBefore, '弹窗失败不写视频索引');
  assert.equal(virtual.files.has(video.filePath), true, '弹窗失败不删视频副本');
  assert.equal(page.data.noteEditor.text, '还没保存的草稿', '弹窗失败不清草稿');
  assert.equal(page._deletePrompt, null, '失败后解除在途锁');

  // (b) 当前环境没有 showModal：同样不当作取消，不写盘。
  const realShowModal = global.wx.showModal;
  delete global.wx.showModal;
  let missing;
  try {
    missing = await page.requestDeleteAttempt(rowEvent(rowOf(page, latest)));
  } finally {
    global.wx.showModal = realShowModal;
  }
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'modal-unavailable');
  assert.equal(missing.reason, 'unavailable');
  assert.match(page.data.notice, /确认框没有打开/);
  assert.equal(archiveRaw(), rawBefore);
  assert.equal(indexRaw(), indexBefore);
  assert.equal(virtual.files.has(video.filePath), true);

  // (c) showModal 同步抛异常：解除在途锁，仍不写盘、不动草稿。
  modal.throwNext = 1;
  const thrown = await page.requestDeleteAttempt(rowEvent(rowOf(page, latest)));
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'modal-unavailable');
  assert.match(thrown.error, /mock synchronous failure/);
  assert.equal(archiveRaw(), rawBefore);
  assert.equal(virtual.files.has(video.filePath), true);
  assert.equal(page.data.noteEditor.text, '还没保存的草稿');
  assert.equal(page._deletePrompt, null);

  // (d) 解锁后再次长按能真正删除：只删这一把，视频副本随之清理，其他把次不动。
  const callsBefore = modal.calls;
  const { outcome } = await confirmDelete(page, rowOf(page, latest));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.video.status, 'done');
  assert.equal(modal.calls, callsBefore + 1);
  assert.equal(archiveOf().attempts.some(item => item.id === latest.id), false);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
  assert.equal(virtual.files.has(video.filePath), false);
});

test('T048-删除31 原身份六项必须齐备且一致：rev 0（数字或字符串）有效，缺失/错位一律不弹确认', async () => {
  const flow = startFlow({ routeName: '身份核对线' });
  const first = addAttempt(flow, 'fail', '一', 0);
  const latest = addAttempt(flow, 'fail', '二', 5);
  const other = addOtherRouteAttempt(flow);
  const page = openRecord(flow);

  // 前置：新把次的 rev 就是 0——这个值不能被当成「缺失」。
  assert.equal(rowOf(page, latest).deleteRev, 0, '新把次的 rev 为 0');

  const callsBefore = modal.calls;
  const rejects = [
    { label: '换档案', overrides: { archiveId: 'archive-other' } },
    { label: '换场次', overrides: { sessionId: 'session-other' } },
    { label: '换线路', overrides: { routeId: other.route.id } },
    { label: '缺档案', overrides: { archiveId: undefined } },
    { label: '缺场次', overrides: { sessionId: undefined } },
    { label: '缺线路', overrides: { routeId: undefined } },
    { label: '缺把次', overrides: { attemptId: undefined } },
    { label: '缺 rev', overrides: { deleteRev: undefined } },
    { label: '空 rev', overrides: { deleteRev: '' } },
    { label: '负 rev', overrides: { deleteRev: -1 } },
    { label: '缺令牌', overrides: { pageToken: undefined } },
    { label: '错令牌', overrides: { pageToken: 'page-stale' } }
  ];
  for (const item of rejects) {
    const result = await page.requestDeleteAttempt(
      rowEvent(rowOf(page, first), item.overrides)
    );
    assert.equal(result, null, item.label + ' 应直接拒绝');
    assert.match(page.data.notice, /这一行已经变化/, item.label + ' 要说明原因');
  }
  assert.equal(modal.calls, callsBefore, '身份缺失/错位一次都不弹确认');
  assert.match(toasts[toasts.length - 1], /未删除/, '拒绝时视口内有 toast');
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), true);
  assert.equal(archiveOf().attempts.some(item => item.id === latest.id), true);

  // rev 0 的数字写法有效：照常确认并只删这一把。
  const zeroNumber = await confirmDelete(page, rowOf(page, first), { deleteRev: 0 });
  assert.equal(zeroNumber.outcome.ok, true, zeroNumber.outcome.error);
  assert.equal(archiveOf().attempts.some(item => item.id === first.id), false);
  assert.equal(archiveOf().attempts.some(item => item.id === latest.id), true);

  // rev 0 的字符串写法同样有效（部分基础库把 dataset 值编码成字符串）。
  const zeroText = await confirmDelete(page, rowOf(page, latest), { deleteRev: '0' });
  assert.equal(zeroText.outcome.ok, true, zeroText.outcome.error);
  assert.equal(archiveOf().attempts.some(item => item.id === latest.id), false);
});

// ------------------------------------------------------------------ *
// T025：删除把次时关联时间点随片段条目自然移除
// ------------------------------------------------------------------ */

test('T025-D1 共享副本删除：被删把次的时间点移除，另一条目的时间点与文件保留；最后引用删除时一并清理', async () => {
  const flow = startFlow();
  const first = addAttempt(flow, 'fail', '一', 0);
  const second = addAttempt(flow, 'fail', '二', 5);
  const shared = seedClip(flow, first, { bytes: 3000, clipId: 'clip-marker-shared' });
  const index = indexOf();
  // 共享副本的另一个条目必须与文件标识是同一个片段（clipId 与文件名一致）。
  index.clips.push({
    clipId: 'clip-marker-shared',
    archiveId: flow.archiveId,
    sessionId: flow.session.id,
    routeId: flow.route.id,
    attemptId: second.id,
    rev: 1,
    bytes: 3000,
    fileId: shared.fileId,
    markers: [
      { id: 'mark-holder', atMs: 1234, clipId: 'clip-marker-shared', rev: 1 }
    ]
  });
  index.clips[0].markers = [
    { id: 'mark-first', atMs: 0, clipId: 'clip-marker-shared', rev: 1 }
  ];
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));

  const page = openRecord(flow);
  const { outcome } = await confirmDelete(page, rowOf(page, first));
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.video.status, 'kept');
  assert.equal(outcome.video.reason, 'shared');
  assert.equal(
    indexOf().clips.some(entry => entry.attemptId === first.id),
    false,
    '被删把次的条目与时间点一起移除'
  );
  const holder = indexOf().clips.find(entry => entry.attemptId === second.id);
  assert.ok(holder, '共享文件仍被另一条目引用');
  assert.deepEqual(
    holder.markers.map(item => item.id),
    ['mark-holder'],
    '只保留仍存在条目的时间点'
  );
  assert.equal(virtual.files.has(shared.filePath), true, '共享副本按设计保留');
  assert.equal(page.data.notice.includes('其他记录'), true);

  // 第二个条目是最后一个引用：删除后文件与 markers 一并清理。
  const { outcome: last } = await confirmDelete(page, rowOf(page, second));
  assert.equal(last.ok, true, last.error);
  assert.equal(last.video.status, 'done');
  assert.equal(indexOf().clips.length, 0, '最后一个条目与时间点一起移除');
  assert.equal(virtual.files.has(shared.filePath), false, '最后一个引用删除后回收副本');
});
