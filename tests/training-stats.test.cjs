/**
 * T022 底部「统计」显示本机把数与实际完攀回归测试（离线部分）
 *
 * 直接加载真实统计页 pages/stats/stats.js，捕获 Page(...) 定义，用隔离的微信本地存储
 * 替身驱动真实页面处理器；本机读数一律先经真实档案层（utils/training-store.js）的
 * 建场、建线、记把与更正操作写入，再让统计页去读，覆盖 R1–R4 的离线判据：
 * - 空档空态、三把（两未完成一完攀）显示 3/1/2/33%、同一分母取整；
 * - 更正完攀后 3/0/3/0%、同一 opId 重试不增把数、重开/刷新/切回一致；
 * - 跨日、同日多场、同色同级不同线路按原 ID 计数，未落盘的待保存操作不计入；
 * - 旧云汇总只读回看、不计入本机数字；断网、旧云拒绝、空数据、迟到回执都不遮挡本机读数；
 * - 损坏档案显示读取失败并保留原字节，与真实空档可区分；
 * - 只进入/刷新/离开统计不写盘：训练档案、照片索引、自测存储逐字节不变，也不碰文件系统。
 * - T047：四个统计标题改为「完攀把数」「把次完攀率」「最高尝试难度」「各岩馆尝试把数」，
 *   只改可见文案；同一夹具下的完攀把数、分母、难度与岩馆计数保持改动前的数字。
 *
 * 刻意不提供 wx.cloud：统计页的本机读数不得依赖云能力，旧云汇总失败只影响它自己那一段。
 * 真机底部 tab、手机字号与云环境实读留给负责人整体验收（待验）。
 *
 * 运行：node --test tests/training-stats.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');
const STATS_WXML = path.join(ROOT, 'pages', 'stats', 'stats.wxml');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const FITNESS_JS = path.join(ROOT, 'utils', 'fitness-test.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTOS_KEY = 'climbingNote.training.v1.photos';
const FITNESS_KEY = 'climbingNote.fitness.v1.records';

// ---- 微信本地存储替身：记录每一次读写，可按需注入写入故障 ----
const storage = new Map();
const io = { reads: [], writes: [], removals: [], fsCalls: [], setFailAt: 0, setCount: 0 };

function resetDevice() {
  storage.clear();
  io.reads = [];
  io.writes = [];
  io.removals = [];
  io.fsCalls = [];
  io.setFailAt = 0;
  io.setCount = 0;
}

// 落盘第 N 次写失败：用于制造「只留下『进行中』标记、把次未提交」的档案。
function armSetFailAt(callNumber) {
  io.setCount = 0;
  io.setFailAt = callNumber;
}

function bytesOf(key) {
  return storage.has(key) ? storage.get(key) : null;
}

const wxLog = { toasts: [], switches: [] };
let pullDownCount = 0;

function resetWxLog() {
  wxLog.toasts = [];
  wxLog.switches = [];
  pullDownCount = 0;
}

// 刻意不带 cloud：T022 的本机统计不得依赖云能力。
global.wx = {
  getStorageSync(key) {
    io.reads.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    io.setCount += 1;
    if (io.setFailAt && io.setCount === io.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + io.setCount);
    }
    storage.set(key, value);
    io.writes.push(key);
  },
  removeStorageSync(key) {
    io.removals.push(key);
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  // 统计页是纯读：不得访问文件系统（原图是本地文件）。
  getFileSystemManager() {
    io.fsCalls.push('getFileSystemManager');
    throw new Error('统计页不得访问文件系统');
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  stopPullDownRefresh() {
    pullDownCount += 1;
  }
};

const db = require(DB_JS);
const realGetAllRecords = db.getAllRecords;
const store = require(STORE_JS);
const fitness = require(FITNESS_JS);

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

const statsDefinition = capturePage(STATS_JS);

/**
 * 页面实例替身：支持 wx 的 setData 数据路径写法。
 */
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

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 从底部「统计」冷启动进入页面（onLoad）；切回 tab 另用 onShow 显式驱动。
function openStats() {
  const page = createPage(statsDefinition);
  page.onLoad();
  return page;
}

// 旧云汇总替换入口：只统计页这一段受影响，本机读数不得跟着变。
function useCloudRecords(handler) {
  db.getAllRecords = () => handler();
}

const FIXED_NOW = new Date(2026, 10, 9, 8, 30);

function startSession(gymName, date) {
  const started = store.startSession({ gymName, date, now: FIXED_NOW });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function addRoute(session, overrides) {
  const created = store.createRoute(
    Object.assign(
      {
        sessionId: session.id,
        name: '蓝色动态线',
        climbType: '抱石',
        grade: 'V3',
        colorName: '蓝色',
        colorHex: '#2f6fe4'
      },
      overrides || {}
    )
  );
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function recordAttempt(input) {
  return store.saveAttempt(
    Object.assign({ now: new Date(2026, 10, 9, 9, 0), note: '' }, input)
  );
}

// 一次最常见的三把前置：同一场次、同一抱石线路，两把未完成 + 一把完攀（走真实档案层）。
function seedThreeAttempts() {
  const date = store.todayLocalDate();
  const session = startSession('据点的岩馆', date);
  const route = addRoute(session, { name: '蓝色动态线', grade: 'V3' });
  const first = recordAttempt({ opId: 'op-fail-1', sessionId: session.id, routeId: route.id, result: 'fail' });
  const second = recordAttempt({ opId: 'op-fail-2', sessionId: session.id, routeId: route.id, result: 'fail' });
  const send = recordAttempt({ opId: 'op-send-1', sessionId: session.id, routeId: route.id, result: 'send' });
  [first, second, send].forEach(saved => assert.equal(saved.ok, true, saved.error));
  return { session, route, sendId: send.attempt.id };
}

// 上个月的最后一天（本机本地日期），用于「本月」判据。
function previousMonthDate() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  first.setDate(first.getDate() - 1);
  return store.formatLocalDate(first);
}

function writeLegacyArchive(raw) {
  storage.set(ARCHIVE_KEY, raw);
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
  db.getAllRecords = realGetAllRecords;
});

// ------------------------------------------------------------------ *
// 结构、只读与禁止项
// ------------------------------------------------------------------ *

test('R1 统计 tab 与页面四件套保持原样，统计页只读本机档案', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ],
    '不允许改动 tabBar：底部「统计」仍指向 pages/stats/stats'
  );
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'pages', 'stats', 'stats' + ext)),
      '缺少统计页文件 stats' + ext
    );
  }

  const source = fs.readFileSync(STATS_JS, 'utf8');
  // 统计页只读：不得出现任何落盘或写档案入口，也不得引云。
  assert.doesNotMatch(source, /setStorageSync|removeStorageSync/, '统计页不得写本地存储');
  assert.doesNotMatch(source, /saveArchive|saveAttempt|correctAttempt|setAttemptNote|startSession|createRoute/, '统计页不得调用档案写入入口');
  assert.doesNotMatch(source, /wx\.cloud/, '统计页不得直接使用云能力');
  assert.doesNotMatch(source, /fitness/, '统计页不得触碰 9c 自测存储');
  assert.match(source, /require\('\.\.\/\.\.\/utils\/training-store'\)/, '统计页必须复用本机档案只读入口');
});

test('R1 统计页文案：本机区块在前、旧云单列在后，最高尝试难度分 V 级与 YDS', () => {
  const wxml = fs.readFileSync(STATS_WXML, 'utf8');
  assert.ok(
    wxml.indexOf('本机把数') !== -1 && wxml.indexOf('旧云记录') !== -1,
    '统计页应同时有本机读数与单列的旧云来源'
  );
  assert.ok(
    wxml.indexOf('本机把数') < wxml.indexOf('旧云记录'),
    '本机结果必须排在旧云来源之前'
  );
  assert.match(wxml, /V 级/, '最高尝试难度须标出 V 级');
  assert.match(wxml, /YDS/, '最高尝试难度须标出 YDS');
  assert.match(wxml, /本月按训练日期算/, '本月读数须说明按把次所属训练日期计算');
  assert.match(wxml, /id="stats-empty"/, '需要可辨别的空档空态');
  assert.match(wxml, /id="archive-error"/, '需要可辨别的读取失败态');
  assert.match(wxml, /id="legacy-error"/, '旧云失败要有单列的错误态');
});

test('T047 四个统计标题各自贴着对应读数，旧标题不再出现', () => {
  const wxml = fs.readFileSync(STATS_WXML, 'utf8');

  // 标题与数字一一对应：不能把「完攀把数」挂到总把数或本月把数上。
  assert.match(
    wxml,
    /<text class="stat-number">\{\{sendCount\}\}<\/text>\s*<text class="stat-label">完攀把数<\/text>/,
    '「完攀把数」对应完攀把次 sendCount'
  );
  assert.match(
    wxml,
    /<text class="stat-number">\{\{totalAttempts\}\}<\/text>\s*<text class="stat-label">本机把数<\/text>/,
    '总把数仍是同一分母的本机把数'
  );
  assert.match(
    wxml,
    /<text class="stat-label">本月把数<\/text>/,
    '本月把数标题保持原样'
  );
  assert.match(
    wxml,
    /<text class="stat-number">\{\{completionRate\}\}%<\/text>\s*<text class="stat-label">把次完攀率<\/text>/,
    '「把次完攀率」对应同一分母的 completionRate'
  );

  // 最高尝试难度仍按抱石 V 级与绳攀 YDS 分列。
  const gradeStart = wxml.indexOf('最高尝试难度');
  const gradeSection = wxml.slice(gradeStart, wxml.indexOf('线路类型'));
  assert.ok(gradeStart !== -1 && gradeStart < wxml.indexOf('线路类型'), '缺「最高尝试难度」段落');
  assert.match(gradeSection, /\{\{boulderMaxGrade\}\}/, '抱石最高难度仍来自 boulderMaxGrade');
  assert.match(gradeSection, /\{\{ropeMaxGrade\}\}/, '绳攀最高难度仍来自 ropeMaxGrade');

  // 各岩馆尝试把数仍是按岩馆分组的尝试把次。
  const gymStart = wxml.indexOf('gymRows.length');
  const gymSection = wxml.slice(gymStart, wxml.indexOf('旧云记录（只读）'));
  assert.ok(gymStart !== -1 && gymStart < wxml.indexOf('旧云记录（只读）'), '缺岩馆分布段落');
  assert.match(gymSection, /<view class="section-title">各岩馆尝试把数<\/view>/);
  assert.match(gymSection, /\{\{item\.count\}\}把/);

  // 旧标题已去掉；完成状态里的「完攀」条与本月说明不跟着改。
  assert.doesNotMatch(wxml, /<text class="stat-label">完攀<\/text>/);
  assert.doesNotMatch(wxml, /<text class="stat-label">完成率<\/text>/);
  assert.doesNotMatch(wxml, /<view class="section-title">最高难度<\/view>/);
  assert.doesNotMatch(wxml, /常去岩馆/);
  assert.match(wxml, /<text class="bar-label">完攀<\/text>/, '完成状态里的完攀条保持不变');
  assert.match(wxml, /本月按训练日期算：\{\{monthAttempts\}\} 把 · 完成率 \{\{monthCompletionRate\}\}%/, '本月说明保持不变');
});

test('T047 同一夹具下四个标题对应的数字与改动前一致', async () => {
  seedThreeAttempts();

  const page = openStats();
  await flush();

  // 完攀把数、分母、难度与岩馆计数都沿用现有汇总，不因改标题而变。
  assert.equal(page.data.totalAttempts, 3, '本机把数（分母）仍是 3');
  assert.equal(page.data.sendCount, 1, '完攀把数仍是 1');
  assert.equal(page.data.completionRate, 33, '把次完攀率仍是 1/3 → 33%');
  assert.equal(page.data.boulderMaxGrade, 'V3', '最高尝试难度仍是抱石 V3');
  assert.equal(page.data.ropeMaxGrade, '', '本档仍没有绳攀线路');
  assert.deepEqual(page.data.gymRows, [
    { name: '据点的岩馆', count: 3, percentage: 100 }
  ], '各岩馆尝试把数仍是 3 把');
});

// ------------------------------------------------------------------ *
// R1 空档与三把读数
// ------------------------------------------------------------------ *

test('R1 空档：明确空态，旧云不可用也不遮住空态，且不写盘', async () => {
  const writesBefore = io.setCount;
  const page = openStats();
  await flush();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.archiveError, '');
  assert.equal(page.data.isEmpty, true, '没有本机档案时显示明确空态');
  assert.equal(page.data.totalAttempts, 0);
  assert.equal(page.data.completionRate, 0);
  // 没有 wx.cloud：旧云这一段自己失败，但不影响本机空态。
  assert.equal(page.data.legacyState, 'error');
  assert.match(page.data.legacyError, /云环境不可用/);
  assert.equal(page.data.isEmpty, true);
  assert.equal(io.setCount, writesBefore, '只进入统计不得写任何本地存储');
  assert.equal(storage.size, 0, '空档下不应凭空落下任何键');
});

test('R1 三把（两未完成一完攀）：本机 3 把、完攀 1、未完成 2、完成率 33%', async () => {
  const { session, route } = seedThreeAttempts();
  const archiveBefore = bytesOf(ARCHIVE_KEY);

  const page = openStats();
  await flush();

  assert.equal(page.data.archiveError, '');
  assert.equal(page.data.isEmpty, false);
  assert.equal(page.data.totalAttempts, 3, '本机把数按已提交把次计');
  assert.equal(page.data.sendCount, 1);
  assert.equal(page.data.failCount, 2);
  assert.equal(page.data.completionRate, 33, '同一分母取整：1/3 → 33%');
  assert.equal(page.data.monthAttempts, 3, '本月按把次所属场次训练日期计算');

  // 最高难度：抱石 V 级单独一行，本档没有绳攀线路。
  assert.equal(page.data.boulderMaxGrade, 'V3');
  assert.equal(page.data.ropeMaxGrade, '');
  assert.equal(page.data.hasMaxGrade, true);

  // 地点按岩馆、类型按长期线路关联，同一分母。
  assert.deepEqual(page.data.gymRows, [
    { name: '据点的岩馆', count: 3, percentage: 100 }
  ]);
  assert.deepEqual(page.data.typeRows, [
    { name: '抱石', count: 3, percentage: 100 }
  ]);
  assert.equal(page.data.gymRows[0].name !== '', true);

  // 只读：进入统计不改动训练档案字节。
  assert.equal(bytesOf(ARCHIVE_KEY), archiveBefore, '进入统计不得改动训练档案');
  assert.equal(session.id, store.loadState().archive.activeSessionId);
  assert.equal(route.id !== '', true);
});

test('R1 断网、旧云拒绝、空数据都不遮挡也不覆盖本机数字', async () => {
  seedThreeAttempts();

  // 旧云拒绝权限。
  useCloudRecords(() => Promise.reject(Object.assign(new Error('denied'), { errCode: -502003 })));
  let page = openStats();
  await flush();
  assert.equal(page.data.legacyState, 'error');
  assert.match(page.data.legacyError, /没有访问旧记录的权限/);
  assert.equal(page.data.totalAttempts, 3, '旧云拒绝不得影响本机把数');
  assert.equal(page.data.sendCount, 1, '旧云拒绝不得影响本机完攀');

  // 旧云返回空集合。
  useCloudRecords(() => Promise.resolve({ data: [] }));
  page = openStats();
  await flush();
  assert.equal(page.data.legacyState, 'empty');
  assert.equal(page.data.legacyRecordCount, 0);
  assert.equal(page.data.totalAttempts, 3);
  assert.equal(page.data.sendCount, 1);

  // 断网 / 无云能力（用真实 db.getAllRecords）：可判别为云不可用。
  db.getAllRecords = realGetAllRecords;
  page = openStats();
  await flush();
  assert.equal(page.data.legacyState, 'error');
  assert.match(page.data.legacyError, /云环境不可用/);
  assert.equal(page.data.totalAttempts, 3);
  assert.equal(page.data.sendCount, 1);
});

test('R1 迟到的旧云回执只丢弃，不覆盖更新的旧云读数与本机数字', async () => {
  seedThreeAttempts();

  const queue = [];
  useCloudRecords(() => {
    const request = deferred();
    queue.push(request);
    return request.promise;
  });

  const page = openStats();
  await flush();
  page.onShow();
  await flush();
  assert.equal(queue.length, 2, '每次重读都要发起新的旧云请求');

  queue[1].resolve({ data: [{ _id: 'a', attempts: 5, status: '完成' }] });
  await flush();
  assert.equal(page.data.legacyState, 'ok');
  assert.equal(page.data.legacyRecordCount, 1);

  queue[0].resolve({ data: [{ _id: 'b' }, { _id: 'c' }, { _id: 'd' }] });
  await flush();
  assert.equal(page.data.legacyRecordCount, 1, '迟到的旧回执被丢弃');
  assert.equal(page.data.totalAttempts, 3, '旧云迟到不得改动本机把数');
  assert.equal(page.data.sendCount, 1);
});

// ------------------------------------------------------------------ *
// R2 更正、重试与重复进入
// ------------------------------------------------------------------ *

test('R2 把原完攀更正为未完成后：3 把、0 完攀、3 未完成、0%', async () => {
  const { sendId } = seedThreeAttempts();

  const corrected = store.correctAttempt(sendId, { now: FIXED_NOW });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.attempt.result, 'fail');
  const archiveAfter = bytesOf(ARCHIVE_KEY);

  const page = openStats();
  await flush();
  assert.equal(page.data.totalAttempts, 3, '更正只翻结果，不加把数');
  assert.equal(page.data.sendCount, 0);
  assert.equal(page.data.failCount, 3);
  assert.equal(page.data.completionRate, 0);
  assert.equal(page.data.monthAttempts, 3);
  assert.equal(bytesOf(ARCHIVE_KEY), archiveAfter, '只看统计不得改动更正结果');
});

test('R2 同一操作重试不产生额外把数，重开/刷新/切回读数一致', async () => {
  const { session, route } = seedThreeAttempts();

  // 同一 opId、同一内容重复提交（迟到回调/连点）。
  const retry = recordAttempt({ opId: 'op-send-1', sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.duplicate, true);
  assert.equal(store.loadState().archive.attempts.length, 3, '重试不得新增把次');

  const first = openStats();
  await flush();
  assert.equal(first.data.totalAttempts, 3);

  // 重开（新实例）一致。
  const reopened = openStats();
  await flush();
  assert.equal(reopened.data.totalAttempts, 3);
  assert.equal(reopened.data.sendCount, 1);

  // 下拉刷新一致，并且收起了下拉刷新。
  pullDownCount = 0;
  await reopened.onPullDownRefresh();
  assert.equal(pullDownCount, 1, '刷新后应结束下拉动画');
  assert.equal(reopened.data.totalAttempts, 3);
  assert.equal(reopened.data.sendCount, 1);

  // 切回 tab（onShow）一致。
  reopened.onShow();
  await flush();
  assert.equal(reopened.data.totalAttempts, 3);
  assert.equal(reopened.data.completionRate, 33);
});

test('R2 保存或更正 9c 自测成绩后，本机 3 把 0 完攀保持不变', async () => {
  const { sendId } = seedThreeAttempts();
  store.correctAttempt(sendId, { now: FIXED_NOW });

  // 先用真实自测模块存一份成绩，再用同一 testId 更正（更新）一次。
  const form = {
    date: store.todayLocalDate(),
    weightKg: '60',
    fingerState: 'untested',
    fingerExtraKg: '',
    pullState: 'untested',
    pullExtraKg: '',
    coreAction: '',
    coreSeconds: '',
    hangSeconds: ''
  };
  const saved = fitness.saveTest(form, { now: FIXED_NOW });
  assert.equal(saved.ok, true, saved.error);
  const updated = fitness.saveTest(Object.assign({}, form, { weightKg: '62' }), {
    testId: saved.record.id,
    now: FIXED_NOW
  });
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.code, 'updated');
  const fitnessBefore = bytesOf(FITNESS_KEY);
  assert.ok(fitnessBefore, '自测成绩应已落盘');

  // 只看统计页这一段读了什么键：置空读日志后再进入。
  io.reads = [];
  const page = openStats();
  await flush();
  assert.equal(page.data.totalAttempts, 3, '9c 成绩不计入本机把数');
  assert.equal(page.data.sendCount, 0, '9c 成绩不计入完攀');
  assert.equal(page.data.failCount, 3);
  assert.equal(page.data.completionRate, 0);
  assert.equal(bytesOf(FITNESS_KEY), fitnessBefore, '只看统计不得改动自测存储');
  assert.equal(io.reads.includes(FITNESS_KEY), false, '统计页不应读取 9c 自测存储');
});

// ------------------------------------------------------------------ *
// R3 归属、待保存与旧汇总
// ------------------------------------------------------------------ *

test('R3 跨日、同日多场、同色同级不同线路按原 ID 计数，未落盘的把次不计入', async () => {
  const today = store.todayLocalDate();
  const lastMonth = previousMonthDate();

  // 上月：一条抱石线两把（跨日回看，本月不计）。
  const pastSession = startSession('据点的岩馆', lastMonth);
  const pastRoute = addRoute(pastSession, { name: '上月抱石线', grade: 'V2' });
  assert.equal(recordAttempt({ opId: 'op-past-1', sessionId: pastSession.id, routeId: pastRoute.id, result: 'fail' }).ok, true);
  assert.equal(recordAttempt({ opId: 'op-past-2', sessionId: pastSession.id, routeId: pastRoute.id, result: 'send' }).ok, true);

  // 同日两场：第一场抱石一蓝一红同色同级但不同线路 ID，第二场顶绳。
  const sessionA = startSession('据点的岩馆', today);
  const blueRoute = addRoute(sessionA, { name: '蓝线 A', grade: 'V3', colorName: '蓝色' });
  const redRoute = addRoute(sessionA, { name: '红线 B', grade: 'V3', colorName: '蓝色' });
  assert.equal(recordAttempt({ opId: 'op-a-blue', sessionId: sessionA.id, routeId: blueRoute.id, result: 'fail' }).ok, true);
  assert.equal(recordAttempt({ opId: 'op-a-red', sessionId: sessionA.id, routeId: redRoute.id, result: 'send' }).ok, true);

  const sessionB = startSession('据点的岩馆', today);
  const ropeRoute = addRoute(sessionB, { name: '顶绳线 C', climbType: '顶绳', grade: '5.10a' });
  assert.equal(recordAttempt({ opId: 'op-b-rope', sessionId: sessionB.id, routeId: ropeRoute.id, result: 'fail' }).ok, true);

  // 未落盘：第二段提交失败，只留下「进行中」标记——这一把不得计入。
  armSetFailAt(2);
  const stranded = recordAttempt({ opId: 'op-stranded', sessionId: sessionB.id, routeId: ropeRoute.id, result: 'send' });
  assert.equal(stranded.ok, false, '第二段落盘失败不得报已保存');
  const raw = store.loadState().archive;
  assert.equal(raw.pendingSaves.length, 1, '失败的这一把留在待保存里');
  assert.equal(raw.attempts.some(item => item.id === 'op-stranded'), false, '未提交的把次不在已落盘把次里');
  io.setFailAt = 0;

  const page = openStats();
  await flush();

  // 已提交把次：上月 2（一未完成一完攀）+ 本日第一场 2（一未完成一完攀）+ 本日第二场 1（未完成）；
  // 提交失败的「op-stranded」不在其中。
  assert.equal(page.data.totalAttempts, 5, '只计已提交把次，未落盘的那一把不计入');
  assert.equal(page.data.sendCount, 2, '上月一把完攀与本日红线的完攀各算一把');
  assert.equal(page.data.failCount, 3);
  assert.equal(page.data.completionRate, 40);
  assert.equal(page.data.monthAttempts, 3, '本月只算本日那三把，上月不计入本月');
  assert.equal(page.data.monthCompletionRate, 33);

  // 同色同级不同线路按原线路 ID 分开计数：抱石（上月 2 + 本日 2）与顶绳各按原把次算。
  assert.deepEqual(page.data.typeRows, [
    { name: '抱石', count: 4, percentage: 80 },
    { name: '顶绳', count: 1, percentage: 20 }
  ]);
  assert.deepEqual(page.data.gymRows, [
    { name: '据点的岩馆', count: 5, percentage: 100 }
  ]);
  // 最高难度按 V 级与 YDS 分开：抱石 V3（上月 V2 更低）、绳攀 5.10a。
  assert.equal(page.data.boulderMaxGrade, 'V3');
  assert.equal(page.data.ropeMaxGrade, '5.10a');
});

test('R3 补上待保存的那一把后读数才 +1（重试用原 opId）', async () => {
  const today = store.todayLocalDate();
  const session = startSession('据点的岩馆', today);
  const route = addRoute(session, { name: '顶绳线', climbType: '顶绳', grade: '5.9' });
  assert.equal(recordAttempt({ opId: 'op-one', sessionId: session.id, routeId: route.id, result: 'fail' }).ok, true);

  armSetFailAt(2);
  assert.equal(recordAttempt({ opId: 'op-two', sessionId: session.id, routeId: route.id, result: 'send' }).ok, false);
  io.setFailAt = 0;

  const before = openStats();
  await flush();
  assert.equal(before.data.totalAttempts, 1, '未落盘的把次不计入');

  // 同一次操作带原场次、原线路、原结果重试：补齐那一把。
  const recovered = recordAttempt({ opId: 'op-two', sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(recovered.ok, true, recovered.error);

  const after = openStats();
  await flush();
  assert.equal(after.data.totalAttempts, 2);
  assert.equal(after.data.sendCount, 1);
  assert.equal(after.data.completionRate, 50);
});

test('R3 旧汇总「尝试 5 次、完成」仍可只读回看，本机数字不增加', async () => {
  seedThreeAttempts();
  const archiveBefore = bytesOf(ARCHIVE_KEY);

  // 旧云返回一条合成旧记录：统计页只报条数与来源，不拆把、不计入本机。
  useCloudRecords(() =>
    Promise.resolve({
      data: [{ _id: 'legacy-1', date: '2026-01-02', location: '旧岩馆', grade: 'V4', status: '完成', attempts: 5 }]
    })
  );

  const page = openStats();
  await flush();
  assert.equal(page.data.legacyState, 'ok');
  assert.equal(page.data.legacyRecordCount, 1);
  assert.equal(page.data.totalAttempts, 3, '旧汇总不得计入本机把数');
  assert.equal(page.data.sendCount, 1, '旧汇总不得计入本机完攀');
  assert.equal(bytesOf(ARCHIVE_KEY), archiveBefore, '回看旧汇总不得改动本机档案');

  // 旧记录的只读回看入口保持可用：仍能显示「尝试 5 次」与完成状态。
  const view = db.legacyRecordView({
    _id: 'legacy-1',
    date: '2026-01-02',
    location: '旧岩馆',
    grade: 'V4',
    status: '完成',
    attempts: 5
  });
  assert.equal(view.present, true);
  assert.equal(view.attempts, 5);
  assert.equal(view.attemptsText, '5 次');
  assert.match(view.summaryText, /尝试 5 次/);
  assert.match(view.readOnlyHint, /不计入本机训练统计/);
});

// ------------------------------------------------------------------ *
// R3 损坏档案与真实空档可区分
// ------------------------------------------------------------------ *

test('R3 损坏档案显示读取失败并保留原字节，与真实空档可区分', async () => {
  const corruptRaw = '{"version":1,"archiveId":"archive-broken"';
  writeLegacyArchive(corruptRaw);

  const page = openStats();
  await flush();
  assert.notEqual(page.data.archiveError, '', '损坏档案必须显示读取失败');
  assert.match(page.data.archiveError, /本机训练档案格式损坏/);
  assert.equal(page.data.isEmpty, true);
  assert.equal(page.data.totalAttempts, 0, '读不出来时不拿 0 冒充本机把数');
  assert.equal(bytesOf(ARCHIVE_KEY), corruptRaw, '损坏档案保持原字节，不被覆盖');

  // 版本不支持的档案同样报错且保留原字节。
  const unsupportedRaw = JSON.stringify({
    version: 99,
    archiveId: 'archive-v99',
    gyms: [],
    sessions: [],
    routes: [],
    attempts: []
  });
  writeLegacyArchive(unsupportedRaw);
  const unsupported = openStats();
  await flush();
  assert.match(unsupported.data.archiveError, /版本不受支持/);
  assert.equal(bytesOf(ARCHIVE_KEY), unsupportedRaw);

  // 真实空档（有档案但还没有把次）不报错：与损坏态可区分。
  storage.delete(ARCHIVE_KEY);
  const today = store.todayLocalDate();
  const session = startSession('据点的岩馆', today);
  addRoute(session, { name: '还没记的线' });
  const emptyButPresent = bytesOf(ARCHIVE_KEY);
  const empty = openStats();
  await flush();
  assert.equal(empty.data.archiveError, '', '真实空档不应报读取失败');
  assert.equal(empty.data.isEmpty, true);
  assert.equal(empty.data.totalAttempts, 0);
  assert.equal(bytesOf(ARCHIVE_KEY), emptyButPresent, '只读空档不得改动档案');
});

// ------------------------------------------------------------------ *
// R4 只读：训练、自测、照片索引与原图逐字节不变
// ------------------------------------------------------------------ *

test('R4 馆名是用户输入：constructor、__proto__ 与普通馆名各按自己的名字记一把', async () => {
  const names = ['constructor', '__proto__', '据点的岩馆'];
  names.forEach((name, index) => {
    const session = startSession(name, '2026-11-09');
    const route = addRoute(session, { name: '线路 ' + (index + 1) });
    const saved = recordAttempt({
      opId: 'op-gym-' + index,
      sessionId: session.id,
      routeId: route.id,
      result: 'fail'
    });
    assert.equal(saved.ok, true, saved.error);
  });

  const page = openStats();
  await flush();

  // 把数按把次计，与馆名无关。
  assert.equal(page.data.totalAttempts, 3, '三个馆各记一把');
  assert.equal(page.data.sendCount, 0);
  assert.equal(page.data.failCount, 3);

  // 每个馆名各有一行真实数字与自己的名字：继承键（constructor、__proto__）不参与计数，
  // 不会把某个馆顶掉，也不会显示成函数字串；同数量时仍按名字稳定排序。
  assert.deepEqual(page.data.gymRows, [
    { name: '__proto__', count: 1, percentage: 33 },
    { name: 'constructor', count: 1, percentage: 33 },
    { name: '据点的岩馆', count: 1, percentage: 33 }
  ]);
  page.data.gymRows.forEach(row => {
    assert.equal(typeof row.count, 'number');
    assert.equal(Number.isInteger(row.count), true);
    assert.equal(/function|native code/.test(row.name), false, '不得把继承来的函数当成馆名');
  });
  assert.equal(page.data.typeRows.length, 1, '类型分布不受馆名影响');
  assert.equal(page.data.typeRows[0].count, 3);
});

test('R4 只进入、刷新、离开统计后，训练/自测/照片索引与原图都不变', async () => {
  const { session, route } = seedThreeAttempts();

  // 合成一份自测成绩与照片索引（受保护键），并记录进入前的字节。
  const fitnessSaved = fitness.saveTest(
    {
      date: store.todayLocalDate(),
      weightKg: '60',
      fingerState: 'untested',
      fingerExtraKg: '',
      pullState: 'untested',
      pullExtraKg: '',
      coreAction: '',
      coreSeconds: '',
      hangSeconds: ''
    },
    { now: FIXED_NOW }
  );
  assert.equal(fitnessSaved.ok, true, fitnessSaved.error);
  const photosIndex = JSON.stringify({
    version: 1,
    archiveId: 'archive-photos',
    photos: [
      { routeId: route.id, filePath: 'wxfile://store/photos/route-1.jpg', updatedAt: '2026-11-09T00:00:00.000Z' }
    ]
  });
  storage.set(PHOTOS_KEY, photosIndex);

  const archiveBefore = bytesOf(ARCHIVE_KEY);
  const fitnessBefore = bytesOf(FITNESS_KEY);
  const photosBefore = bytesOf(PHOTOS_KEY);
  const sessionsBefore = JSON.stringify(store.loadState().archive.sessions);
  const writesBefore = io.setCount;
  const keysBefore = [...storage.keys()].sort();

  // 进入 → 刷新 → 切回 → 离开。
  const page = openStats();
  await flush();
  page.onShow();
  await flush();
  await page.onPullDownRefresh();
  if (typeof page.onHide === 'function') page.onHide();
  if (typeof page.onUnload === 'function') page.onUnload();
  await flush();

  assert.equal(bytesOf(ARCHIVE_KEY), archiveBefore, '训练档案逐字节不变');
  assert.equal(bytesOf(FITNESS_KEY), fitnessBefore, '自测存储逐字节不变');
  assert.equal(bytesOf(PHOTOS_KEY), photosBefore, '照片索引逐字节不变');
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.loadState().archive.sessions)),
    JSON.parse(sessionsBefore),
    '场次归属不变'
  );
  assert.equal(io.setCount, writesBefore, '统计页不得写本地存储');
  assert.equal(io.removals.length, 0, '统计页不得删除任何键');
  assert.equal(io.fsCalls.length, 0, '统计页不得访问文件系统（原图不动）');
  assert.deepEqual([...storage.keys()].sort(), keysBefore, '键集合不变');
  assert.equal(page.data.totalAttempts, 3);
  assert.equal(page.data.sendCount, 1);
  assert.equal(session.id !== '', true);
  assert.equal(page.data.gymRows[0].count, 3);
});
