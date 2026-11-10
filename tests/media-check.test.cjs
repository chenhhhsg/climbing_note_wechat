/**
 * 本地视频验证页离线测试（V01–V03、V05）
 *
 * 直接加载独立实验工程的真实页面文件，只替换微信选择器和播放器，
 * 用 Node 内置测试工具验证选片参数、页面状态、时间换算与配置。
 *
 * 运行：node --test tests/media-check.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEV_PROJECT = path.join(ROOT, 'devtools', 'media-check');
const PAGE_DIR = path.join(DEV_PROJECT, 'pages', 'media-check');
const PAGE_JS = path.join(PAGE_DIR, 'media-check.js');
const PAGE_WXML = path.join(PAGE_DIR, 'media-check.wxml');
const PAGE_JSON = path.join(PAGE_DIR, 'media-check.json');

const VIDEO_A = {
  tempFilePath: 'wxfile://tmp-video-a.mp4',
  duration: 12,
  width: 1920,
  height: 1080,
  size: 1024 * 1024
};
const VIDEO_B = {
  tempFilePath: 'wxfile://tmp-video-b.mp4',
  duration: 15,
  width: 1080,
  height: 1920,
  size: 2 * 1024 * 1024
};
const SHORT_VIDEO = {
  tempFilePath: 'wxfile://tmp-video-short.mp4',
  duration: 3.4,
  width: 640,
  height: 360,
  size: 512 * 1024
};

// ---- wx 模拟：必须在加载页面文件之前就绪 ----
const wxLog = {
  chooseMediaOptions: [],
  chooseMediaHandler: null,
  videoContexts: [],
  storageCalls: 0
};

global.wx = {
  chooseMedia(options) {
    wxLog.chooseMediaOptions.push(options);
    assert.equal(typeof wxLog.chooseMediaHandler, 'function', '测试应预设选择器行为');
    wxLog.chooseMediaHandler(options);
  },
  createVideoContext(id, page) {
    const context = {
      id,
      page,
      playCalls: 0,
      pauseCalls: 0,
      seekCalls: [],
      play() { this.playCalls += 1; },
      pause() { this.pauseCalls += 1; },
      seek(position) { this.seekCalls.push(position); }
    };
    wxLog.videoContexts.push(context);
    return context;
  },
  getStorageSync() {
    wxLog.storageCalls += 1;
    return '';
  },
  setStorageSync() {
    wxLog.storageCalls += 1;
  }
};

function resetWxLog() {
  wxLog.chooseMediaOptions = [];
  wxLog.chooseMediaHandler = null;
  wxLog.videoContexts = [];
  wxLog.storageCalls = 0;
}

function chooseSuccess(file) {
  wxLog.chooseMediaHandler = options => {
    options.success({ tempFiles: [file], type: 'video' });
  };
}

function chooseCancel() {
  wxLog.chooseMediaHandler = options => {
    options.fail({ errMsg: 'chooseMedia:fail cancel' });
  };
}

function chooseFail(errMsg) {
  wxLog.chooseMediaHandler = options => {
    options.fail({ errMsg });
  };
}

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
  page.onLoad();
  return page;
}

// 播放器事件的身份来自实际触发事件的 video 节点：token 与 id 都随节点走。
function videoEvent(identity, detail) {
  return {
    currentTarget: {
      id: identity.domId,
      dataset: { videoToken: identity.token }
    },
    detail: detail || {}
  };
}

function currentIdentity(page) {
  return page.data.videoInstances[0];
}

function currentEvent(page, detail) {
  return videoEvent(currentIdentity(page), detail);
}

function loadedMetadata(page, duration, width, height, identity) {
  page.onVideoLoadedMetadata(
    videoEvent(identity || currentIdentity(page), { duration, width, height })
  );
}

function contextsById(domId) {
  return wxLog.videoContexts.filter(context => context.id === domId);
}

// ---- V01 ----
test('V01 选择器限定相册、视频和单选', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();

  await page.chooseVideo();

  assert.equal(wxLog.chooseMediaOptions.length, 1);
  const options = wxLog.chooseMediaOptions[0];
  assert.equal(options.count, 1, '只能选一段');
  assert.deepEqual(options.mediaType, ['video'], '只允许视频');
  assert.deepEqual(options.sourceType, ['album'], '只允许相册');

  assert.equal(page.data.videoPath, VIDEO_A.tempFilePath);
  assert.equal(page.data.hasVideo, true);
  assert.equal(page.data.ready, false, '选片后等待播放器元数据');
  assert.equal(page.data.chooseError, '');
  assert.equal(page.data.videoInstances.length, 1, '每次选片只保留一个原生节点');
  assert.equal(page.data.videoInstances[0].token, page.data.activeToken);
  assert.equal(page.data.seekDisabled, true, '元数据未就绪时按钮禁用');
  assert.equal(page.data.shortVideoMessage, '');
});

test('V01 首次取消仍可再次选择且不显示错误', async () => {
  resetWxLog();
  chooseCancel();
  const page = createPage();

  await page.chooseVideo();

  assert.equal(page.data.chooseError, '');
  assert.equal(page.data.hasVideo, false);
  assert.equal(page.data.videoPath, '');
  assert.deepEqual(page.data.videoInstances, []);

  chooseSuccess(VIDEO_A);
  await page.chooseVideo();

  assert.equal(page.data.videoPath, VIDEO_A.tempFilePath);
  assert.equal(page.data.chooseError, '');
});

test('V01 播放 A 后取消重选，播放器继续使用 A', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  const identity = currentIdentity(page);
  loadedMetadata(page, 12.5, 1920, 1080);
  page.onVideoPlay(currentEvent(page, {}));
  page.onVideoTimeUpdate(currentEvent(page, { currentTime: 3.25 }));

  assert.equal(page.data.ready, true);
  assert.equal(page.data.playing, true);
  assert.equal(page.data.currentTime, 3.25);

  chooseCancel();
  await page.chooseVideo();

  assert.equal(page.data.videoPath, VIDEO_A.tempFilePath, '取消重选不能丢掉 A');
  assert.equal(page.data.ready, true);
  assert.equal(page.data.duration, 12.5);
  assert.equal(page.data.currentTime, 3.25);
  assert.equal(page.data.currentTimeText, '3.25');
  assert.equal(page.data.chooseError, '');
  assert.deepEqual(currentIdentity(page), identity, '取消选片不能更换节点身份');
});

test('V01 选择失败显示可见错误并允许重试', async () => {
  resetWxLog();
  chooseFail('chooseMedia:fail system error');
  const page = createPage();

  await page.chooseVideo();

  assert.match(page.data.chooseError, /选择视频失败/);
  assert.match(page.data.chooseError, /system error/);
  assert.equal(page.data.hasVideo, false);

  chooseSuccess(VIDEO_A);
  await page.chooseVideo();

  assert.equal(page.data.chooseError, '');
  assert.equal(page.data.videoPath, VIDEO_A.tempFilePath);
});

// ---- V02 ----
test('V02 从 A 换到 B 后清空旧就绪状态、位置和错误提示', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  const identityA = currentIdentity(page);
  loadedMetadata(page, 12.5, 1920, 1080);
  page.onVideoPlay(currentEvent(page, {}));
  page.onVideoTimeUpdate(currentEvent(page, { currentTime: 6.5 }));
  page.seekToFifthSecond();
  const contextA = page.getVideoContext();
  assert.equal(contextA.id, identityA.domId);
  assert.deepEqual(contextA.seekCalls, [5]);

  chooseSuccess(VIDEO_B);
  await page.chooseVideo();
  const identityB = currentIdentity(page);

  assert.notEqual(identityB.token, identityA.token, '每次成功选片必须有新 token');
  assert.notEqual(identityB.domId, identityA.domId, '每次成功选片必须创建新的原生节点 id');
  assert.equal(page.data.activeToken, identityB.token);
  assert.equal(page.data.videoPath, VIDEO_B.tempFilePath);
  assert.equal(page.data.hasVideo, true);
  assert.equal(page.data.ready, false, 'B 的元数据到达前不能沿用 A 的就绪状态');
  assert.equal(page.data.duration, null);
  assert.equal(page.data.durationText, '');
  assert.equal(page.data.width, null);
  assert.equal(page.data.height, null);
  assert.equal(page.data.playing, false);
  assert.equal(page.data.currentTime, null);
  assert.equal(page.data.currentTimeText, '');
  assert.equal(page.data.seekTargetSeconds, null);
  assert.equal(page.data.seekDisabled, true);
  assert.equal(page.data.shortVideoMessage, '');
  assert.equal(page.data.seekStatus, '');
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.chooseError, '');

  const contextB = page.getVideoContext();
  assert.equal(contextB.id, identityB.domId, 'videoContext 跟随当前组件');
  assert.notEqual(contextB, contextA, '换片后不能继续使用旧组件的上下文');
  assert.equal(contextsById(identityA.domId).length, 1);
  assert.equal(contextsById(identityB.domId).length, 1);
});

test('V02 B 元数据就绪前禁用跳转，就绪后才允许', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  loadedMetadata(page, 12, 1920, 1080);

  chooseSuccess(VIDEO_B);
  await page.chooseVideo();
  assert.equal(page.data.ready, false);
  assert.equal(page.data.seekDisabled, true);

  const context = page.getVideoContext();
  page.seekToFifthSecond();
  assert.equal(context.seekCalls.length, 0, '元数据未就绪时不得发送跳转');
  assert.match(page.data.seekStatus, /元数据尚未就绪/);
  assert.equal(page.data.seekTargetSeconds, null);

  loadedMetadata(page, 15.2, 1080, 1920);
  assert.equal(page.data.ready, true);
  assert.equal(page.data.duration, 15.2);
  assert.equal(page.data.width, 1080);
  assert.equal(page.data.height, 1920);
  assert.equal(page.data.seekDisabled, false);
  assert.equal(page.data.currentTime, null, '元数据事件不声称已收到 0 秒位置');
  assert.equal(page.data.currentTimeText, '');

  page.seekToFifthSecond();
  assert.deepEqual(context.seekCalls, [5]);
  assert.equal(page.data.seekTargetSeconds, 5);
});

test('V02 A 的迟到元数据/位置/错误事件不会污染 B，B 有效元数据到达才可跳转', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  const identityA = currentIdentity(page);
  loadedMetadata(page, 12.5, 1920, 1080);
  page.onVideoPlay(currentEvent(page, {}));
  page.onVideoTimeUpdate(currentEvent(page, { currentTime: 3.25 }));
  page.seekToFifthSecond();
  const contextA = page.getVideoContext();
  assert.deepEqual(contextA.seekCalls, [5]);

  chooseSuccess(VIDEO_B);
  await page.chooseVideo();
  const identityB = currentIdentity(page);
  assert.notEqual(identityB.token, identityA.token);
  assert.notEqual(identityB.domId, identityA.domId);

  const contextB = page.getVideoContext();
  assert.equal(contextB.id, identityB.domId, '当前 videoContext 必须指向 B 的原生节点');

  // A 的原生节点已移除，它迟到的事件仍带 A 的 token，页面必须丢弃。
  page.onVideoLoadedMetadata(
    videoEvent(identityA, { duration: 12.5, width: 1920, height: 1080 })
  );
  page.onVideoTimeUpdate(videoEvent(identityA, { currentTime: 9.9 }));
  page.onVideoError(videoEvent(identityA, { errMsg: 'MEDIA_ERR_DECODE' }));
  page.onVideoPlay(videoEvent(identityA, {}));

  assert.equal(page.data.ready, false, 'A 的迟到元数据不能让 B 就绪');
  assert.equal(page.data.duration, null);
  assert.equal(page.data.durationText, '');
  assert.equal(page.data.width, null);
  assert.equal(page.data.height, null);
  assert.equal(page.data.currentTime, null, 'A 的迟到位置不能写进 B');
  assert.equal(page.data.currentTimeText, '');
  assert.equal(page.data.errorMessage, '', 'A 的迟到错误不能显示为 B 的错误');
  assert.equal(page.data.playing, false);
  assert.equal(page.data.seekDisabled, true);

  page.seekToFifthSecond();
  assert.equal(contextB.seekCalls.length, 0, 'B 元数据到达前不得发送 seek');
  assert.equal(contextA.seekCalls.length, 1, '旧上下文不应收到新的 seek');
  assert.match(page.data.seekStatus, /元数据尚未就绪/);

  // 只有携带 B token 的有效元数据到达，才允许跳转。
  loadedMetadata(page, 15.2, 1080, 1920);
  assert.equal(page.data.ready, true);
  assert.equal(page.data.duration, 15.2);
  assert.equal(page.data.seekDisabled, false);
  assert.equal(page.data.currentTime, null);

  // B 已就绪后，A 再迟到一次元数据也不能覆盖 B。
  loadedMetadata(page, 99, 1, 1, identityA);
  assert.equal(page.data.duration, 15.2);
  assert.equal(page.data.ready, true);

  page.seekToFifthSecond();
  assert.deepEqual(contextB.seekCalls, [5]);
  assert.equal(contextA.seekCalls.length, 1);

  // B 播放后，A 的迟到 pause 不能把 B 改成暂停。
  page.onVideoPlay(currentEvent(page, {}));
  assert.equal(page.data.playing, true);
  page.onVideoPause(videoEvent(identityA, {}));
  assert.equal(page.data.playing, true, 'A 的迟到暂停事件不能影响 B');

  // B 的 timeupdate 才更新实际位置。
  page.onVideoTimeUpdate(videoEvent(identityA, { currentTime: 11.1 }));
  assert.equal(page.data.currentTime, null);
  page.onVideoTimeUpdate(currentEvent(page, { currentTime: 5.04 }));
  assert.equal(page.data.currentTime, 5.04);
  assert.equal(page.data.seekTargetSeconds, 5, '目标值与实际回报分开记录');
});

test('V02 同一视频重新选择生成新身份，旧事件被忽略且新元数据可重新就绪', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  const firstIdentity = currentIdentity(page);
  loadedMetadata(page, 12.5, 1920, 1080);
  const contextFirst = page.getVideoContext();
  assert.equal(page.data.ready, true);

  chooseSuccess(VIDEO_A);
  await page.chooseVideo();
  const secondIdentity = currentIdentity(page);

  assert.notEqual(secondIdentity.token, firstIdentity.token, '同一路径重选也要有新 token');
  assert.notEqual(secondIdentity.domId, firstIdentity.domId, '同一路径重选也要有新原生节点');
  assert.equal(page.data.ready, false, '重选同一视频后重新等待元数据');
  assert.equal(page.data.duration, null);
  assert.equal(page.data.seekDisabled, true);

  page.onVideoLoadedMetadata(
    videoEvent(firstIdentity, { duration: 12.5, width: 1920, height: 1080 })
  );
  assert.equal(page.data.ready, false, '旧节点的元数据不能让重选后的视频就绪');

  loadedMetadata(page, 12.5, 1920, 1080);
  assert.equal(page.data.ready, true);
  assert.equal(page.data.duration, 12.5);
  assert.equal(page.data.seekDisabled, false);

  const contextSecond = page.getVideoContext();
  assert.equal(contextSecond.id, secondIdentity.domId);
  page.seekToFifthSecond();
  assert.deepEqual(contextSecond.seekCalls, [5]);
  assert.equal(contextFirst.seekCalls.length, 0, '旧上下文不应收到 seek');
});

test('V02 播放失败显示错误并可重选', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  loadedMetadata(page, 12, 1920, 1080);
  page.onVideoPlay(currentEvent(page, {}));
  page.seekToFifthSecond();
  assert.deepEqual(page.getVideoContext().seekCalls, [5]);

  page.onVideoError(currentEvent(page, { errMsg: 'MEDIA_ERR_DECODE' }));

  assert.equal(page.data.ready, false);
  assert.equal(page.data.playing, false);
  assert.equal(page.data.duration, null);
  assert.equal(page.data.currentTime, null);
  assert.equal(page.data.currentTimeText, '');
  assert.equal(page.data.seekDisabled, true);
  assert.match(page.data.errorMessage, /视频播放失败/);
  assert.match(page.data.errorMessage, /MEDIA_ERR_DECODE/);

  page.seekToFifthSecond();
  assert.deepEqual(page.getVideoContext().seekCalls, [5], '失败后不得再发跳转');

  chooseSuccess(VIDEO_B);
  await page.chooseVideo();

  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.videoPath, VIDEO_B.tempFilePath);
  assert.equal(page.data.seekDisabled, true);
});

test('V02 重新进入验证页不恢复上次临时路径', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const first = createPage();
  await first.chooseVideo();
  loadedMetadata(first, 12, 1920, 1080);
  assert.equal(first.data.hasVideo, true);

  const second = createPage();

  assert.equal(second.data.videoPath, '');
  assert.equal(second.data.hasVideo, false);
  assert.equal(second.data.ready, false);
  assert.deepEqual(second.data.videoInstances, []);
  assert.equal(second.data.activeToken, '');
  assert.equal(second.data.seekDisabled, true);
  assert.equal(second.data.shortVideoMessage, '');
  assert.equal(second.getVideoContext(), null, '无选片时不应创建播放器上下文');
  assert.equal(wxLog.storageCalls, 0, '页面不应读写本地缓存');
});

// ---- V03 ----
test('V03 长于 5 秒：一次点击只发一次 seek(5)，目标与回报分开断言', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();
  loadedMetadata(page, 12.04, 1920, 1080);

  assert.equal(page.data.targetPositionMs, 5000);
  assert.equal(page.data.targetPositionSeconds, 5);
  assert.equal(page.data.seekDisabled, false, '长片元数据到达后按钮可用');
  assert.equal(page.data.currentTime, null, '元数据事件不能凭空声称收到 0 秒位置');
  assert.equal(page.data.currentTimeText, '');

  const context = page.getVideoContext();
  page.seekToFifthSecond();

  assert.equal(context.seekCalls.length, 1, '一次点击只发送一次跳转');
  assert.equal(context.seekCalls[0], 5, '5000 毫秒在播放器边界换算为 5 秒');
  assert.equal(typeof context.seekCalls[0], 'number');
  assert.equal(page.data.seekTargetSeconds, 5, '按钮目标值单独记录');
  assert.equal(page.data.currentTime, null, '跳转请求本身不代表播放器已回报位置');
  assert.equal(page.data.currentTimeText, '');
  assert.match(page.data.seekStatus, /等待播放器回报/);

  page.onVideoTimeUpdate(currentEvent(page, { currentTime: 5.04 }));

  assert.equal(page.data.currentTime, 5.04, '实际位置来自播放器回报');
  assert.equal(page.data.currentTimeText, '5.04');
  assert.equal(context.seekCalls.length, 1, '时间回报不应触发新的跳转');
});

test('V03 不足 5 秒：元数据到达即禁用并显示原因，方法守卫仍为零发送', async () => {
  resetWxLog();
  chooseSuccess(SHORT_VIDEO);
  const page = createPage();
  await page.chooseVideo();
  loadedMetadata(page, 3.4, 640, 360);

  assert.equal(page.data.ready, true);
  assert.equal(page.data.duration, 3.4);
  assert.equal(page.data.durationText, '3.40');
  assert.equal(page.data.seekDisabled, true, '元数据到达即可禁用跳转按钮');
  assert.match(page.data.shortVideoMessage, /不足 5 秒/);
  assert.match(page.data.shortVideoMessage, /3\.40/);
  assert.equal(page.data.currentTime, null);

  const context = page.getVideoContext();
  page.seekToFifthSecond();

  assert.equal(context.seekCalls.length, 0, '不足 5 秒时发送次数为零');
  assert.equal(page.data.seekTargetSeconds, null);
  assert.equal(page.data.seekDisabled, true);
  assert.match(page.data.seekStatus, /不足 5 秒/);
  assert.match(page.data.seekStatus, /3\.40/);

  // 换成够长的视频后，短片原因必须清空，按钮重新可用。
  chooseSuccess(VIDEO_A);
  await page.chooseVideo();
  assert.equal(page.data.shortVideoMessage, '');
  assert.equal(page.data.seekDisabled, true);
  loadedMetadata(page, 12.04, 1920, 1080);
  assert.equal(page.data.shortVideoMessage, '');
  assert.equal(page.data.seekDisabled, false);
  page.seekToFifthSecond();
  assert.deepEqual(page.getVideoContext().seekCalls, [5]);
});

test('V03 元数据未就绪时不向播放器发送跳转', async () => {
  resetWxLog();
  chooseSuccess(VIDEO_A);
  const page = createPage();
  await page.chooseVideo();

  const context = page.getVideoContext();
  page.seekToFifthSecond();

  assert.equal(context.seekCalls.length, 0);
  assert.equal(page.data.seekDisabled, true);
  assert.match(page.data.seekStatus, /元数据尚未就绪/);
});

// ---- V05 ----
test('V05 独立工程入口、页面文件与事件绑定齐全', () => {
  const devProject = JSON.parse(
    fs.readFileSync(path.join(DEV_PROJECT, 'project.config.json'), 'utf8')
  );
  const devApp = JSON.parse(
    fs.readFileSync(path.join(DEV_PROJECT, 'app.json'), 'utf8')
  );
  const rootProject = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8')
  );

  assert.equal(devProject.compileType, 'miniprogram');
  assert.equal(devProject.miniprogramRoot, './');
  assert.equal(devProject.libVersion, '2.25.4');
  assert.equal(devProject.appid, rootProject.appid, '实验工程复用本项目可用 AppID');
  assert.deepEqual(devApp.pages, ['pages/media-check/media-check']);

  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(
      fs.existsSync(path.join(PAGE_DIR, `media-check.${ext}`)),
      `缺少页面文件 media-check.${ext}`
    );
  }

  const appJs = fs.readFileSync(path.join(DEV_PROJECT, 'app.js'), 'utf8');
  assert.doesNotMatch(appJs, /wx\.cloud/, '独立工程启动时不应初始化云服务');

  const wxml = fs.readFileSync(PAGE_WXML, 'utf8');
  assert.match(wxml, /wx:for="\{\{videoInstances\}\}"/);
  assert.match(wxml, /wx:key="token"/);
  assert.match(wxml, /id="\{\{item\.domId\}\}"/);
  assert.match(wxml, /data-video-token="\{\{item\.token\}\}"/);
  for (const binding of [
    'bindtap="chooseVideo"',
    'bindtap="togglePlay"',
    'bindtap="seekToFifthSecond"',
    'bindloadedmetadata="onVideoLoadedMetadata"',
    'bindplay="onVideoPlay"',
    'bindpause="onVideoPause"',
    'bindtimeupdate="onVideoTimeUpdate"',
    'binderror="onVideoError"'
  ]) {
    assert.ok(wxml.includes(binding), `WXML 应包含 ${binding}`);
  }
  assert.match(wxml, /disabled="\{\{seekDisabled\}\}"/);
  assert.match(wxml, /shortVideoMessage/);
  assert.match(wxml, /targetPositionMs/);
  assert.match(wxml, /targetPositionSeconds/);
  assert.match(wxml, /currentTimeText/);

  for (const method of [
    'chooseVideo',
    'useVideo',
    'isCurrentVideoEvent',
    'getVideoContext',
    'onVideoLoadedMetadata',
    'onVideoPlay',
    'onVideoPause',
    'onVideoTimeUpdate',
    'onVideoError',
    'togglePlay',
    'seekToFifthSecond'
  ]) {
    assert.equal(typeof pageDefinition[method], 'function', `${method} 应为页面方法`);
  }

  const pageConfig = JSON.parse(fs.readFileSync(PAGE_JSON, 'utf8'));
  assert.equal(pageConfig.navigationBarTitleText, '本地视频验证');
});

test('V05 根配置排除实验目录，正式路由与 tabBar 相对基线无差异', () => {
  const rootProject = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8')
  );
  const ignore = rootProject.packOptions.ignore;
  assert.ok(
    ignore.some(item => item.type === 'folder' && item.value === 'devtools/media-check'),
    '正式工程打包应排除 devtools/media-check'
  );
  assert.equal(rootProject.appid, 'wx9ea86e9d7aa04c2f', 'AppID 不得变更');
  assert.equal(rootProject.cloudbaseRoot, 'cloudbase/');
  assert.equal(rootProject.cloudfunctionRoot, 'cloudfunctions/');

  const rootApp = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  // T017 起新增正式场内记录页；T018/T020 各再增一页。
  // 不把正式 app.pages 自己当唯一 oracle：用获批页面白名单加源码四件套独立核对。
  const basePages = [
    'pages/index/index',
    'pages/add-record/add-record',
    'pages/record-list/record-list',
    'pages/record-detail/record-detail',
    'pages/stats/stats',
    'pages/profile/profile'
  ];
  const approvedExtraPages = [
    'pages/training-session/training-session',
    'pages/training-route/training-route',
    'pages/fitness-test/fitness-test'
  ];
  const approvedPages = new Set([...basePages, ...approvedExtraPages]);

  assert.equal(
    new Set(rootApp.pages).size,
    rootApp.pages.length,
    '正式页面不得重复注册'
  );
  for (const page of rootApp.pages) {
    assert.ok(approvedPages.has(page), `不得注册未批准的正式页面：${page}`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(
        fs.existsSync(path.join(ROOT, `${page}.${ext}`)),
        `页面源码四件套缺失：${page}.${ext}`
      );
    }
  }
  assert.deepEqual(
    rootApp.pages.filter(page => basePages.includes(page)),
    basePages,
    '原六页保留且相对顺序不变'
  );
  assert.deepEqual(
    rootApp.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ]
  );
  assert.doesNotMatch(JSON.stringify(rootApp), /media-check/);
});
