/**
 * 逐把视频 · 手工时间点（T025）
 *
 * 时间点嵌在**当前片段索引条目**的可选 `markers` 数组里：归属由片段条目自己的
 * 档案、原场次、原线路、原把次与片段 ID/版本给出，不另建索引键、不新增媒体文件。
 * 本模块只做纯判定与展示转换，不读写 storage、文件或播放器：
 * - 旧索引没有 `markers` 字段时按空列表读；单条损坏的标记被丢弃，不影响视频本身；
 * - 持久值是整数毫秒；跳转请求换算成秒，并在时长内收口（0 秒可记，片尾不越界）；
 * - 页面记点前先由调用方核对**当前正在显示的已保存播放器**：片源 token、片段
 *   ID/版本/文件标识、原生时长与原生 currentTime 全部可用且一致；
 * - 跳转只发请求，实际落点以播放器后续回报的 currentTime 为准；在回报落到目标
 *   附近之前不接受旧画面位置作为新的记点依据。
 *
 * 真实解码、真机 currentTime 精度与 seek 落点交给整项 QA 与手机复验（待验）。
 */

// 标记 ID 只由本模块生成；重试沿用同一个 ID，因此同一次动作不会新增第二个点。
const MARKER_ID_PATTERN = /^mark-[A-Za-z0-9_-]+$/;
// 跳转确认容差：与整项验收的画面误差上限一致（0.5 秒）。
const SEEK_CONFIRM_TOLERANCE_MS = 500;
// 播放器回报片尾时允许的收口余量：超出仍按「非法位置」拒绝，不静默截断错误读数。
const DURATION_EDGE_TOLERANCE_SECONDS = 0.5;
// 跳转之后等待原生位置回报的时长；超时后重试一次，仍无回报则解除等待（不伪造落点）。
const SEEK_REPORT_WAIT_MS = 900;

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 微信原生回调里的位置/时长：只认真正的有限 number。
 * Number(null)/Number(false)/Number('')/Number([]) 都是 0，绝不能把「没有读数」
 * 伪造为「0 秒」；真实数值 0 仍然保留。
 */
function safeNativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 索引/请求里的持久数值：允许非空十进制数字文本（旧 JSON 兼容），
 * 但布尔、空白串、数组、对象一律视为缺值，避免被 Number 隐式转成 0。
 */
function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'object' ||
    typeof value === 'symbol'
  ) {
    return null;
  }
  let text = value;
  if (typeof text === 'string') {
    text = text.trim();
    if (text === '') return null;
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function isMarkerId(value) {
  return hasText(value) && MARKER_ID_PATTERN.test(value);
}

/** 持久值：非负整数毫秒；布尔、空串、负数、小数都不是合法时间点。 */
function normalizeAtMs(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return null;
  }
  const number = safeNumber(value);
  if (number === null || number < 0 || !Number.isInteger(number)) return null;
  return number;
}

function markerRevOf(value) {
  // 与索引层 revOf 一致：旧条目缺版本号按 0 处理。
  if (value === undefined || value === null || value === '') return 0;
  const number = safeNumber(value);
  return number === null || number < 0 ? null : Math.floor(number);
}

/**
 * 单条标记：必须带自己的片段 ID 与版本，并与所属片段条目一致。
 * `clip` 可以是片段条目或 { clipId, rev }；不一致的标记不会进入列表，
 * 也不会在索引回写时被保留（旧数据补字段不改变片段本身）。
 */
function normalizeMarker(raw, clip) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isMarkerId(raw.id)) return null;
  const atMs = normalizeAtMs(raw.atMs);
  if (atMs === null) return null;
  if (!clip || !hasText(clip.clipId)) return null;
  const rev = markerRevOf(clip.rev);
  if (rev === null) return null;
  if (raw.clipId !== clip.clipId) return null;
  if (markerRevOf(raw.rev) !== rev) return null;
  return {
    id: raw.id,
    atMs,
    clipId: clip.clipId,
    rev,
    createdAt: hasText(raw.createdAt) ? raw.createdAt : ''
  };
}

function sortMarkers(list) {
  return list.slice().sort((left, right) => {
    if (left.atMs !== right.atMs) return left.atMs - right.atMs;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** 读索引用：缺字段按空列表，坏条目丢弃，结果按时间升序。 */
function normalizeMarkers(raw, clip) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  raw.forEach(item => {
    const marker = normalizeMarker(item, clip);
    if (!marker || seen.has(marker.id)) return;
    seen.add(marker.id);
    list.push(marker);
  });
  return sortMarkers(list);
}

function pad(value, length) {
  let text = String(value);
  while (text.length < length) text = '0' + text;
  return text;
}

/** 展示用时间：0:05.123（分:秒.毫秒），与持久整数毫秒一一对应。 */
function formatSecondsText(atMs) {
  const value = normalizeAtMs(atMs);
  if (value === null) return '';
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return minutes + ':' + pad(seconds, 2) + '.' + pad(millis, 3);
}

/** 列表视图：只暴露展示需要的字段，排序与持久值一致。 */
function markerViews(markers) {
  return sortMarkers(Array.isArray(markers) ? markers : []).map(marker => ({
    id: marker.id,
    atMs: marker.atMs,
    timeText: formatSecondsText(marker.atMs),
    createdAt: marker.createdAt || ''
  }));
}

/**
 * 由原生播放器读数得到要持久的时间点：
 * - 只接受原生回调给出的有限 number（0 秒是合法值，null/false/空白/数组不是）；
 * - 片尾只收口到 `floor(duration*1000)`，不写入超过时长的毫秒；
 * - 超出片尾容差、负值、缺时长都拒绝并给出可辨原因。
 */
function markTimeOf(currentTimeSeconds, durationSeconds) {
  const current = safeNativeNumber(currentTimeSeconds);
  const duration = safeNativeNumber(durationSeconds);
  if (current === null || current < 0) {
    return {
      ok: false,
      code: 'no-current-time',
      error: '播放器还没有回报可用的当前时间，暂时不能记点；请先播放或拖动一下。'
    };
  }
  if (duration === null || duration <= 0) {
    return {
      ok: false,
      code: 'no-duration',
      error: '播放器还没有回报视频时长，暂时不能记点；请稍后再试。'
    };
  }
  if (current > duration + DURATION_EDGE_TOLERANCE_SECONDS) {
    return {
      ok: false,
      code: 'out-of-range',
      error: '播放器回报的位置超出视频时长，暂时不能记点；请拖动到视频范围内再记。'
    };
  }
  const durationMs = Math.floor(duration * 1000);
  const reportedMs = Math.round(current * 1000);
  const atMs = Math.max(0, Math.min(reportedMs, durationMs));
  return { ok: true, code: 'ready', error: '', atMs };
}

/**
 * 写索引时允许的时长上限：同时参考「本次原生回报」与「当前片段已知时长」。
 * - 任一处有效就能记（旧索引没有时长、但原生给了有效读数 → 接受）；
 * - 两处都没有有效时长 → 拒绝，避免没有上限地写任意位置；
 * - 两处相差在片尾容差内按较大者（元数据与实际解码的轻差，不误拒片尾）；
 *   相差更大则按较小者，过期/伪造的更长时长不能写出超过已知片段时长的点。
 */
function markerDurationLimit(nativeDurationSeconds, clipDurationSeconds) {
  const native = safeNativeNumber(nativeDurationSeconds);
  const clip = safeNumber(clipDurationSeconds);
  const values = [];
  if (native !== null && native > 0) values.push(native);
  if (clip !== null && clip > 0) values.push(clip);
  if (values.length === 0) {
    return {
      ok: false,
      code: 'no-duration',
      error: '播放器与当前片段都没有可用的视频时长，暂时不能记时间点；请重新播放后再试。'
    };
  }
  let duration = values[0];
  if (values.length === 2) {
    duration =
      Math.abs(values[0] - values[1]) <= DURATION_EDGE_TOLERANCE_SECONDS
        ? Math.max(values[0], values[1])
        : Math.min(values[0], values[1]);
  }
  return {
    ok: true,
    code: 'ready',
    error: '',
    durationSeconds: duration,
    limitMs: Math.floor(duration * 1000)
  };
}

/**
 * 跳转请求：持久毫秒换算为秒，并收口到 [0, duration]。
 * 只负责请求参数；请求值不得回填为「实际落点」。
 */
function seekSecondsOf(atMs, durationSeconds) {
  const value = normalizeAtMs(atMs);
  if (value === null) {
    return { ok: false, code: 'invalid-time', error: '这个时间点不是有效的整数毫秒，无法跳转。' };
  }
  const duration = safeNativeNumber(durationSeconds);
  if (duration === null || duration <= 0) {
    return {
      ok: false,
      code: 'no-duration',
      error: '播放器还没有回报视频时长，暂时不能跳到时间点。'
    };
  }
  const seconds = Math.max(0, Math.min(value / 1000, duration));
  return { ok: true, code: 'ready', error: '', seconds: Math.round(seconds * 1000) / 1000 };
}

/** 播放器回报的位置是否已经落到跳转目标附近（默认 ±0.5 秒）。 */
function isSeekConfirmed(targetMs, reportedTimeSeconds, toleranceMs) {
  const target = normalizeAtMs(targetMs);
  const reported = safeNativeNumber(reportedTimeSeconds);
  if (target === null || reported === null || reported < 0) return false;
  const tolerance =
    safeNumber(toleranceMs) !== null && toleranceMs >= 0
      ? safeNumber(toleranceMs)
      : SEEK_CONFIRM_TOLERANCE_MS;
  return Math.abs(Math.round(reported * 1000) - target) <= tolerance;
}

/**
 * 页面记点前的严格就绪判定。只返回判定与可展示提示，不触发任何写入。
 *
 * state:
 *   busy / markerBusy / choosing   页面其他操作进行中
 *   indexError                     本机视频索引不可读
 *   hasSavedVideo / savedClip      已保存片段与索引读回
 *   playerKind / playerToken / expectedToken / sourceCurrent
 *   clipMatchesPlayer              播放器片段与索引当前片段是同一 ID/版本/文件
 *   durationSeconds / currentTimeSeconds
 *   seekPending                    上一次跳转尚未得到播放器位置回报
 */
function markReadiness(state) {
  const input = state || {};
  if (input.busy || input.choosing) {
    return { ok: false, code: 'busy', hint: '正在保存或更换视频，完成后再记时间点。' };
  }
  if (input.markerBusy) {
    return { ok: false, code: 'marker-busy', hint: '正在写入时间点，完成后再记。' };
  }
  if (input.indexError) {
    return {
      ok: false,
      code: 'index-unreadable',
      hint: '本机视频索引暂时读不出来，无法记录时间点；已有视频仍可播放。'
    };
  }
  if (!input.hasSavedVideo || !input.savedClip) {
    return { ok: false, code: 'no-saved-video', hint: '这一把还没有已保存的本机视频副本，不能记时间点。' };
  }
  if (input.playerKind !== 'saved') {
    return {
      ok: false,
      code: 'not-saved-player',
      hint: '当前播放的是待确认的新片预览，不能给原片记时间点；取消更换或用已保存视频记。'
    };
  }
  if (!input.sourceCurrent) {
    return { ok: false, code: 'stale-player', hint: '播放器片源已经变化，正在重新核对这一把的视频。' };
  }
  if (!input.clipMatchesPlayer) {
    return {
      ok: false,
      code: 'clip-mismatch',
      hint: '播放器显示的片段与当前关联不一致，暂不能记点；请重新进入本页核对。'
    };
  }
  if (input.seekPending) {
    return {
      ok: false,
      code: 'seek-pending',
      hint: '跳转还没有得到播放器回报的实际位置，先不要记点，避免记到旧画面。'
    };
  }
  const duration = safeNativeNumber(input.durationSeconds);
  if (duration === null || duration <= 0) {
    return { ok: false, code: 'no-duration', hint: '播放器还没有回报视频时长，暂时不能记点。' };
  }
  const current = safeNativeNumber(input.currentTimeSeconds);
  if (current === null || current < 0) {
    return {
      ok: false,
      code: 'no-current-time',
      hint: '播放器还没有回报当前时间，暂时不能记点；请先播放或拖动一下。'
    };
  }
  const time = markTimeOf(current, duration);
  if (!time.ok) return { ok: false, code: time.code, hint: time.error };
  return { ok: true, code: 'ready', hint: '', atMs: time.atMs };
}

/** 每次新记点生成一个操作身份；失败重试沿用同一个 ID。 */
function makeMarkerId() {
  return 'mark-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  MARKER_ID_PATTERN,
  SEEK_CONFIRM_TOLERANCE_MS,
  SEEK_REPORT_WAIT_MS,
  DURATION_EDGE_TOLERANCE_SECONDS,
  hasText,
  safeNativeNumber,
  safeNumber,
  isMarkerId,
  normalizeAtMs,
  normalizeMarker,
  normalizeMarkers,
  sortMarkers,
  formatSecondsText,
  markerViews,
  markTimeOf,
  markerDurationLimit,
  seekSecondsOf,
  isSeekConfirmed,
  markReadiness,
  makeMarkerId
};
