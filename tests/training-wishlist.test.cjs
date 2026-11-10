/**
 * T027「下次想爬」按岩馆保存线路清单回归测试（R3、R6 的离线部分）
 *
 * 直接加载真实的 utils/training-wishlist.js 与正式页面
 * （pages/training-wishlist、pages/training-route、pages/index），用隔离的微信本地存储
 * 替身与写入故障注入驱动真实处理器，并核对 WXML 里的真实按钮绑定。
 *
 * T035 起整份清单在独立页 pages/training-wishlist：首页只留一行入口（标题 + 数量 = listWishlist
 * 的本档条目数），场内页不再铺清单，加入／撤下／归档留在原线资料页与小结勾选里。
 *
 * 覆盖：同一线路只收藏一条、按岩馆分组不串馆、累计把数与最近一条非空备注、
 * 关注的抱石首次完攀进入已完成（改成未完成后回到想爬）、顶绳先锋完攀后照常续记、
 * 拆线归档与撤下收藏只影响清单、旧档案首次读取兼容、清单损坏与版本不支持的可判别
 * 报错、写入失败重试与迟到重复点击幂等、普通清缓存不动清单，以及收藏前后训练档案
 * 与照片索引的原始字节一致；独立清单的按馆分组／状态／空态、失败与重试、只读打开
 * （含点开原线与重试）都不写盘。
 *
 * 串档修复：清单按「档案 ID + 长期线路 ID」共同定位（两份档案可以各有一条 route-1）。
 * 因此还覆盖：换成另一份档案后看不到、也动不了原来那份档案的收藏（含小结的批量勾选
 * 口径与独立清单显示），切回原档案收藏仍在；入口带着换档前的 archiveId 时不展示任何
 * 条目；没有注明档案 ID 的旧条目不归属于任何档案（不上屏、也不被增删改，原字节保留）。
 *
 * 刻意不提供 wx.cloud 与本地文件系统：本机清单、清单展示与「继续原线」都不得依赖
 * 云能力；照片只验证「有照片 / 无图 / 照片不可用」三种展示分支，照片文件本身的读写
 * 由 T019 的测试覆盖。真实设备字体、日光对比度与触控留给负责人整体验收（待验）。
 *
 * 运行：node --test tests/training-wishlist.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const RECORD_WXML = path.join(ROOT, 'pages', 'training-record', 'training-record.wxml');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const INDEX_WXML = path.join(ROOT, 'pages', 'index', 'index.wxml');
const WISHLIST_PAGE_JS = path.join(ROOT, 'pages', 'training-wishlist', 'training-wishlist.js');
const WISHLIST_PAGE_WXML = path.join(ROOT, 'pages', 'training-wishlist', 'training-wishlist.wxml');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const WISHLIST_KEY = 'climbingNote.training.v1.wishlist';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入写入故障 ----
const storage = new Map();
const keyWrites = new Map();
const fault = { setFailAt: 0, setCount: 0, getFail: false };

function resetDevice() {
  storage.clear();
  keyWrites.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.getFail = false;
}

/** 从第 N 次 setStorageSync 开始失败：用于构造「落盘失败」与「写失败后重试」。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

function disarmSetFail() {
  fault.setCount = 0;
  fault.setFailAt = 0;
}

function writesOf(key) {
  return keyWrites.get(key) || 0;
}

function rawOf(key) {
  return storage.has(key) ? storage.get(key) : '';
}

const wxLog = { navigations: [], switches: [], toasts: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.toasts = [];
}

// 刻意不带 cloud 与文件系统：本机清单与页面展示都不得依赖它们。
global.wx = {
  getStorageSync(key) {
    if (fault.getFail) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    keyWrites.set(key, writesOf(key) + 1);
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo(options) {
    wxLog.navigations.push(options.url);
  },
  switchTab(options) {
    wxLog.switches.push(options.url);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  }
};

const store = require(STORE_JS);
const wishlist = require(WISHLIST_JS);

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

const sessionDefinition = capturePage(SESSION_JS);
const routeDefinition = capturePage(ROUTE_JS);
const indexDefinition = capturePage(INDEX_JS);
const wishlistPageDefinition = capturePage(WISHLIST_PAGE_JS);

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

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

/**
 * 照片控制器替身：只回答「有照片 / 无图 / 照片不可用」，不改任何文件或索引。
 * 页面按 routeId 取照片状态，因此这里按 routeId 返回固定结果。
 */
function fakePhotoUi(views) {
  const table = views || {};
  return {
    init: () => Promise.resolve({ ok: true }),
    load: () => Promise.resolve(),
    clear: () => {},
    view(routeId) {
      const found = table[routeId];
      if (found) return found;
      return {
        status: 'none',
        hasPhoto: false,
        missing: false,
        thumbnailPath: '',
        mainPath: '',
        statusText: '添加线路照片（可选、可稍后添加）'
      };
    }
  };
}

function savedPhotoView(thumbnailPath) {
  return {
    status: 'saved',
    hasPhoto: true,
    missing: false,
    thumbnailPath: thumbnailPath || '/tmp/photo-1-thumb.jpg',
    mainPath: '/tmp/photo-1.jpg',
    statusText: '照片保存在本机'
  };
}

function missingPhotoView() {
  return {
    status: 'missing',
    hasPhoto: false,
    missing: true,
    thumbnailPath: '',
    mainPath: '',
    statusText: '本机照片不可用，可重新添加'
  };
}

// ---- 走正式档案层搭建夹具（清单只读，页面只读；夹具一律经 store 注入） ----
function startAt(date, gymName) {
  const started = store.startSession({
    gymName,
    date,
    now: new Date(date + 'T09:30:00')
  });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function newRoute(session, options = {}) {
  const created = store.createRoute({
    sessionId: session.id,
    name: options.name || '蓝色动态线',
    climbType: options.climbType || '抱石',
    grade: options.grade || 'V3',
    colorName: options.colorName || '蓝色',
    colorHex: options.colorHex || '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function record(session, route, result, note, at) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note: note || '',
    now: at ? new Date(at) : undefined
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveOf() {
  return store.loadState().archive;
}

/**
 * 另一份完整的本机档案（B）：archiveId 不同，但里面的线路 ID 也是 route-1。
 * 用来复现并守住「只看 routeId 会串档」：换档后 B 自己的 route-1 不该被 A 的收藏认领。
 */
function otherArchiveRaw(archiveId, gymName) {
  return JSON.stringify({
    version: 1,
    archiveId: archiveId,
    nextGymSeq: 2,
    nextSessionSeq: 2,
    nextRouteSeq: 2,
    nextAttemptSeq: 1,
    gyms: [{ id: 'gym-1', name: gymName, createdAt: '2026-11-08T09:00:00.000Z' }],
    sessions: [
      {
        id: 'session-1',
        seq: 1,
        gymId: 'gym-1',
        date: '2026-11-08',
        createdAt: '2026-11-08T09:00:00.000Z'
      }
    ],
    routes: [
      {
        id: 'route-1',
        seq: 1,
        gymId: 'gym-1',
        name: '另一份档案里的线路',
        climbType: '抱石',
        grade: 'V3',
        colorName: '蓝色',
        colorHex: '#2f6fe4',
        createdAt: '2026-11-08T09:05:00.000Z'
      }
    ],
    sessionRoutes: [
      { sessionId: 'session-1', routeId: 'route-1', addedAt: '2026-11-08T09:05:00.000Z' }
    ],
    attempts: [],
    pendingSaves: [],
    pendingCorrections: [],
    activeSessionId: 'session-1',
    activeRouteId: 'route-1'
  });
}

/** 直接换掉档案键＝换成另一份档案（同机重开、档案被重置都走这条路径）。 */
function swapArchive(raw) {
  storage.set(ARCHIVE_KEY, raw);
  return archiveOf();
}

/** 两个岩馆各一条同色同级的抱石线：A 馆在前，B 馆在后。 */
function twoGymsFixture() {
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  const sessionB = startAt('2026-11-09', 'B 馆');
  const routeB = newRoute(sessionB, { name: '蓝色动态线', grade: 'V3' });
  return { sessionA, routeA, sessionB, routeB };
}

function favorite(routeId, now) {
  const outcome = wishlist.addWishlist(routeId, now ? { now } : undefined);
  assert.equal(outcome.ok, true, outcome.error);
  return outcome;
}

function entriesFor(gymId) {
  const listed = wishlist.listWishlist(archiveOf(), gymId ? { gymId } : undefined);
  assert.equal(listed.ok, true, listed.error);
  return listed;
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
});

// ------------------------------------------------------------------ *
// 清单的稳定 ID、按馆分组与幂等
// ------------------------------------------------------------------ *

test('T027 首次进入没有清单键：返回空清单、不报错也不落盘', () => {
  const loaded = wishlist.loadWishlist();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.present, false);
  assert.deepEqual(loaded.state.items, []);

  const listed = wishlist.listWishlist(store.loadState().archive);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.groups, []);
  assert.deepEqual(listed.items, []);
  assert.equal(rawOf(WISHLIST_KEY), '', '只读不应产生清单键');
});

test('T027 只收藏 A 馆的线两次：A 馆仅一项，B 馆无该项', () => {
  const { routeA, routeB } = twoGymsFixture();

  const first = wishlist.addWishlist(routeA.id);
  assert.equal(first.ok, true);
  assert.equal(first.code, 'added');
  assert.equal(first.entry.routeId, routeA.id);

  const second = wishlist.addWishlist(routeA.id);
  assert.equal(second.ok, true);
  assert.equal(second.code, 'duplicate');
  assert.equal(second.duplicate, true, '重复点击应幂等');
  assert.equal(writesOf(WISHLIST_KEY), 1, '重复点击不应再次落盘');

  const groupA = entriesFor(archiveOf().routes.find(item => item.id === routeA.id).gymId);
  assert.equal(groupA.groups.length, 1);
  assert.equal(groupA.groups[0].gymName, 'A 馆');
  assert.equal(groupA.items.length, 1);
  assert.equal(groupA.items[0].routeId, routeA.id);
  assert.equal(groupA.items[0].status, 'wanted');

  // B 馆没有这一项，也没有被 A 馆的收藏带出来。
  const groupB = entriesFor(archiveOf().routes.find(item => item.id === routeB.id).gymId);
  assert.deepEqual(groupB.items, []);
  assert.deepEqual(groupB.groups, []);

  // 全部清单里也只有一条，正好是 A 馆那条线。
  const all = entriesFor();
  assert.equal(all.items.length, 1);
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0].gymName, 'A 馆');
});

test('T027 同色同级的 A、B 两条线各自独立：收藏哪条只出现哪条，绝不并成一条', () => {
  const { routeA, routeB } = twoGymsFixture();
  assert.notEqual(routeA.id, routeB.id, '同色同级也各有独立 ID');

  favorite(routeB.id);
  let all = entriesFor();
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].routeId, routeB.id);
  assert.equal(all.groups[0].gymName, 'B 馆');

  favorite(routeA.id);
  all = entriesFor();
  assert.equal(all.items.length, 2, '两条线是同名同色也各占一条');
  const byGym = new Map(all.groups.map(group => [group.gymName, group.items.map(item => item.routeId)]));
  assert.deepEqual(byGym.get('A 馆'), [routeA.id]);
  assert.deepEqual(byGym.get('B 馆'), [routeB.id]);
});

test('T027 清单按岩馆分组：馆内先想爬、再已完成、最后已归档', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const wanted = newRoute(session, { name: '想爬的线', grade: 'V3' });
  const done = newRoute(session, { name: '已完攀的线', grade: 'V4' });
  const archived = newRoute(session, { name: '拆掉的线', grade: 'V2' });
  [wanted, done, archived].forEach(route => favorite(route.id));
  record(session, done, 'send', '', '2026-11-09T10:00:00');
  const filed = wishlist.archiveWishlist(archived.id);
  assert.equal(filed.ok, true);

  const listed = entriesFor();
  assert.equal(listed.groups.length, 1);
  assert.deepEqual(
    listed.groups[0].items.map(item => item.routeId),
    [wanted.id, done.id, archived.id]
  );
  assert.deepEqual(
    listed.groups[0].items.map(item => item.status),
    ['wanted', 'completed', 'archived']
  );
  assert.equal(listed.groups[0].countText, '3 条');
});

test('T027 累计把数与最近一条非空备注跟随档案，跨日跨场次取最近一句', () => {
  const day1 = startAt('2026-11-09', 'A 馆');
  const route = newRoute(day1, { name: '蓝色动态线', grade: 'V3' });
  favorite(route.id);

  record(day1, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  // 空备注与只有空白的备注都不算「最近备注」。
  record(day1, route, 'fail', '', '2026-11-09T10:10:00');
  record(day1, route, 'fail', '   ', '2026-11-09T10:20:00');

  const day2 = startAt('2026-11-10', 'A 馆');
  const day2Route = newRoute(day2, { name: '另一条线', grade: 'V4' });
  record(day2, day2Route, 'fail', '别的线的备注', '2026-11-10T10:00:00');
  record(day2, route, 'fail', '抓到后向左摆', '2026-11-10T10:30:00');

  const entry = entriesFor().items.find(item => item.routeId === route.id);
  assert.equal(entry.attemptCount, 4, '只累计这条线自己的把数');
  assert.equal(entry.attemptCountText, '4 把');
  assert.equal(entry.latestNote, '抓到后向左摆');
  assert.equal(entry.hasNote, true);

  // 还没落盘的「进行中」操作不计入累计把数（与底部统计同一口径）。
  // 第二段落盘失败，档案里留下一条真实的「待保存」操作。
  armSetFailAt(2);
  const pending = store.saveAttempt({
    sessionId: day2.id,
    routeId: route.id,
    result: 'fail',
    note: '',
    now: new Date('2026-11-10T11:00:00')
  });
  assert.equal(pending.ok, false, '第二段落盘失败时不报已保存');
  disarmSetFail();
  assert.ok(archiveOf().pendingSaves.length > 0, '夹具应留下一条待保存操作');
  const afterPending = entriesFor().items.find(item => item.routeId === route.id);
  assert.equal(
    afterPending.attemptCount,
    entry.attemptCount,
    '清单的累计把数不含还没落盘的把次'
  );
});

// ------------------------------------------------------------------ *
// 状态推导：已完成、续记与拆线归档
// ------------------------------------------------------------------ *

test('T027 关注的抱石首次完攀进入已完成；把这一把改成未完成后回到想爬', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', climbType: '抱石', grade: 'V3' });
  favorite(route.id);
  assert.equal(entriesFor().items[0].status, 'wanted');

  const sent = record(session, route, 'send', '这次成了', '2026-11-09T10:00:00');
  const done = entriesFor().items[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.statusText, '已完成');
  assert.equal(done.completed, true);

  // 完攀后沿用档案层的抱石守卫：不能重复新增把次。
  const blocked = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'send',
    note: ''
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);

  // 改成未完成后回到想爬，可以继续续记；把数、ID、场次与备注都不变。
  const corrected = store.correctAttempt(sent.id);
  assert.equal(corrected.ok, true);
  const backWanted = entriesFor().items[0];
  assert.equal(backWanted.status, 'wanted');
  assert.equal(backWanted.attemptCount, 1);
  assert.equal(backWanted.latestNote, '这次成了');
  assert.equal(backWanted.sendCount, 0);

  const again = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'send',
    note: '',
    now: new Date('2026-11-09T10:20:00')
  });
  assert.equal(again.ok, true, '纠正后应能在同一条原线上再次完攀');
  assert.equal(entriesFor().items[0].status, 'completed');
});

test('T027 顶绳、先锋完攀后照常留在想爬并继续记，不进入已完成', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const topRope = newRoute(session, { name: '顶绳线', climbType: '顶绳', grade: '5.10a' });
  const lead = newRoute(session, { name: '先锋线', climbType: '先锋', grade: '5.11a' });
  favorite(topRope.id);
  favorite(lead.id);

  record(session, topRope, 'send', '顶绳完攀', '2026-11-09T10:00:00');
  record(session, lead, 'send', '先锋完攀', '2026-11-09T10:30:00');

  const entries = entriesFor().items;
  assert.deepEqual(entries.map(item => item.status), ['wanted', 'wanted']);
  assert.deepEqual(entries.map(item => item.statusText), ['想爬', '想爬']);

  // 绳攀可重复完攀：完攀后照常续记。
  const more = store.saveAttempt({
    sessionId: session.id,
    routeId: topRope.id,
    result: 'send',
    note: '',
    now: new Date('2026-11-09T11:00:00')
  });
  assert.equal(more.ok, true, '顶绳完攀后应能继续记');
  assert.equal(entriesFor().items.find(item => item.routeId === topRope.id).attemptCount, 2);
});

test('T027 拆线归档保留照片、把次与历史；撤下收藏只影响清单', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  favorite(route.id);
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  record(session, route, 'fail', '抓到后向左摆', '2026-11-09T10:10:00');

  // 照片索引已经保存过一张主照片（本单只读它，不读写照片文件）。
  storage.set(
    PHOTO_KEY,
    JSON.stringify({
      version: 1,
      nextPhotoSeq: 2,
      nextOpSeq: 1,
      routes: [{ archiveId: archiveOf().archiveId, routeId: route.id, photoId: 'photo-1', rev: 1, activeOpSeq: 0 }],
      photos: [
        {
          photoId: 'photo-1',
          archiveId: archiveOf().archiveId,
          routeId: route.id,
          storage: { type: 'local', location: '/tmp/photo-1.jpg' },
          bytes: { main: 1024, thumb: 128 },
          width: 800,
          height: 600,
          createdAt: '2026-11-09T09:40:00.000Z'
        }
      ],
      operations: []
    })
  );

  const archiveBefore = rawOf(ARCHIVE_KEY);
  const photoBefore = rawOf(PHOTO_KEY);
  const historyBefore = store.routeHistory(archiveOf(), route.id);

  const filed = wishlist.archiveWishlist(route.id);
  assert.equal(filed.ok, true);
  assert.equal(filed.code, 'archived');
  assert.equal(filed.entry.status, 'archived');

  const archivedEntry = entriesFor().items[0];
  assert.equal(archivedEntry.status, 'archived');
  assert.equal(archivedEntry.attemptCount, 2, '归档后累计把数照旧');
  assert.equal(archivedEntry.latestNote, '抓到后向左摆', '归档后最近备注照旧');

  const historyAfter = store.routeHistory(archiveOf(), route.id);
  assert.deepEqual(historyAfter.groups, historyBefore.groups, '拆线归档不改跨日历史');
  assert.equal(historyAfter.attemptCount, historyBefore.attemptCount);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '归档不改训练档案');
  assert.equal(rawOf(PHOTO_KEY), photoBefore, '归档不改照片索引（照片仍可回看）');

  // 归档幂等：再点一次不产生第二条，也不重复写盘。
  const writes = writesOf(WISHLIST_KEY);
  const again = wishlist.archiveWishlist(route.id);
  assert.equal(again.ok, true);
  assert.equal(again.code, 'already-archived');
  assert.equal(writesOf(WISHLIST_KEY), writes);
  assert.equal(entriesFor().items.length, 1);

  // 已归档后重新加入＝「又要爬了」：还是一条，回到想爬。
  const reAdd = wishlist.addWishlist(route.id);
  assert.equal(reAdd.ok, true);
  assert.equal(reAdd.code, 'reactivated');
  assert.equal(entriesFor().items.length, 1);
  assert.equal(entriesFor().items[0].status, 'wanted');

  // 撤下收藏：只从清单里移除这一条，线路、把次、备注与照片都不动。
  const removed = wishlist.removeWishlist(route.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(entriesFor().items, []);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '撤下收藏不改训练档案');
  assert.equal(rawOf(PHOTO_KEY), photoBefore, '撤下收藏不改照片索引');
  assert.equal(store.routeHistory(archiveOf(), route.id).attemptCount, 2);

  // 撤下幂等：已经没有这一条时不再写盘。
  const writesAfterRemove = writesOf(WISHLIST_KEY);
  const removeAgain = wishlist.removeWishlist(route.id);
  assert.equal(removeAgain.ok, true);
  assert.equal(removeAgain.code, 'absent');
  assert.equal(removeAgain.removed, false);
  assert.equal(writesOf(WISHLIST_KEY), writesAfterRemove);

  // 撤下后重新加入仍是一条（不残留第二条）。
  favorite(route.id);
  assert.equal(entriesFor().items.length, 1);
});

test('T027 归档不在清单里的线路被拒绝，且不新建条目', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  const outcome = wishlist.archiveWishlist(route.id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'missing');
  assert.equal(rawOf(WISHLIST_KEY), '', '被拒绝时不应落盘');
  assert.deepEqual(entriesFor().items, []);
});

// ------------------------------------------------------------------ *
// 旧档案兼容与异常恢复
// ------------------------------------------------------------------ *

test('T027 旧档案首次读取兼容：缺后加字段与缺 climbType 的旧 V 级线路照常收藏与判定', () => {
  // 旧版档案：没有 sessionRoutes / pendingSaves / pendingCorrections，线路没有 climbType。
  storage.set(
    ARCHIVE_KEY,
    JSON.stringify({
      version: 1,
      archiveId: 'archive-legacy-1',
      nextGymSeq: 2,
      nextSessionSeq: 2,
      nextRouteSeq: 2,
      nextAttemptSeq: 1,
      gyms: [{ id: 'gym-1', name: '老档案岩馆', createdAt: '2026-11-01T09:00:00.000Z' }],
      sessions: [
        {
          id: 'session-1',
          seq: 1,
          gymId: 'gym-1',
          date: '2026-11-01',
          createdAt: '2026-11-01T09:00:00.000Z'
        }
      ],
      routes: [
        {
          id: 'route-1',
          seq: 1,
          gymId: 'gym-1',
          name: '旧 V 级线',
          grade: 'V2',
          createdAt: '2026-11-01T09:05:00.000Z'
        }
      ],
      attempts: [],
      activeSessionId: 'session-1',
      activeRouteId: 'route-1'
    })
  );

  const loaded = store.loadState();
  assert.equal(loaded.ok, true, '旧档案应能兼容读取');
  assert.equal(loaded.present, true);

  const added = wishlist.addWishlist('route-1');
  assert.equal(added.ok, true, added.error);
  assert.equal(added.entry.climbType, '抱石', '缺 climbType 的旧 V 级线路按抱石只读展示');
  assert.equal(entriesFor().items[0].gymName, '老档案岩馆');

  // 旧 V 级按抱石判定：首次完攀进入已完成，改成未完成后回到想爬。
  const sent = record(
    { id: 'session-1' },
    { id: 'route-1' },
    'send',
    '旧档完攀',
    '2026-11-01T10:00:00'
  );
  assert.equal(entriesFor().items[0].status, 'completed');
  const corrected = store.correctAttempt(sent.id);
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(entriesFor().items[0].status, 'wanted');
});

test('T027 清单损坏或版本不受支持：可见报错、保留原数据、写入口一律拒绝', () => {
  const { routeA } = twoGymsFixture();
  const broken = '{ not-json';
  storage.set(WISHLIST_KEY, broken);

  const loaded = wishlist.loadWishlist();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.corrupt, true);
  assert.match(loaded.error, /损坏/);

  const listed = wishlist.listWishlist(archiveOf());
  assert.equal(listed.ok, false);
  assert.match(listed.error, /损坏/);

  for (const outcome of [
    wishlist.addWishlist(routeA.id),
    wishlist.removeWishlist(routeA.id),
    wishlist.archiveWishlist(routeA.id)
  ]) {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'unreadable');
  }
  assert.equal(rawOf(WISHLIST_KEY), broken, '损坏时不得覆盖原清单');

  const unsupported = JSON.stringify({ version: 99, items: [] });
  storage.set(WISHLIST_KEY, unsupported);
  const versioned = wishlist.loadWishlist();
  assert.equal(versioned.ok, false);
  assert.equal(versioned.corrupt, true);
  assert.match(versioned.error, /版本不受支持/);
  assert.equal(wishlist.addWishlist(routeA.id).code, 'unreadable');
  assert.equal(rawOf(WISHLIST_KEY), unsupported, '版本不支持时不得覆盖原清单');

  // 结构损坏（同一线路出现两条）同样按损坏处理。
  const duplicated = JSON.stringify({
    version: 1,
    items: [
      { routeId: routeA.id, gymId: '', addedAt: '2026-11-09T09:00:00.000Z', archivedAt: '' },
      { routeId: routeA.id, gymId: '', addedAt: '2026-11-09T09:00:01.000Z', archivedAt: '' }
    ]
  });
  storage.set(WISHLIST_KEY, duplicated);
  assert.equal(wishlist.loadWishlist().ok, false);
  assert.equal(rawOf(WISHLIST_KEY), duplicated);
});

test('T027 读取本身失败时返回可判别错误而不是崩溃', () => {
  const { routeA } = twoGymsFixture();
  fault.getFail = true;
  const loaded = wishlist.loadWishlist();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.present, false);
  assert.match(loaded.error, /读取下次想爬清单失败/);
  assert.equal(wishlist.addWishlist(routeA.id).code, 'unreadable');
  fault.getFail = false;
});

test('T027 写入失败不报已保存；故障解除后重试只产生一条', () => {
  const { routeA } = twoGymsFixture();

  armSetFailAt(1);
  const failed = wishlist.addWishlist(routeA.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  assert.match(failed.error, /保存下次想爬清单失败/);
  assert.equal(rawOf(WISHLIST_KEY), '', '落盘失败时不应留下半条记录');
  assert.deepEqual(entriesFor().items, []);

  disarmSetFail();
  const retried = wishlist.addWishlist(routeA.id);
  assert.equal(retried.ok, true);
  assert.equal(retried.code, 'added');
  assert.equal(entriesFor().items.length, 1, '重试后只有一条');

  // 迟到回调/重复点击：同一条线路再加两次仍是一条，且不再写盘。
  const writes = writesOf(WISHLIST_KEY);
  assert.equal(wishlist.addWishlist(routeA.id).code, 'duplicate');
  assert.equal(wishlist.addWishlist(routeA.id).code, 'duplicate');
  assert.equal(entriesFor().items.length, 1);
  assert.equal(writesOf(WISHLIST_KEY), writes);

  // 撤下时落盘失败：清单保持原样，重试后可正常撤下。
  armSetFailAt(1);
  const removeFailed = wishlist.removeWishlist(routeA.id);
  assert.equal(removeFailed.ok, false);
  assert.equal(removeFailed.code, 'write-failed');
  assert.equal(entriesFor().items.length, 1, '撤下失败时收藏仍在');
  disarmSetFail();
  assert.equal(wishlist.removeWishlist(routeA.id).removed, true);
  assert.deepEqual(entriesFor().items, []);
});

test('T027 重开（重新加载模块）后清单与档案一致：没有只存在内存里的收藏状态', () => {
  const { routeA, routeB } = twoGymsFixture();
  favorite(routeA.id);
  favorite(routeB.id);
  const before = entriesFor();

  // 重新加载模块＝重新启动小程序：清单只从本机存储读取，不依赖任何内存状态。
  delete require.cache[require.resolve(WISHLIST_JS)];
  const reopened = require(WISHLIST_JS);
  const after = reopened.listWishlist(archiveOf());

  assert.equal(after.ok, true, after.error);
  assert.deepEqual(
    after.items.map(item => [item.routeId, item.status, item.attemptCount]),
    before.items.map(item => [item.routeId, item.status, item.attemptCount])
  );
  assert.deepEqual(
    after.groups.map(group => group.gymName),
    before.groups.map(group => group.gymName)
  );

  // 重开后再撤下一条：只影响这一条，另一条与它的岩馆归属都不变。
  assert.equal(reopened.removeWishlist(routeA.id).removed, true);
  const rest = reopened.listWishlist(archiveOf());
  assert.deepEqual(rest.items.map(item => item.routeId), [routeB.id]);
  assert.equal(rest.groups.length, 1);
  assert.equal(rest.groups[0].gymName, 'B 馆');
});

test('T027 清单键受保护：普通清缓存不动它，也不动命名空间外的键', () => {
  const { routeA } = twoGymsFixture();
  favorite(routeA.id);
  storage.set('climbingNote.training.v1.cache.demo', 'cache');
  storage.set('climbingNote.training.v1.thumbs.photos', 'thumbs');
  storage.set('trialProject.records', 'other-namespace');
  const before = rawOf(WISHLIST_KEY);
  const archiveBefore = rawOf(ARCHIVE_KEY);

  assert.equal(store.isProtectedKey(WISHLIST_KEY), true, '清单键属于受保护的本机资料');
  assert.equal(store.isRebuildableKey(WISHLIST_KEY), false);

  const cleared = store.clearRebuildableStorage();
  assert.equal(cleared.ok, true, cleared.error);
  assert.deepEqual(
    cleared.removed.slice().sort(),
    ['climbingNote.training.v1.cache.demo', 'climbingNote.training.v1.thumbs.photos']
  );
  assert.equal(rawOf(WISHLIST_KEY), before, '清缓存后收藏仍在');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);
  assert.equal(rawOf('trialProject.records'), 'other-namespace');
  assert.equal(entriesFor().items.length, 1);
});

test('T027 条目指向的线路已不在当前档案里时跳过，不串到别的岩馆', () => {
  const { routeA } = twoGymsFixture();
  favorite(routeA.id);
  const archiveId = archiveOf().archiveId;
  storage.set(
    WISHLIST_KEY,
    JSON.stringify({
      version: 1,
      items: [
        { archiveId: archiveId, routeId: routeA.id, gymId: '', addedAt: '2026-11-09T09:00:00.000Z', archivedAt: '' },
        { archiveId: archiveId, routeId: 'route-999', gymId: '', addedAt: '2026-11-09T09:00:00.000Z', archivedAt: '' }
      ]
    })
  );

  const listed = entriesFor();
  assert.equal(listed.ok, true);
  assert.equal(listed.items.length, 1, '找不到的线路不显示，也不顶替别的馆');
  assert.equal(listed.orphanCount, 1);
  assert.equal(listed.foreignCount, 0, '同一份档案里找不到线路与「属于别的档案」是两回事');
  assert.equal(listed.items[0].routeId, routeA.id);
  assert.equal(listed.groups.length, 1);
  assert.equal(listed.groups[0].gymName, 'A 馆');
});

// ------------------------------------------------------------------ *
// 串档修复：按 archiveId + 长期 routeId 共同定位（B 的增删归档不得触及 A）
// ------------------------------------------------------------------ *

test('T027 换成另一份档案后不串档：B 看不到 A 的收藏，切回 A 仍然看得见', () => {
  // A 档案：收藏它自己的 route-1。
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  record(sessionA, routeA, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  const archiveA = archiveOf();
  assert.notEqual(archiveA.archiveId, 'archive-b-1');
  favorite(routeA.id);
  assert.equal(writesOf(WISHLIST_KEY), 1);
  assert.deepEqual(entriesFor().items.map(item => item.routeId), [routeA.id]);

  // 换成另一份档案 B：它里面也有一条 route-1，但那是另一条线。
  const archiveB = swapArchive(otherArchiveRaw('archive-b-1', 'QA 岩馆 A'));
  assert.equal(archiveB.archiveId, 'archive-b-1');
  assert.equal(archiveB.routes[0].id, routeA.id, '两份档案里都有同名的 route-1');

  // B 里看不到 A 的收藏：清单为空，也不是「已收藏」。
  const listedB = wishlist.listWishlist(archiveB);
  assert.equal(listedB.ok, true, listedB.error);
  assert.deepEqual(listedB.items, [], 'B 里不显示 A 的收藏');
  assert.deepEqual(listedB.groups, []);
  assert.equal(listedB.foreignCount, 1, 'A 的那条属于别的档案，记在 foreignCount');
  assert.equal(listedB.orphanCount, 0);
  assert.equal(wishlist.wishlistEntry(archiveB, routeA.id).entry, null, 'B 的 route-1 不是已收藏');
  assert.equal(wishlist.wishlistMembership(archiveB, [routeA.id]).entries.size, 0);

  // B 的撤下与归档只按自己的档案找：都不落盘，也不动 A 的收藏。
  const wishlistBefore = rawOf(WISHLIST_KEY);
  const removeInB = wishlist.removeWishlist(routeA.id);
  assert.equal(removeInB.ok, true);
  assert.equal(removeInB.code, 'absent', 'B 的清单里本来就没有这一条');
  const archiveInB = wishlist.archiveWishlist(routeA.id);
  assert.equal(archiveInB.ok, false);
  assert.equal(archiveInB.code, 'missing');
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore, 'B 的撤下与归档不得改写 A 的清单');
  assert.equal(writesOf(WISHLIST_KEY), 1);

  // B 加入自己的 route-1：两份档案各一条，各自只看得见自己的那条。
  const addedInB = wishlist.addWishlist(routeA.id, { now: new Date('2026-11-08T10:00:00') });
  assert.equal(addedInB.ok, true, addedInB.error);
  assert.equal(addedInB.code, 'added', 'B 里这条还没收藏过，应是新加入');
  assert.equal(addedInB.entry.name, '另一份档案里的线路');
  assert.deepEqual(
    wishlist.listWishlist(archiveB).items.map(item => item.name),
    ['另一份档案里的线路']
  );

  // 切回 A：先前那条收藏还在，也不是 B 的条目。
  swapArchive(JSON.stringify(archiveA));
  const listedA = wishlist.listWishlist(archiveA);
  assert.deepEqual(listedA.items.map(item => item.routeId), [routeA.id]);
  assert.equal(listedA.items[0].name, '蓝色动态线');
  assert.equal(listedA.items[0].latestNote, '起步用右脚');
  assert.equal(listedA.foreignCount, 1, 'B 的那条对 A 来说也是别的档案');

  // 清单里确实各存一条；A 的撤下只删 A 的那条。
  assert.equal(wishlist.loadWishlist().state.items.length, 2);
  assert.deepEqual(
    wishlist.loadWishlist().state.items.map(item => item.archiveId),
    [archiveA.archiveId, 'archive-b-1']
  );
  const removedInA = wishlist.removeWishlist(routeA.id);
  assert.equal(removedInA.ok, true);
  assert.equal(removedInA.removed, true);
  const left = wishlist.loadWishlist().state.items;
  assert.equal(left.length, 1);
  assert.equal(left[0].archiveId, 'archive-b-1', 'A 的撤下只撤掉 A 的那条');
  assert.deepEqual(
    wishlist.listWishlist(archiveB).items.map(item => item.routeId),
    [routeA.id],
    'B 的收藏一条不少'
  );
});

test('T027 合计清单与小结勾选也按档案隔离：换档后 A 的收藏不画成勾选状态', () => {
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  favorite(routeA.id);
  const archiveA = archiveOf();

  const archiveB = swapArchive(otherArchiveRaw('archive-b-1', 'QA 岩馆 A'));
  // 小结的批量勾选（T029）读的是同一份清单：B 里 route-1 不是已收藏。
  const membershipB = wishlist.wishlistMembership(archiveB, [routeA.id]);
  assert.equal(membershipB.ok, true, membershipB.error);
  assert.equal(membershipB.entries.size, 0, '别的档案的收藏不当成本档案的勾选状态');
  assert.equal(membershipB.entries.has(routeA.id), false);
  const entryB = wishlist.wishlistEntry(archiveB, routeA.id);
  assert.equal(wishlist.wishlistActionView(entryB.entry).canAdd, true, 'B 里可以正常加入');

  // 切回 A：勾选状态回到 A 的实际存储。
  swapArchive(JSON.stringify(archiveA));
  const membershipA = wishlist.wishlistMembership(archiveA, [routeA.id]);
  assert.equal(membershipA.entries.get(routeA.id).status, 'wanted');
  assert.equal(membershipA.entries.get(routeA.id).inList, true);
});

test('T027 没有注明档案 ID 的旧条目不归属任何档案：不上屏、不被增删改、原字节保留', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  const legacy = JSON.stringify({
    version: 1,
    items: [
      { routeId: route.id, gymId: '', addedAt: '2026-11-09T09:00:00.000Z', archivedAt: '' }
    ]
  });
  storage.set(WISHLIST_KEY, legacy);

  // 读得出来（不算损坏），但不猜它属于哪一份档案，因此不上屏。
  const loaded = wishlist.loadWishlist();
  assert.equal(loaded.ok, true, '缺 archiveId 的旧条目不算损坏');
  assert.equal(loaded.present, true);
  assert.equal(loaded.state.items.length, 1);
  assert.equal(loaded.state.items[0].archiveId, '');

  const listed = wishlist.listWishlist(archiveOf());
  assert.equal(listed.ok, true, listed.error);
  assert.deepEqual(listed.items, []);
  assert.equal(listed.foreignCount, 1);
  assert.equal(listed.orphanCount, 0, '没注明来源不等于线路在档案里找不到');
  assert.equal(wishlist.wishlistEntry(archiveOf(), route.id).entry, null);
  assert.equal(wishlist.wishlistMembership(archiveOf(), [route.id]).entries.size, 0);

  // 撤下与归档这条同名线路 ID：只对本档案的条目生效，旧条目一个字节都不动。
  const absent = wishlist.removeWishlist(route.id);
  assert.equal(absent.code, 'absent');
  assert.equal(writesOf(WISHLIST_KEY), 0, '不猜归属：旧条目不被撤下');
  assert.equal(wishlist.archiveWishlist(route.id).code, 'missing');
  assert.equal(rawOf(WISHLIST_KEY), legacy, '旧条目原字节保留');

  // 加入：新条目带自己的档案 ID，旧条目仍留在原处（routeId 相同、归属不同，互不覆盖）。
  const added = wishlist.addWishlist(route.id);
  assert.equal(added.ok, true, added.error);
  assert.equal(added.code, 'added');
  const items = wishlist.loadWishlist().state.items;
  assert.equal(items.length, 2);
  assert.equal(items[0].archiveId, '');
  assert.equal(items[0].addedAt, '2026-11-09T09:00:00.000Z', '旧条目原样保留');
  assert.equal(items[1].archiveId, archiveOf().archiveId);
  assert.deepEqual(wishlist.listWishlist(archiveOf()).items.map(item => item.routeId), [route.id]);
});

test('T035 换档后不串档：独立清单只列本档条目，带旧档案 ID 的迟到操作按原归属被拒绝', () => {
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  favorite(routeA.id);
  const archiveIdA = archiveOf().archiveId;
  const archiveARaw = rawOf(ARCHIVE_KEY);
  assert.equal(routeA.id, 'route-1');

  // 独立清单在 A 档案里渲染过一次：列出 A 的那条线。
  const pageA = openWishlistPage({ archiveId: archiveIdA });
  assert.equal(pageA.data.claimError, '');
  assert.equal(pageA.data.itemCount, 1);
  assert.deepEqual(pageA.data.groups[0].items.map(item => item.routeId), [routeA.id]);

  // 换成另一份档案 B：它里面也有一条 route-1，但那是另一条线。
  storage.set(ARCHIVE_KEY, otherArchiveRaw('archive-b-1', 'QA 岩馆 A'));
  const wishlistBefore = rawOf(WISHLIST_KEY);

  // B 的清单页：只按 B 的档案 ID 取条目，A 的收藏不上屏。
  const pageB = openWishlistPage({ archiveId: 'archive-b-1' });
  assert.equal(pageB.data.loadError, '');
  assert.equal(pageB.data.listError, '');
  assert.equal(pageB.data.itemCount, 0);
  assert.deepEqual(pageB.data.groups, []);

  // A 那个页面实例：入口带的是 A 的档案 ID，现在只给可见状态，不拿 B 的线顶替。
  pageA.onShow();
  assert.match(pageA.data.claimError, /另一份本机档案/);
  assert.equal(pageA.data.itemCount, 0);
  assert.deepEqual(pageA.data.groups, []);

  // 换档前的迟到操作（渲染时用的 archiveId 还是 A）：按原归属被拒绝，一个字都不写。
  const late = wishlist.addWishlist(routeA.id, { archiveId: archiveIdA });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'archive-mismatch');
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore, '迟到操作不得改写清单');

  // B 自己加入写的是 B 那一条；A 的收藏原样留着。
  const addedInB = wishlist.addWishlist('route-1', { archiveId: 'archive-b-1' });
  assert.equal(addedInB.ok, true, addedInB.error);
  const items = wishlist.loadWishlist().state.items;
  assert.equal(items.length, 2, '两份档案各一条，同名的 route-1 不互相覆盖');
  assert.equal(items.filter(item => item.archiveId === 'archive-b-1').length, 1);
  assert.equal(items.filter(item => item.archiveId === archiveIdA).length, 1);

  // 切回 A：那条收藏还在，独立清单显示的仍是 A 自己的那条线。
  storage.set(ARCHIVE_KEY, archiveARaw);
  const backInA = openWishlistPage({ archiveId: archiveIdA });
  assert.equal(backInA.data.claimError, '');
  assert.equal(backInA.data.itemCount, 1);
  assert.equal(backInA.data.groups[0].items[0].name, '蓝色动态线');
});

test('T027 收藏、撤下与归档不改训练档案与照片索引的原始字节', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  storage.set(PHOTO_KEY, 'photo-index-sentinel');
  const archiveBefore = rawOf(ARCHIVE_KEY);
  const photoBefore = rawOf(PHOTO_KEY);

  favorite(route.id);
  wishlist.archiveWishlist(route.id);
  wishlist.addWishlist(route.id);
  wishlist.removeWishlist(route.id);

  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '训练档案在清单操作前后逐字节一致');
  assert.equal(rawOf(PHOTO_KEY), photoBefore, '照片索引在清单操作前后逐字节一致');
});

test('T027 加入、撤下与归档的判定只有一份：wishlistActionView 与页面共用', () => {
  const { routeA } = twoGymsFixture();

  const notAdded = wishlist.wishlistActionView(null);
  assert.equal(notAdded.canAdd, true);
  assert.equal(notAdded.canRemove, false);
  assert.equal(notAdded.canArchive, false);

  favorite(routeA.id);
  const wanted = wishlist.wishlistActionView(entriesFor().items[0]);
  assert.equal(wanted.canAdd, false);
  assert.equal(wanted.canRemove, true);
  assert.equal(wanted.canArchive, true);
  assert.match(wanted.stateText, /想爬/);

  const filed = wishlist.archiveWishlist(routeA.id);
  const archived = wishlist.wishlistActionView(filed.entry);
  assert.equal(archived.archived, true);
  assert.equal(archived.canAdd, true, '已归档可以重新加入');
  assert.equal(archived.canArchive, false, '已归档不再提供归档入口');
  assert.equal(archived.canRemove, true);
});

// ------------------------------------------------------------------ *
// 独立清单页（T035）：按馆分组、状态、空态与失败重试
// ------------------------------------------------------------------ *

/** 独立清单页：query 是首页带过来的入口参数（archiveId 用于核对归属）。 */
function openWishlistPage(query) {
  const page = createPage(wishlistPageDefinition);
  page.onLoad(query || {});
  return page;
}

/** 线路资料页：按原长期线路 ID 打开；照片只验证展示分支，不读写文件或索引。 */
function openRoutePage(routeId, photoViews) {
  const page = createPage(routeDefinition);
  page.onLoad({ routeId });
  page._photoUi = fakePhotoUi(photoViews);
  page.refreshView();
  return page;
}

/** 首页：旧云读取在测试里不接云，等一次 flush 让本机与云状态都落定。 */
async function openIndexPage() {
  const page = createPage(indexDefinition);
  page.onLoad();
  await flush();
  return page;
}

test('T035 独立清单：按岩馆分组显示想爬/已完成/已归档，带累计把数与最近备注，点开按原线路 ID 进资料', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const wanted = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, wanted, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  record(session, wanted, 'fail', '', '2026-11-09T10:05:00');
  const done = newRoute(session, { name: '已完攀的线', grade: 'V4' });
  record(session, done, 'send', '这次成了', '2026-11-09T10:10:00');
  const broken = newRoute(session, { name: '拆掉的线', grade: 'V5' });
  favorite(wanted.id);
  favorite(done.id);
  favorite(broken.id);
  assert.equal(wishlist.archiveWishlist(broken.id).ok, true);

  const page = openWishlistPage();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.claimError, '');
  assert.equal(page.data.listError, '');
  assert.equal(page.data.hasItems, true);
  assert.equal(page.data.itemCount, 3);
  assert.match(page.data.countText, /共 3 条 · 1 家岩馆/);

  const gym = page.data.groups[0];
  assert.equal(gym.gymId, session.gymId);
  assert.equal(gym.gymName, 'A 馆');
  assert.equal(gym.countText, '3 条');
  assert.deepEqual(
    gym.items.map(item => item.routeId),
    [wanted.id, done.id, broken.id],
    '馆内先想爬、再已完成、最后已归档'
  );
  assert.deepEqual(gym.items.map(item => item.statusText), ['想爬', '已完成', '已归档']);
  assert.equal(gym.items[0].attemptCountText, '2 把', '累计把数来自档案里的全部场次');
  assert.equal(gym.items[0].latestNote, '起步用右脚', '最近一条非空备注');
  assert.equal(gym.items[0].grade, 'V3');
  assert.equal(gym.items[0].climbType, '抱石');
  assert.equal(gym.items[2].status, 'archived');
  // 页面数量与既有口径同源：就是 listWishlist 的本档可展示条目数。
  assert.equal(page.data.itemCount, wishlist.listWishlist(archiveOf()).items.length);

  // 点开某一条：按原长期线路 ID 进资料回看，导航本身不写任何键、也不会创建任何关联。
  const archiveBefore = rawOf(ARCHIVE_KEY);
  const wishlistBefore = rawOf(WISHLIST_KEY);
  const photoBefore = rawOf(PHOTO_KEY);
  const activeRouteBefore = archiveOf().activeRouteId;
  const linksBefore = archiveOf().sessionRoutes.length;
  resetWxLog();
  page.openRoute(tapDataset({ archiveId: archiveOf().archiveId, routeId: done.id }));
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-route/training-route?archiveId=' +
      archiveOf().archiveId +
      '&routeId=' +
      done.id
  ]);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore);
  assert.equal(rawOf(PHOTO_KEY), photoBefore);
  assert.equal(archiveOf().activeRouteId, activeRouteBefore, '单纯导航不换当前线路');
  assert.equal(archiveOf().sessionRoutes.length, linksBefore, '单纯导航不创建关联');

  // 已有的显式「继续这条线」操作仍可到达：进资料后按「当天再记」显式选择场次。
  const routePage = openRoutePage(wanted.id);
  assert.equal(routePage.data.canRecordAgain, true);
  assert.equal(typeof routePage.recordAgain, 'function');
});

test('T035 独立清单：第二馆 B 的线按 B 的原线路 ID 进资料，返回后活动场次不变', () => {
  const { sessionA, routeA, sessionB, routeB } = twoGymsFixture();
  favorite(routeA.id);
  favorite(routeB.id);
  record(sessionB, routeB, 'fail', 'B 馆的线', '2026-11-09T11:00:00');

  const activeBefore = archiveOf().activeSessionId;
  const page = openWishlistPage();
  assert.equal(page.data.itemCount, 2);
  assert.deepEqual(
    page.data.groups.map(group => group.gymName),
    ['A 馆', 'B 馆'],
    '按岩馆分组、按岩馆名排序'
  );

  // 点选第二馆 B：进的是 B 那条线的资料（原照片、备注与历史都由原线路 ID 决定）。
  resetWxLog();
  page.openRoute(tapDataset({ archiveId: archiveOf().archiveId, routeId: routeB.id }));
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-route/training-route?archiveId=' +
      archiveOf().archiveId +
      '&routeId=' +
      routeB.id
  ]);
  const routePage = openRoutePage(routeB.id, { [routeB.id]: savedPhotoView('/tmp/thumb-b.jpg') });
  assert.equal(routePage.data.route.id, routeB.id);
  assert.equal(routePage.data.route.name, '蓝色动态线');
  assert.equal(routePage.data.attemptCountText, '1 把');
  assert.equal(routePage.data.groups.length, 1);
  assert.equal(routePage.data.groups[0].attempts.length, 1);
  assert.equal(routePage.data.groups[0].attempts[0].note, 'B 馆的线', '资料显示的是 B 自己的备注');
  assert.equal(routePage.data.wishlistState.status, 'wanted');
  assert.equal(routePage.data.routePhoto.hasPhoto, true, '按原线路 ID 显示 B 自己的照片');
  assert.equal(routePage.data.routePhoto.thumbnailPath, '/tmp/thumb-b.jpg');

  // A 馆那条线没有被共用同一个 routeId 的 B 顶替（这里是同一档案里的两个馆）。
  const routePageA = openRoutePage(routeA.id);
  assert.equal(routePageA.data.route.id, routeA.id);
  assert.equal(routePageA.data.attemptCountText, '0 把');
  assert.equal(routePageA.data.routePhoto.hasPhoto, false, 'A 那条没有照片，不借用 B 的');

  // 返回清单再回首页：活动场次、当前线路与清单数量都不变。
  page.onShow();
  assert.equal(page.data.itemCount, 2);
  assert.deepEqual(page.data.groups.map(group => group.gymName), ['A 馆', 'B 馆']);
  assert.equal(archiveOf().activeSessionId, activeBefore, '点开清单不改活动场次');
});

test('T035 独立清单只读：打开、重试与点开都不写档案、清单与照片索引', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  favorite(route.id);
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  const photoBlob = JSON.stringify({ version: 1, photos: [{ routeId: route.id }] });
  storage.set(PHOTO_KEY, photoBlob);

  const archiveBefore = rawOf(ARCHIVE_KEY);
  const wishlistBefore = rawOf(WISHLIST_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);
  const photoWrites = writesOf(PHOTO_KEY);

  const page = openWishlistPage({ archiveId: archiveOf().archiveId });
  assert.equal(page.data.itemCount, 1);
  page.retryLoad();
  page.onShow();
  page.openRoute(tapDataset({ routeId: route.id }));

  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '档案逐字节不变');
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore, '清单逐字节不变');
  assert.equal(rawOf(PHOTO_KEY), photoBlob, '照片索引逐字节不变');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites, '打开本页不多写一次档案');
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites, '打开本页不多写一次清单');
  assert.equal(writesOf(PHOTO_KEY), photoWrites, '打开本页不写照片索引');
  // 本页没有任何写入口：数据层之外不存在第二个清单实现。
  for (const name of ['addWishlist', 'removeWishlist', 'archiveWishlist']) {
    assert.equal(typeof wishlistPageDefinition[name], 'undefined', '本页不应有：' + name);
  }
});

test('T035 旧档没有清单键：独立清单是空态、首页仍是可点的 0 条入口', async () => {
  startAt('2026-11-09', 'A 馆');
  assert.equal(rawOf(WISHLIST_KEY), '', '夹具本身没有清单键');

  const page = openWishlistPage();
  assert.equal(page.data.listError, '');
  assert.equal(page.data.claimError, '');
  assert.equal(page.data.hasItems, false);
  assert.equal(page.data.itemCount, 0);
  assert.deepEqual(page.data.groups, []);
  assert.equal(page.data.countText, '0 条', '空清单的数量就是 0');
  assert.equal(rawOf(WISHLIST_KEY), '', '只读打开不会新建清单键');

  const home = await openIndexPage();
  assert.equal(home.data.wishlistItemCount, 0);
  assert.equal(home.data.wishlistCountText, '0 条', '空清单显示 0');
  assert.equal(home.data.hasWishlist, false);
  assert.equal(home.data.wishlistError, '');

  resetWxLog();
  home.openWishlist();
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-wishlist/training-wishlist?archiveId=' + archiveOf().archiveId
  ]);
  assert.equal(rawOf(WISHLIST_KEY), '', '首页入口不写清单');
});

test('T035 清单损坏或版本不受支持：独立清单显示失败与重试，原键逐字节保留；首页入口仍在', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  favorite(route.id);
  const good = rawOf(WISHLIST_KEY);
  const archiveBefore = rawOf(ARCHIVE_KEY);

  // 1) JSON 解析不了：可见「损坏」。
  storage.set(WISHLIST_KEY, '{ not-json');
  const brokenJson = rawOf(WISHLIST_KEY);
  const pageJson = openWishlistPage();
  assert.match(pageJson.data.listError, /损坏/);
  assert.equal(pageJson.data.hasItems, false);
  assert.deepEqual(pageJson.data.groups, []);
  assert.equal(pageJson.data.itemCount, 0, '不拿 0 冒充「还没收藏」之外的结果');
  pageJson.retryLoad();
  assert.match(pageJson.data.listError, /损坏/);
  assert.equal(rawOf(WISHLIST_KEY), brokenJson, '重试不覆盖损坏的原数据');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);

  // 2) 版本不受支持：可见报错，写入口不存在，原键不动。
  const unsupported = JSON.stringify({ version: 99, items: [] });
  storage.set(WISHLIST_KEY, unsupported);
  const pageVersion = openWishlistPage();
  assert.match(pageVersion.data.listError, /版本不受支持/);
  assert.equal(pageVersion.data.itemCount, 0);
  pageVersion.retryLoad();
  assert.equal(rawOf(WISHLIST_KEY), unsupported);

  // 3) 修回原清单后重试：在同一页上按修复后的清单显示（只读，不写盘）。
  storage.set(WISHLIST_KEY, good);
  pageVersion.retryLoad();
  assert.equal(pageVersion.data.listError, '');
  assert.equal(pageVersion.data.itemCount, 1);
  assert.equal(rawOf(WISHLIST_KEY), good);

  // 首页入口照常在：显示可见提示，点开仍能进独立清单看原因与重试。
  storage.set(WISHLIST_KEY, brokenJson);
  const home = await openIndexPage();
  assert.equal(home.data.wishlistCountText, '');
  assert.equal(home.data.hasWishlist, false);
  assert.match(home.data.wishlistError, /损坏/);
  resetWxLog();
  home.openWishlist();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(rawOf(WISHLIST_KEY), brokenJson, '首页与入口都不覆盖损坏的原清单');
});

test('T035 跨档碰撞：两份档案各有一条 route-1，只列本档那一条；入口带旧档案 ID 时不顶替', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(session, { name: '本档的线', grade: 'V3' });
  favorite(routeA.id);
  const archiveIdA = archiveOf().archiveId;
  const rawA = rawOf(ARCHIVE_KEY);
  assert.equal(routeA.id, 'route-1');

  // 换成另一份档案：里面也有一条 route-1，并且也收藏了它（同一份清单文件、档案 ID 不同）。
  swapArchive(otherArchiveRaw('archive-b', 'B 馆'));
  assert.equal(archiveOf().archiveId, 'archive-b');
  assert.equal(wishlist.addWishlist('route-1').ok, true);
  assert.equal(wishlist.loadWishlist().state.items.length, 2, '清单里留着两份档案的收藏');

  // 独立清单只列本档（B）那一条：不显示、也不拿 A 的收藏顶上来。
  const pageB = openWishlistPage();
  assert.equal(pageB.data.claimError, '');
  assert.equal(pageB.data.listError, '');
  assert.equal(pageB.data.itemCount, 1);
  assert.deepEqual(pageB.data.groups.map(group => group.gymName), ['B 馆']);
  assert.deepEqual(pageB.data.groups[0].items.map(item => item.routeId), ['route-1']);
  assert.equal(pageB.data.groups[0].items[0].name, '另一份档案里的线路');
  assert.equal(pageB.data.groups[0].items[0].attemptCountText, '0 把');

  // 首页数量同样只数本档：与 listWishlist 口径一致（这里是 1 条，不是 2 条）。
  assert.equal(
    wishlist.listWishlist(archiveOf()).items.length,
    pageB.data.itemCount,
    '数量口径与 listWishlist 一致'
  );

  // 入口带的是换档前那一份档案的 ID：不展示任何条目，也不写入任何一份档案。
  const wishlistBefore = rawOf(WISHLIST_KEY);
  const pageStale = openWishlistPage({ archiveId: archiveIdA });
  assert.match(pageStale.data.claimError, /另一份本机档案/);
  assert.equal(pageStale.data.listError, '');
  assert.deepEqual(pageStale.data.groups, []);
  assert.equal(pageStale.data.itemCount, 0);
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore);

  // 切回 A 档案：A 的收藏仍在，显示的是 A 自己那条线。
  swapArchive(rawA);
  const pageA = openWishlistPage({ archiveId: archiveIdA });
  assert.equal(pageA.data.claimError, '');
  assert.deepEqual(pageA.data.groups.map(group => group.gymName), ['A 馆']);
  assert.deepEqual(pageA.data.groups[0].items.map(item => item.routeId), [routeA.id]);
  assert.equal(pageA.data.groups[0].items[0].name, '本档的线');
});

test('T035 首页与场内都不再铺清单：首页只剩一行入口，场内没有清单展示与写入口', () => {
  const indexWxml = fs.readFileSync(INDEX_WXML, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');

  // 首页：一行入口（标题 + 数量），没有清单条目、也没有按条目的线路 ID。
  assert.match(indexWxml, /id="wishlist-entry"[\s\S]{0,200}bindtap="openWishlist"/);
  assert.match(indexWxml, /id="wishlist-count"/);
  assert.doesNotMatch(indexWxml, /id="wishlist-gym-/);
  assert.doesNotMatch(indexWxml, /id="wishlist-\{\{/);
  assert.doesNotMatch(indexWxml, /bindtap="openWishlistRoute"/);
  assert.equal(typeof indexDefinition.openWishlistRoute, 'undefined');
  assert.equal(typeof indexDefinition.data.wishlistGroups, 'undefined');

  // 场内：整块清单展示（分组行与当前线路的清单卡）都不在，写入口也没有留在场内。
  assert.doesNotMatch(sessionWxml, /id="wishlist-section"/);
  assert.doesNotMatch(sessionWxml, /id="selected-wishlist"/);
  assert.doesNotMatch(sessionWxml, /id="wishlist-row-/);
  for (const handler of [
    'refreshWishlist',
    'wishlistView',
    'selectedWishlistView',
    'continueWishlistRoute',
    'openWishlistRoute',
    'addSelectedToWishlist',
    'removeSelectedFromWishlist',
    'archiveSelectedWishlist'
  ]) {
    assert.equal(typeof sessionDefinition[handler], 'undefined', '场内不应再有：' + handler);
  }

  // 保留的功能一个不少：小结入口、本场线路入口与记录 tab 仍在；
  // T036 起结果按钮在单线记录页，不在场内再铺一份。
  assert.match(sessionWxml, /bindtap="openSessionSummary"/);
  assert.match(sessionWxml, /bindtap="openRecord"/);
  assert.doesNotMatch(sessionWxml, /class="result-button result-fail"/);
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  assert.match(recordWxml, /class="result-button result-fail"/);
  assert.match(recordWxml, /bindtap="recordAttempt"/);
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ],
    'tabBar 路由不变'
  );
});

// ------------------------------------------------------------------ *
// 线路详情页与首页
// ------------------------------------------------------------------ *

test('T027 线路详情页：加入、撤下、拆线归档与状态文案；归档后逐把历史仍在', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', climbType: '抱石', grade: 'V3' });
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');

  const page = openRoutePage(route.id);
  assert.equal(page.data.wishlistState.inList, false);
  assert.equal(page.data.wishlistState.canAdd, true);

  page.addToWishlist();
  assert.equal(page.data.wishlistState.inList, true);
  assert.equal(page.data.wishlistState.canArchive, true);
  assert.equal(page.data.wishlistState.canRemove, true);
  assert.match(page.data.notice, /已加入下次想爬/);
  assert.equal(entriesFor().items.length, 1);

  // 完攀后详情页显示已完成，并把这一把的更正入口留在原位。
  const sent = record(session, route, 'send', '这次成了', '2026-11-09T10:10:00');
  // 回到页面按最新档案重算（onShow 走的就是这条 loadPage）。
  page.retryLoad();
  assert.equal(page.data.wishlistState.status, 'completed');
  assert.match(page.data.wishlistState.stateText, /已完成/);
  assert.equal(page.data.correctionRows.length, 1);

  // 详情页「改为未完成」后回到想爬。
  page.correctSend(
    tapDataset({
      attemptId: sent.id,
      routeId: route.id,
      sessionId: session.id
    })
  );
  assert.equal(page.data.wishlistState.status, 'wanted');
  assert.equal(entriesFor().items[0].status, 'wanted');

  // 拆线归档：清单变已归档，逐把历史与照片状态仍在页面上。
  const archiveBefore = rawOf(ARCHIVE_KEY);
  page.archiveWishlistItem();
  assert.equal(page.data.wishlistState.status, 'archived');
  assert.equal(page.data.wishlistState.canAdd, true);
  assert.equal(page.data.hasAttempts, true);
  assert.equal(page.data.attemptCountText, '2 把', '归档后逐把记录仍在页面上');
  assert.equal(page.data.groups.length, 1);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore, '归档不动训练档案');

  // 撤下后详情页回到「还没加入」。
  page.removeFromWishlist();
  assert.equal(page.data.wishlistState.inList, false);
  assert.deepEqual(entriesFor().items, []);

  // 写失败：不报已保存，可重试。
  armSetFailAt(1);
  page.addToWishlist();
  assert.match(page.data.notice, /收藏未保存/);
  assert.equal(entriesFor().items.length, 0);
  disarmSetFail();
});

test('T027 线路详情页：清单损坏时显示可见错误并收回写入口', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  const broken = '{ not-json';
  storage.set(WISHLIST_KEY, broken);
  const archiveBefore = rawOf(ARCHIVE_KEY);

  const page = openRoutePage(route.id);
  assert.match(page.data.wishlistState.error, /损坏/);
  assert.equal(page.data.wishlistState.canAdd, false);
  assert.equal(page.data.wishlistState.canRemove, false);
  assert.equal(page.data.wishlistState.canArchive, false);

  page.addToWishlist();
  page.archiveWishlistItem();
  assert.equal(rawOf(WISHLIST_KEY), broken, '详情页也不得覆盖损坏的原清单');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);
  assert.equal(page.data.hasAttempts, true);
});

test('T027 线路详情页：加入、撤下与拆线归档也改独立清单页看到的那一条（同一份清单）', () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');

  const routePage = openRoutePage(route.id);
  routePage.addToWishlist();

  // 资料页加入的那一条，正好就是独立清单页列出的那一条。
  const listPage = openWishlistPage();
  assert.equal(listPage.data.itemCount, 1);
  assert.deepEqual(listPage.data.groups[0].items.map(item => item.routeId), [route.id]);

  // 资料页撤下后，独立清单页按最新清单重算为空态（同一份记录，没有第二份）。
  routePage.removeFromWishlist();
  listPage.onShow();
  assert.equal(listPage.data.itemCount, 0);
  assert.equal(listPage.data.hasItems, false);
  assert.deepEqual(entriesFor().items, []);
});

test('T035 首页单行入口：数量就是 listWishlist 的本档条目数，点击进独立清单且不写盘', async () => {
  const sessionA = startAt('2026-11-09', 'A 馆');
  const routeA = newRoute(sessionA, { name: '蓝色动态线', grade: 'V3' });
  record(sessionA, routeA, 'fail', '起步用右脚', '2026-11-09T10:00:00');
  const done = newRoute(sessionA, { name: '已完攀的线', grade: 'V4' });
  record(sessionA, done, 'send', '', '2026-11-09T10:10:00');

  const sessionB = startAt('2026-11-09', 'B 馆');
  const routeB = newRoute(sessionB, { name: 'B 馆的线', grade: '5.10a', climbType: '顶绳' });
  favorite(routeA.id);
  favorite(done.id);
  favorite(routeB.id);
  const archived = newRoute(sessionB, { name: 'B 馆拆掉的线', grade: 'V2' });
  favorite(archived.id);
  assert.equal(wishlist.archiveWishlist(archived.id).ok, true);

  const archiveBefore = rawOf(ARCHIVE_KEY);
  const wishlistBefore = rawOf(WISHLIST_KEY);
  const listed = wishlist.listWishlist(archiveOf());

  const page = await openIndexPage();
  assert.equal(page.data.wishlistError, '');
  assert.equal(page.data.wishlistItemCount, listed.items.length, '首页数量 = listWishlist 的条目数');
  assert.equal(page.data.wishlistItemCount, 4, '已归档也照常计入');
  assert.equal(page.data.wishlistCountText, '4 条');
  assert.equal(page.data.hasWishlist, true);

  // 点这一行：打开独立清单（带上渲染这一刻的档案 ID 供核对）。
  resetWxLog();
  page.openWishlist();
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-wishlist/training-wishlist?archiveId=' + archiveOf().archiveId
  ]);

  // 首页只读：打开与点开都不写本机档案与清单。
  assert.equal(rawOf(ARCHIVE_KEY), archiveBefore);
  assert.equal(rawOf(WISHLIST_KEY), wishlistBefore);

  // 资料页移除一条后回首页：数量据实刷新。
  const routePage = openRoutePage(routeA.id);
  routePage.removeFromWishlist();
  const again = await openIndexPage();
  assert.equal(again.data.wishlistItemCount, 3);
  assert.equal(again.data.wishlistCountText, '3 条');
});

test('T035 首页单行入口在小结勾选后按最新清单刷新数量', async () => {
  const session = startAt('2026-11-09', 'A 馆');
  const route = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, route, 'fail', '起步用右脚', '2026-11-09T10:00:00');

  const before = await openIndexPage();
  assert.equal(before.data.wishlistItemCount, 0);
  assert.equal(before.data.wishlistCountText, '0 条');

  // 小结勾选走的就是这一份清单接口（场内页只留小结入口，不再有场内清单）。
  const added = wishlist.addWishlist(route.id);
  assert.equal(added.ok, true, added.error);

  const after = await openIndexPage();
  assert.equal(after.data.wishlistItemCount, 1);
  assert.equal(after.data.wishlistCountText, '1 条');
});

// ------------------------------------------------------------------ *
// 绑定与实现只有一份
// ------------------------------------------------------------------ *

test('T035 WXML 绑定核对：首页单行入口与独立清单都绑定真实处理函数', () => {
  const indexWxml = fs.readFileSync(INDEX_WXML, 'utf8');
  const wishlistWxml = fs.readFileSync(WISHLIST_PAGE_WXML, 'utf8');
  const routeWxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');

  assert.ok(handlersIn(indexWxml).includes('openWishlist'), '首页应绑定：openWishlist');
  assert.equal(typeof indexDefinition.openWishlist, 'function');

  for (const handler of ['openRoute', 'goHome']) {
    assert.ok(handlersIn(wishlistWxml).includes(handler), '独立清单应绑定：' + handler);
    assert.equal(typeof wishlistPageDefinition[handler], 'function');
  }
  assert.ok(handlersIn(wishlistWxml).includes('retryLoad'), '独立清单应绑定重试入口');
  assert.equal(typeof wishlistPageDefinition.retryLoad, 'function');

  // 独立清单每一条都带真实线路 ID，点开用的是同一个 ID。
  assert.match(wishlistWxml, /data-route-id="\{\{route\.routeId\}\}"/);

  // 线路详情页仍是加入、撤下与拆线归档的唯一入口。
  for (const handler of ['addToWishlist', 'removeFromWishlist', 'archiveWishlistItem']) {
    assert.ok(handlersIn(routeWxml).includes(handler), '线路详情页应绑定：' + handler);
    assert.equal(typeof routeDefinition[handler], 'function');
  }
  // 场内不再有清单绑定。
  for (const handler of ['continueWishlistRoute', 'openWishlistRoute', 'addSelectedToWishlist']) {
    assert.equal(handlersIn(sessionWxml).includes(handler), false, '场内不应再绑定：' + handler);
  }

  // 三页都走 utils/training-wishlist.js：加入、撤下与归档只有一份实现。
  assert.match(fs.readFileSync(ROUTE_JS, 'utf8'), /utils\/training-wishlist/);
  assert.match(fs.readFileSync(WISHLIST_PAGE_JS, 'utf8'), /utils\/training-wishlist/);
  assert.match(fs.readFileSync(INDEX_JS, 'utf8'), /utils\/training-wishlist/);
});

test('T027 清单层不接云、不读旧记录：只读写正式本机命名空间里的清单键', () => {
  const text = fs.readFileSync(WISHLIST_JS, 'utf8');
  assert.ok(!/wx\.cloud/.test(text), '清单层不应直接使用 wx.cloud');
  assert.ok(!/require\(.*db\.js/.test(text), '清单层不应依赖 utils/db.js');
  assert.ok(!/climbing_records/.test(text), '清单层不应触及旧集合');
  assert.match(text, /store\.NAMESPACE \+ 'wishlist'/, '清单键在正式本机命名空间内');
  assert.equal(wishlist.WISHLIST_KEY, 'climbingNote.training.v1.wishlist');
  for (const page of [SESSION_JS, ROUTE_JS, INDEX_JS, WISHLIST_PAGE_JS]) {
    assert.ok(!/wx\.cloud/.test(fs.readFileSync(page, 'utf8')), page + ' 不应直接用 wx.cloud');
  }
  // 独立清单页只读：只有导航与重试，没有清单写接口。
  const listPageText = fs.readFileSync(WISHLIST_PAGE_JS, 'utf8');
  ['addWishlist', 'removeWishlist', 'archiveWishlist', 'saveWishlist'].forEach(name => {
    assert.ok(!new RegExp('wishlist\\.' + name).test(listPageText), name + ' 不应出现在独立清单页');
  });
});
