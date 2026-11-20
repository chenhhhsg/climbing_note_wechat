/**
 * T059 R4 反馈真实复制回执（离线部分）
 *
 * 直接加载正式个人页 pages/profile/profile.js，用严格微信参数对象替身驱动：
 * - 确认反馈后只发出一次 wx.setClipboardData({ data, success, fail })；
 * - 只有原生 success 回调才提示「已复制」，粘贴内容与输入完全相同；
 * - 原生 fail 不提示成功，原文留在页面内存并提供同文重试；
 * - 取消（即使微信回传 content）不写剪贴板、不写存储、不提示；
 * - 旧弹窗 / 旧剪贴板回执按操作序号丢弃，不覆盖更新的操作；
 * - 重复点击反馈也只让最新操作生效。
 *
 * 这里不连真实云、不读写真实剪贴板、不落任何反馈存储；原生粘贴结果、真机弹窗与
 * 输入法表现仍需在手机上复核（待验）。
 *
 * 运行：node --test tests/review-profile.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');
const PROFILE_WXML = path.join(ROOT, 'pages', 'profile', 'profile.wxml');

const storage = new Map();
const log = {
  modals: [],
  toasts: [],
  clipboardCalls: [],
  clipboardText: null,
  storageWrites: [],
  profileCalls: []
};

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    log.storageWrites.push({ key, value });
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: Array.from(storage.keys()) };
  },
  showModal(options) {
    log.modals.push(options);
  },
  showToast(options) {
    log.toasts.push(options);
  },
  setClipboardData(options) {
    log.clipboardCalls.push({ options, argCount: arguments.length });
  },
  getUserProfile(options) {
    log.profileCalls.push({ options, argCount: arguments.length });
  }
};

const appState = { globalData: { userInfo: null } };
global.getApp = () => appState;

let profileDefinition = null;

function resetAll() {
  storage.clear();
  log.modals.length = 0;
  log.toasts.length = 0;
  log.clipboardCalls.length = 0;
  log.clipboardText = null;
  log.storageWrites.length = 0;
  log.profileCalls.length = 0;
  appState.globalData.userInfo = null;
}

beforeEach(() => {
  resetAll();
  profileDefinition = capturePage(PROFILE_JS);
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

function confirmModal(index, content) {
  log.modals[index].success({ confirm: true, cancel: false, content });
}

/** 模拟原生剪贴板写入成功，并回调页面。 */
function succeedClipboard(index) {
  const call = log.clipboardCalls[index];
  log.clipboardText = call.options.data;
  call.options.success({ errMsg: 'setClipboardData:ok' });
}

function failClipboard(index) {
  log.clipboardCalls[index].options.fail({ errMsg: 'setClipboardData:fail' });
}

/** 模拟微信资料读取成功。 */
function succeedProfile(index, userInfo) {
  log.profileCalls[index].options.success({ userInfo });
}

/** 模拟微信资料读取被拒绝或失败。 */
function failProfile(index, errMsg) {
  log.profileCalls[index].options.fail({ errMsg });
}

test('R4 成功：单个原生参数对象复制，成功回调后才提示已复制且文字一致', () => {
  const page = createPage(profileDefinition);
  page.feedback();

  assert.equal(log.modals.length, 1);
  assert.equal(log.modals[0].editable, true);
  assert.equal(log.clipboardCalls.length, 0, '只打开弹窗不应触碰剪贴板');
  assert.equal(log.toasts.length, 0);

  const text = '  第三个挂片的螺栓有点松，建议检查  ';
  confirmModal(0, text);

  assert.equal(log.clipboardCalls.length, 1, '一次确认只复制一次');
  assert.equal(log.clipboardCalls[0].argCount, 1, '只允许一个原生参数对象');
  assert.equal(typeof log.clipboardCalls[0].options.success, 'function');
  assert.equal(typeof log.clipboardCalls[0].options.fail, 'function');
  assert.equal(log.clipboardCalls[0].options.data, text, '复制原文，不做裁剪');
  assert.equal(log.toasts.length, 0, '原生回调前不得先报成功');

  succeedClipboard(0);

  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, '已复制');
  assert.equal(log.toasts[0].icon, 'success');
  assert.equal(log.clipboardText, text, '粘贴出来应与输入完全相同');
  assert.equal(page.data.feedbackCopyFailed, false);
  assert.equal(log.storageWrites.length, 0, '反馈不得写本机存储');

  // 原生即使重复回调，也只允许成功一次。
  succeedClipboard(0);
  assert.equal(log.toasts.length, 1);
});

test('R4 失败：不提示成功，保留原文并提供同文重试', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  confirmModal(0, '顶绳保护站附近的岩点有松动');

  assert.equal(log.clipboardCalls.length, 1);
  failClipboard(0);

  assert.equal(page.data.feedbackCopyFailed, true);
  assert.equal(page.data.feedbackDraft, '顶绳保护站附近的岩点有松动');
  assert.equal(log.storageWrites.length, 0, '失败也不得落存储');
  assert.equal(
    log.toasts.some(item => item.title === '已复制' || item.title === '感谢反馈'),
    false,
    '原生失败不得声称已复制或已发送'
  );
  assert.match(log.toasts[0].title, /复制失败/);

  const wxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  assert.ok(wxml.indexOf('wx:if="{{feedbackCopyFailed}}"') !== -1, '失败态应有条件渲染');
  assert.ok(wxml.indexOf('bindtap="retryFeedback"') !== -1, '失败态应提供重试入口');

  page.retryFeedback();

  assert.equal(log.clipboardCalls.length, 2);
  assert.equal(log.clipboardCalls[1].argCount, 1);
  assert.equal(
    log.clipboardCalls[1].options.data,
    '顶绳保护站附近的岩点有松动',
    '重试必须使用同一段文字'
  );

  succeedClipboard(1);
  assert.equal(page.data.feedbackCopyFailed, false);
  assert.equal(page.data.feedbackDraft, '');
  assert.equal(log.toasts.at(-1).title, '已复制');
});

test('R4 取消：即使回传 content 也不写剪贴板、不写存储、不提示', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  log.modals[0].success({ confirm: false, cancel: true, content: '取消时仍带着的输入' });

  assert.equal(log.clipboardCalls.length, 0);
  assert.equal(log.storageWrites.length, 0);
  assert.equal(log.toasts.length, 0);
  assert.equal(page.data.feedbackDraft, '');
  assert.equal(page.data.feedbackCopyFailed, false);
});

test('R4 空内容：确认也不复制、不写存储，只提示先输入', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  confirmModal(0, '   \n  ');

  assert.equal(log.clipboardCalls.length, 0);
  assert.equal(log.storageWrites.length, 0);
  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, '请先输入反馈');
});

test('R4 迟到回执：旧复制回调不覆盖新操作', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  confirmModal(0, '旧反馈');
  assert.equal(log.clipboardCalls.length, 1);

  // 旧复制还悬着时，用户又发起并确认了一段新反馈。
  page.feedback();
  confirmModal(1, '新反馈');
  assert.equal(log.clipboardCalls.length, 2);

  // 旧回执无论成功或失败都只能被丢弃。
  succeedClipboard(0);
  assert.equal(log.toasts.length, 0, '迟到的旧成功不得提示');
  failClipboard(0);
  assert.equal(log.toasts.length, 0, '迟到的旧失败也不得提示');
  assert.equal(page.data.feedbackDraft, '新反馈');
  assert.equal(page.data.feedbackCopyFailed, false);

  succeedClipboard(1);
  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, '已复制');
  assert.equal(log.clipboardText, '新反馈');
});

test('R4 重复交互：旧弹窗回执不能发起复制或覆盖最新弹窗', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  page.feedback();
  assert.equal(log.modals.length, 2);

  // 先返回的旧弹窗确认被丢弃。
  confirmModal(0, '旧弹窗文字');
  assert.equal(log.clipboardCalls.length, 0);

  confirmModal(1, '最新弹窗文字');
  assert.equal(log.clipboardCalls.length, 1);
  assert.equal(log.clipboardCalls[0].options.data, '最新弹窗文字');

  succeedClipboard(0);
  assert.equal(log.toasts.length, 1);
  assert.equal(page.data.feedbackDraft, '');
});

test('R4 保留个人页既有入口与菜单结构', () => {
  const wxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  [
    'bindtap="getUserProfile"',
    'bindtap="goToFitnessTest"',
    'bindtap="feedback"',
    'bindtap="clearCache"',
    'bindtap="goToAbout"'
  ].forEach(marker => {
    assert.ok(wxml.indexOf(marker) !== -1, '个人页缺少既有入口 ' + marker);
  });
  assert.equal(typeof profileDefinition.feedback, 'function');
  assert.equal(typeof profileDefinition.retryFeedback, 'function');
  assert.equal(typeof profileDefinition.clearCache, 'function');
});

// ------------------------------------------------------------------ T066 U7

test('U7 入口只表达本机显示的资料能力，不再暗示登录、绑定或同步成功', () => {
  const wxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  assert.ok(wxml.includes('设置头像昵称'), '资料入口应改为「设置头像昵称」');
  assert.equal(wxml.includes('点击登录'), false, '不应再出现点击登录');
  assert.equal(wxml.includes('登录'), false, '不应再让用户以为要登录');
  assert.equal(wxml.includes('绑定账号'), false, '不应暗示绑定账号');
  assert.equal(/同步成功|已同步|同步完成/.test(wxml), false, '不应暗示同步成功');
  assert.ok(wxml.includes('不会创建账号'), '应说明不会创建账号');
  assert.ok(wxml.includes('只在本页显示'), '应说明资料只在本页显示');
  assert.ok(wxml.includes('保存在这台手机的攀笔中'), '保留本机训练记录归属说明');
  assert.ok(wxml.includes('id="profile-notice"'), '资料结果应有独立的页面提示位');
  assert.equal(typeof profileDefinition.getUserProfile, 'function');
});

test('U7 资料成功独立于复制反馈：不清草稿与失败态，也不写存储', () => {
  const page = createPage(profileDefinition);
  page.feedback();
  confirmModal(0, '顶绳保护站附近的岩点有松动');
  failClipboard(0);
  assert.equal(page.data.feedbackCopyFailed, true);
  assert.equal(page.data.feedbackDraft, '顶绳保护站附近的岩点有松动');
  assert.equal(log.toasts.length, 1);

  const userInfo = { nickName: '阿岩', avatarUrl: 'https://example.invalid/a.png' };
  page.getUserProfile();
  assert.equal(log.profileCalls.length, 1);
  assert.equal(log.profileCalls[0].argCount, 1, '只允许一个原生参数对象');
  assert.equal(typeof log.profileCalls[0].options.success, 'function');
  assert.equal(typeof log.profileCalls[0].options.fail, 'function');
  succeedProfile(0, userInfo);

  assert.equal(page.data.hasUserInfo, true);
  assert.deepEqual(page.data.userInfo, userInfo);
  assert.equal(appState.globalData.userInfo, userInfo);
  assert.equal(page.data.profileNotice, '');
  assert.equal(page.data.feedbackCopyFailed, true, '资料成功不得覆盖复制失败态');
  assert.equal(page.data.feedbackDraft, '顶绳保护站附近的岩点有松动');
  assert.equal(log.toasts.length, 1, '资料成功不弹提示、不冒充复制结果');
  assert.equal(log.storageWrites.length, 0, '资料只保留在本机内存');
});

test('U7 拒绝与失败分别说明，且都不影响意见反馈', () => {
  const page = createPage(profileDefinition);
  page.getUserProfile();
  failProfile(0, 'getUserProfile:fail auth deny');
  assert.equal(page.data.hasUserInfo, false);
  assert.equal(page.data.profileNoticeKind, 'denied');
  assert.match(page.data.profileNotice, /已取消/);
  assert.equal(page.data.feedbackDraft, '');
  assert.equal(page.data.feedbackCopyFailed, false);
  assert.equal(log.toasts.length, 0, '资料拒绝不弹提示、不干扰复制反馈');

  page.getUserProfile();
  failProfile(1, 'getUserProfile:fail internal error');
  assert.equal(page.data.profileNoticeKind, 'failed');
  assert.match(page.data.profileNotice, /读取失败/);
  assert.equal(page.data.hasUserInfo, false);
  assert.equal(page.data.feedbackDraft, '');
  assert.equal(page.data.feedbackCopyFailed, false);
  assert.equal(log.toasts.length, 0, '资料失败不弹提示、不干扰复制反馈');
});

test('U7 资料失败提示点名真实控件，且连续两次读取（失败后成功）不改反馈与存储', () => {
  const wxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  const noticeTag = wxml.match(/<text[^>]*id="profile-notice"[^>]*>/);
  assert.ok(noticeTag, '#profile-notice 应存在');
  assert.equal(
    /bindtap|catchtap/.test(noticeTag[0]),
    false,
    '提示文字本身不应再成为第二个点击路径'
  );

  // 只从页面实际绑定的资料控件取处理函数，避免测试绕过绑定直接调方法。
  const controlMatch = wxml.match(/<view[^>]*bindtap="(getUserProfile)"[^>]*>/);
  assert.ok(controlMatch, '页面应保留绑定的「设置头像昵称」控件');
  const handler = page => page[controlMatch[1]];
  assert.equal(typeof profileDefinition[controlMatch[1]], 'function');

  const page = createPage(profileDefinition);
  page.feedback();
  confirmModal(0, '失败后仍保留的反馈草稿');
  failClipboard(0);
  const draft = page.data.feedbackDraft;
  assert.equal(page.data.feedbackCopyFailed, true);
  assert.equal(log.toasts.length, 1);

  // 第一次：失败。提示必须点名可用的「设置头像昵称」控件。
  handler(page).call(page);
  assert.equal(log.profileCalls.length, 1);
  failProfile(0, 'getUserProfile:fail internal error');
  assert.equal(page.data.profileNoticeKind, 'failed');
  assert.match(page.data.profileNotice, /「设置头像昵称」/, '失败提示应点名真实控件');
  assert.equal(page.data.profileNotice.includes('可点此重试'), false, '不应暗示提示文字可点');

  // 第二次：同一个绑定控件再试一次并成功。
  handler(page).call(page);
  assert.equal(log.profileCalls.length, 2);
  succeedProfile(1, { nickName: '阿岩', avatarUrl: 'https://example.invalid/a.png' });
  assert.equal(page.data.hasUserInfo, true);
  assert.equal(page.data.profileNotice, '');
  assert.equal(page.data.profileNoticeKind, '');

  assert.equal(page.data.feedbackCopyFailed, true, '资料读取不得改复制失败态');
  assert.equal(page.data.feedbackDraft, draft, '资料读取不得改反馈草稿');
  assert.equal(log.clipboardCalls.length, 1, '资料读取不得触碰剪贴板');
  assert.equal(log.toasts.length, 1, '资料读取不弹提示、不冒充复制结果');
  assert.equal(log.storageWrites.length, 0, '资料只保留在本机内存');
});

test('U7 复制结果不覆盖资料读取提示', () => {
  const page = createPage(profileDefinition);
  page.getUserProfile();
  failProfile(0, 'getUserProfile:fail internal error');
  const notice = page.data.profileNotice;
  const kind = page.data.profileNoticeKind;

  page.feedback();
  confirmModal(0, '资料失败后仍可复制');
  succeedClipboard(0);

  assert.equal(log.toasts.at(-1).title, '已复制');
  assert.equal(page.data.profileNotice, notice, '复制成功不得清掉资料结果提示');
  assert.equal(page.data.profileNoticeKind, kind);
  assert.equal(page.data.hasUserInfo, false, '复制成功不得冒充资料读取成功');
});

test('U7 微信资料接口不可用时只在本页说明失败，不抛异常', () => {
  const page = createPage(profileDefinition);
  const original = global.wx.getUserProfile;
  global.wx.getUserProfile = undefined;
  try {
    assert.doesNotThrow(() => page.getUserProfile());
  } finally {
    global.wx.getUserProfile = original;
  }
  assert.equal(page.data.profileNoticeKind, 'failed');
  assert.match(page.data.profileNotice, /读取失败/);
  assert.equal(page.data.hasUserInfo, false);
  assert.equal(page.data.feedbackDraft, '');
  assert.equal(page.data.feedbackCopyFailed, false);
  assert.equal(log.toasts.length, 0);
});
