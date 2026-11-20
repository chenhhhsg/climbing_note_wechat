/**
 * T058 R3 首页旧云记录状态互斥与可重试（离线部分）
 *
 * 直接加载正式首页 pages/index/index.js，用隔离云替身驱动真实页面处理器：
 * - 旧记录区四态互斥：loading / error / 成功空 / 成功有数据；
 * - 失败显示 utils/db.js 既有分类的原原因并保留重试，绝不显示「还没有旧记录」；
 * - 首次进入（onLoad + 首次 onShow）只发一次请求，返回首页可刷新；
 * - 迟到失败不覆盖更新的成功数据；本机训练入口始终独立可操作；
 * - getApp().globalData.cloudReady === false 时首次进入直接给可重试的不可用状态，
 *   但重试始终实际请求，仍由 db 区分不可用、拒绝与临时网络失败。
 *
 * 这里不提供 wx.cloud、不读取真实云环境或账号；真实云权限、原生渲染与手机实测待验。
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
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const storage = new Map();
const wxLog = { navigations: [], switches: [] };

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
  stopPullDownRefresh() {}
};

let appState = { globalData: { cloudReady: true } };
global.getApp = () => appState;

const db = require(DB_JS);
const store = require(STORE_JS);
const realGetRecentRecords = db.getRecentRecords;

let indexDefinition = null;
let cloudCalls = 0;

function resetAll() {
  storage.clear();
  wxLog.navigations = [];
  wxLog.switches = [];
  appState = { globalData: { cloudReady: true } };
  cloudCalls = 0;
  db.getRecentRecords = realGetRecentRecords;
}

beforeEach(() => {
  resetAll();
  indexDefinition = capturePage(INDEX_JS);
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
