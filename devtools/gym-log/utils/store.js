/**
 * 岩馆快速记录 · 独立本地试用数据层
 *
 * 只读写专用缓存键，不读取正式工程的记录，也不访问云环境。
 * 岩馆与线路来自虚构样例；用户新建的线路、场次和尝试都保存在本机。
 * 所有 ID 一经创建就固定下来，用于区分同色同级的线路和跨天回看。
 * 抱石首次完攀的共用判定见 routeCompletion；顶绳和先锋可重复完攀。
 * 误点完攀时可原位把原把次从「完攀」改成「未完成」（见 pendingCorrections）：
 * 只改那一把的结果，把数、时间、序号与所属场次都不变，之后可以正常再记。
 * 更正的目标校验、入队、请求格式与回执结清都在本文件共用一份（今日页与详情页共用），
 * 页面只负责渲染与提示文案，不再各写一套。
 *
 * 重置世代（generation）标识「这一次的编号空间」：重置或切换数据集后编号会从头
 * 分配，世代让迟到的旧请求与复用同编号的新数据分开，见 newGeneration。
 */
const {
  TRIAL_DATASET_ID,
  TRIAL_OWNER_ID,
  isTrialDatasetId
} = require('./trial-profile.js');
const routeRules = require('./route-rules.js');

const STORE_KEY = 'climbingNote.gymLogTrial.v1';
const STATE_VERSION = 1;

/**
 * 重置世代（沿用数据集身份，补上被 datasetId 复用掩盖的那一层）。
 *
 * 无照片重置会保持同一个 datasetId（照片语义不变），但场次、线路、尝试与
 * 待确认编号都从头开始——旧的 `attempt-1` / `session-1` 会被新数据重新分配。
 * 只靠 datasetId 无法区分「重置前」与「重置后」的请求，所以每次重建编号空间
 * （首次创建或任一重置）都换一个一次性 token，随状态持久化。
 * 旧缓存没有该字段时统一按 LEGACY_GENERATION 读取：既不判损坏，也不改写旧缓存。
 */
const LEGACY_GENERATION = 'gen-legacy-0';
let generationSeq = 0;

function newGeneration() {
  generationSeq += 1;
  return (
    'gen-' + generationSeq + '-' + Math.random().toString(36).slice(2, 10)
  );
}

const GYMS = [
  { id: 'gym-chalkbox', name: '粉笔盒攀岩馆（虚构）' },
  { id: 'gym-northshore', name: '北岸抱石馆（虚构）' }
];

// 同一岩馆内刻意放两条同色同级的线路，名称与 ID 不同。
const FIXTURE_ROUTES = [
  {
    id: 'route-chalkbox-blue-dyn',
    gymId: 'gym-chalkbox',
    name: '蓝色动态线',
    colorName: '蓝色',
    colorHex: '#2f6fe4',
    grade: 'V3'
  },
  {
    id: 'route-chalkbox-blue-balance',
    gymId: 'gym-chalkbox',
    name: '蓝色平衡线',
    colorName: '蓝色',
    colorHex: '#2f6fe4',
    grade: 'V3'
  },
  {
    id: 'route-chalkbox-red-overhang',
    gymId: 'gym-chalkbox',
    name: '红色仰角线',
    colorName: '红色',
    colorHex: '#d94a3a',
    grade: 'V4'
  },
  {
    id: 'route-northshore-yellow-small',
    gymId: 'gym-northshore',
    name: '黄色小点线',
    colorName: '黄色',
    colorHex: '#d9a21b',
    grade: 'V2'
  },
  {
    id: 'route-northshore-green-slab',
    gymId: 'gym-northshore',
    name: '绿色平衡线',
    colorName: '绿色',
    colorHex: '#3c8c5a',
    grade: 'V2'
  }
];

/**
 * 旧记录只有汇总、没有逐次尝试，只作只读样例展示。
 * 不进入 state.routes / state.attempts，不参与逐次统计，也不会被改写成多条尝试。
 */
const LEGACY_SUMMARY_SAMPLE = {
  id: 'route-legacy-summary-v3',
  gymId: 'gym-chalkbox',
  name: '旧汇总样例线',
  colorName: '蓝色',
  colorHex: '#2f6fe4',
  grade: 'V3',
  legacy: {
    label: '旧汇总 · 虚构只读样例',
    summaryText: 'V3 / 尝试 5 次 / 完成',
    hint: '按原始汇总原样显示：不生成 5 条逐次尝试，也不计入逐次统计'
  }
};

const ROUTE_COLORS = [
  { name: '蓝色', hex: '#2f6fe4' },
  { name: '红色', hex: '#d94a3a' },
  { name: '黄色', hex: '#d9a21b' },
  { name: '绿色', hex: '#3c8c5a' },
  { name: '黑色', hex: '#2a2a28' },
  { name: '白色', hex: '#d8d3c6' }
];

// 等级选项按攀岩类型区分，取值与顺序见 utils/route-rules.js（参照正式等级表）。
// 旧缓存里的线路可能没有 climbType，读取时按抱石兼容展示，不回写、不迁移。

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatLocalDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function formatLocalTime(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function todayLocalDate(now) {
  return formatLocalDate(now || new Date());
}

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function createInitialState() {
  return {
    version: STATE_VERSION,
    // 试用数据集属于本机试用数据本身；照片归属按 owner + dataset + route 隔离。
    datasetId: TRIAL_DATASET_ID,
    // 重置世代：每次重建编号空间都换新值，用来区分重置/切换前后的同编号请求。
    generation: newGeneration(),
    nextSessionSeq: 1,
    nextRouteSeq: 1,
    nextAttemptSeq: 1,
    sessions: [],
    routes: clone(FIXTURE_ROUTES),
    attempts: [],
    // 已经点了结果、但保存端尚未确认的操作；opId 与最终尝试 ID 相同。
    pendingSaves: [],
    // 已经点了「改为未完成」、但更正尚未确认的操作；attemptId 就是要改正的原把次 ID。
    pendingCorrections: [],
    activeSessionId: '',
    activeRouteId: ''
  };
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSeq(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeEntrySeq(items, readSeq) {
  const read = readSeq || (item => item.seq);
  return items.reduce((max, item) => {
    const seq = read(item);
    return isSeq(seq) ? Math.max(max, seq) : max;
  }, 0);
}

function normalizeCounter(value, items, readSeq) {
  const max = normalizeEntrySeq(items, readSeq);
  return isSeq(value) && value > max ? value : max + 1;
}

/**
 * 样例线路没有 seq；新建设线路带 seq，旧缓存里的 route-local-N 从 ID 兜底。
 * 两种情况都要能恢复成有效的下一个序号，避免 NaN 破坏稳定 ID。
 */
function routeSeq(route) {
  if (isSeq(route.seq)) return route.seq;
  const match = /^route-local-(\d+)$/.exec(
    typeof route.id === 'string' ? route.id : ''
  );
  return match ? Number(match[1]) : 0;
}

/**
 * 只接受当前版本、结构完整的缓存；损坏时返回 null，由页面提示并允许重置。
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== STATE_VERSION) return null;
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.routes) || !Array.isArray(raw.attempts)) {
    return null;
  }

  // 旧版本缓存没有待确认操作，按空数组兼容读取。
  const pendingRaw = raw.pendingSaves === undefined ? [] : raw.pendingSaves;
  if (!Array.isArray(pendingRaw)) return null;

  // 旧版本缓存没有「更正中的操作」，同样按空数组兼容读取。
  const correctionsRaw =
    raw.pendingCorrections === undefined ? [] : raw.pendingCorrections;
  if (!Array.isArray(correctionsRaw)) return null;

  // 旧试用缓存还没有 datasetId：补上当前虚构数据集标识，原场次、线路与尝试照常读取。
  const datasetId =
    raw.datasetId === undefined ? TRIAL_DATASET_ID : raw.datasetId;
  if (!isTrialDatasetId(datasetId)) return null;

  // 旧缓存没有重置世代：按 LEGACY_GENERATION 兼容读取，同一份旧缓存的待确认操作
  // 会读到同一个世代，不会因为缺字段被判成过期请求。
  const generation = hasText(raw.generation) ? raw.generation : LEGACY_GENERATION;

  const sessionsOk = raw.sessions.every(
    item =>
      item &&
      hasText(item.id) &&
      isSeq(item.seq) &&
      hasText(item.gymId) &&
      isDateString(item.date) &&
      hasText(item.createdAt)
  );
  const routesOk = raw.routes.every(
    item =>
      item &&
      hasText(item.id) &&
      hasText(item.gymId) &&
      hasText(item.name) &&
      hasText(item.colorName) &&
      hasText(item.colorHex) &&
      hasText(item.grade)
  );
  const attemptsOk = raw.attempts.every(
    item =>
      item &&
      hasText(item.id) &&
      isSeq(item.seq) &&
      hasText(item.sessionId) &&
      hasText(item.routeId) &&
      (item.result === 'fail' || item.result === 'send') &&
      typeof item.note === 'string' &&
      hasText(item.createdAt)
  );
  const pendingOk = pendingRaw.every(
    item =>
      item &&
      hasText(item.opId) &&
      isSeq(item.seq) &&
      hasText(item.sessionId) &&
      hasText(item.routeId) &&
      (item.result === 'fail' || item.result === 'send') &&
      typeof item.note === 'string' &&
      hasText(item.createdAt) &&
      // 重置世代是后加的字段：旧待确认没有它时仍按可读处理，不判定损坏。
      (item.generation === undefined || typeof item.generation === 'string')
  );
  if (!sessionsOk || !routesOk || !attemptsOk || !pendingOk) return null;

  // 更正中的操作只引用原把次：结构必须完整，否则判损坏。
  const correctionsOk = correctionsRaw.every(
    item =>
      item &&
      hasText(item.attemptId) &&
      hasText(item.sessionId) &&
      hasText(item.routeId) &&
      hasText(item.createdAt) &&
      (item.generation === undefined || typeof item.generation === 'string')
  );
  if (!correctionsOk) return null;

  const uniqueIds = items => new Set(items.map(item => item.id)).size === items.length;
  const uniqueOpIds = new Set(pendingRaw.map(item => item.opId)).size === pendingRaw.length;
  const uniqueCorrectionIds =
    new Set(correctionsRaw.map(item => item.attemptId)).size === correctionsRaw.length;
  const attemptIds = new Set(raw.attempts.map(item => item.id));
  if (
    !uniqueIds(raw.sessions) ||
    !uniqueIds(raw.routes) ||
    !uniqueIds(raw.attempts) ||
    !uniqueOpIds ||
    !uniqueCorrectionIds ||
    pendingRaw.some(item => attemptIds.has(item.opId))
  ) {
    return null;
  }

  // 更正只能作用在仍然存在、且仍是同一场次同一线路的完攀把次上：
  // 原把次已被重置、被别处结清或已改成未完成时，这条待更正不可能再应用，
  // 读取时丢掉待更正本身即可——不改动任何已保存尝试，也不影响其他线路。
  const attemptById = new Map(raw.attempts.map(item => [item.id, item]));
  const pendingCorrections = correctionsRaw.filter(item => {
    const attempt = attemptById.get(item.attemptId);
    return Boolean(
      attempt &&
        attempt.result === 'send' &&
        attempt.sessionId === item.sessionId &&
        attempt.routeId === item.routeId
    );
  });

  return {
    version: STATE_VERSION,
    datasetId,
    generation,
    nextSessionSeq: normalizeCounter(raw.nextSessionSeq, raw.sessions),
    nextRouteSeq: normalizeCounter(raw.nextRouteSeq, raw.routes, routeSeq),
    // 待确认操作已经占用了序号，重试不能重新分配 ID。
    nextAttemptSeq: normalizeCounter(
      raw.nextAttemptSeq,
      raw.attempts.concat(pendingRaw.map(item => ({ seq: item.seq })))
    ),
    sessions: raw.sessions,
    routes: raw.routes,
    attempts: raw.attempts,
    pendingSaves: pendingRaw,
    pendingCorrections,
    activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : '',
    activeRouteId: typeof raw.activeRouteId === 'string' ? raw.activeRouteId : ''
  };
}

/**
 * 读取只发生在专用键上。空缓存是正常的首次进入，不报错。
 */
function loadState() {
  let raw;
  try {
    raw = wx.getStorageSync(STORE_KEY);
  } catch (error) {
    return {
      state: createInitialState(),
      error: '读取本地试用数据失败：' + errorText(error)
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { state: createInitialState(), error: '' };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return {
      state: createInitialState(),
      error: '本地试用数据格式损坏，请重置后再试'
    };
  }

  const state = normalizeState(parsed);
  if (!state) {
    return {
      state: createInitialState(),
      error: '本地试用数据格式损坏，请重置后再试'
    };
  }
  return { state, error: '' };
}

function saveState(state) {
  try {
    wx.setStorageSync(STORE_KEY, JSON.stringify(state));
    return { ok: true, error: '' };
  } catch (error) {
    return {
      ok: false,
      error: '本地保存失败：' + errorText(error)
    };
  }
}

/**
 * 一条线路的完攀状态，供今日页与详情页共用（T015 直接复用）。
 *
 * 归属按「当前试用用户 + 当前数据集 + 长期线路 ID」判断：这里的状态本身就是当前
 * 数据集的快照；用户与数据集标识同时写入模拟账本，两侧执行同一份规则。
 * - 抱石（含缺 climbType 的旧 V 级线路）首次完攀后不再新增任何把次；
 * - 历史已有多条完攀时 sendCount 保持原数目，closed 仍为真；
 * - 顶绳和先锋可以重复完攀，不因此关闭入口；
 * - 误点完攀可原把改正：latestSendId 给出最近一把可识别的已确认完攀，
 *   canCorrect 表示现在可以发起「改为未完成」；已有待更正时不再重复发起。
 * 只读计算，不写缓存、不迁移旧数据、不生成逐把明细。
 */
function routeCompletion(state, routeId) {
  const unknown = {
    known: false,
    routeId: routeId || '',
    isBoulder: false,
    repeatable: true,
    sendCount: 0,
    pendingSendCount: 0,
    pendingCorrectionCount: 0,
    hasSend: false,
    hasPendingSend: false,
    completed: false,
    closed: false,
    canRecord: true,
    latestSendId: '',
    correcting: false,
    canCorrect: false
  };

  const route =
    state && Array.isArray(state.routes)
      ? state.routes.find(item => item.id === routeId)
      : null;
  if (!route) return unknown;

  const isBoulder = routeRules.isBoulderRoute(route);
  const attempts = (state.attempts || []).filter(
    item => item.routeId === route.id
  );
  const sends = attempts.filter(item => item.result === 'send');
  const pendingSends = (state.pendingSaves || []).filter(
    item => item.routeId === route.id && item.result === 'send'
  );
  // 更正中的操作只认这条线自己的原把次，跨线路的待更正不影响本条线路。
  const corrections = (state.pendingCorrections || []).filter(
    item => item.routeId === route.id
  );
  const hasSend = sends.length > 0;
  const hasPendingSend = pendingSends.length > 0;
  // 抱石首次完攀：已确认或仍在待确认都关闭全部新增入口；顶绳、先锋可重复。
  const closed = isBoulder && (hasSend || hasPendingSend);

  // 最近一把可识别的已确认完攀就是「改为未完成」的明确目标；多条历史完攀时逐次更正。
  const target = routeRules.latestSendAttempt(attempts, route.id);
  const correcting = isBoulder && corrections.length > 0;

  return {
    known: true,
    routeId: route.id,
    isBoulder,
    repeatable: !isBoulder,
    sendCount: sends.length,
    pendingSendCount: pendingSends.length,
    pendingCorrectionCount: corrections.length,
    hasSend,
    hasPendingSend,
    completed: isBoulder && hasSend,
    closed,
    canRecord: !closed,
    latestSendId: target ? target.id : '',
    correcting,
    // 已有待更正时不再重复发起；更正失败后由页面复用同一条待更正重试。
    canCorrect: isBoulder && hasSend && !correcting
  };
}

/**
 * 这条线「改为未完成」的目标把次（原 stable attempt/op ID），没有可更正的对象时返回 null。
 * 只读挑选：目标必须是当前线路里已确认的完攀，且所属场次仍然存在，
 * 这样更正才能维持原来的把数、时间、序号与场次。
 */
function latestSendForCorrection(state, routeId) {
  const completion = routeCompletion(state, routeId);
  if (!completion.known || !completion.latestSendId) return null;

  const attempt = (state.attempts || []).find(
    item => item.id === completion.latestSendId && item.result === 'send'
  );
  if (!attempt) return null;
  if (!(state.sessions || []).some(item => item.id === attempt.sessionId)) {
    return null;
  }
  return attempt;
}

/**
 * 这条线仍在更正中的操作（同一线路最多一条）；没有时返回 null。
 */
function pendingCorrectionFor(state, routeId) {
  return (
    (state.pendingCorrections || []).find(item => item.routeId === routeId) ||
    null
  );
}

/* ------------------------------------------------------------------ *
 * 「改为未完成」的共用逻辑（T015 返工）
 *
 * 今日页与详情页用的是同一份：目标校验、入队、请求格式与回执结清都在这里，
 * 页面只把渲染当时的目标带下来、并按返回结果更新自己的展示字段。
 * 与页面无关，是纯状态收发（除 finishCorrectionJob 需要读写缓存外）。
 * ------------------------------------------------------------------ */

function findSession(state, id) {
  return ((state && state.sessions) || []).find(item => item.id === id) || null;
}

function sessionLabel(state, session) {
  const sameDay = ((state && state.sessions) || [])
    .filter(item => item.date === session.date)
    .sort((left, right) => left.seq - right.seq);
  return '第 ' + (sameDay.findIndex(item => item.id === session.id) + 1) + ' 场';
}

function gymName(gymId) {
  const gym = GYMS.find(item => item.id === gymId);
  return gym ? gym.name : '未知岩馆';
}

/**
 * 「改为未完成」的目标说明：要说清改正的是哪一天、哪一场、第几把，
 * 避免用户改错把次。只读计算，找不到原把次或原场次时返回 null。
 */
function sendTargetText(state, attemptId) {
  if (!hasText(attemptId)) return null;
  const attempt = (state.attempts || []).find(item => item.id === attemptId);
  if (!attempt) return null;
  const session = findSession(state, attempt.sessionId);
  if (!session) return null;

  // 把次编号与详情页一致：同场次同线路内按序号，重试与更正都不跳号。
  const ordered = state.attempts
    .filter(
      item =>
        item.sessionId === attempt.sessionId && item.routeId === attempt.routeId
    )
    .sort((left, right) => left.seq - right.seq);
  const index = ordered.findIndex(item => item.id === attempt.id);
  return {
    attemptId: attempt.id,
    routeId: attempt.routeId,
    sessionId: attempt.sessionId,
    label: '第 ' + (index + 1) + ' 把',
    contextText:
      session.date +
      ' ' +
      sessionLabel(state, session) +
      ' · ' +
      gymName(session.gymId)
  };
}

/**
 * 从事件里取出渲染当时带下来的更正上下文。
 * 页面按真实 tap 传入 `event.currentTarget.dataset`；缺字段时按空值处理，
 * 由 correctionTargetFromDataset 判定，绝不回落到「最新一把」。
 */
function correctionDataset(event) {
  const dataset =
    (event && event.currentTarget && event.currentTarget.dataset) || {};
  return {
    attemptId: hasText(dataset.attemptId) ? dataset.attemptId : '',
    routeId: hasText(dataset.routeId) ? dataset.routeId : '',
    sessionId: hasText(dataset.sessionId) ? dataset.sessionId : '',
    generation: hasText(dataset.generation) ? dataset.generation : '',
    datasetId: hasText(dataset.datasetId) ? dataset.datasetId : '',
    ownerId: hasText(dataset.ownerId) ? dataset.ownerId : ''
  };
}

/**
 * 校验「这次点按要改正的是哪一把」，只认渲染当时的目标。
 *
 * 返回 { status, attempt }：
 * - 'ok'          这一把仍是同一条抱石线、同一场次里已确认的完攀，可以更正；
 * - 'missing'     没带原把次 ID，或这一把在原场次里已不存在（例如已被重置）；
 * - 'stale'       渲染上下文来自别的编号空间/数据集/归属，或页面已切到别的线路；
 * - 'conflict'    带下来的线路/场次与这一把不一致；
 * - 'unsupported' 这条线路不是抱石（绳攀可重复，没有「首次完攀」概念）；
 * - 'resolved'    这一把已经不是完攀（已被别处或早前一次更正改过）。
 *
 * 任何非 'ok' 的结果都不会挑另一把来改正：参数缺失或过时绝不默默取最新的完攀。
 * generation / datasetId / ownerId 缺省时不判过期（兼容旧的渲染与调用），
 * 只要带了就必须与当前试用数据一致。
 */
function correctionTargetFromDataset(state, dataset, currentRouteId) {
  const data = dataset || {};
  if (!hasText(data.attemptId)) return { status: 'missing', attempt: null };

  const attempt =
    (state.attempts || []).find(item => item.id === data.attemptId) || null;
  if (!attempt) return { status: 'missing', attempt: null };

  if (hasText(data.routeId) && data.routeId !== attempt.routeId) {
    return { status: 'conflict', attempt: null };
  }
  if (hasText(data.sessionId) && data.sessionId !== attempt.sessionId) {
    return { status: 'conflict', attempt: null };
  }
  // 页面已经切到别的线路：这一把不再属于当前展示，按过期处理。
  if (hasText(currentRouteId) && currentRouteId !== attempt.routeId) {
    return { status: 'stale', attempt: null };
  }
  if (
    hasText(data.generation) &&
    hasText(state.generation) &&
    data.generation !== state.generation
  ) {
    return { status: 'stale', attempt: null };
  }
  if (hasText(data.datasetId) && data.datasetId !== state.datasetId) {
    return { status: 'stale', attempt: null };
  }
  if (hasText(data.ownerId) && data.ownerId !== TRIAL_OWNER_ID) {
    return { status: 'stale', attempt: null };
  }

  const route =
    (state.routes || []).find(item => item.id === attempt.routeId) || null;
  if (!route || !routeRules.isBoulderRoute(route)) {
    return { status: 'unsupported', attempt: null };
  }
  if (!findSession(state, attempt.sessionId)) {
    return { status: 'missing', attempt: null };
  }
  // 已经在别处（或早前一次更正）改成未完成：迟到的旧按钮只提示，不改别的把次。
  if (attempt.result !== 'send') return { status: 'resolved', attempt };
  return { status: 'ok', attempt };
}

/**
 * 目标校验不通过时给用户的短提示：说清「没有改动任何东西」与下一步。
 * 由页面写进自己的提示字段，不在按钮附近堆长文案，也不把更正说成新增一把。
 */
function correctionStatusNotice(status) {
  switch (status) {
    case 'stale':
      return '页面已刷新或记录已变化，未做更正：请按最新显示重新确认要改正的那一把。';
    case 'conflict':
      return '这一把不属于当前线路或场次，未做更正。';
    case 'unsupported':
      return '只有抱石的已完攀把次能改成未完成。';
    case 'resolved':
      return '这一把已经是未完成，未改动其他把次。';
    default:
      return '这条线路没有可改正的已确认完攀：只有抱石的已完攀把次能改成未完成。';
  }
}

/**
 * 记下一条待更正（纯函数，调用方负责落盘）：只记「要改正哪一把」，
 * 场次、线路与编号空间（世代）一并记下；已有同目标的待更正时原位替换，不重复入队。
 */
function enqueueCorrection(state, attempt) {
  const next = clone(state);
  next.pendingCorrections = (next.pendingCorrections || []).filter(
    item => item.attemptId !== attempt.id
  );
  next.pendingCorrections.push({
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    routeId: attempt.routeId,
    createdAt: new Date().toISOString(),
    // 与待确认操作一样记下编号空间：重置/切换后的迟到回执据此不写回新数据。
    generation: state.generation || ''
  });
  return next;
}

/**
 * 更正请求的格式（保存端契约只有这一份）：只报「要改正的原把次」与它自己的
 * 场次/线路/世代；线路类型、归属与结果都由保存端按试用数据与账本判定。
 */
function correctionRequest(entry) {
  return {
    opId: entry.attemptId,
    sessionId: entry.sessionId,
    routeId: entry.routeId,
    generation: entry.generation || ''
  };
}

/**
 * 更正回执的共用结清：读最新持久状态，只核销这一个原把次，返回页面要展示的决定。
 *
 * 返回 { state, storageError, notice, failure, code }：
 * - state 为 null 表示缓存不可读，页面只需显示 storageError，不动其他任何数据；
 * - notice 是给用户的短提示，由页面写进自己的提示字段（今日页 saveNotice / 详情 recordNotice）；
 * - failure 是页面重试提示用的失败码（'' 表示清掉旧失败码）；
 * - code 是给测试与排查用的结论：stale / settled / already-settled / noop / corrected /
 *   local-write-failed / settle-write-failed / unreceived / unreadable。
 *
 * 关键点仍是「只改这一把」：成功时只翻那一把的 result，其他记录（含后来新记的
 * 完攀）一律不动；失败或丢回执时保留待更正，可再点一次按同一把重试。
 */
function finishCorrectionJob(attemptId, outcome, snapshot) {
  const loaded = loadState();
  if (loaded.error) {
    return {
      state: null,
      storageError: loaded.error,
      notice: '',
      failure: '',
      code: 'unreadable'
    };
  }

  const latest = loaded.state;
  const pending = (latest.pendingCorrections || []).some(
    item => item.attemptId === attemptId
  );

  // 重置或切换数据集后到达的旧回执：编号空间已经换新，绝不写回。
  if (snapshot && snapshot.generation && snapshot.generation !== latest.generation) {
    return {
      state: latest,
      storageError: '',
      notice: '',
      failure: '',
      code: 'stale'
    };
  }
  if (outcome && outcome.stale) {
    return {
      state: latest,
      storageError: '',
      notice: '',
      failure: '',
      code: 'stale'
    };
  }
  // 保存端判定这条更正不属于当前线路/场次/归属：不应用，也不留下永远做不完的待更正。
  if (outcome && outcome.opIdConflict) {
    return settleCorrectionJob(
      latest,
      attemptId,
      (outcome.error || '这条更正不属于当前线路') + '，本次更正已撤销。'
    );
  }
  // 账本里已经没有这一把（例如账本被重置）或该线路不是抱石：只清掉待更正，
  // 本地把次原样不动——不做「只改一份数据」的半套更正。
  if (outcome && (outcome.correctionMissing || outcome.unsupported)) {
    return settleCorrectionJob(
      latest,
      attemptId,
      (outcome.error || '这一把无法更正') +
        '，本次更正已撤销，其他记录未改动。'
    );
  }

  if (outcome && outcome.ok) {
    // 别的实例已经结清这条待更正：只按最新状态同步显示。
    if (!pending) {
      return {
        state: latest,
        storageError: '',
        notice: '',
        failure: '',
        code: 'already-settled'
      };
    }

    const next = clone(latest);
    next.pendingCorrections = next.pendingCorrections.filter(
      item => item.attemptId !== attemptId
    );
    const attempt = next.attempts.find(item => item.id === attemptId);

    // 原把次已不是完攀：只清掉待更正，绝不复活旧完攀，也不改写别的把次。
    if (!attempt || attempt.result !== 'send') {
      const cleaned = saveState(next);
      if (!cleaned.ok) {
        return {
          state: latest,
          storageError: cleaned.error,
          notice: '更正已确认，但本地写入失败，可再点「改为未完成」重试。',
          failure: '',
          code: 'settle-write-failed'
        };
      }
      return {
        state: next,
        storageError: '',
        notice: '',
        failure: '',
        code: 'noop'
      };
    }

    // 原位改正：只翻这一把的 result，其他把次、序号、场次与备注都不动。
    attempt.result = 'fail';
    const saved = saveState(next);
    if (!saved.ok) {
      // 账本已改、本地没落盘：保留待更正，再点一次会拿到保存端的幂等确认。
      return {
        state: latest,
        storageError: saved.error,
        notice:
          '保存端已把这一把改成未完成，但本地写入失败；本地仍显示「已完攀」，可再点「改为未完成」重试。',
        failure: 'save-error',
        code: 'local-write-failed'
      };
    }
    return {
      state: next,
      storageError: '',
      notice: '',
      failure: '',
      code: 'corrected'
    };
  }

  // 没拿到回执：持久状态不变，保留待更正并给出重试入口。
  if (pending) {
    const lost = Boolean(outcome && outcome.receiptLost);
    return {
      state: latest,
      storageError: '',
      notice: lost
        ? (outcome.error || '模拟回执丢失') +
          '。这一把仍按「已完攀」显示，可再点「改为未完成」按同一把重试。'
        : (outcome && outcome.error ? outcome.error : '模拟保存端返回失败') +
          '。这一把仍按「已完攀」显示，可再点「改为未完成」重试。',
      failure: lost ? 'receipt-lost' : 'save-error',
      code: 'unreceived'
    };
  }

  return {
    state: latest,
    storageError: '',
    notice: '',
    failure: '',
    code: 'unreceived'
  };
}

/**
 * 保存端明确拒绝这条更正（跨归属或原记录已不在）时，只撤销待更正。
 * 已保存的尝试、其他线路与其他号码都不动；撤销本身写失败时保留待更正可再试。
 */
function settleCorrectionJob(latest, attemptId, notice) {
  const settled = clone(latest);
  settled.pendingCorrections = settled.pendingCorrections.filter(
    item => item.attemptId !== attemptId
  );

  const cleaned = saveState(settled);
  if (!cleaned.ok) {
    return {
      state: latest,
      storageError: cleaned.error,
      notice: notice + '本地撤销尚未写入，可再点一次重试。',
      failure: '',
      code: 'settle-write-failed'
    };
  }
  return {
    state: settled,
    storageError: '',
    notice,
    failure: '',
    code: 'settled'
  };
}

module.exports = {
  STORE_KEY,
  STATE_VERSION,
  LEGACY_GENERATION,
  GYMS,
  FIXTURE_ROUTES,
  LEGACY_SUMMARY_SAMPLE,
  ROUTE_COLORS,
  CLIMB_TYPES: routeRules.CLIMB_TYPES,
  GRADES_BY_TYPE: routeRules.GRADES_BY_TYPE,
  DEFAULT_CLIMB_TYPE: routeRules.DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE: routeRules.DEFAULT_GRADE,
  clone,
  formatLocalDate,
  formatLocalTime,
  todayLocalDate,
  isDateString,
  createInitialState,
  normalizeState,
  loadState,
  saveState,
  routeCompletion,
  latestSendForCorrection,
  pendingCorrectionFor,
  sendTargetText,
  correctionDataset,
  correctionTargetFromDataset,
  correctionStatusNotice,
  enqueueCorrection,
  correctionRequest,
  finishCorrectionJob,
  TRIAL_OWNER_ID,
  isBoulderRoute: routeRules.isBoulderRoute,
  isSameSendOwner: routeRules.isSameSendOwner
};
