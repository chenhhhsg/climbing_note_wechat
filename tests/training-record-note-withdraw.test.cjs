/**
 * T048–T050 现场返工与 T056 R1 逐把备注草稿：单线记录页的「备注」入口与直接「撤销」
 *
 * 只覆盖本需求（tests/ 下的其它文件保持各自的原断言），直接加载真实的
 * pages/training-record 与 utils/training-store.js，用隔离的本机存储替身与可注入故障
 * 核对：
 * - 最新一把与展开的旧把统一一个「备注」入口：打开原把、带出原文、取消不写、保存只改
 *   这一把；视频入口仍按各自的原把关联给「＋ 添加视频／回看视频」；
 * - 撤销最近一把：原把离开现场有效列表、前一把只补位、提示「已撤销第 N 把」；原 ID、
 *   内部序号、备注与视频归属都不转移，新记一把另取 ID、显示编号连续；
 * - 撤销唯一有效完攀后抱石限制解除，可以重新记「未完成／完攀」；两种结果都按第 2 把接上；
 * - 撤销失败（第一段写就未写、第二段写成但回执丢失）都按已落盘状态显示，成功只扣一次；
 *   同一坐标的第二次点按不会撤到前一把，也不会触发一次新的记把；
 * - 撤销后重开与 onShow 仍按已保存的有效把次展示，前一把不再给撤销入口；同线另一场、
 *   同场另一条线各用各的原把与计数。
 *
 * 真机触控与微信模拟器视口另在整项 QA 登记（待验）。
 *
 * 运行：node --test tests/training-record-note-withdraw.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const ATTEMPTS_JS = path.join(
  ROOT,
  'pages',
  'training-attempts',
  'training-attempts.js'
);

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入故障 ----
const storage = new Map();
const fault = { setFailAt: 0, setCount: 0, loseResponseAt: 0 };
const nav = [];

function resetDevice() {
  storage.clear();
  nav.length = 0;
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
}

/** 第 N 次写盘失败：数据没有落盘（写前失败）。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

/** 第 N 次写盘已生效但回执丢失：键里已是新数据，调用方只看到失败。 */
function armSetLoseResponseAt(callNumber) {
  fault.setCount = 0;
  fault.loseResponseAt = callNumber;
}

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    storage.set(key, value);
    if (fault.loseResponseAt && fault.setCount === fault.loseResponseAt) {
      throw new Error('setStorageSync:fail after durable write injected at call ' + fault.setCount);
    }
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo(options) {
    nav.push(options);
  },
  navigateBack() {},
  showToast() {},
  showModal() {}
};

const store = require(STORE_JS);

let definition = null;
global.Page = def => {
  definition = def;
};
require(RECORD_JS);
assert.ok(definition, 'training-record 应注册 Page 定义');
const recordDefinition = definition;
definition = null;
require(ATTEMPTS_JS);
assert.ok(definition, 'training-attempts 应注册 Page 定义');
const attemptsDefinition = definition;

function createPage(baseDefinition) {
  const base = baseDefinition || recordDefinition;
  const page = Object.create(base);
  page.data = JSON.parse(JSON.stringify(base.data));
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

function archiveOf() {
  const raw = storage.get(ARCHIVE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function rawArchive() {
  return storage.get(ARCHIVE_KEY) || '';
}

function openRecord(sessionId, routeId) {
  const archive = archiveOf();
  const page = createPage();
  page.onLoad({ archiveId: archive.archiveId, sessionId, routeId });
  assert.equal(page.data.contextError, '', '单线页应能按原归属打开');
  return page;
}

/** 本场逐把页（T056 两页共用同一份备注事件处理）。 */
function openAttempts(sessionId, routeId) {
  const archive = archiveOf();
  const page = createPage(attemptsDefinition);
  page.onLoad({ archiveId: archive.archiveId, sessionId, routeId });
  assert.equal(page.data.contextError, '', '本场逐把页应能按原归属打开');
  return page;
}

/** 当前编辑器输入事件：与 WXML 的输入框一样带原 attemptId 与本次编辑代次。 */
function noteInput(page, value) {
  return {
    detail: { value },
    currentTarget: {
      dataset: {
        attemptId: page.data.noteEditor.attemptId,
        editVersion: page.data.noteEditor.version
      }
    }
  };
}

/** 保存/取消按钮的 dataset（WXML 绑定打开时那一把与那一代次）。 */
function noteButtonEvent(editor) {
  return tapDataset({ attemptId: editor.attemptId, editVersion: editor.version });
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

/** 这一行渲染时带下来的撤销参数（与 WXML 上的 dataset 一一对应）。 */
function withdrawEvent(row) {
  return tapDataset({
    attemptId: row.id,
    archiveId: row.archiveId,
    sessionId: row.sessionId,
    routeId: row.routeId,
    expected: row.expected,
    expectedRev: row.expectedRev
  });
}

/** 带真实触点的撤销事件：detail 是微信 tap 的页面坐标，timeStamp 模拟同一时钟。 */
function withdrawAt(row, point, timeStamp) {
  const dataset = withdrawEvent(row).currentTarget.dataset;
  return { currentTarget: { dataset }, target: { dataset }, detail: point, timeStamp };
}

/** 带真实触点的结果按钮事件：dataset 与 WXML 上「未完成 / 完攀」一致。 */
function recordAt(page, result, point, timeStamp) {
  const dataset = {
    result,
    archiveId: page.data.archiveId,
    sessionId: page.data.activeSession.id,
    routeId: page.data.selectedRoute.id
  };
  return { currentTarget: { dataset }, target: { dataset }, detail: point, timeStamp };
}

function saveAttempts(sessionId, routeId, results, notes) {
  return results.map((result, index) => {
    const saved = store.saveAttempt({
      sessionId,
      routeId,
      result,
      note: notes && notes[index] ? notes[index] : '',
      now: new Date(2026, 10, 18, 9, 5 + index * 5)
    });
    assert.equal(saved.ok, true, saved.error);
    return saved.attempt;
  });
}

function writeVideoClips(items) {
  const archiveId = archiveOf().archiveId;
  storage.set(
    VIDEO_INDEX_KEY,
    JSON.stringify({
      version: 1,
      clips: items.map(item => ({
        clipId: item.clipId,
        archiveId,
        sessionId: item.sessionId,
        routeId: item.routeId,
        attemptId: item.attemptId,
        rev: 1,
        bytes: 1024,
        fileId: 'attempt-video/v1/' + archiveId + '/' + item.clipId + '.mp4'
      }))
    })
  );
}

function startSession(gymName, date) {
  const started = store.startSession({
    gymName,
    date,
    now: new Date(2026, 10, 18, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function createRoute(sessionId, name, climbType) {
  const created = store.createRoute({
    sessionId,
    name,
    climbType: climbType || '顶绳',
    grade: climbType === '抱石' ? 'V3' : '5.10a',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function lastVideoParams() {
  const options = nav[nav.length - 1];
  assert.ok(options, '应有一次页面跳转');
  const url = new URL(options.url, 'https://example.invalid');
  assert.equal(url.pathname, '/pages/attempt-video/attempt-video');
  return {
    archiveId: url.searchParams.get('archiveId'),
    sessionId: url.searchParams.get('sessionId'),
    routeId: url.searchParams.get('routeId'),
    attemptId: url.searchParams.get('attemptId')
  };
}

beforeEach(() => {
  resetDevice();
});

// ------------------------------------------------------------------ *
// 备注入口：最新与旧把同一个「备注」，只改原把
// ------------------------------------------------------------------ *

test('T048/T050 返工 备注：最新与旧把都写「备注」，打开原把带出原文，保存只改这一把', () => {
  const session = startSession('岩馆 备注');
  const route = createRoute(session.id, '备注顶绳线', '顶绳');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'fail'],
    ['第一把原文：先挂左脚', '']
  );
  writeVideoClips([
    {
      clipId: 'clip-note-first',
      sessionId: session.id,
      routeId: route.id,
      attemptId: attempts[0].id
    }
  ]);
  const videoIndexRaw = storage.get(VIDEO_INDEX_KEY);

  const page = openRecord(session.id, route.id);
  const first = page.data.attemptCards.find(row => row.id === attempts[0].id);
  const second = page.data.attemptCards.find(row => row.id === attempts[1].id);
  assert.equal(page.data.attemptCards[0].id, attempts[1].id, '最新一把在前');
  assert.equal(first.noteActionText, '备注', '旧把入口就是「备注」');
  assert.equal(second.noteActionText, '备注', '最新一把入口也是「备注」');
  assert.equal(first.videoEntryText, '回看视频', '旧把自己的片');
  assert.equal(second.videoEntryText, '＋ 添加视频', '最新一把没有借用旧把的视频');

  // 打开旧把备注：带出原文，编辑抬头是这一把。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.attemptId, attempts[0].id);
  assert.equal(page.data.noteEditor.text, '第一把原文：先挂左脚', '有备注就带出原文');
  assert.equal(page.data.noteEditor.attemptLabel, '第 1 把');

  // 取消：一个字节都不写。
  const rawBeforeCancel = rawArchive();
  page.onNoteInput({ detail: { value: '取消掉的草稿' } });
  page.cancelNote(
    tapDataset({
      attemptId: page.data.noteEditor.attemptId,
      editVersion: page.data.noteEditor.version
    })
  );
  assert.equal(page.data.noteEditor, null);
  assert.equal(rawArchive(), rawBeforeCancel, '取消不写盘');

  // 保存：只改打开时的那一把。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  page.onNoteInput({ detail: { value: '第一把改过的备注' } });
  page.saveNote(
    tapDataset({
      attemptId: page.data.noteEditor.attemptId,
      editVersion: page.data.noteEditor.version
    })
  );
  assert.equal(page.data.noteEditor, null);
  const savedArchive = archiveOf();
  assert.equal(
    savedArchive.attempts.find(item => item.id === attempts[0].id).note,
    '第一把改过的备注'
  );
  assert.equal(
    savedArchive.attempts.find(item => item.id === attempts[1].id).note,
    '',
    '没点的那一把备注不变'
  );
  assert.equal(storage.get(VIDEO_INDEX_KEY), videoIndexRaw, '改备注不动视频索引');

  // 视频入口仍按各自的原把带四个 ID。
  nav.length = 0;
  page.openAttemptVideo(
    tapDataset({
      attemptId: attempts[1].id,
      archiveId: savedArchive.archiveId,
      sessionId: session.id,
      routeId: route.id
    })
  );
  assert.deepEqual(lastVideoParams(), {
    archiveId: savedArchive.archiveId,
    sessionId: session.id,
    routeId: route.id,
    attemptId: attempts[1].id
  });
  nav.length = 0;
  page.openAttemptVideo(
    tapDataset({
      attemptId: attempts[0].id,
      archiveId: savedArchive.archiveId,
      sessionId: session.id,
      routeId: route.id
    })
  );
  assert.deepEqual(lastVideoParams(), {
    archiveId: savedArchive.archiveId,
    sessionId: session.id,
    routeId: route.id,
    attemptId: attempts[0].id
  });
});

// ------------------------------------------------------------------ *
// 两种结果重记：编号连续、唯一完攀解锁、原把身份与媒体不转移
// ------------------------------------------------------------------ *

test('T050 返工 撤销后重记未完成与完攀：界面显示第 2 把，唯一完攀解锁，原把与媒体不转移', () => {
  const session = startSession('岩馆 重记');
  const route = createRoute(session.id, '重记抱石线', '抱石');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'send'],
    ['第一把备注', '第二把完攀']
  );
  writeVideoClips([
    {
      clipId: 'clip-rework-first',
      sessionId: session.id,
      routeId: route.id,
      attemptId: attempts[0].id
    },
    {
      clipId: 'clip-rework-second',
      sessionId: session.id,
      routeId: route.id,
      attemptId: attempts[1].id
    }
  ]);
  const videoIndexRaw = storage.get(VIDEO_INDEX_KEY);

  const page = openRecord(session.id, route.id);
  assert.equal(page.data.routeCompleted, true, '抱石已有唯一完攀');
  const secondRow = page.data.attemptCards[0];
  assert.equal(secondRow.id, attempts[1].id);
  assert.equal(secondRow.showWithdraw, true, '最近一把给「撤销」');

  // 撤销唯一完攀：解除抱石限制，这一把离开现场列表，总数减一。
  page.undoLatestAttempt(withdrawEvent(secondRow));
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.equal(page.data.routeCompleted, false, '撤销唯一完攀后现场重新开放记把');
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.routeCountText, '1 把');
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [attempts[0].id]);
  assert.equal(page.data.attemptCards[0].showWithdraw, false, '前一把只补位，不给撤销入口');

  const firstPersisted = archiveOf().attempts.find(item => item.id === attempts[0].id);
  assert.equal(firstPersisted.note, '第一把备注');
  const undoneSecond = archiveOf().attempts.find(item => item.id === attempts[1].id);
  assert.equal(undoneSecond.seq, attempts[1].seq);
  assert.equal(undoneSecond.note, '第二把完攀');
  assert.equal(undoneSecond.result, 'send');
  assert.equal(typeof undoneSecond.undoneAt, 'string');
  assert.equal(storage.get(VIDEO_INDEX_KEY), videoIndexRaw, '撤销不写视频索引');

  // 第 1 种结果：新记未完成，显示第 2 把、另取 ID、不接原第 2 把的备注与视频。
  page.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把');
  let fresh = page.data.attemptCards[0];
  assert.notEqual(fresh.id, attempts[1].id, '新一把不复用已撤销的原 ID');
  assert.equal(fresh.label, '第 2 把', '界面序号按有效把次连续');
  assert.equal(fresh.note, '', '没有借用原第 2 把的备注');
  assert.equal(fresh.videoEntryText, '＋ 添加视频', '没有借用原第 2 把的视频');
  assert.equal(fresh.showWithdraw, true, '成功后才有新的撤销入口');
  assert.equal(
    page.data.attemptCards[1].videoEntryText,
    '回看视频',
    '原第 1 把的视频归属不变'
  );

  // 再撤销这把新的一把，改记完攀：同样显示第 2 把，唯一完攀重新成立。
  page.undoLatestAttempt(withdrawEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.routeCompleted, false);
  page.recordAttempt(tapDataset({ result: 'send' }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.routeCompleted, true, '新完攀重新锁定抱石线');
  const freshSend = page.data.attemptCards[0];
  assert.equal(freshSend.label, '第 2 把');
  assert.equal(freshSend.isSend, true);
  assert.notEqual(freshSend.id, fresh.id);
  assert.notEqual(freshSend.id, attempts[1].id);

  // 重开：仍按已保存的有效把次展示，原第 1 把与两条已撤回原把都在档案里。
  const reopened = openRecord(session.id, route.id);
  assert.deepEqual(
    reopened.data.attemptCards.map(row => [row.label, row.id]),
    [
      ['第 2 把', freshSend.id],
      ['第 1 把', attempts[0].id]
    ]
  );
  assert.equal(reopened.data.attemptCards[0].showWithdraw, true, '重开后最近一把仍可撤销');
  assert.equal(reopened.data.attemptCards[1].showWithdraw, false);
  const persisted = archiveOf().attempts;
  assert.equal(persisted.find(item => item.id === attempts[0].id).note, '第一把备注');
  assert.equal(persisted.find(item => item.id === attempts[1].id).undoneAt !== undefined, true);
  assert.equal(persisted.find(item => item.id === fresh.id).undoneAt !== undefined, true);
  assert.equal(storage.get(VIDEO_INDEX_KEY), videoIndexRaw, '整个重记过程不写视频索引');
});

// ------------------------------------------------------------------ *
// 失败重试、回执丢失与连点：只扣一次，不能撤到前一把
// ------------------------------------------------------------------ *

test('T050 返工 撤销失败与回执丢失：原把保留可重试，成功只扣一次，连点不撤前一把', () => {
  const session = startSession('岩馆 撤销重试');
  const route = createRoute(session.id, '重试顶绳线', '顶绳');
  const attempts = saveAttempts(session.id, route.id, ['fail', 'fail'], ['第一把', '第二把']);
  const page = openRecord(session.id, route.id);
  const latest = page.data.attemptCards[0];
  assert.equal(latest.id, attempts[1].id);
  assert.equal(latest.showWithdraw, true);

  // 第一段写就失败：原把仍在，入口换成同一把的「重试撤销」，计数不减。
  const rawBefore = rawArchive();
  armSetFailAt(1);
  page.undoLatestAttempt(withdrawEvent(latest));
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  // 现场提示与实控件用同一个名字「重试撤销」，不再出现旧文案「重试撤回这一把」。
  assert.match(page.data.notice, /撤销未保存/);
  assert.match(page.data.notice, /重试撤销/);
  assert.doesNotMatch(page.data.notice, /重试撤回这一把/);
  assert.equal(rawArchive(), rawBefore, '第一段写失败不落任何数据');
  assert.equal(page.data.routeCountText, '2 把');
  const failedRow = page.data.attemptCards[0];
  assert.equal(failedRow.id, attempts[1].id);
  assert.equal(failedRow.isUndone, false, '原把仍是有效把次');
  assert.equal(failedRow.showWithdraw, true);
  assert.equal(failedRow.undoText, '重试撤销');
  assert.match(failedRow.stateText, /^撤销未保存/);
  assert.equal(page.data.attemptCards.some(row => row.id === attempts[0].id), true);

  // 原坐标（同一把）重试成功：只扣一次，前一把只补位。
  const staleSecond = withdrawEvent(failedRow);
  armSetFailAt(0);
  page.undoLatestAttempt(withdrawEvent(page.data.attemptCards[0]));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [attempts[0].id]);
  const middleArchive = archiveOf();
  assert.equal(
    middleArchive.attempts.filter(item => item.undoneAt !== undefined).length,
    1,
    '成功只扣一次'
  );

  // 同一坐标的第二次点按（迟到的同一把事件）：不再写盘，也不会撤到第 1 把。
  page.undoLatestAttempt(staleSecond);
  assert.equal(rawArchive(), JSON.stringify(middleArchive), '重复点按不写盘');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).undoneAt,
    undefined,
    '前一把没有被连带撤销'
  );

  // 再成功记一把后，对新的一把做「写成但回执丢失」：按已落盘状态确认，只扣一次。
  page.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(page.data.routeCountText, '2 把');
  const newLatest = page.data.attemptCards[0];
  assert.equal(newLatest.label, '第 2 把');
  assert.equal(newLatest.showWithdraw, true);
  armSetLoseResponseAt(2);
  page.undoLatestAttempt(withdrawEvent(newLatest));
  assert.equal(page.data.storageError, '', '回执丢失不当作未保存');
  assert.match(page.data.notice, /已撤销第 2 把/);
  assert.match(page.data.notice, /回执丢失/);
  assert.equal(page.data.routeCountText, '1 把', '按已落盘状态只扣一次');
  const afterLoss = archiveOf();
  const lostAttempt = afterLoss.attempts.find(item => item.id === newLatest.id);
  assert.equal(typeof lostAttempt.undoneAt, 'string', '回执丢失的那次其实已经落盘');
  assert.equal(afterLoss.attempts.filter(item => item.undoneAt !== undefined).length, 2);

  // 已经没有可撤销的目标：同一坐标再点也不写盘。
  const bytesAfterLoss = rawArchive();
  page.undoLatestAttempt(withdrawEvent(newLatest));
  assert.equal(rawArchive(), bytesAfterLoss, '没有目标时重复点按不写盘');
  assert.equal(page.data.routeCountText, '1 把');
});

// ------------------------------------------------------------------ *
// 撤销成功后的重复原事件与同一触点回弹：保留成功提示，不误记下一把
// ------------------------------------------------------------------ *

test('T050 返工 撤销成功后重复原按钮与同点结果回弹不落盘，不同位置或无触点的立即重记照常', () => {
  const session = startSession('岩馆 撤销回弹');
  const route = createRoute(session.id, '回弹抱石线', '抱石');
  const attempts = saveAttempts(session.id, route.id, ['fail', 'send'], ['第一把', '第二把']);
  const page = openRecord(session.id, route.id);
  const latest = page.data.attemptCards[0];
  assert.equal(latest.id, attempts[1].id);
  assert.equal(page.data.routeCompleted, true, '前置：唯一完攀收起结果按钮');
  const point = { x: 305, y: 493 };

  // 真实触点撤销成功：卡片收起、唯一完攀解除，结果按钮在同一区域重新出现。
  page.undoLatestAttempt(withdrawAt(latest, point, 10));
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.equal(page.data.routeCompleted, false);
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [attempts[0].id]);
  const committed = rawArchive();

  // 同一个原按钮的第二次点击：不再进共用实现，不写盘，也不把「已撤销第 2 把」换成别的提示。
  page.undoLatestAttempt(withdrawAt(latest, point, 25));
  assert.equal(rawArchive(), committed, '重复原按钮不写盘');
  assert.equal(page.data.notice, '已撤销第 2 把', '成功提示不被重复点击覆盖');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).undoneAt,
    undefined,
    '前一把没有被连带撤销'
  );

  // 同一触点的短时结果事件：这是重排后落到刚出现的结果按钮上的回弹，不能记成下一把。
  page.recordAttempt(recordAt(page, 'fail', point, 40));
  assert.equal(rawArchive(), committed, '同点结果回弹不写盘');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.notice, '已撤销第 2 把', '回弹被吞掉时保留成功提示');

  // 位置明显不同的立即重记不受影响：仍按有效把次接上第 2 把。
  page.recordAttempt(recordAt(page, 'fail', { x: 35, y: 100 }, 45));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把');
  const fresh = page.data.attemptCards[0];
  assert.notEqual(fresh.id, attempts[0].id, '新一把不复用已撤销的原 ID');
  assert.notEqual(fresh.id, attempts[1].id);
  assert.equal(fresh.label, '第 2 把');
  assert.equal(fresh.showWithdraw, true);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).undoneAt,
    undefined,
    '重记没有撤到补位的前一把'
  );

  // 再记成功后，迟到的原按钮仍只被忽略：不撤新一把，也不改写当前提示。
  const afterNew = rawArchive();
  page.undoLatestAttempt(withdrawAt(latest, point, 50));
  assert.equal(rawArchive(), afterNew, '迟到原按钮不落盘');
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [fresh.id, attempts[0].id]);
  assert.equal(page.data.attemptCards[0].showWithdraw, true, '新一把的撤销入口保持');
  assert.equal(page.data.notice, '', '迟到事件不覆盖当前提示');

  // 无触点的程序化记把不受坐标兜底限制：即使仍在撤销后的短窗口内也照常落盘。
  page.undoLatestAttempt(withdrawAt(fresh, { x: 200, y: 600 }, 60));
  assert.equal(page.data.notice, '已撤销第 2 把');
  page.recordAttempt(tapDataset({ result: 'send' }));
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.routeCompleted, true, '无触点记把照常参与完攀判定');
});

// ------------------------------------------------------------------ *
// 重开、跨日与同场另一条线：门控与适用范围
// ------------------------------------------------------------------ *

test('T050 返工 撤销后的门控在重开与 onShow 保持；同线另一场、同场另一条线各自独立', () => {
  const session = startSession('岩馆 范围', '2026-11-18');
  const route = createRoute(session.id, '范围顶绳线', '顶绳');
  const firstRun = saveAttempts(session.id, route.id, ['fail', 'fail'], ['本场第一把', '本场第二把']);

  const neighbor = createRoute(session.id, '范围旁线', '顶绳');
  const neighborAttempt = store.saveAttempt({
    sessionId: session.id,
    routeId: neighbor.id,
    result: 'fail',
    note: '旁线这一把',
    now: new Date(2026, 10, 18, 10, 0)
  });
  assert.equal(neighborAttempt.ok, true, neighborAttempt.error);

  const day2 = startSession('岩馆 范围', '2026-11-19');
  assert.equal(store.linkRouteToSession(day2.id, route.id).ok, true);
  const secondRunAttempts = saveAttempts(
    day2.id,
    route.id,
    ['fail', 'fail'],
    ['第二天第一把', '第二天第二把']
  );

  const page = openRecord(session.id, route.id);
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [firstRun[1].id, firstRun[0].id],
    '只列入口这一场这一条线'
  );
  page.undoLatestAttempt(withdrawEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '1 把');

  // onShow 重读：前一把补位且仍不给撤销入口（门控来自已保存状态，不靠内存）。
  page.onShow();
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [firstRun[0].id]);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);
  assert.equal(page.data.routeCountText, '1 把');

  // 重开同一入口：同样按已保存的有效把次展示，原把身份与备注可回读。
  const reopened = openRecord(session.id, route.id);
  assert.deepEqual(reopened.data.attemptCards.map(row => row.id), [firstRun[0].id]);
  assert.equal(reopened.data.attemptCards[0].note, '本场第一把');
  assert.equal(reopened.data.attemptCards[0].showWithdraw, false, '重开也不给前一把撤销入口');
  assert.equal(
    typeof archiveOf().attempts.find(item => item.id === firstRun[1].id).undoneAt,
    'string'
  );

  // 同线另一场不受影响：它自己的两把、自己的最近一把与撤销入口都在。
  const day2Page = openRecord(day2.id, route.id);
  assert.deepEqual(
    day2Page.data.attemptCards.map(row => row.id),
    [secondRunAttempts[1].id, secondRunAttempts[0].id]
  );
  assert.equal(day2Page.data.attemptCards[0].showWithdraw, true);
  assert.equal(day2Page.data.routeCountText, '2 把');

  // 同场另一条线也不串：只列自己的原把，计数与撤销目标各归各的。
  const neighborPage = openRecord(session.id, neighbor.id);
  assert.deepEqual(
    neighborPage.data.attemptCards.map(row => row.id),
    [neighborAttempt.attempt.id]
  );
  assert.equal(neighborPage.data.attemptCards[0].showWithdraw, true);
  assert.equal(neighborPage.data.routeCountText, '1 把');

  // 过期的跨场事件送到这一页：不落盘，也不改本场这一条线。
  const bytesBefore = rawArchive();
  reopened.undoLatestAttempt(
    tapDataset({
      attemptId: secondRunAttempts[1].id,
      archiveId: archiveOf().archiveId,
      sessionId: day2.id,
      routeId: route.id,
      expected: 'effective',
      expectedRev: 0
    })
  );
  assert.equal(rawArchive(), bytesBefore, '别的场次的迟到撤销不落盘');
  assert.match(reopened.data.notice, /最近一把已经变了|别的场次/);
  assert.equal(reopened.data.routeCountText, '1 把');
});

// c8b3c1b 原生 QA（320px）：微信 button 的 width:auto 实际算出 184×44，把最新一把
// 「第 2 把」压成三行。这里只做静态回归：常态撤销必须写死 44×44、文案居中，并用
// 「父行 + button + 类」压过 style v2 的 button:not([size=mini]) 默认 184px；
// 重试文案单独用有限加宽的固定盒；最新行的序号、结果、时间仍保持单行。
test('T050 返工：撤销命中盒固定 44×44，重试只做有限加宽', () => {
  const wxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxss'),
    'utf8'
  );
  const wxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxml'),
    'utf8'
  );
  function ruleOf(selector) {
    const start = wxss.indexOf(selector);
    assert.ok(start >= 0, selector + ' 规则存在');
    const brace = wxss.indexOf('{', start);
    return wxss.slice(brace + 1, wxss.indexOf('}', brace));
  }

  const withdraw = ruleOf('.record-attempt-withdraw');
  assert.match(withdraw, /min-width:\s*44px;/, '常态命中盒最小宽度 44px');
  assert.match(withdraw, /height:\s*44px;/, '常态命中盒高度写死 44px');
  assert.match(withdraw, /min-height:\s*44px;/, '常态命中盒最小高度 44px');
  assert.match(withdraw, /padding:\s*0;/, '内边距不再叠加到命中盒外');
  assert.match(withdraw, /align-items:\s*center;/, '文案垂直居中');
  assert.match(withdraw, /justify-content:\s*center;/, '文案水平居中');
  assert.doesNotMatch(withdraw, /width:\s*auto;/, '不回到会被算成 184px 的 auto');

  // style v2 内置 button:not([size=mini]) { width:184px } 的优先级高于裸类；
  // 静态断言宽度规则保持「父行 + button + 类」，避免以后又退回 184px。
  const withdrawWidth = ruleOf('.record-attempt-headline button.record-attempt-withdraw');
  assert.match(withdrawWidth, /width:\s*44px;/, '常态命中盒宽度写死 44px');
  assert.match(withdrawWidth, /max-width:\s*44px;/, '44px 上限挡住微信 button 默认宽度');
  assert.doesNotMatch(withdrawWidth, /!important/, '用选择器优先级解决，不靠 !important');

  const retry = ruleOf('.record-attempt-headline button.record-attempt-withdraw-retry');
  assert.match(retry, /width:\s*128rpx;/, '重试盒用有限加宽的固定值');
  assert.match(retry, /min-width:\s*128rpx;/, '重试盒最小宽度覆盖常态 44px');
  assert.match(retry, /max-width:\s*128rpx;/, '重试盒同样有上限');
  assert.ok(
    wxml.includes("item.undoText === '重试撤销'"),
    '重试态按已有的 item.undoText 选类'
  );
  assert.ok(wxml.includes('record-attempt-withdraw-retry'), '重试类挂在撤销按钮上');

  const latestLine = ruleOf('.record-attempt-latest .record-attempt-headline');
  assert.match(latestLine, /flex-wrap:\s*nowrap;/, '最新行不换行');
  assert.match(
    ruleOf('.record-attempt-latest .record-attempt-label'),
    /white-space:\s*nowrap;/,
    '最新序号保持单行'
  );
  assert.match(
    ruleOf('.record-attempt-latest .record-attempt-time'),
    /white-space:\s*nowrap;/,
    '最新时间保持单行'
  );
});

// ------------------------------------------------------------------ *
// T056 R1：逐把备注草稿按四个原 ID 隔离，A → B → A 不丢
// ------------------------------------------------------------------ *

test('T056 R1 单线页 A→B→A：各自草稿保留，保存 B 不动 A 的草稿与原值，取消只丢同一把', () => {
  const session = startSession('岩馆 T056 单线');
  const route = createRoute(session.id, 'T056 单线', '顶绳');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'fail', 'fail'],
    ['A 原备注', 'B 原备注', 'C 原备注']
  );
  const page = openRecord(session.id, route.id);
  const cardsBefore = page.data.attemptCards.map(row => row.id);
  const expandedBefore = page.data.expandedAttemptId;

  // A：输入未提交草稿，切到 B，再回 A。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, 'A 原备注');
  page.onNoteInput(noteInput(page, 'A 未保存草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  assert.equal(page.data.noteEditor.text, 'B 原备注', '切到 B 带出 B 的原值');
  page.onNoteInput(noteInput(page, 'B 未保存草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.attemptId, attempts[0].id);
  assert.equal(page.data.noteEditor.text, 'A 未保存草稿', '回到 A 草稿仍在');
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    cardsBefore,
    '切换备注不改现场卡片顺序'
  );
  assert.equal(page.data.expandedAttemptId, expandedBefore, '切换备注不改展开态');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 原备注',
    '草稿没有写盘'
  );

  // 保存 B：只落 B，A 的草稿与已保存原值都保持。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[1].id).note,
    'B 未保存草稿'
  );
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 原备注',
    '保存 B 不改 A 的原值'
  );
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, 'A 未保存草稿', '保存 B 后 A 草稿仍在');

  // 未提交的空字符串也是草稿：切走再回来不能被原值顶掉。
  page.onNoteInput(noteInput(page, ''));
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, '', '空草稿保持为空，不回填原值');

  // 明确取消只丢弃这一把：A 的草稿清掉，B 自己的草稿不受影响。
  page.cancelNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.noteEditor, null);
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, 'A 原备注', '取消 A 后回到 A 的已保存原值');
  page.onNoteInput(noteInput(page, 'A 第二次草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.onNoteInput(noteInput(page, 'B 第二次草稿'));
  page.cancelNote(noteButtonEvent(page.data.noteEditor));
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  assert.equal(page.data.noteEditor.text, 'B 未保存草稿', '取消 B 只丢 B 的草稿');
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, 'A 第二次草稿', '取消 B 不动 A 的草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[2].id).note,
    'C 原备注',
    '没打开过的第三把原值不变'
  );

  // 展开 A 的备注区后折叠再展开：草稿仍跟着原把，不因收起而释放。
  page.toggleAttemptRow(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.expandedAttemptId, attempts[0].id);
  page.toggleAttemptRow(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.expandedAttemptId, '', '折叠后编辑器区域收起');
  assert.equal(page.data.noteEditor.text, 'A 第二次草稿', '折叠不释放草稿');
  page.toggleAttemptRow(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, 'A 第二次草稿', '再展开仍可继续编辑');
});

test('T056 R1 本场逐把页 A→B→A：草稿保留，旧代次输入/保存/取消不读写，跨页面实例隔离', () => {
  const session = startSession('岩馆 T056 逐把');
  const route = createRoute(session.id, 'T056 逐把线', '顶绳');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'fail'],
    ['A 原备注', 'B 原备注']
  );
  const neighbor = createRoute(session.id, 'T056 旁线', '顶绳');
  const neighborAttempt = store.saveAttempt({
    sessionId: session.id,
    routeId: neighbor.id,
    result: 'fail',
    note: '旁线原备注',
    now: new Date(2026, 10, 18, 10, 0)
  });
  assert.equal(neighborAttempt.ok, true, neighborAttempt.error);

  const page = openAttempts(session.id, route.id);
  const rowsBefore = page.data.attempts.map(row => row.id);

  // 旧代次：取消并重新打开同一把后，旧编辑器的输入/保存/取消都不能落到新草稿上。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  const staleEditor = page.data.noteEditor;
  page.onNoteInput(noteInput(page, '旧代次草稿'));
  page.cancelNote(noteButtonEvent(staleEditor));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.notEqual(
    page.data.noteEditor.version,
    staleEditor.version,
    '取消后重新打开换编辑代次'
  );
  page.onNoteInput(noteInput(page, '新代次草稿'));

  page.onNoteInput({
    detail: { value: '旧代次迟到输入' },
    currentTarget: {
      dataset: { attemptId: staleEditor.attemptId, editVersion: staleEditor.version }
    }
  });
  assert.equal(page.data.noteEditor.text, '新代次草稿', '旧输入不覆盖新草稿');

  const beforeStaleSave = rawArchive();
  page.saveNote(noteButtonEvent(staleEditor));
  assert.equal(rawArchive(), beforeStaleSave, '旧保存不写盘');
  assert.equal(page.data.noteEditor.text, '新代次草稿', '旧保存不收新草稿');
  assert.match(page.data.notice, /之前打开的备注编辑/);

  page.cancelNote(noteButtonEvent(staleEditor));
  assert.equal(page.data.noteEditor.text, '新代次草稿', '旧取消不清新草稿');

  // A → B → A：B 用自己的原值，回到 A 仍是 A 的草稿。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  assert.equal(page.data.noteEditor.text, 'B 原备注');
  page.onNoteInput(noteInput(page, 'B 未保存草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, '新代次草稿', '回到 A 草稿仍在');
  assert.deepEqual(page.data.attempts.map(row => row.id), rowsBefore, '逐把行顺序不变');

  // 保存 B 后 A 的草稿仍在，且旁线、第三条线都不受影响。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[1].id).note,
    'B 未保存草稿'
  );
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.text, '新代次草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 原备注',
    'A 的原值没被草稿或 B 的保存改写'
  );
  assert.equal(
    archiveOf().attempts.find(item => item.id === neighborAttempt.attempt.id).note,
    '旁线原备注',
    '同场另一条线的原备注不变'
  );

  // 跨页面实例隔离：另一页实例只按已保存档案带出，不共享本实例的草稿。
  const otherPage = openAttempts(session.id, route.id);
  otherPage.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(
    otherPage.data.noteEditor.text,
    'A 原备注',
    '草稿只在所在页面实例内，不串到另一实例'
  );
  // 另一实例自己的查看草稿也按它自己的明确取消释放，不影响本页。
  otherPage.cancelNote(noteButtonEvent(otherPage.data.noteEditor));

  // 本页保存 A 成功后才释放草稿；另一实例重新读档看到已保存的新备注。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    '新代次草稿'
  );
  otherPage.onShow();
  otherPage.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(otherPage.data.noteEditor.text, '新代次草稿', '另一实例读到已保存备注');
});

test('T056 R1 保存故障保留草稿可重试；写后读回确认成功才释放，读回不一致不丢草稿', () => {
  const session = startSession('岩馆 T056 重试');
  const route = createRoute(session.id, 'T056 重试线', '顶绳');
  const attempts = saveAttempts(session.id, route.id, ['fail'], ['原备注']);
  const page = openRecord(session.id, route.id);
  const attemptId = attempts[0].id;

  // 写前失败：编辑器和草稿都保留，原值不变。
  page.openNoteEditor(tapDataset({ attemptId }));
  page.onNoteInput(noteInput(page, '失败后重试的草稿'));
  armSetFailAt(1);
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  armSetFailAt(0);
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.match(page.data.notice, /备注未保存/);
  assert.equal(page.data.noteEditor.attemptId, attemptId);
  assert.equal(page.data.noteEditor.text, '失败后重试的草稿', '失败不丢输入');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '原备注',
    '失败不报已保存'
  );

  // 原样重试成功：读回确认后才收起编辑器。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '失败后重试的草稿'
  );

  // 写成但回执丢失：页面按失败保留草稿；重试走同一把的重复写入，读回后释放。
  page.openNoteEditor(tapDataset({ attemptId }));
  page.onNoteInput(noteInput(page, '回执丢失的草稿'));
  armSetLoseResponseAt(1);
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  armSetLoseResponseAt(0);
  assert.match(page.data.notice, /备注未保存/);
  assert.equal(page.data.noteEditor.text, '回执丢失的草稿', '回执丢失仍保留草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '回执丢失的草稿',
    '这一次其实已经落盘'
  );
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null, '重试读回确认后才释放');

  // 档案层声称成功但盘上没有这次内容：页面读回不一致，不释放草稿。
  page.openNoteEditor(tapDataset({ attemptId }));
  page.onNoteInput(noteInput(page, '读回不一致的草稿'));
  const realSetAttemptNote = store.setAttemptNote;
  store.setAttemptNote = () => {
    const loaded = store.loadState();
    return { ok: true, code: 'saved', error: '', archive: loaded.archive };
  };
  try {
    page.saveNote(noteButtonEvent(page.data.noteEditor));
  } finally {
    store.setAttemptNote = realSetAttemptNote;
  }
  assert.match(page.data.storageError, /读回/);
  assert.equal(page.data.noteEditor.text, '读回不一致的草稿', '读回不一致不丢草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '回执丢失的草稿',
    '没有把未落盘的内容当作已保存'
  );

  // 恢复真实写入后可重试成功。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '读回不一致的草稿'
  );
});

// ------------------------------------------------------------------ *
// T056 R1-E：A→B→A 后早前 A 的迟到输入/保存/取消仍失效；新 A 读回确认后才保存
// ------------------------------------------------------------------ *

test('T056 R1-E 单线页 A→B→A：旧 A 迟到输入/保存/取消失效，新 A 读回确认后才释放草稿', () => {
  const session = startSession('岩馆 T056 R1E 单线');
  const route = createRoute(session.id, 'T056 R1E 单线', '顶绳');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'fail'],
    ['A 原备注', 'B 原备注']
  );
  const page = openRecord(session.id, route.id);

  // A 第一次挂载：留住这一次编辑器原生事件（原 attemptId + 原代次）。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  const oldA = page.data.noteEditor;
  page.onNoteInput(noteInput(page, 'A 第一次草稿'));
  const staleInput = {
    detail: { value: 'A 迟到的旧输入' },
    currentTarget: {
      dataset: { attemptId: oldA.attemptId, editVersion: oldA.version }
    }
  };
  const staleSave = noteButtonEvent(oldA);
  const staleCancel = noteButtonEvent(oldA);

  // A → B → A：草稿文字保留，但重新挂载必须换新代次。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.onNoteInput(noteInput(page, 'B 未保存草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  const newA = page.data.noteEditor;
  assert.equal(newA.text, 'A 第一次草稿', '回到 A 草稿文字仍在');
  assert.notEqual(newA.version, oldA.version, '重新挂载换新代次');

  page.onNoteInput(noteInput(page, 'A 回来后继续写'));
  const committed = rawArchive();

  // 早前 A 的迟到输入不能覆盖新 A 的草稿。
  page.onNoteInput(staleInput);
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 输入不覆盖新 A 草稿');
  assert.equal(rawArchive(), committed, '旧 A 输入不写盘');

  // 早前 A 的迟到保存不能提交新 A 的内容。
  page.saveNote(staleSave);
  assert.equal(rawArchive(), committed, '旧 A 保存不写盘');
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 保存不收新草稿');
  assert.match(page.data.notice, /之前打开的备注编辑/);

  // 早前 A 的迟到取消不能丢弃新 A 的草稿。
  page.cancelNote(staleCancel);
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 取消不清新 A 草稿');
  assert.notEqual(page.data.noteEditor, null);

  // 新 A 保存：档案层声称成功但读回不一致时不释放草稿。
  const realSetAttemptNote = store.setAttemptNote;
  store.setAttemptNote = () => {
    const loaded = store.loadState();
    return { ok: true, code: 'saved', error: '', archive: loaded.archive };
  };
  try {
    page.saveNote(noteButtonEvent(page.data.noteEditor));
  } finally {
    store.setAttemptNote = realSetAttemptNote;
  }
  assert.match(page.data.storageError, /读回/);
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '读回不一致不释放草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 原备注',
    '未落盘的输入没有被当作已保存'
  );

  // 恢复真实写入：读回确认成功后才释放草稿。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 回来后继续写'
  );

  // B 的未提交草稿全程没被 A 的保存释放。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  assert.equal(page.data.noteEditor.text, 'B 未保存草稿', '保存 A 不动 B 的草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[1].id).note,
    'B 原备注',
    'B 的原值也没被 A 的保存改写'
  );
});

test('T056 R1-E 本场逐把页 A→B→A：旧 A 迟到输入/保存/取消失效，新 A 读回确认后才释放草稿', () => {
  const session = startSession('岩馆 T056 R1E 逐把');
  const route = createRoute(session.id, 'T056 R1E 逐把线', '顶绳');
  const attempts = saveAttempts(
    session.id,
    route.id,
    ['fail', 'fail'],
    ['A 原备注', 'B 原备注']
  );
  const page = openAttempts(session.id, route.id);

  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  const oldA = page.data.noteEditor;
  page.onNoteInput(noteInput(page, 'A 第一次草稿'));
  const staleInput = {
    detail: { value: 'A 迟到的旧输入' },
    currentTarget: {
      dataset: { attemptId: oldA.attemptId, editVersion: oldA.version }
    }
  };
  const staleSave = noteButtonEvent(oldA);
  const staleCancel = noteButtonEvent(oldA);

  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  page.onNoteInput(noteInput(page, 'B 未保存草稿'));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  const newA = page.data.noteEditor;
  assert.equal(newA.text, 'A 第一次草稿', '回到 A 草稿文字仍在');
  assert.notEqual(newA.version, oldA.version, '重新挂载换新代次');

  page.onNoteInput(noteInput(page, 'A 回来后继续写'));
  const committed = rawArchive();
  page.onNoteInput(staleInput);
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 输入不覆盖新 A 草稿');
  assert.equal(rawArchive(), committed, '旧 A 输入不写盘');

  page.saveNote(staleSave);
  assert.equal(rawArchive(), committed, '旧 A 保存不写盘');
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 保存不收新草稿');

  page.cancelNote(staleCancel);
  assert.equal(page.data.noteEditor.text, 'A 回来后继续写', '旧 A 取消不清新 A 草稿');
  assert.notEqual(page.data.noteEditor, null);

  // 新 A 保存走完整读回确认：成功后才收起编辑器并释放草稿。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    'A 回来后继续写'
  );
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  assert.equal(page.data.noteEditor.text, 'B 未保存草稿', '保存 A 不动 B 的草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[1].id).note,
    'B 原备注',
    'B 的原值不变'
  );
});

test('T056 R1 读回必须仍是原来那一把：档案身份不符时不释放草稿', () => {
  const session = startSession('岩馆 T056 身份');
  const route = createRoute(session.id, 'T056 身份线', '顶绳');
  const attempts = saveAttempts(session.id, route.id, ['fail'], ['原备注']);
  const page = openRecord(session.id, route.id);
  const attemptId = attempts[0].id;

  page.openNoteEditor(tapDataset({ attemptId }));
  page.onNoteInput(noteInput(page, '身份核对草稿'));
  const originalRaw = rawArchive();

  // 写成功但读回落在**另一份档案身份**上（同 ID、同文字也不算这一把）。
  const realSetAttemptNote = store.setAttemptNote;
  store.setAttemptNote = () => {
    const loaded = store.loadState();
    const crafted = JSON.parse(JSON.stringify(loaded.archive));
    crafted.archiveId = crafted.archiveId + '-replaced';
    const target = crafted.attempts.find(item => item.id === attemptId);
    target.note = '身份核对草稿';
    storage.set(ARCHIVE_KEY, JSON.stringify(crafted));
    return { ok: true, code: 'saved', error: '', archive: crafted };
  };
  try {
    page.saveNote(noteButtonEvent(page.data.noteEditor));
  } finally {
    store.setAttemptNote = realSetAttemptNote;
    storage.set(ARCHIVE_KEY, originalRaw);
  }
  assert.match(page.data.storageError, /读回/);
  assert.notEqual(page.data.noteEditor, null, '身份不符不释放草稿');
  assert.equal(page.data.noteEditor.text, '身份核对草稿');
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '原备注',
    '原档案里的这一把仍是原值'
  );

  // 恢复真实写入后可重试成功。
  page.saveNote(noteButtonEvent(page.data.noteEditor));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attemptId).note,
    '身份核对草稿'
  );
});
