/**
 * 逐把视频 · 入口归属与相册单选（T023）
 *
 * 逐把明细页与跨日线路历史共用的这一份实现：
 * - 入口固定带齐**档案、原场次、长期线路、原把次**四个 ID；打开视频页后再按同一组
 *   ID 逐项核对一次。缺参、串档、同名异线（把次不属于这一条线）、已撤回、还没保存
 *   的待保存操作与只存在于旧汇总里的把次都不受理，也不改动任何记录；
 * - 相册选择只用一个选项对象调用 wx.chooseMedia，限定相册、视频、单选；
 * - 选中的临时路径只进入当前页面的待确认预览，本单**不创建持久文件或索引**（确认
 *   保存与持久副本在 T026 实现）。
 *
 * 列表上的关联状态只读视频索引：索引键与条目形状由 T026 写入，本单只读；没有索引
 * 时一律显示「未添加视频」。因此本单的任何操作都不会写 storage。
 */
const store = require('./training-store.js');
const recordActions = require('./training-record-actions.js');

// T026 写入的独立视频索引；本单只读，绝不创建。与照片、卡点、清单同用正式本机命名空间。
const VIDEO_INDEX_KEY = store.NAMESPACE + 'attempt-video';

// 相册单选：一个选项对象同时说明数量、媒体类型与来源。
const CHOOSE_MEDIA_OPTIONS = {
  count: 1,
  mediaType: ['video'],
  sourceType: ['album']
};

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 入口参数：archiveId / sessionId / routeId / attemptId（兼容大小写写法）。
 */
function parseVideoQuery(query) {
  const data = query || {};
  return {
    archiveId: data.archiveId || data.archiveid || '',
    sessionId: data.sessionId || data.sessionid || '',
    routeId: data.routeId || data.routeid || '',
    attemptId: data.attemptId || data.attemptid || ''
  };
}

/**
 * 视频页查询串：档案、场次、线路与原把次四个 ID 一起带过去。
 */
function videoQueryString(ids) {
  const context = ids || {};
  return recordActions.recordQueryString(context) +
    '&attemptId=' +
    encodeURIComponent(context.attemptId || '');
}

/**
 * 这一次预览 / 选择属于哪一组归属：四个 ID 拼成的稳定标识。
 * 换档、换场次、换线路或换把次都会得到不同的标识，迟到的选择回调据此丢弃。
 */
function contextToken(ids) {
  const context = ids || {};
  return [
    context.archiveId || '',
    context.sessionId || '',
    context.routeId || '',
    context.attemptId || ''
  ].join('|');
}

/**
 * 按入口的四个 ID 核对归属（只读，不写盘）。
 *
 * 档案、场次与线路的核对直接复用单线记录页那一份 loadRecordContext（同一份错误与
 * 判定，不另立一套）；这里再核对原把次：
 * - 找不到这个 attemptId：待保存操作（opId）单独提示「还没保存」，其余按不在本机
 *   档案里处理（旧云汇总没有本机把次，同样落到这里）；
 * - 把次的场次/线路与入口不一致：同名异线、串场次，拒绝；
 * - 已撤回的把次：恢复之后才能添加或回看视频，本单不受理。
 *
 * 返回 { ok, code, error, archive, session, route, attempt }。
 */
function loadVideoContext(query) {
  const ids = parseVideoQuery(query);
  const base = recordActions.loadRecordContext(ids);
  if (!base.ok) {
    return {
      ok: false,
      code: base.code,
      error: base.error,
      archive: base.archive || null,
      session: base.session || null,
      route: base.route || null,
      attempt: null
    };
  }

  const archive = base.archive;
  const rejected = {
    ok: false,
    error: '',
    archive,
    session: base.session,
    route: base.route,
    attempt: null
  };

  if (!ids.attemptId) {
    return Object.assign({}, rejected, {
      code: 'missing-attempt',
      error: '缺少把次参数，无法确定要给哪一把添加视频；未改动任何记录。'
    });
  }

  const attempt = (archive.attempts || []).find(item => item.id === ids.attemptId) || null;
  if (!attempt) {
    const pending = (archive.pendingSaves || []).some(op => op.opId === ids.attemptId);
    return pending
      ? Object.assign({}, rejected, {
          code: 'pending-attempt',
          error: '这一把还没有保存成功，确认保存后才能添加视频；未改动任何记录。'
        })
      : Object.assign({}, rejected, {
          code: 'missing-attempt',
          error: '这一把不在本机训练档案里（旧汇总或已不在本机），无法添加视频；未改动任何记录。'
        });
  }

  // 四个 ID 必须同时对上：只对上场次或线路都不算归属正确，同名异线不能顶替。
  if (attempt.sessionId !== base.session.id || attempt.routeId !== base.route.id) {
    return Object.assign({}, rejected, {
      code: 'attempt-mismatch',
      error: '这一把不属于这一场这一条线，无法添加视频；未改动任何记录。'
    });
  }

  if (!store.isEffectiveAttempt(attempt)) {
    return Object.assign({}, rejected, {
      code: 'undone-attempt',
      error: '这一把已经撤回，恢复之后才能添加或回看视频；未改动任何记录。'
    });
  }

  return {
    ok: true,
    code: 'ready',
    error: '',
    archive,
    session: base.session,
    route: base.route,
    attempt
  };
}

/**
 * 读取视频索引（只读，永不创建）。T026 之前键不存在，返回空列表。
 * 形状不对或读取失败时给出可见状态，不影响列表上的其他内容。
 */
function readVideoIndex() {
  let raw;
  try {
    raw = typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function'
      ? wx.getStorageSync(VIDEO_INDEX_KEY)
      : '';
  } catch (error) {
    return { ok: false, code: 'unreadable', error: '本机视频索引读取失败', clips: [] };
  }
  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, code: 'empty', error: '', clips: [] };
  }

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, code: 'broken', error: '本机视频索引无法解析', clips: [] };
    }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.clips)) {
    return { ok: false, code: 'broken', error: '本机视频索引结构不受支持', clips: [] };
  }
  return { ok: true, code: 'ready', error: '', clips: parsed.clips };
}

function clipFor(read, archiveId, attemptId) {
  if (!read || !read.ok || !hasText(archiveId) || !hasText(attemptId)) return null;
  const matches = read.clips.filter(
    clip =>
      clip &&
      clip.archiveId === archiveId &&
      clip.attemptId === attemptId &&
      hasText(clip.fileId)
  );
  if (!matches.length) return null;
  // 同一把只应有一条当前片段。若替换期间索引里短暂残留多条，取版本号最大的一条；
  // 都没有版本号时取最后写入的一条，避免继续播放被替换掉的旧副本。
  let chosen = matches[matches.length - 1];
  let chosenRev = safeNumber(chosen.rev);
  for (const clip of matches) {
    const rev = safeNumber(clip.rev);
    if (rev !== null && (chosenRev === null || rev > chosenRev)) {
      chosen = clip;
      chosenRev = rev;
    }
  }
  return chosen;
}

function linkView(read, archiveId, attemptId) {
  const clip = clipFor(read, archiveId, attemptId);
  if (clip) {
    return { state: 'saved', hasVideo: true, stateText: '已添加视频', entryText: '看视频 ›' };
  }
  if (read && !read.ok) {
    return {
      state: 'unreadable',
      hasVideo: false,
      stateText: '视频关联不可读',
      entryText: '添加视频 ›'
    };
  }
  return { state: 'none', hasVideo: false, stateText: '未添加视频', entryText: '添加视频 ›' };
}

/** 单行关联状态：读一次索引即用（视频页与小列表用）。 */
function videoLinkView(archiveId, attemptId) {
  return linkView(readVideoIndex(), archiveId, attemptId);
}

/**
 * 视频页用的关联读取：一次读索引同时给出这一把当前有效的片段与展示状态。
 * T024 起页面据此拿片段去播放、更换和移除；T026 写入后立即生效。
 *
 * 返回 { ok, code, error, clip, state, stateText, entryText }：
 * - ok 为 false 时索引不可读，clip 为 null；
 * - clip 只在状态为 saved 时非空（与列表上的「看视频」判定同一份 clipFor）。
 */
function videoClipView(archiveId, attemptId) {
  const read = readVideoIndex();
  if (!read.ok) {
    const view = linkView(read, archiveId, attemptId);
    return {
      ok: false,
      code: read.code,
      error: read.error,
      clip: null,
      state: view.state,
      stateText: view.stateText,
      entryText: view.entryText
    };
  }
  const clip = clipFor(read, archiveId, attemptId);
  const view = linkView(read, archiveId, attemptId);
  return {
    ok: true,
    code: clip ? 'saved' : 'none',
    error: '',
    clip,
    state: view.state,
    stateText: view.stateText,
    entryText: view.entryText
  };
}

/**
 * 一次刷新内给多行算关联状态：索引只读一次，避免 45 行逐行读 storage。
 * 返回 Map<attemptId, linkView>。
 */
function videoLinkMap(archiveId, attempts) {
  const read = readVideoIndex();
  const map = new Map();
  (attempts || []).forEach(attempt => {
    if (attempt && attempt.id) map.set(attempt.id, linkView(read, archiveId, attempt.id));
  });
  return map;
}

/**
 * 相册单选的选项：每次调用都新建一个对象，页面可以安全地补充 success/fail。
 * count 1、只允许视频、只允许相册。
 */
function chooseMediaOptions() {
  return Object.assign({}, CHOOSE_MEDIA_OPTIONS, {
    mediaType: CHOOSE_MEDIA_OPTIONS.mediaType.slice(),
    sourceType: CHOOSE_MEDIA_OPTIONS.sourceType.slice()
  });
}

/** 用户主动取消选片：不是错误，可以立刻再选一次。 */
function isCancelError(error) {
  const message = (error && error.errMsg) || '';
  return /cancel/i.test(message);
}

function formatBytes(bytes) {
  const value = safeNumber(bytes);
  if (value === null || value < 0) return '未知大小';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileNameOf(tempFilePath) {
  const text = hasText(tempFilePath) ? tempFilePath : '';
  const parts = text.split('/');
  const name = parts[parts.length - 1] || '';
  return name || '所选视频';
}

/**
 * 把选择器返回的文件收成待确认预览的展示字段。
 * 只读 tempFiles[0]；不复制文件、不写索引、不上传。
 */
function previewFromChoice(res) {
  const file = res && res.tempFiles && res.tempFiles[0];
  if (!file || !hasText(file.tempFilePath)) {
    return { ok: false, code: 'no-file', error: '没有取得视频文件，请重新选择。', preview: null };
  }

  const size = safeNumber(file.size);
  if (size !== null && size <= 0) {
    return { ok: false, code: 'empty-file', error: '取得的视频文件为空，请重新选择。', preview: null };
  }

  const duration = safeNumber(file.duration);
  const width = safeNumber(file.width);
  const height = safeNumber(file.height);
  return {
    ok: true,
    code: 'ready',
    error: '',
    preview: {
      tempFilePath: file.tempFilePath,
      fileName: fileNameOf(file.tempFilePath),
      sizeBytes: size,
      sizeText: formatBytes(size),
      durationSeconds: duration,
      durationText: duration !== null && duration > 0 ? duration.toFixed(1) : '',
      width: width !== null && width > 0 ? width : null,
      height: height !== null && height > 0 ? height : null,
      dimensionText: width && height && width > 0 && height > 0 ? width + '×' + height : ''
    }
  };
}

module.exports = {
  VIDEO_INDEX_KEY,
  parseVideoQuery,
  videoQueryString,
  contextToken,
  loadVideoContext,
  readVideoIndex,
  videoLinkView,
  videoClipView,
  videoLinkMap,
  chooseMediaOptions,
  isCancelError,
  formatBytes,
  previewFromChoice
};
