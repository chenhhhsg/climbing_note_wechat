/**
 * T058 R3 首页旧云记录状态互斥与可重试（离线部分）
 * T060 R5 旧云表单保存成功后的终态（离线部分）
 * T061 R6 旧云总量 count 查询（离线部分）
 *
 * 直接加载正式首页 pages/index/index.js，用隔离云替身驱动真实页面处理器：
 * - 旧记录区四态互斥：loading / error / 成功空 / 成功有数据；
 * - 失败显示 utils/db.js 既有分类的原原因并保留重试，绝不显示「还没有旧记录」；
 * - 首次进入（onLoad + 首次 onShow）只发一次请求，返回首页可刷新；
 * - 迟到失败不覆盖更新的成功数据；本机训练入口始终独立可操作；
 * - getApp().globalData.cloudReady === false 时首次进入直接给可重试的不可用状态，
 *   但重试始终实际请求，仍由 db 区分不可用、拒绝与临时网络失败。
 *
 * 同时直接加载正式旧云表单 pages/add-record/add-record.js，只用合成云替身：
 * - 写入成功后提交锁定，连点零写，只会排一次延迟返回；
 * - 返回失败保留锁定并给出显式重试返回，重试返回不重复上传或写库；
 * - 页面卸载取消已排队的返回计划，离开后不再弹回；
 * - 明确失败不锁定、不删除已上传文件，原输入保留并可原地重试。
 *
 * 这里不提供真实 wx.cloud、不读取真实云环境或账号；仅 R6 在文件末尾装入合成 count
 * 替身来核对总量查询，真实云权限、原生渲染与手机实测待验。
 *
 * 运行：node --test tests/review-legacy-cloud.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const INDEX_WXML = path.join(ROOT, 'pages', 'index', 'index.wxml');
const ADD_RECORD_JS = path.join(ROOT, 'pages', 'add-record', 'add-record.js');
const ADD_RECORD_WXML = path.join(ROOT, 'pages', 'add-record', 'add-record.wxml');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const storage = new Map();
const wxLog = {
  navigations: [],
  switches: [],
  backs: [],
  toasts: [],
  loading: 0,
  hiddenLoading: 0
};
let navigateBackImpl = null;

global.wx = {
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
    return { keys: Array.from(storage.keys()) };
  },
  navigateTo(options) {
    wxLog.navigations.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  navigateBack(options) {
    wxLog.backs.push(options || {});
    if (navigateBackImpl) navigateBackImpl(options || {});
  },
  showLoading() {
    wxLog.loading += 1;
  },
  hideLoading() {
    wxLog.hiddenLoading += 1;
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  stopPullDownRefresh() {}
};

function freshAppState() {
  return {
    globalData: {
      cloudReady: true,
      climbTypes: ['抱石', '先锋攀', '顶绳攀', '室内', '室外'],
      statusOptions: ['完成', '未完成', '挂片', '红点']
    }
  };
}

let appState = freshAppState();
global.getApp = () => appState;

const db = require(DB_JS);
const store = require(STORE_JS);
const realGetRecentRecords = db.getRecentRecords;
const realAddRecord = db.addRecord;
const realUploadImage = db.uploadImage;
const realDeleteImage = db.deleteImage;

let indexDefinition = null;
let addRecordDefinition = null;
let cloudCalls = 0;
let writeLog = null;

function resetAll() {
  storage.clear();
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.backs = [];
  wxLog.toasts = [];
  wxLog.loading = 0;
  wxLog.hiddenLoading = 0;
  navigateBackImpl = null;
  appState = freshAppState();
  cloudCalls = 0;
  db.getRecentRecords = realGetRecentRecords;
  db.addRecord = realAddRecord;
  db.uploadImage = realUploadImage;
  db.deleteImage = realDeleteImage;
  writeLog = { addRecord: 0, uploads: 0, deletes: 0, lastRecord: null };
}

beforeEach(() => {
  resetAll();
  indexDefinition = capturePage(INDEX_JS);
  addRecordDefinition = capturePage(ADD_RECORD_JS);
});

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

/** 页面实例替身：支持 wx 的 setData 数据路径写法。 */
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

function openHome() {
  const page = createPage(indexDefinition);
  page.onLoad();
  return page;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

async function flush(rounds) {
  const count = typeof rounds === 'number' ? rounds : 10;
  for (let index = 0; index < count; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** 本机训练档案：只写正式命名空间，用来核对训练入口与云状态无关。 */
function seedTraining(gymName) {
  const started = store.startSession({
    gymName: gymName || '隔离岩馆',
    now: new Date(2026, 10, 20, 9, 0, 0)
  });
  assert.equal(started.ok, true, started.error);
}

function stubCloud(handler) {
  db.getRecentRecords = () => {
    cloudCalls += 1;
    return handler(cloudCalls);
  };
}

// ------------------------------------------------------------------ 状态互斥

test('R3 不可用：失败只显示不可用原因与重试，不显示空态，本机训练仍可操作', async () => {
  seedTraining('断网岩馆');
  stubCloud(() => Promise.reject(Object.assign(
    new Error('云开发不可用'),
    { code: db.CLOUD_UNAVAILABLE }
  )));

  const home = openHome();
  await flush();

  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.cloudErrorKind, 'unavailable');
  assert.match(home.data.cloudError, /旧记录暂不可读（云环境不可用）/);
  assert.equal(home.data.isEmpty, false, '失败不得落成空态');
  assert.equal(home.data.loading, false);
  assert.equal(home.data.recentRecords.length, 0);

  // 本机训练入口只读本机档案，失败不改它。
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.gymName, '断网岩馆');
  home.startTraining();
  assert.equal(wxLog.navigations.at(-1).url, '/pages/training-session/training-session?start=1');
});

test('R3 拒绝：直接使用 db 既有数字错误码分类，不另造错误语义', async () => {
  stubCloud(() => Promise.reject({
    errCode: -502003,
    errMsg: 'database permission denied'
  }));

  const home = openHome();
  await flush();

  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.cloudErrorKind, 'denied');
  assert.match(home.data.cloudError, /没有访问旧记录的权限/);
  assert.equal(home.data.isEmpty, false);
});

test('R3 临时网络失败：显示可重试原因，重试成功后有数据', async () => {
  stubCloud(call => {
    if (call === 1) {
      return Promise.reject({ errMsg: 'request:fail timeout' });
    }
    return Promise.resolve({
      data: [{ _id: 'rec-retry', date: '2026-11-20', location: '重试岩馆' }]
    });
  });

  const home = openHome();
  await flush();

  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.cloudErrorKind, 'failed');
  assert.match(home.data.cloudError, /读取旧记录失败/);
  assert.match(home.data.cloudError, /请检查网络后重试/);
  assert.equal(home.data.isEmpty, false);
  assert.equal(typeof home.retryRecentRecords, 'function');

  await home.retryRecentRecords();
  await flush();

  assert.equal(cloudCalls, 2);
  assert.equal(home.data.cloudState, 'ok');
  assert.equal(home.data.loading, false);
  assert.equal(home.data.isEmpty, false);
  assert.equal(home.data.cloudError, '');
  assert.equal(home.data.cloudErrorKind, '');
  assert.equal(home.data.recentRecords.length, 1);
  assert.equal(home.data.recentRecords[0]._id, 'rec-retry');
});

test('R3 成功空：只有成功且确实为空才进入空态', async () => {
  stubCloud(() => Promise.resolve({ data: [] }));

  const home = openHome();
  await flush();

  assert.equal(home.data.cloudState, 'ok');
  assert.equal(home.data.loading, false);
  assert.equal(home.data.isEmpty, true);
  assert.equal(home.data.recentRecords.length, 0);
  assert.equal(home.data.cloudError, '');
});

// ------------------------------------------------------------------ 生命周期与迟到回执

test('R3 首次进入只发一次请求，返回首页刷新一次', async () => {
  stubCloud(call => Promise.resolve({
    data: [{
      _id: call === 1 ? 'rec-first' : 'rec-return',
      date: '2026-11-20'
    }]
  }));

  const home = openHome();
  home.onShow(); // 真实生命周期：onLoad 之后紧跟首次 onShow
  await flush();

  assert.equal(cloudCalls, 1, '首次进入只允许一次读取');
  assert.equal(home.data.recentRecords[0]._id, 'rec-first');

  home.onShow(); // 从别的页面返回
  await flush();

  assert.equal(cloudCalls, 2, '返回首页应刷新一次');
  assert.equal(home.data.recentRecords[0]._id, 'rec-return');
  assert.equal(home.data.cloudState, 'ok');
});

test('R3 过时失败不覆盖更新后的成功数据', async () => {
  const first = deferred();
  const second = deferred();
  stubCloud(call => (call === 1 ? first.promise : second.promise));

  const home = createPage(indexDefinition);
  const firstTask = home.loadRecentRecords();
  const secondTask = home.loadRecentRecords();

  second.resolve({ data: [{ _id: 'rec-new', date: '2026-11-20' }] });
  await secondTask;
  assert.equal(home.data.cloudState, 'ok');
  assert.equal(home.data.recentRecords[0]._id, 'rec-new');

  first.reject({ errMsg: 'request:fail timeout' });
  await firstTask;

  assert.equal(home.data.cloudState, 'ok', '迟到失败不能把成功状态改成失败');
  assert.equal(home.data.cloudError, '');
  assert.equal(home.data.recentRecords.length, 1);
  assert.equal(home.data.recentRecords[0]._id, 'rec-new');
});

test('R3 本机训练入口在晚到的失败之后仍保持可操作', async () => {
  seedTraining('迟到岩馆');
  const pending = deferred();
  stubCloud(() => pending.promise);

  const home = openHome();
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);

  pending.reject({ errMsg: 'request:fail timeout' });
  await flush();

  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.gymName, '迟到岩馆');
  home.continueTraining();
  assert.equal(wxLog.navigations.at(-1).url, '/pages/training-session/training-session');
});

// ------------------------------------------------------------------ getApp 云状态

test('R3 getApp 明确不可用时首次进入不发请求，重试仍实际请求并可恢复', async () => {
  appState = { globalData: { cloudReady: false } };
  stubCloud(() => Promise.resolve({ data: [{ _id: 'rec-back', date: '2026-11-20' }] }));

  const home = openHome();
  await flush();

  assert.equal(cloudCalls, 0, '已明确云不可用时不重复发起首次请求');
  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.cloudErrorKind, 'unavailable');
  assert.equal(home.data.isEmpty, false);

  await home.retryRecentRecords();
  await flush();

  assert.equal(cloudCalls, 1, '重试必须真实发起请求');
  assert.equal(home.data.cloudState, 'ok');
  assert.equal(home.data.recentRecords[0]._id, 'rec-back');
});

test('R3 getApp 没给出 cloudReady 时仍发一次请求，并保留 db 分类', async () => {
  appState = { globalData: {} };
  stubCloud(() => Promise.reject({ errMsg: 'request:fail timeout' }));

  const home = openHome();
  await flush();

  assert.equal(cloudCalls, 1);
  assert.equal(home.data.cloudState, 'error');
  assert.equal(home.data.cloudErrorKind, 'failed');
  assert.match(home.data.cloudError, /请检查网络后重试/);
});

// ------------------------------------------------------------------ 模板互斥与绑定

test('R3 模板四态互斥，重试按钮有真实处理器，不保留无条件的空态/列表分支', () => {
  const source = fs.readFileSync(INDEX_WXML, 'utf8');

  assert.ok(source.indexOf('id="cloud-loading"') !== -1);
  assert.ok(source.indexOf('id="cloud-error"') !== -1);
  assert.ok(source.indexOf('id="cloud-empty"') !== -1);
  assert.ok(source.indexOf('id="cloud-records"') !== -1);
  assert.ok(source.indexOf('bindtap="retryRecentRecords"') !== -1);
  assert.equal(typeof indexDefinition.retryRecentRecords, 'function');

  // 空态与列表都必须显式以 cloudState === 'ok' 为条件，失败不可能落进去。
  assert.match(source, /wx:elif="\{\{cloudState === 'ok' && isEmpty\}\}"/);
  assert.match(source, /wx:elif="\{\{cloudState === 'ok'\}\}"/);
  assert.equal(source.indexOf('wx:if="{{isEmpty}}"'), -1);
  assert.equal(source.indexOf('wx:else class="record-list"'), -1);
});

// ------------------------------------------------------------------ T060 R5 旧云表单终态

function openAddRecord() {
  const page = createPage(addRecordDefinition);
  page.onLoad();
  return page;
}

/** 合成云替身：只统计页面实际发起的上传、写库与删除调用。 */
function stubWrites(options) {
  const opts = options || {};
  db.uploadImage = (filePath) => {
    writeLog.uploads += 1;
    if (opts.upload) return opts.upload(filePath, writeLog.uploads);
    return Promise.resolve({ fileID: 'cloud://synthetic/' + writeLog.uploads + '.jpg' });
  };
  db.addRecord = (record) => {
    writeLog.addRecord += 1;
    writeLog.lastRecord = record;
    if (opts.addRecord) return opts.addRecord(writeLog.addRecord, record);
    return Promise.resolve({ _id: 'synthetic-' + writeLog.addRecord });
  };
  db.deleteImage = () => {
    writeLog.deletes += 1;
    return Promise.resolve({});
  };
}

test('R5 合成云成功后连点：云写入与延迟返回各一次，提交进入终态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubWrites();

  const page = openAddRecord();
  page.setData({
    location: '终态岩馆',
    images: ['wxfile://tmp-a.jpg', 'wxfile://tmp-b.jpg'],
    notes: '终态备注',
    attempts: 3
  });

  const first = page.submitForm();
  const second = page.submitForm(); // 保存中连点
  await Promise.all([first, second]);
  await flush();

  assert.equal(writeLog.uploads, 2, '既有上传路径每张图只上传一次');
  assert.equal(writeLog.addRecord, 1, '实际云写入只发生一次');
  assert.equal(page.data.saveState, 'saved');
  assert.equal(page.data.isSubmitting, false);
  assert.equal(page.data.returnFailed, false);
  assert.equal(wxLog.toasts.filter(item => item.title === '保存成功').length, 1);

  // 成功终态后的连点既不补写，也不叠加返回计划。
  await page.submitForm();
  await page.submitForm();
  await page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1);
  assert.equal(writeLog.uploads, 2);

  assert.equal(wxLog.backs.length, 0, '延迟返回到点前不返回');
  t.mock.timers.tick(1499);
  assert.equal(wxLog.backs.length, 0);
  t.mock.timers.tick(1);
  assert.equal(wxLog.backs.length, 1, '延迟返回只执行一次');
  assert.equal(wxLog.backs[0].delta, 1);

  page.onUnload();
  t.mock.timers.tick(5000);
  assert.equal(wxLog.backs.length, 1, '卸载后不再排返回');
  assert.equal(writeLog.deletes, 0, '本任务不调用云删除');
});

test('R5 返回失败：保存仍锁定，可显式重试返回且零重复写', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubWrites();
  navigateBackImpl = (options) => {
    if (wxLog.backs.length === 1) {
      if (typeof options.fail === 'function') options.fail({ errMsg: 'navigateBack:fail' });
      return;
    }
    if (typeof options.success === 'function') options.success({});
  };

  const page = openAddRecord();
  page.setData({ location: '返回失败岩馆' });

  await page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1);

  t.mock.timers.tick(1500);
  assert.equal(wxLog.backs.length, 1);
  assert.equal(page.data.returnFailed, true);
  assert.equal(page.data.saveState, 'saved');
  assert.equal(page.data.isSubmitting, false);
  assert.equal(wxLog.toasts.at(-1).title, '已保存，返回失败');

  // 锁定状态下的连点仍然零写。
  await page.submitForm();
  await page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1);
  assert.equal(writeLog.uploads, 0);

  // 显式重试返回：只重试页面返回，不重复上传或写库。
  page.retryReturn();
  assert.equal(wxLog.backs.length, 2);
  assert.equal(writeLog.addRecord, 1);
  assert.equal(writeLog.uploads, 0);
  assert.equal(page.data.saveState, 'saved');
  assert.equal(writeLog.deletes, 0);
});

test('R5 离开页面取消返回计划：卸载后定时器不再弹回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubWrites();

  const page = openAddRecord();
  page.setData({ location: '卸载岩馆' });
  await page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1);
  assert.equal(page.data.saveState, 'saved');

  page.onUnload();
  t.mock.timers.tick(5000);

  assert.equal(wxLog.backs.length, 0, '卸载应清掉已排队的返回');
  assert.equal(writeLog.addRecord, 1);
});

test('R5 明确失败可原地重试：原输入与上传路径保持，不删除云文件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubWrites({
    addRecord: (call) => {
      if (call === 1) return Promise.reject({ errCode: -1, errMsg: 'request:fail 写入失败' });
      return Promise.resolve({ _id: 'synthetic-retry' });
    }
  });

  const page = openAddRecord();
  page.setData({
    location: '重试岩馆',
    notes: '原备注',
    attempts: 4,
    images: ['wxfile://tmp-a.jpg']
  });

  await page.submitForm();
  await flush();

  assert.equal(writeLog.addRecord, 1);
  assert.equal(writeLog.uploads, 1);
  assert.equal(page.data.saveState, '', '明确失败不是终态');
  assert.equal(page.data.isSubmitting, false);
  assert.equal(page.data.location, '重试岩馆');
  assert.equal(page.data.notes, '原备注');
  assert.equal(page.data.attempts, 4);
  assert.deepEqual(page.data.images, ['wxfile://tmp-a.jpg']);
  assert.equal(wxLog.toasts.at(-1).title, '保存失败');
  assert.equal(writeLog.deletes, 0, '失败不删除已上传文件');
  assert.equal(wxLog.backs.length, 0);

  await page.submitForm();
  await flush();

  assert.equal(writeLog.addRecord, 2, '明确失败后重试原表单');
  assert.equal(writeLog.uploads, 2, '重试仍走同一条既有上传路径');
  assert.equal(page.data.saveState, 'saved');
  assert.deepEqual(writeLog.lastRecord.images, ['cloud://synthetic/2.jpg']);

  t.mock.timers.tick(1500);
  assert.equal(wxLog.backs.length, 1);
  assert.equal(writeLog.deletes, 0);
});

test('R5 模板保留旧表单并绑定终态锁定与显式返回', () => {
  const source = fs.readFileSync(ADD_RECORD_WXML, 'utf8');

  assert.ok(source.includes('id="submit-record"'));
  assert.match(source, /disabled="\{\{isSubmitting \|\| saveState === 'saved'\}\}"/);
  assert.ok(source.includes('id="return-failed"'));
  assert.match(source, /wx:if="\{\{returnFailed\}\}"/);
  assert.ok(source.includes('id="retry-return"'));
  assert.ok(source.includes('bindtap="retryReturn"'));

  // 旧表单入口与既有结构保持。
  assert.ok(source.includes('bindtap="submitForm"'));
  assert.ok(source.includes('bindtap="chooseImage"'));
  assert.ok(source.includes('bindtap="previewImage"'));
  assert.ok(source.includes('catchtap="deleteImage"'));

  assert.equal(typeof addRecordDefinition.retryReturn, 'function');
  assert.equal(typeof addRecordDefinition.goBackAfterSave, 'function');
  assert.equal(typeof addRecordDefinition.onUnload, 'function');

  // 未保存时显式返回不生效，避免无记录时误触发返回。
  const page = openAddRecord();
  page.retryReturn();
  assert.equal(wxLog.backs.length, 0);
});

test('R5 卸载后迟到的写入成功：不落终态、不弹提示、不再排返回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const write = deferred();
  stubWrites({ addRecord: () => write.promise });

  const page = openAddRecord();
  page.setData({ location: '迟到成功岩馆' });

  const submitting = page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1, '写入在页面存活时发起');

  // 页面先卸载，之后写入才成功返回。
  page.onUnload();
  write.resolve({ _id: 'synthetic-late' });
  await submitting;
  await flush();

  assert.equal(page.data.saveState, '', '卸载后迟到的成功不再落终态');
  assert.equal(page.data.returnFailed, false, '卸载后不再改 UI 状态');
  assert.equal(
    wxLog.toasts.filter(item => item.title === '保存成功').length,
    0,
    '卸载后不再弹保存成功提示'
  );

  t.mock.timers.tick(5000);
  assert.equal(wxLog.backs.length, 0, '卸载后不再创建新的返回计划');
  assert.equal(writeLog.addRecord, 1, '迟到的成功不产生第二次写库');
});

test('R5 返回失败后连点重试：同一时刻只保留一个在飞原生返回请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubWrites();

  // 原生回调保持未决，用来观察连点重试是否叠加请求。
  const pending = [];
  navigateBackImpl = options => {
    pending.push(options);
  };

  const page = openAddRecord();
  page.setData({ location: '单飞岩馆' });

  await page.submitForm();
  await flush();
  assert.equal(writeLog.addRecord, 1);

  // 首次延迟返回发出，原生回调未决；随后回调失败。
  t.mock.timers.tick(1500);
  assert.equal(wxLog.backs.length, 1);
  assert.equal(pending.length, 1);
  pending[0].fail({ errMsg: 'navigateBack:fail' });
  assert.equal(page.data.returnFailed, true);
  assert.equal(page.data.saveState, 'saved');

  // 失败回调后快速连点三次：回调仍未决，只允许一个在飞的原生返回请求。
  page.retryReturn();
  page.retryReturn();
  page.retryReturn();
  assert.equal(wxLog.backs.length, 2, '连点重试只发起一次原生返回');
  assert.equal(pending.length, 2);

  // 在飞请求失败后解除单飞，才允许下一次显式重试。
  pending[1].fail({ errMsg: 'navigateBack:fail' });
  page.retryReturn();
  assert.equal(wxLog.backs.length, 3);

  assert.equal(writeLog.addRecord, 1, '重试返回全程零重复写');
  assert.equal(writeLog.uploads, 0);
  assert.equal(writeLog.deletes, 0);
});

// ------------------------------------------------------------------ T061 R6 旧云总量
//
// db.getRecordsCount 与旧记录读取使用同一个集合、同一份授权范围，但只调用 count()，
// 不拉取记录列表（getAllRecords 单批最多 20，看不到 37）。本段在文件末尾装入合成
// wx.cloud 替身，记录集合名与 count/get 调用次数；不读取真实云环境或账号。

function installSyntheticCloud() {
  const box = {
    response: { total: 0 },
    reject: null,
    collectionNames: [],
    countCalls: 0,
    listCalls: 0
  };
  global.wx.cloud = {
    database() {
      return {
        collection(name) {
          box.collectionNames.push(name);
          return {
            count() {
              box.countCalls += 1;
              if (box.reject) return Promise.reject(box.reject);
              return Promise.resolve(box.response);
            },
            orderBy() { box.listCalls += 1; return this; },
            skip() { box.listCalls += 1; return this; },
            limit() { box.listCalls += 1; return this; },
            get() { box.listCalls += 1; return Promise.resolve({ data: [] }); }
          };
        }
      };
    }
  };
  return box;
}

// db 会惰性缓存实例与集合：首个 R6 用例装入替身后，后续用例复用同一个盒子，
// 只重置响应与计数，避免缓存指向旧替身。这样前面用例仍保持「不提供 wx.cloud」。
let countCloudBox = null;

function resetCountCloud() {
  if (!countCloudBox) countCloudBox = installSyntheticCloud();
  countCloudBox.response = { total: 0 };
  countCloudBox.reject = null;
  countCloudBox.collectionNames.length = 0;
  countCloudBox.countCalls = 0;
  countCloudBox.listCalls = 0;
  return countCloudBox;
}

test('R6 旧云总量只走同一集合的 count 查询，0/1/37 原样返回且不拉取列表', async () => {
  const box = resetCountCloud();

  // 同一集合、同一授权范围：沿用旧记录集合，不换集合、不加额外的筛选。
  for (const total of [0, 1, 37]) {
    box.response = { total: total };
    assert.equal(await db.getRecordsCount(), total, '0/1/37 都按真实 total 返回');
  }
  assert.equal(box.countCalls, 3, '每次总量各发起一次 count');
  assert.equal(box.listCalls, 0, '不调用 orderBy/skip/limit/get，未拉取记录列表');
  assert.deepEqual(box.collectionNames, ['climbing_records'], '仍是旧记录同一个集合');
});

test('R6 count 响应不是非负整数时按读取失败拒绝，不拿 0 冒充', async () => {
  const box = resetCountCloud();

  for (const bad of [{ total: '37' }, { total: -1 }, { total: 1.5 }, { total: NaN }, {}]) {
    box.response = bad;
    await assert.rejects(
      () => db.getRecordsCount(),
      error => error.code === db.COUNT_INVALID_CODE,
      '不可识别的 total 必须拒绝：' + JSON.stringify(bad)
    );
    assert.equal(db.describeCloudError({ code: db.COUNT_INVALID_CODE, message: '旧云记录总数响应无法识别' }).kind, 'failed');
  }
  assert.equal(box.listCalls, 0, '非法响应也不回退到列表读取');
});

test('R6 count 的无权限与网络失败保留 db 既有分类，下一次可重试', async () => {
  const box = resetCountCloud();

  box.reject = Object.assign(new Error('denied'), { errCode: -502003 });
  await assert.rejects(
    () => db.getRecordsCount(),
    error => db.describeCloudError(error).kind === 'denied'
  );

  box.reject = { errMsg: 'request:fail timeout' };
  await assert.rejects(
    () => db.getRecordsCount(),
    error => db.describeCloudError(error).kind === 'failed'
  );

  // 恢复后重试成功，错误不粘住。
  box.reject = null;
  box.response = { total: 37 };
  assert.equal(await db.getRecordsCount(), 37);
  assert.equal(box.countCalls, 3);
  assert.equal(box.listCalls, 0);
});
