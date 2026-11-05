/**
 * 记录列表页面回归测试（L01–L07、R1）
 *
 * 直接加载真实页面文件，捕获 Page(...) 定义，替换 utils/db 的响应，
 * 用可手动完成的 Promise 控制请求完成顺序。
 *
 * 运行：node --test tests/record-list.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PAGE_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const PAGE_WXML = path.join(ROOT, 'pages', 'record-list', 'record-list.wxml');
const PAGE_JSON = path.join(ROOT, 'pages', 'record-list', 'record-list.json');
const DB_JS = path.join(ROOT, 'utils', 'db.js');

// ---- wx 模拟：必须在加载 utils/db.js 之前就绪 ----
const wxLog = {
  stopPullDownRefresh: 0,
  toasts: [],
  navigations: []
};

global.wx = {
  cloud: {
    database() {
      return {
        serverDate: () => new Date('2026-01-01T00:00:00.000Z'),
        collection() {
          return {
            orderBy() { return this; },
            skip() { return this; },
            limit() { return this; },
            get() { return Promise.resolve({ data: [] }); },
            doc() {
              return {
                get() { return Promise.resolve({ data: {} }); },
                remove() { return Promise.resolve({}); }
              };
            },
            add() { return Promise.resolve({ _id: 'mock-id' }); }
          };
        }
      };
    },
    uploadFile() { return Promise.resolve({ fileID: 'cloud://mock.jpg' }); },
    deleteFile() { return Promise.resolve({}); }
  },
  stopPullDownRefresh() { wxLog.stopPullDownRefresh += 1; },
  showToast(options) { wxLog.toasts.push(options); },
  navigateTo(options) { wxLog.navigations.push(options); },
  showModal() {},
  showLoading() {},
  hideLoading() {}
};

function resetWxLog() {
  wxLog.stopPullDownRefresh = 0;
  wxLog.toasts = [];
  wxLog.navigations = [];
}

// 真实 db 模块在载入时调用 wx.cloud.database()，随后只替换 getRecords 响应。
const db = require(DB_JS);
let currentGetRecords = () => Promise.resolve({ data: [] });
db.getRecords = (page, pageSize) => currentGetRecords(page, pageSize);

// 捕获原生 Page(...) 定义
let pageDefinition = null;
global.Page = definition => {
  pageDefinition = definition;
};
require(PAGE_JS);

function createPage() {
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

function useDb(handler) {
  const calls = [];
  currentGetRecords = (page, pageSize) => {
    calls.push({ page, pageSize });
    return handler(page, pageSize, calls.length);
  };
  return calls;
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

function makeRecord(id, overrides = {}) {
  return {
    _id: id,
    date: '2026-01-02',
    location: '岩馆',
    climbType: '抱石',
    grade: 'V3',
    status: '完成',
    attempts: 3,
    notes: `备注-${id}`,
    images: [`cloud://${id}.jpg`],
    ...overrides
  };
}

function idsOf(page) {
  return page.data.records.map(record => record._id);
}

// ---- L01 ----
test('L01 首次进入 onLoad/onShow 只请求一次第一页并显示空态', async () => {
  resetWxLog();
  const calls = useDb(() => Promise.resolve({ data: [] }));
  const page = createPage();

  page.onLoad();
  assert.equal(calls.length, 0, 'onLoad 不应发起请求');

  await page.onShow();

  assert.deepEqual(calls, [{ page: 1, pageSize: 20 }]);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.isEmpty, true);
  assert.equal(page.data.loadError, false);
  assert.equal(page.data.records.length, 0);
});

// ---- L02 ----
test('L02 保留旧记录字段并按原 _id 打开现有详情页', async () => {
  resetWxLog();
  const original = makeRecord('rec-1', {
    date: '2026-02-03',
    location: '岩馆 A',
    grade: 'V5',
    attempts: 7,
    notes: '脚点很滑，最后一步换手',
    images: ['cloud://photo-1.jpg', 'cloud://photo-2.jpg']
  });
  useDb(() => Promise.resolve({ data: [original] }));

  const page = createPage();
  await page.onShow();

  assert.equal(page.data.records.length, 1);
  const item = page.data.records[0];
  assert.equal(item._id, 'rec-1');
  assert.equal(item.date, '2026-02-03');
  assert.equal(item.location, '岩馆 A');
  assert.equal(item.grade, 'V5');
  assert.equal(item.attempts, 7);
  assert.equal(item.notes, '脚点很滑，最后一步换手');
  assert.deepEqual(item.images, ['cloud://photo-1.jpg', 'cloud://photo-2.jpg']);
  assert.match(item.dateText, /2026年/);

  page.goToDetail({ currentTarget: { dataset: { id: 'rec-1' } } });

  assert.equal(wxLog.navigations.length, 1);
  assert.equal(
    wxLog.navigations[0].url,
    '/pages/record-detail/record-detail?id=rec-1'
  );
});

// ---- L03 ----
test('L03 返回列表刷新时用新第一页整体替换，同一条记录不重复', async () => {
  resetWxLog();
  const firstPage = [makeRecord('a'), makeRecord('b')];
  const refreshedPage = [makeRecord('new'), makeRecord('a'), makeRecord('b')];
  let requestCount = 0;
  useDb(() => {
    requestCount += 1;
    return Promise.resolve({ data: requestCount === 1 ? firstPage : refreshedPage });
  });

  const page = createPage();
  await page.onShow();
  assert.deepEqual(idsOf(page), ['a', 'b']);

  // 模拟从新增页返回，再次触发 onShow
  await page.onShow();

  assert.deepEqual(idsOf(page), ['new', 'a', 'b']);
  assert.equal(idsOf(page).filter(id => id === 'a').length, 1);
  assert.equal(idsOf(page).filter(id => id === 'b').length, 1);
  assert.equal(page.data.page, 1);
  assert.equal(page.data.loading, false);
});

// ---- L04 ----
test('L04 首屏失败显示可恢复错误态，重试第一页后显示记录', async () => {
  resetWxLog();
  let attempt = 0;
  const calls = useDb(() => {
    attempt += 1;
    if (attempt === 1) {
      return Promise.reject(new Error('offline'));
    }
    return Promise.resolve({ data: [makeRecord('rec-ok')] });
  });

  const page = createPage();
  await page.onShow();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.loadError, true);
  assert.equal(page.data.isEmpty, false);
  assert.equal(page.data.records.length, 0);

  // 对应 WXML 首屏错误分支绑定的 retryRefresh
  await page.retryRefresh();

  assert.deepEqual(calls.map(call => call.page), [1, 1]);
  assert.equal(page.data.loadError, false);
  assert.equal(page.data.loading, false);
  assert.deepEqual(idsOf(page), ['rec-ok']);
});

// ---- L05 ----
test('L05 已有记录时下拉刷新失败保留旧记录并结束动画，重试后替换', async () => {
  resetWxLog();
  const oldRecords = [makeRecord('old-1'), makeRecord('old-2')];
  const newRecords = [makeRecord('new-1'), makeRecord('new-2')];
  let requestCount = 0;
  const calls = useDb(() => {
    requestCount += 1;
    if (requestCount === 1) {
      return Promise.resolve({ data: oldRecords });
    }
    if (requestCount === 2) {
      return Promise.reject(new Error('offline'));
    }
    return Promise.resolve({ data: newRecords });
  });

  const page = createPage();
  await page.onShow();

  await page.onPullDownRefresh();

  assert.deepEqual(idsOf(page), ['old-1', 'old-2']);
  assert.equal(page.data.refreshError, true);
  assert.equal(page.data.loading, false);
  assert.equal(wxLog.stopPullDownRefresh, 1);

  await page.retryRefresh();

  assert.deepEqual(calls.map(call => call.page), [1, 1, 1]);
  assert.deepEqual(idsOf(page), ['new-1', 'new-2']);
  assert.equal(page.data.refreshError, false);
  assert.equal(page.data.loading, false);
});

test('L05 下拉刷新成功也结束动画', async () => {
  resetWxLog();
  useDb(() => Promise.resolve({ data: [makeRecord('ok')] }));

  const page = createPage();
  await page.onShow();
  await page.onPullDownRefresh();

  assert.equal(wxLog.stopPullDownRefresh, 1);
  assert.deepEqual(idsOf(page), ['ok']);
  assert.equal(page.data.refreshError, false);
  assert.equal(page.data.loading, false);
});

// ---- L06 ----
test('L06 21 条记录：请求序列 1,2,2，失败保留前页，重试后 21 个不同 ID', async () => {
  resetWxLog();
  const allRecords = Array.from({ length: 21 }, (_, index) => makeRecord(`r-${index}`));
  let secondPageAttempts = 0;
  const calls = useDb(pageNumber => {
    if (pageNumber === 1) {
      return Promise.resolve({ data: allRecords.slice(0, 20) });
    }
    secondPageAttempts += 1;
    if (secondPageAttempts === 1) {
      return Promise.reject(new Error('断网'));
    }
    return Promise.resolve({ data: allRecords.slice(20) });
  });

  const page = createPage();
  await page.onShow();
  assert.equal(page.data.records.length, 20);
  assert.equal(page.data.hasMore, true);

  // 同一次翻页过程中连续触底，只应产生一次请求
  const firstTouch = page.onReachBottom();
  const secondTouch = page.onReachBottom();
  await Promise.all([firstTouch, secondTouch]);

  assert.deepEqual(calls.map(call => call.page), [1, 2]);
  assert.equal(page.data.records.length, 20);
  assert.equal(page.data.loadMoreError, true);
  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.page, 1, '失败时页码不应推进');

  await page.retryLoadMore();

  assert.deepEqual(calls.map(call => call.page), [1, 2, 2]);
  assert.equal(page.data.records.length, 21);
  assert.equal(new Set(idsOf(page)).size, 21);
  assert.equal(page.data.hasMore, false);
  assert.equal(page.data.loadMoreError, false);

  // 没有第 3 页可请求
  await page.onReachBottom();
  assert.equal(calls.length, 3);
});

// ---- L07 ----
test('L07 旧第二页先成功、新第一页后成功：最终只显示刷新后的第一页', async () => {
  resetWxLog();
  const initial = Array.from({ length: 20 }, (_, index) => makeRecord(`old-${index}`));
  const staleSecondPage = Array.from({ length: 20 }, (_, index) => makeRecord(`stale-${index}`));
  const refreshed = [makeRecord('fresh-0'), ...initial.slice(0, 19)];
  const secondPageDeferred = deferred();
  const refreshDeferred = deferred();
  let firstPageCalls = 0;

  useDb(pageNumber => {
    if (pageNumber === 1) {
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve({ data: initial });
      }
      return refreshDeferred.promise;
    }
    return secondPageDeferred.promise;
  });

  const page = createPage();
  await page.onShow();

  const loadMorePromise = page.onReachBottom();
  assert.equal(page.data.loadingMore, true);

  const refreshPromise = page.onPullDownRefresh();
  assert.equal(page.data.loading, true);
  assert.equal(page.data.loadingMore, false);

  // 过时的第二页先完成：不能混入列表，也不能提前放开加载锁
  secondPageDeferred.resolve({ data: staleSecondPage });
  await loadMorePromise;

  assert.equal(page.data.loading, true, '新第一页未完成前不能放开加载锁');
  assert.deepEqual(idsOf(page), initial.map(record => record._id));

  refreshDeferred.resolve({ data: refreshed });
  await refreshPromise;

  assert.deepEqual(idsOf(page), refreshed.map(record => record._id));
  assert.equal(new Set(idsOf(page)).size, refreshed.length);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.refreshError, false);
  assert.equal(page.data.loadMoreError, false);
  assert.equal(wxLog.stopPullDownRefresh, 1);
});

test('L07 刷新先成功、旧第二页后成功：旧结果不覆盖新第一页', async () => {
  resetWxLog();
  const initial = Array.from({ length: 20 }, (_, index) => makeRecord(`old-${index}`));
  const staleSecondPage = Array.from({ length: 20 }, (_, index) => makeRecord(`stale-${index}`));
  const refreshed = [makeRecord('fresh-0'), ...initial.slice(0, 19)];
  const secondPageDeferred = deferred();
  const refreshDeferred = deferred();
  let firstPageCalls = 0;

  useDb(pageNumber => {
    if (pageNumber === 1) {
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve({ data: initial });
      }
      return refreshDeferred.promise;
    }
    return secondPageDeferred.promise;
  });

  const page = createPage();
  await page.onShow();

  const loadMorePromise = page.onReachBottom();
  const refreshPromise = page.onPullDownRefresh();

  refreshDeferred.resolve({ data: refreshed });
  await refreshPromise;
  assert.deepEqual(idsOf(page), refreshed.map(record => record._id));

  secondPageDeferred.resolve({ data: staleSecondPage });
  await loadMorePromise;

  assert.deepEqual(idsOf(page), refreshed.map(record => record._id));
  assert.equal(page.data.page, 1);
  assert.equal(page.data.refreshError, false);
  assert.equal(page.data.loadMoreError, false);
  assert.equal(page.data.loading, false);
});

test('L07 刷新成功后旧第二页失败：不把界面变成错误态', async () => {
  resetWxLog();
  const initial = Array.from({ length: 20 }, (_, index) => makeRecord(`old-${index}`));
  const refreshed = [makeRecord('fresh-0'), ...initial.slice(0, 19)];
  const secondPageDeferred = deferred();
  const refreshDeferred = deferred();
  let firstPageCalls = 0;

  useDb(pageNumber => {
    if (pageNumber === 1) {
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve({ data: initial });
      }
      return refreshDeferred.promise;
    }
    return secondPageDeferred.promise;
  });

  const page = createPage();
  await page.onShow();

  const loadMorePromise = page.onReachBottom();
  const refreshPromise = page.onPullDownRefresh();

  refreshDeferred.resolve({ data: refreshed });
  await refreshPromise;

  secondPageDeferred.reject(new Error('过时请求失败'));
  await loadMorePromise;

  assert.deepEqual(idsOf(page), refreshed.map(record => record._id));
  assert.equal(page.data.loading, false);
  assert.equal(page.data.refreshError, false);
  assert.equal(page.data.loadMoreError, false);
  assert.equal(wxLog.stopPullDownRefresh, 1);
});

// ---- R1 ----
test('R1 过时下拉请求不能提前结束当前下拉动画', async () => {
  resetWxLog();
  const initial = [makeRecord('init-0'), makeRecord('init-1')];
  const refreshA = [makeRecord('a-0')];
  const refreshB = [makeRecord('b-0'), makeRecord('b-1'), makeRecord('b-2')];
  const pullDownA = deferred();
  const showRefresh = deferred();
  const pullDownB = deferred();
  let firstPageCalls = 0;

  useDb(pageNumber => {
    firstPageCalls += 1;
    if (firstPageCalls === 1) {
      return Promise.resolve({ data: initial });
    }
    if (firstPageCalls === 2) {
      return pullDownA.promise;
    }
    if (firstPageCalls === 3) {
      return showRefresh.promise;
    }
    return pullDownB.promise;
  });

  const page = createPage();
  await page.onShow();
  assert.deepEqual(idsOf(page), ['init-0', 'init-1']);

  // 慢下拉 A
  const pullDownAPromise = page.onPullDownRefresh();
  assert.equal(page.data.loading, true);

  // 再次显示页面，随后发起下拉 B；B 是最新一次下拉
  const showPromise = page.onShow();
  const pullDownBPromise = page.onPullDownRefresh();

  // A 先返回：B 仍在等待，过时回调不得结束当前动画
  pullDownA.resolve({ data: refreshA });
  await pullDownAPromise;

  assert.equal(page.data.loading, true, 'B 未完成前应保持加载中');
  assert.equal(wxLog.stopPullDownRefresh, 0, '过时下拉不得结束当前动画');

  // B 后返回：只有它负责结束动画并更新列表
  pullDownB.resolve({ data: refreshB });
  await pullDownBPromise;

  assert.equal(page.data.loading, false);
  assert.equal(wxLog.stopPullDownRefresh, 1);
  assert.deepEqual(idsOf(page), ['b-0', 'b-1', 'b-2']);

  // 更早的页面显示请求最后返回，也不改变结果
  showRefresh.resolve({ data: [makeRecord('show-0')] });
  await showPromise;

  assert.deepEqual(idsOf(page), ['b-0', 'b-1', 'b-2']);
  assert.equal(page.data.loading, false);
  assert.equal(wxLog.stopPullDownRefresh, 1);
});

// ---- 页面模板绑定 ----
test('WXML 条件分支、事件名与页面方法一致', () => {
  const wxml = fs.readFileSync(PAGE_WXML, 'utf8');

  assert.match(wxml, /wx:if="\{\{loading && records\.length === 0\}\}"/);
  assert.match(wxml, /wx:elif="\{\{loadError && records\.length === 0\}\}"/);
  assert.match(wxml, /wx:elif="\{\{isEmpty\}\}"/);
  assert.match(wxml, /loadError && records\.length === 0[\s\S]*?bindtap="retryRefresh"/);
  assert.match(wxml, /refreshError[\s\S]*?bindtap="retryRefresh"/);
  assert.match(wxml, /loadMoreError[\s\S]*?bindtap="retryLoadMore"/);
  assert.match(wxml, /bindtap="goToDetail"/);
  assert.match(wxml, /data-id="\{\{item\._id\}\}"/);
  assert.match(wxml, /\{\{item\.attempts\}\}次/);
  assert.match(wxml, /wx:for="\{\{item\.images\}\}"/);
  assert.match(wxml, /还没有攀岩记录/);

  for (const methodName of ['retryRefresh', 'retryLoadMore', 'goToDetail', 'goToAddRecord']) {
    assert.equal(typeof pageDefinition[methodName], 'function', `${methodName} 应为页面方法`);
  }

  const pageConfig = JSON.parse(fs.readFileSync(PAGE_JSON, 'utf8'));
  assert.equal(pageConfig.enablePullDownRefresh, true);
});
