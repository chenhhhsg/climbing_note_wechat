/**
 * T068 个人页文字备份交付
 *
 * 直接加载正式 pages/profile/profile.js，并驱动真实 utils/training-store.js、
 * training-wishlist.js 与 training-backup.js；微信存储、弹窗与剪贴板都是隔离替身。
 *
 * 覆盖：
 * - 入口说明只备份文字，不包含照片/视频/时间点/操作日志，恢复不产生可播放副本；
 * - 导出只读、复制必须由用户再点，成功只来自 wx.setClipboardData.success；
 * - 大文档复制失败与普通失败分开提示，文本始终留在页面；
 * - 有界输入、独立预演、取消/改动/离开页面/迟到回执都零写入；
 * - 无效文本、读取失败、写失败、已提交但回读未验证时的页面说明；
 * - 受损诊断逐字保留原文且不能当正常备份导入；
 * - 正式恢复后旧档、旧清单、照片/视频索引、stage/commit 均保留，普通清缓存不碰；
 * - 320/390 宽的结构性要求（流式按钮、100% 输入框）与既有入口保留。
 *
 * 不访问真实微信存储、云端、文件系统、剪贴板或任何真实用户档案。
 * 运行：node --test tests/training-backup-ui.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');
const PROFILE_WXML = path.join(ROOT, 'pages', 'profile', 'profile.wxml');
const PROFILE_WXSS = path.join(ROOT, 'pages', 'profile', 'profile.wxss');
const PROFILE_JSON = path.join(ROOT, 'pages', 'profile', 'profile.json');
const APP_JSON = path.join(ROOT, 'app.json');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');
const BACKUP_JS = path.join(ROOT, 'utils', 'training-backup.js');

const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const EXTERNAL_KEY = 'gymLogTrial.records';

// ---- 隔离存储与故障注入 ----
const storage = new Map();
const writes = [];
const fault = { get: null, set: null, mismatch: null };
let fileSystemCalls = 0;

function resetFaults() {
  fault.get = null;
  fault.set = null;
  fault.mismatch = null;
}

function arm(kind, match, times) {
  fault[kind] = { match, times: times === undefined ? 1 : times };
}

function consume(kind, key) {
  const rule = fault[kind];
  if (!rule || rule.times <= 0 || !rule.match(key)) return false;
  rule.times -= 1;
  return true;
}

// ---- 原生接口替身 ----
const clipboardCalls = [];
const toasts = [];
const modals = [];
const heldModals = [];
let modalQueue = [];

function resetNativeLog() {
  clipboardCalls.length = 0;
  toasts.length = 0;
  modals.length = 0;
  heldModals.length = 0;
  modalQueue = [];
  fileSystemCalls = 0;
}

global.wx = {
  getStorageSync(key) {
    if (consume('get', key)) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    writes.push({ key, value });
    if (consume('set', key)) throw new Error('setStorageSync:fail injected');
    if (consume('mismatch', key)) {
      storage.set(key, value + '\u0000readback-mismatch');
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
  showModal(options) {
    assert.equal(typeof options, 'object', 'showModal 必须收到参数对象');
    assert.equal(typeof options.success, 'function', 'showModal 必须带 success');
    modals.push(options);
    const behavior = modalQueue.length > 0 ? modalQueue.shift() : 'confirm';
    if (behavior === 'hold') {
      heldModals.push(options);
      return;
    }
    if (behavior === 'cancel') {
      options.success({ confirm: false, cancel: true });
      return;
    }
    if (behavior === 'fail') {
      assert.equal(typeof options.fail, 'function', '确认弹窗必须提供 fail');
      options.fail({ errMsg: 'showModal:fail injected' });
      return;
    }
    if (typeof behavior === 'function') {
      behavior(options);
      return;
    }
    options.success({ confirm: true, cancel: false });
  },
  showToast(options) {
    toasts.push(options);
  },
  setClipboardData(options) {
    clipboardCalls.push({ options, argCount: arguments.length });
    assert.equal(typeof options.success, 'function', '剪贴板必须带 success');
    assert.equal(typeof options.fail, 'function', '剪贴板必须带 fail');
  },
  navigateTo() {},
  getUserProfile() {},
  getFileSystemManager() {
    fileSystemCalls += 1;
    throw new Error('测试不得触碰文件系统');
  }
};

const appState = { globalData: { userInfo: null } };
global.getApp = () => appState;

const store = require(STORE_JS);
const wishlist = require(WISHLIST_JS);
const backup = require(BACKUP_JS);

let profileDefinition = null;

function capturePage() {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  delete require.cache[require.resolve(PROFILE_JS)];
  require(PROFILE_JS);
  assert.ok(definition, '个人页应注册 Page 定义');
  return definition;
}

function createPage() {
  const page = Object.create(profileDefinition);
  page.data = JSON.parse(JSON.stringify(profileDefinition.data));
  page.setData = function setData(patch) {
    Object.keys(patch || {}).forEach(key => {
      const parts = key.split('.');
      let node = this.data;
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!node[parts[index]] || typeof node[parts[index]] !== 'object') {
          node[parts[index]] = {};
        }
        node = node[parts[index]];
      }
      node[parts[parts.length - 1]] = patch[key];
    });
  };
  return page;
}

function succeedClipboard(index) {
  clipboardCalls[index].options.success({ errMsg: 'setClipboardData:ok' });
}

function failClipboard(index) {
  clipboardCalls[index].options.fail({ errMsg: 'setClipboardData:fail' });
}

function setImportText(page, text) {
  page.onBackupImportInput({ detail: { value: text } });
}

function protectedSnapshot() {
  return [...storage.entries()]
    .filter(([key]) => !store.isRebuildableKey(key))
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

function stageKeys() {
  return [...storage.keys()].filter(key => key.indexOf(store.BACKUP_STAGE_PREFIX) === 0);
}

// ---- 合成档案：多日/同日多馆、昵称与标点、逐把备注、撤回、清单归档（无真实用户数据） ----
function seedFixture() {
  storage.clear();
  store.resetLayoutCache();

  const s1 = store.startSession({
    gymName: '岩馆·东',
    date: '2026-11-18',
    now: new Date(2026, 10, 18, 9, 0)
  });
  assert.equal(s1.ok, true, s1.error);
  const r1 = store.createRoute({
    sessionId: s1.session.id,
    name: '“黄色均衡线”',
    climbType: '抱石',
    grade: 'V4',
    colorName: '黄',
    now: new Date(2026, 10, 18, 9, 5)
  });
  assert.equal(r1.ok, true, r1.error);
  const a1 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'fail',
    note: '第一把：起手很滑；第二把换右脚！',
    now: new Date(2026, 10, 18, 9, 10)
  });
  assert.equal(a1.ok, true, a1.error);
  const a2 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'fail',
    note: '待撤回的备注：保留原文',
    now: new Date(2026, 10, 18, 9, 15)
  });
  assert.equal(a2.ok, true, a2.error);
  const undone = store.undoAttempt(a2.attempt.id, {
    opId: 'ui-undo-1',
    now: new Date(2026, 10, 18, 9, 18)
  });
  assert.equal(undone.ok, true, undone.error);
  const a3 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'send',
    note: '完成（用了 3 把）——“左手侧拉”。',
    now: new Date(2026, 10, 18, 9, 20)
  });
  assert.equal(a3.ok, true, a3.error);

  const s2 = store.startSession({
    gymName: '岩馆·西',
    date: '2026-11-19',
    now: new Date(2026, 10, 19, 18, 0)
  });
  assert.equal(s2.ok, true, s2.error);
  const r2 = store.createRoute({
    sessionId: s2.session.id,
    name: '蓝色耐力线',
    climbType: '顶绳',
    grade: '5.10c',
    colorName: '蓝',
    now: new Date(2026, 10, 19, 18, 5)
  });
  assert.equal(r2.ok, true, r2.error);
  const linked = store.linkRouteToSession(s2.session.id, r1.route.id);
  assert.equal(linked.ok, true, linked.error);
  const a4 = store.saveAttempt({
    sessionId: s2.session.id,
    routeId: r2.route.id,
    result: 'fail',
    note: '第二场再试：还是没跨过第三把……',
    now: new Date(2026, 10, 19, 18, 20)
  });
  assert.equal(a4.ok, true, a4.error);

  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  const archiveId = loaded.archive.archiveId;
  const added = wishlist.addWishlist(r2.route.id, {
    archiveId,
    now: new Date(2026, 10, 19, 19, 0)
  });
  assert.equal(added.ok, true, added.error);
  const archived = wishlist.archiveWishlist(r2.route.id, {
    archiveId,
    now: new Date(2026, 10, 19, 19, 10)
  });
  assert.equal(archived.ok, true, archived.error);

  // 合成媒体索引：验证恢复与清缓存都不改写、也不访问文件系统。
  const photoRaw = JSON.stringify({
    version: 1,
    photos: [{ id: 'photo-1', filePath: 'wxfile://synthetic/photo-1.jpg' }],
    routes: [],
    operations: []
  });
  const videoRaw = JSON.stringify({ version: 1, items: [] });
  storage.set(store.PHOTO_INDEX_KEY, photoRaw);
  storage.set(VIDEO_INDEX_KEY, videoRaw);

  return { archiveId, photoRaw, videoRaw, routes: [r1.route.id, r2.route.id] };
}

function previewFor(page, text) {
  setImportText(page, text);
  const result = page.previewBackupImport();
  assert.equal(result.ok, true, result.error);
  assert.ok(page.data.backupPreview && page.data.backupPreview.token);
  return result;
}

beforeEach(() => {
  storage.clear();
  writes.length = 0;
  resetFaults();
  resetNativeLog();
  appState.globalData.userInfo = null;
  store.resetLayoutCache();
  profileDefinition = capturePage();
});

// ------------------------------------------------------------------ *
// 入口、范围说明与响应式结构
// ------------------------------------------------------------------ *

test('T068-UI-A 既有页面内提供入口，范围说明点名媒体/时间点/操作日志与旧归属', () => {
  const wxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  const wxss = fs.readFileSync(PROFILE_WXSS, 'utf8');
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  const profileJson = JSON.parse(fs.readFileSync(PROFILE_JSON, 'utf8'));

  [
    'id="backup-section"',
    'id="backup-scope"',
    'id="backup-import-input"',
    'bindtap="exportBackupText"',
    'bindtap="copyBackupText"',
    'bindtap="exportBackupDiagnostics"',
    'bindtap="copyBackupDiagnostics"',
    'bindtap="previewBackupImport"',
    'bindtap="confirmBackupRestore"'
  ].forEach(marker => {
    assert.ok(wxml.indexOf(marker) !== -1, '个人页备份区缺少 ' + marker);
  });
  assert.ok(
    wxml.indexOf('maxlength="{{backupImportMaxLength}}"') !== -1,
    '导入输入必须有界'
  );
  assert.ok(wxml.indexOf('selectable="{{true}}"') !== -1, '导出文本应可长按自选保存');

  const scope = wxml.slice(wxml.indexOf('id="backup-scope"'), wxml.indexOf('id="backup-notice"'));
  ['照片', '视频', '时间点', '操作日志', '云端记录', '旧档案', '可播放副本'].forEach(word => {
    assert.ok(scope.indexOf(word) !== -1, '备份说明应包含 ' + word);
  });
  assert.ok(scope.indexOf('不包含') !== -1);
  assert.ok(scope.indexOf('只备份文字') !== -1);

  // 既有入口与页面结构不变；不新增页面路由或页面配置。
  ['bindtap="getUserProfile"', 'bindtap="goToFitnessTest"', 'bindtap="feedback"', 'bindtap="clearCache"', 'bindtap="goToAbout"'].forEach(
    marker => assert.ok(wxml.indexOf(marker) !== -1, '既有入口丢失 ' + marker)
  );
  assert.equal(appJson.pages.length, 15, '不应新增页面路由');
  assert.equal(
    appJson.pages.some(item => /backup/i.test(item)),
    false,
    '备份必须留在既有个人页'
  );
  assert.equal(profileJson.navigationBarTitleText, '我的');
  assert.equal(typeof profileDefinition.exportBackupText, 'function');
  assert.equal(typeof profileDefinition.previewBackupImport, 'function');
  assert.equal(typeof profileDefinition.confirmBackupRestore, 'function');

  // 300/390 宽的结构性保障：按钮可换行、输入框与文本框按 100% 流式。
  assert.match(wxss, /\.backup-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(wxss, /\.backup-import\s*\{[^}]*width:\s*100%/);
  assert.match(wxss, /\.backup-text-box\s*\{[^}]*width:\s*100%/);
  assert.match(wxss, /\.backup-button\s*\{[^}]*flex:\s*1 1 240rpx/);
  assert.equal(/\.backup-[^{]*\{[^}]*white-space:\s*nowrap/.test(wxss), false);
});

// ------------------------------------------------------------------ *
// 导出只读、显式复制与大小文档失败
// ------------------------------------------------------------------ *

test('T068-UI-B 导出只读且不碰剪贴板；读取失败不清掉此前导出的文字', () => {
  seedFixture();
  const page = createPage();
  const before = writes.length;

  const exported = page.exportBackupText();
  assert.equal(exported.ok, true, exported.error);
  assert.equal(writes.length, before, '导出不得写任何键');
  assert.equal(clipboardCalls.length, 0, '生成备份不得自动复制');
  assert.ok(page.data.backupExportText.length > 0);
  assert.match(page.data.backupExportMeta, /场/);
  assert.match(page.data.backupNotice, /已生成文本备份/);

  const parsed = JSON.parse(page.data.backupExportText);
  assert.equal(parsed.summary.attempts, exported.summary.attempts);
  assert.ok(parsed.contents.excludes.indexOf('photos') !== -1);

  const keptText = page.data.backupExportText;
  arm('get', key => key === store.ARCHIVE_KEY, 1);
  const failed = page.exportBackupText();
  assert.equal(failed.ok, false);
  assert.equal(page.data.backupNoticeKind, 'error');
  assert.equal(page.data.backupExportText, keptText, '读取失败不得隐藏此前导出文字');
  assert.equal(writes.length, before, '失败的导出同样不写');

  // 导入框里的原文也必须保留。
  setImportText(page, '用户此前粘贴的原文');
  arm('get', key => key === store.ARCHIVE_KEY, 1);
  page.exportBackupText();
  assert.equal(page.data.backupImportText, '用户此前粘贴的原文');
});

test('T068-UI-C 复制必须显式点击，成功只来自原生回调；新操作使旧回执失效', () => {
  seedFixture();
  const page = createPage();
  page.exportBackupText();

  page.copyBackupText();
  assert.equal(clipboardCalls.length, 1);
  assert.equal(clipboardCalls[0].argCount, 1, '只允许一个原生参数对象');
  assert.equal(clipboardCalls[0].options.data, page.data.backupExportText);
  assert.equal(toasts.length, 0, '原生回调前不得提示成功');

  succeedClipboard(0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, '备份文本已复制');
  assert.equal(toasts[0].icon, 'success');
  assert.match(page.data.backupNotice, /已复制/);
  assert.equal(page.data.backupCopyFailed, false);

  // 普通失败：不报成功，文本和失败态都保留。
  page.exportBackupText();
  page.copyBackupText();
  const failIndex = clipboardCalls.length - 1;
  failClipboard(failIndex);
  assert.equal(page.data.backupCopyFailed, true);
  assert.equal(page.data.backupCopyFailureKind, 'failed');
  assert.match(page.data.backupNotice, /仍保留/);
  assert.ok(page.data.backupExportText.length > 0, '失败不得清空文本');
  const toastCount = toasts.length;
  page.copyBackupText();
  succeedClipboard(clipboardCalls.length - 1);
  assert.equal(toasts.length, toastCount + 1);
  assert.equal(toasts.at(-1).title, '备份文本已复制');

  // 迟到的旧成功：重新生成后旧回执不得再提示或改状态。
  page.exportBackupText();
  page.copyBackupText();
  const staleIndex = clipboardCalls.length - 1;
  page.exportBackupText(); // 新操作，旧回执应作废
  const beforeStale = toasts.length;
  succeedClipboard(staleIndex);
  assert.equal(toasts.length, beforeStale, '迟到的旧复制成功不得提示');
});

test('T068-UI-D 大文档复制失败与普通失败区分，且不隐藏原文', () => {
  seedFixture();
  const page = createPage();
  page.exportBackupText();

  // 直接放一段超过页面「大文档」提示阈值的合成文本（不是产品上限）。
  page.data.backupExportText = '你'.repeat(Math.ceil((256 * 1024) / 3) + 100);
  page.copyBackupText();
  failClipboard(clipboardCalls.length - 1);

  assert.equal(page.data.backupCopyFailed, true);
  assert.equal(page.data.backupCopyFailureKind, 'too-large');
  assert.match(page.data.backupCopyIssueText, /剪贴板可能放不下/);
  assert.match(page.data.backupNotice, /剪贴板可能放不下/);
  assert.equal(toasts.at(-1).title, '文本较大，未复制');
  assert.ok(page.data.backupExportText.length > 0, '失败不得清空文本');
});

test('T068-UI-E 备份复制与诊断复制各自回执，不互相冒充', () => {
  seedFixture();
  const page = createPage();
  page.exportBackupText();
  page.copyBackupText(); // 0：备份复制悬着
  page.exportBackupDiagnostics(); // 新操作，旧复制回执作废
  page.copyBackupDiagnostics(); // 1

  succeedClipboard(1);
  assert.equal(toasts.at(-1).title, '诊断原文已复制');
  assert.match(page.data.backupNotice, /诊断原文已复制/);
  assert.equal(page.data.backupCopyFailed, false, '诊断复制不得改动备份复制状态');

  const beforeStale = toasts.length;
  succeedClipboard(0);
  assert.equal(toasts.length, beforeStale, '旧备份复制回执不得冒充诊断结果');
});

// ------------------------------------------------------------------ *
// 有界输入、预演、取消与恢复
// ------------------------------------------------------------------ *

test('T068-UI-F 预演零写入；改动输入使预演失效，旧确认零写入', () => {
  seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  const before = writes.length;

  previewFor(page, exported.text);
  assert.equal(writes.length, before, '预演不得写任何键');
  assert.match(page.data.backupNotice, /检查通过，尚未写入/);
  const preview = page.data.backupPreview;
  assert.equal(preview.summary.attempts, exported.summary.attempts);

  // 改一个字符：预演立刻失效，恢复按钮隐藏。
  setImportText(page, exported.text + ' ');
  assert.equal(page.data.backupPreview, null);
  assert.match(page.data.backupNotice, /预演已失效/);
  assert.equal(page.data.backupImportText, exported.text + ' ');

  const modalBefore = modals.length;
  page.confirmBackupRestore();
  assert.equal(modals.length, modalBefore, '没有有效预演就不得弹确认');
  assert.equal(writes.length, before);

  // 取消：不写，保留预演与原输入。
  previewFor(page, exported.text);
  modalQueue.push('cancel');
  page.confirmBackupRestore();
  assert.equal(modals.length, modalBefore + 1);
  assert.equal(writes.length, before, '取消不得写入');
  assert.match(page.data.backupNotice, /已取消恢复/);
  assert.equal(page.data.backupImportText, exported.text);
  assert.ok(page.data.backupPreview, '取消后仍可再次确认');
});

test('T068-UI-G 显式确认后恢复文字，旧档/媒体/索引/stage 保留且不碰文件系统', () => {
  const fixture = seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  const oldArchiveRaw = storage.get(store.ARCHIVE_KEY);
  const oldWishlistRaw = storage.get(store.WISHLIST_KEY);

  previewFor(page, exported.text);
  page.confirmBackupRestore();

  assert.match(page.data.backupNotice, /恢复完成/);
  assert.equal(page.data.backupPreview, null);
  assert.equal(page.data.backupImportText, exported.text, '成功后仍保留粘贴原文');
  assert.ok(stageKeys().length >= 2, 'stage 原文应保留');
  assert.ok(storage.has(store.BACKUP_COMMIT_KEY), '提交记录应存在');
  assert.ok(storage.has(store.BACKUP_PENDING_KEY), '提交计划原文应保留');

  const restored = store.loadState();
  assert.equal(restored.ok, true, restored.error);
  assert.notEqual(restored.archive.archiveId, fixture.archiveId);
  assert.equal(restored.archive.attempts.length, exported.summary.attempts);
  assert.deepEqual(
    restored.archive.attempts.map(item => item.note).sort(),
    JSON.parse(oldArchiveRaw).attempts.map(item => item.note).sort()
  );

  assert.equal(storage.get(store.ARCHIVE_KEY), oldArchiveRaw, '旧档案原文必须逐字保留');
  assert.equal(storage.get(store.WISHLIST_KEY), oldWishlistRaw, '旧清单原文必须逐字保留');
  assert.equal(storage.get(store.PHOTO_INDEX_KEY), fixture.photoRaw);
  assert.equal(storage.get(VIDEO_INDEX_KEY), fixture.videoRaw);
  assert.equal(fileSystemCalls, 0, '文本恢复不得触碰媒体文件');
});

test('T068-UI-H 无效文本与受损诊断都不能导入；诊断逐字保留原文', () => {
  storage.clear();
  store.resetLayoutCache();
  const damaged = '{"version":1,"archiveId":"synthetic",BROKEN';
  storage.set(store.ARCHIVE_KEY, damaged);
  const page = createPage();

  const diagnostics = page.exportBackupDiagnostics();
  assert.equal(diagnostics.ok, true, diagnostics.error);
  const parsed = JSON.parse(page.data.backupDiagnosticsText);
  assert.equal(parsed.current.archive.text, damaged, '诊断必须逐字保留受损原文');
  assert.equal(parsed.current.archive.parseOk, false);
  assert.match(page.data.backupNotice, /不能作为备份导入/);

  setImportText(page, '这只是一段普通文字');
  let before = writes.length;
  let result = page.previewBackupImport();
  assert.equal(result.ok, false);
  assert.equal(writes.length, before, '无效文本零写入');
  assert.equal(page.data.backupImportText, '这只是一段普通文字', '失败不得隐藏原文');
  assert.match(page.data.backupNotice, /检查未通过/);

  // 诊断原文格式不同：不得被当作验证过的备份封套接受。
  setImportText(page, page.data.backupDiagnosticsText);
  before = writes.length;
  result = page.previewBackupImport();
  assert.equal(result.ok, false);
  assert.equal(writes.length, before, '诊断原文零写入');
  assert.equal(page.data.backupImportText, page.data.backupDiagnosticsText);

  const modalBefore = modals.length;
  page.confirmBackupRestore();
  assert.equal(modals.length, modalBefore, '没有预演不得进入确认');
  assert.equal(writes.length, before);
});

test('T068-UI-I 预演读取当前档案失败：不写、不隐藏粘贴原文，故障恢复后可再预演', () => {
  seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  setImportText(page, exported.text);
  const before = writes.length;

  arm('get', key => key === store.ARCHIVE_KEY, 1);
  const failed = page.previewBackupImport();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'current-read-failed');
  assert.equal(writes.length, before);
  assert.equal(page.data.backupPreview, null);
  assert.equal(page.data.backupImportText, exported.text);
  assert.match(page.data.backupNotice, /检查未通过/);

  const retried = page.previewBackupImport();
  assert.equal(retried.ok, true, retried.error);
  assert.equal(page.data.backupImportText, exported.text);
});

test('T068-UI-J 写前失败：页面保留原文与旧档案，要求重新预演而非盲目重试', () => {
  seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  const oldArchiveId = store.loadState().archive.archiveId;
  previewFor(page, exported.text);

  arm('set', key => key === store.BACKUP_PENDING_KEY, 1);
  page.confirmBackupRestore();

  assert.match(page.data.backupNotice, /恢复未写入/);
  assert.match(page.data.backupNotice, /重新检查/);
  assert.equal(page.data.backupPreview, null, '失败后必须重新预演');
  assert.equal(page.data.backupImportText, exported.text, '失败不得隐藏原文');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(store.loadState().archive.archiveId, oldArchiveId);
});

test('T068-UI-K 已提交但回读未验证：提示先诊断，不引导原样重试', () => {
  seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  previewFor(page, exported.text);

  arm('mismatch', key => key === store.BACKUP_COMMIT_KEY, 1);
  page.confirmBackupRestore();

  assert.equal(page.data.backupPreview, null, '未验证提交后必须撤销预演');
  assert.equal(page.data.backupImportText, exported.text);
  assert.match(page.data.backupNotice, /提交结果未能核对/);
  assert.match(page.data.backupNotice, /导出受损诊断/);
  assert.match(page.data.backupNotice, /不要用同一段文本再次恢复/);
  assert.equal(/重试/.test(page.data.backupNotice), false, '不得建议可能重放旧状态的重试');
  assert.equal(store.loadState().ok, false, '提交记录损坏时应返回可见错误而不是半提交');
});

// ------------------------------------------------------------------ *
// 延迟回执、离开页面与清缓存边界
// ------------------------------------------------------------------ *

test('T068-UI-L 输入改动/离开页面使旧确认与旧剪贴板回执失效，全程零写入', () => {
  seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();

  // 预演后打开确认弹窗，用户又改输入：旧弹窗确认不得写。
  previewFor(page, exported.text);
  modalQueue.push('hold');
  page.confirmBackupRestore();
  assert.equal(heldModals.length, 1);
  const before = writes.length;
  setImportText(page, exported.text + '改');
  heldModals[0].success({ confirm: true, cancel: false });
  assert.equal(writes.length, before, '输入改动后的旧确认不得写入');
  assert.equal(page.data.backupImportText, exported.text + '改');

  // 再次预演并打开弹窗，然后页面隐藏：旧确认不得写。
  previewFor(page, exported.text);
  modalQueue.push('hold');
  page.confirmBackupRestore();
  assert.equal(heldModals.length, 2);
  page.onHide();
  heldModals[1].success({ confirm: true, cancel: false });
  assert.equal(writes.length, before, '离开页面后的旧确认不得写入');
  assert.equal(page.data.backupPreview, null);
  assert.match(page.data.backupNotice, /预演已失效/);

  // 剪贴板悬着时卸载：迟到成功不得提示。
  page.exportBackupText();
  page.copyBackupText();
  const pendingClipboard = clipboardCalls.length - 1;
  const toastBefore = toasts.length;
  page.onUnload();
  succeedClipboard(pendingClipboard);
  assert.equal(toasts.length, toastBefore, '卸载后的旧剪贴板回执不得提示');

  // 带着预演直接卸载：预演失效，零写入。
  const page2 = createPage();
  const exported2 = page2.exportBackupText();
  previewFor(page2, exported2.text);
  const unloadWrites = writes.length;
  page2.onUnload();
  assert.equal(page2.data.backupPreview, null);
  assert.equal(writes.length, unloadWrites, '卸载不得写入');
});

test('T068-UI-M 普通清缓存保留档案/清单/媒体索引/commit/stage/pending 原文', async () => {
  const fixture = seedFixture();
  const page = createPage();
  const exported = page.exportBackupText();
  previewFor(page, exported.text);
  page.confirmBackupRestore();

  const rebuildable = [
    store.REBUILDABLE_PREFIXES[0] + 'thumb-a',
    store.REBUILDABLE_PREFIXES[1] + 'photo-b'
  ];
  rebuildable.forEach(key => storage.set(key, 'rebuildable-value'));
  storage.set(EXTERNAL_KEY, '旧试用数据保持原样');

  const protectedBefore = protectedSnapshot();
  const toastBefore = toasts.length;
  const outcome = await page.clearCacheConfirmed();

  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(outcome.removed.slice().sort(), rebuildable.slice().sort());
  assert.equal(storage.has(rebuildable[0]), false);
  assert.equal(storage.has(rebuildable[1]), false);
  assert.equal(storage.get(EXTERNAL_KEY), '旧试用数据保持原样');
  assert.deepEqual(protectedSnapshot(), protectedBefore, '受保护键必须逐字保留');
  assert.ok(storage.has(store.BACKUP_COMMIT_KEY));
  assert.ok(storage.has(store.BACKUP_PENDING_KEY));
  assert.ok(stageKeys().length >= 2);
  assert.equal(storage.get(store.PHOTO_INDEX_KEY), fixture.photoRaw);
  assert.equal(storage.get(VIDEO_INDEX_KEY), fixture.videoRaw);
  assert.equal(fileSystemCalls, 0, '清缓存不得访问照片/视频文件');
  assert.equal(toasts.length, toastBefore + 1);
  assert.equal(toasts.at(-1).title, '清除成功');
});
