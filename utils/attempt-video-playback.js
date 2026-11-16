/**
 * 逐把视频 · 原生播放、更换与移除（T024）
 *
 * 与 T023 的分工：T023 只把相册选中的临时路径放进待确认预览；本模块接原生
 * `video` 的播放事件，并把「保存到本机 / 更换 / 移除」三个动作接到持久层接口上。
 *
 * 本模块只做判定与请求组装，**不读写文件、不写 storage、不上传**：
 * - 已保存片源的播放路径按索引里的相对文件标识 + 小程序用户目录拼出来；
 * - 每个正在显示的片源有自己的 token（归属标识 + 序号）。原生 video 事件带节点
 *   上的 token 回来，只有当前片的 token 才被采用，换片后的旧 loadedmetadata /
 *   play / pause / error 一律丢弃；
 * - 持久层接口由 T026 实现，通过 setVideoStore 注入。本模块只把请求交出去，
 *   「成功」不采信写入回执本身，而是以读回的本机视频索引为准；回执丢了但索引
 *   已经指向目标状态时也算成功（并标明回执不明确）；
 * - 回执迟到时由页面按操作序号、归属标识和预览序号丢弃，不覆盖另一片源、另一把
 *   或已经离开的页面。
 *
 * 持久层契约（T026 实现后注入；请求里已带齐档案、场次、线路、原把次与片段信息）：
 *   store.commit(request)  -> 值或 Promise，形如 { ok, error?, ... }
 *   store.replace(request) -> 同上
 *   store.remove(request)  -> 同上
 * 方法应在索引落盘（或已经可以读回目标状态）之后再 resolve/finish；页面拿到结果后
 * 会立刻读一次索引判定真实状态。返回值只用于判断「写入是否明确失败」，其中的
 * 成功标记不直接决定界面状态。replace/remove 的 request 带原片段的 clipId/rev，
 * 供持久层做版本核对与无引用副本回收。
 *
 * T026：持久层默认由 utils/attempt-video-files.js 提供。页面在模块加载时注册一个
 * 按档案创建服务的工厂（setVideoStoreFactory）；调用时才按 request.archiveId 取
 * 对应档案的服务，因此后台页面与换档迟到回调不会写到另一份档案。
 * setVideoStore 仍可显式覆盖工厂（测试与宿主注入用），显式实例优先。
 */
const attemptVideo = require('./attempt-video.js');

const KIND_SAVED = 'saved';
const KIND_PREVIEW = 'preview';

const METHOD_COMMIT = 'commit';
const METHOD_REPLACE = 'replace';
const METHOD_REMOVE = 'remove';

const OPERATION_METHODS = [METHOD_COMMIT, METHOD_REPLACE, METHOD_REMOVE];

const UNAVAILABLE_MESSAGE =
  '当前版本还不能保存或修改本机视频副本（本机保存服务未就绪）；已有视频仍可回看。';

// 显式实例由 setVideoStore 注入（测试与宿主）；生产默认走工厂，按 request.archiveId
// 取对应档案的持久层。工厂在页面模块加载时注册，不写 storage、不碰文件。
let videoStore = null;
let videoStoreFactory = null;

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

/** 与照片文件适配器同一份路径规范化：保留协议后的双斜线，去掉多余斜线。 */
function normalizePath(value) {
  if (!hasText(value)) return '';
  const text = value.replace(/\\/g, '/');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/.exec(text);
  const scheme = match ? match[1] : '';
  const rest = match ? match[2] : text;
  return scheme + rest.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function joinPath(base, relative) {
  const root = normalizePath(base);
  const rest = hasText(relative) ? relative.replace(/\\/g, '/') : '';
  if (!hasText(root) || !hasText(rest)) return '';
  return normalizePath(root + '/' + rest);
}

function fileNameOf(value) {
  const text = hasText(value) ? value.replace(/\\/g, '/') : '';
  const parts = text.split('/');
  const name = parts[parts.length - 1] || '';
  return name || '所选视频';
}

function userDataPathOf(options) {
  const config = options || {};
  if (hasText(config.userDataPath)) return normalizePath(config.userDataPath);
  if (
    typeof wx !== 'undefined' &&
    wx &&
    wx.env &&
    hasText(wx.env.USER_DATA_PATH)
  ) {
    return normalizePath(wx.env.USER_DATA_PATH);
  }
  return '';
}

/**
 * 索引里的文件标识必须是目录内的相对路径：不接受协议前缀、盘符式绝对路径、
 * 根路径和 `..`，避免把播放器指到视频目录之外。
 */
function isSafeFileId(fileId) {
  if (!hasText(fileId)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fileId)) return false;
  const text = fileId.replace(/\\/g, '/');
  if (text.charAt(0) === '/') return false;
  return text.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function savedSourceFromClip(clip, options) {
  const source = clip || {};
  if (!hasText(source.clipId) || !hasText(source.fileId)) {
    return {
      ok: false,
      code: 'incomplete-clip',
      error: '视频关联信息不完整，无法定位本机文件；请重新选择原片。',
      source: null
    };
  }
  if (!isSafeFileId(source.fileId)) {
    return {
      ok: false,
      code: 'unsafe-file',
      error: '视频关联里的文件位置不受支持，无法播放；请重新选择原片。',
      source: null
    };
  }
  const base = userDataPathOf(options);
  if (!base) {
    return {
      ok: false,
      code: 'no-user-data-path',
      error: '当前环境拿不到小程序用户目录，无法定位本机视频；请重新选择原片。',
      source: null
    };
  }
  const bytes = safeNumber(source.bytes);
  return {
    ok: true,
    code: 'ready',
    error: '',
    source: {
      kind: KIND_SAVED,
      clipId: source.clipId,
      rev: safeNumber(source.rev),
      fileId: source.fileId,
      src: joinPath(base, source.fileId),
      bytes,
      sizeText: attemptVideo.formatBytes(bytes),
      durationText: '',
      dimensionText: '',
      fileName: fileNameOf(source.fileId)
    }
  };
}

function previewSourceFromPreview(preview) {
  const item = preview || {};
  if (!hasText(item.tempFilePath)) {
    return {
      ok: false,
      code: 'no-file',
      error: '没有可播放的临时文件，请重新选择。',
      source: null
    };
  }
  return {
    ok: true,
    code: 'ready',
    error: '',
    source: {
      kind: KIND_PREVIEW,
      clipId: '',
      rev: null,
      fileId: '',
      src: item.tempFilePath,
      bytes: safeNumber(item.sizeBytes),
      sizeText: item.sizeText || attemptVideo.formatBytes(item.sizeBytes),
      durationText: item.durationText || '',
      dimensionText: item.dimensionText || '',
      fileName: item.fileName || fileNameOf(item.tempFilePath)
    }
  };
}

function sourceLabel(kind) {
  return kind === KIND_SAVED ? '已保存的本机副本' : '待确认的临时文件';
}

/** 片源 token：归属标识 + 序号，换把、换片或刷新都会得到新的 token。 */
function sourceToken(contextToken, seq) {
  return (hasText(contextToken) ? contextToken : 'no-context') + '#' + String(seq);
}

function videoDomId(seq) {
  return 'attempt-video-player-' + String(seq);
}

/**
 * 事件属于哪个片源：只看触发事件的节点带的 token，不用页面当前状态反推，
 * 否则换片后旧节点的迟到事件会被当成新视频。
 */
function isCurrentVideoEvent(event, activeToken) {
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const token = (dataset && dataset.videoToken) || '';
  return token !== '' && token === activeToken;
}

/** 播放器元数据回报：只用于展示，不代表播放位置。 */
function metadataPatch(detail) {
  const data = detail || {};
  const duration = safeNumber(data.duration);
  const width = safeNumber(data.width);
  const height = safeNumber(data.height);
  return {
    playerReady: duration !== null,
    playerDurationText: duration !== null && duration > 0 ? duration.toFixed(2) : '',
    playerDimensionText: width !== null && height !== null && width > 0 && height > 0
      ? width + '×' + height
      : ''
  };
}

function toggleCommand(playing) {
  return playing ? 'pause' : 'play';
}

/**
 * 播放器错误：已保存副本先提示文件可能被清理或损坏，并给出重选出口；
 * 临时预览只提示重选，不影响原把次与已有视频。
 */
function playbackErrorMessage(errMsg, kind) {
  const message = hasText(errMsg) ? errMsg : '未知错误';
  if (kind === KIND_SAVED) {
    return (
      '这段本机视频打不开（' + message + '），可能已被清理或文件损坏；' +
      '请从相册重新选择原片。原把次、备注与相册里的原片都还在。'
    );
  }
  return (
    '这段临时视频打不开（' + message + '）；请重新选择。原把次与已有视频不受影响。'
  );
}

function unavailableMessage() {
  return UNAVAILABLE_MESSAGE;
}

function setVideoStore(store) {
  videoStore = store && typeof store === 'object' ? store : null;
}

function getVideoStore() {
  return videoStore;
}

/**
 * 按档案创建持久层的工厂。工厂只应在调用那一刻创建/取得该档案的服务；
 * 传入非法值等同「没有工厂」。
 */
function setVideoStoreFactory(factory) {
  videoStoreFactory = typeof factory === 'function' ? factory : null;
}

function getVideoStoreFactory() {
  return videoStoreFactory;
}

/** 显式实例优先；没有显式实例时按请求的档案取工厂服务。 */
function resolveVideoStore(request) {
  if (videoStore) return videoStore;
  if (!videoStoreFactory) return null;
  try {
    const resolved = videoStoreFactory(request && request.archiveId);
    return resolved && typeof resolved === 'object' ? resolved : null;
  } catch (error) {
    return null;
  }
}

function videoStoreAvailable() {
  return Boolean(videoStore || videoStoreFactory);
}

/**
 * 调持久层并收敛结果：同步异常、Promise 拒绝、非对象返回值都变成
 * { ok:false, error }，页面永远拿到一个可展示的对象，不会因为接口形态抛错。
 */
function callVideoStore(method, request) {
  if (OPERATION_METHODS.indexOf(method) === -1) {
    return Promise.resolve({ ok: false, code: 'bad-method', error: '不支持的视频操作：' + method });
  }
  const store = resolveVideoStore(request);
  if (!store || typeof store[method] !== 'function') {
    return Promise.resolve({ ok: false, code: 'unavailable', error: UNAVAILABLE_MESSAGE });
  }
  let result;
  try {
    result = store[method](request);
  } catch (error) {
    return Promise.resolve({ ok: false, code: 'threw', error: errorText(error) });
  }
  return Promise.resolve(result).then(
    receipt => {
      if (!receipt || typeof receipt !== 'object') {
        return {
          ok: false,
          code: 'bad-receipt',
          error: '本机保存服务没有返回可核对的结果，按未确认处理。'
        };
      }
      return receipt;
    },
    error => ({ ok: false, code: 'rejected', error: errorText(error) })
  );
}

function attemptBaseOf(context) {
  const item = context || {};
  return {
    archiveId: item.archiveId || '',
    sessionId: item.sessionId || '',
    routeId: item.routeId || '',
    attemptId: item.attemptId || '',
    attemptSeq: safeNumber(item.attemptSeq)
  };
}

function previewInfoOf(preview) {
  const item = preview || {};
  return {
    tempFilePath: item.tempFilePath || '',
    fileName: item.fileName || '',
    sizeBytes: safeNumber(item.sizeBytes),
    durationSeconds: safeNumber(item.durationSeconds),
    width: safeNumber(item.width),
    height: safeNumber(item.height)
  };
}

/**
 * 三个动作的请求体：
 * - commit：新片的临时文件信息；
 * - replace：原片片段标识/版本 + 新片临时文件信息；
 * - remove：只带当前片段标识/版本/文件标识与实际字节。
 */
function buildRequest(kind, context, beforeClip, preview) {
  const base = attemptBaseOf(context);
  const before = beforeClip || {};
  if (kind === METHOD_REMOVE) {
    return Object.assign({ action: kind }, base, {
      clipId: before.clipId || '',
      rev: safeNumber(before.rev),
      fileId: before.fileId || '',
      bytes: safeNumber(before.bytes)
    });
  }
  const request = Object.assign({ action: kind }, base, previewInfoOf(preview));
  if (kind === METHOD_REPLACE) {
    request.clipId = before.clipId || '';
    request.rev = safeNumber(before.rev);
    request.fileId = before.fileId || '';
    request.bytes = safeNumber(before.bytes);
  }
  return request;
}

function operationStatusText(kind) {
  if (kind === METHOD_COMMIT) return '正在写入本机副本并提交关联…';
  if (kind === METHOD_REPLACE) return '正在写入新副本并提交更换…';
  return '正在移除小程序内的副本…';
}

function sameClipIdentity(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftRev = safeNumber(left.rev);
  const rightRev = safeNumber(right.rev);
  return (left.clipId || '') === (right.clipId || '') && leftRev === rightRev;
}

/**
 * 更换是否已经落到索引上：片段标识变了，或同一片段的版本号变大。
 * 同标识同版本不算提交成功——这正是「回执成功但索引没变」要拦住的情况。
 */
function clipChanged(before, after) {
  if (!after) return false;
  if (!before) return true;
  if ((before.clipId || '') !== (after.clipId || '')) return true;
  const beforeRev = safeNumber(before.rev);
  const afterRev = safeNumber(after.rev);
  if (beforeRev === null || afterRev === null) return false;
  return afterRev > beforeRev;
}

/**
 * 按读回的视频索引判断这次操作的真实结果（不采信回执）：
 * - 索引读不回来：回执成功也只算「未确认」，回执失败算失败；
 * - 索引已到目标状态（保存/更换后有一段新片，移除后没有片段）：成功，
 *   即使写入回执丢了（receiptLost）；
 * - 回执成功而索引没变：未确认，页面保留原片与预览，可重新核对；
 * - 回执失败且索引没变：失败，原关联不动。
 *
 * 返回 { ok, code, error, clip, receiptLost }：
 * ok 为 true 时 clip 是读回的当前片段（移除后为 null）。
 */
function evaluateOperation(kind, beforeClip, receipt, read) {
  const receiptOk = Boolean(receipt && receipt.ok);
  const receiptError = (receipt && receipt.error) || '';
  const readOk = Boolean(read && read.ok);

  if (!readOk) {
    const readError = (read && read.error) || '本机视频索引不可读';
    return {
      ok: false,
      code: receiptOk ? 'unconfirmed' : 'failed',
      error: receiptOk
        ? '写入后无法读回本机视频索引（' + readError + '），结果未确认；请稍后重新进入本页核对，原把次与已有视频不受影响。'
        : '写入失败：' + (receiptError || '未知错误') + '；并且无法读回本机视频索引确认结果。',
      clip: null,
      receiptLost: false
    };
  }

  const after = read.clip || null;
  let confirmed = false;
  if (kind === METHOD_REMOVE) {
    confirmed = !after;
  } else if (kind === METHOD_COMMIT) {
    confirmed = Boolean(after);
  } else {
    confirmed = clipChanged(beforeClip, after);
  }

  if (confirmed) {
    return {
      ok: true,
      code: kind === METHOD_REMOVE ? 'removed' : 'committed',
      error: '',
      clip: after,
      receiptLost: !receiptOk
    };
  }
  if (!receiptOk) {
    return {
      ok: false,
      code: 'failed',
      error: '写入失败：' + (receiptError || '未知错误') + '；本页没有改动原关联，可以重试。',
      clip: after,
      receiptLost: false
    };
  }
  return {
    ok: false,
    code: 'unconfirmed',
    error:
      kind === METHOD_REMOVE
        ? '移除后本机索引里仍能看到这段视频，结果未确认；请稍后重新进入本页核对，原关联暂不改动。'
        : '写入后本机索引还没有指向新视频，结果未确认；请稍后重新进入本页核对，原关联暂不改动。',
    clip: after,
    receiptLost: false
  };
}

function operationSuccessText(kind, outcome) {
  const suffix = outcome && outcome.receiptLost
    ? '（写入回执不明确，已按本机索引读回确认）'
    : '';
  if (kind === METHOD_COMMIT) {
    return '已保存到本机：这一把现在可以从本机副本回看。' + suffix;
  }
  if (kind === METHOD_REPLACE) {
    return '已更换为新的本机副本；旧副本在确认没有引用后清理。' + suffix;
  }
  return '已移除小程序内的本机副本；原把次、备注与系统相册里的原片都还在。' + suffix;
}

module.exports = {
  KIND_SAVED,
  KIND_PREVIEW,
  METHOD_COMMIT,
  METHOD_REPLACE,
  METHOD_REMOVE,
  isSafeFileId,
  joinPath,
  savedSourceFromClip,
  previewSourceFromPreview,
  sourceLabel,
  sourceToken,
  videoDomId,
  isCurrentVideoEvent,
  metadataPatch,
  toggleCommand,
  playbackErrorMessage,
  unavailableMessage,
  setVideoStore,
  getVideoStore,
  setVideoStoreFactory,
  getVideoStoreFactory,
  resolveVideoStore,
  videoStoreAvailable,
  callVideoStore,
  buildRequest,
  operationStatusText,
  sameClipIdentity,
  clipChanged,
  evaluateOperation,
  operationSuccessText,
  errorText
};
