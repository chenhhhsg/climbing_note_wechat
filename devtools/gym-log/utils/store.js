/**
 * 岩馆快速记录 · 独立本地试用数据层
 *
 * 只读写专用缓存键，不读取正式工程的记录，也不访问云环境。
 * 岩馆与线路来自虚构样例；用户新建的线路、场次和尝试都保存在本机。
 * 所有 ID 一经创建就固定下来，用于区分同色同级的线路和跨天回看。
 */
const STORE_KEY = 'climbingNote.gymLogTrial.v1';
const STATE_VERSION = 1;

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

const ROUTE_COLORS = [
  { name: '蓝色', hex: '#2f6fe4' },
  { name: '红色', hex: '#d94a3a' },
  { name: '黄色', hex: '#d9a21b' },
  { name: '绿色', hex: '#3c8c5a' },
  { name: '黑色', hex: '#2a2a28' },
  { name: '白色', hex: '#d8d3c6' }
];

const GRADES = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];

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
    nextSessionSeq: 1,
    nextRouteSeq: 1,
    nextAttemptSeq: 1,
    sessions: [],
    routes: clone(FIXTURE_ROUTES),
    attempts: [],
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

function normalizeEntrySeq(items) {
  return items.reduce((max, item) => Math.max(max, item.seq), 0);
}

function normalizeCounter(value, items) {
  const max = normalizeEntrySeq(items);
  return isSeq(value) && value > max ? value : max + 1;
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
  if (!sessionsOk || !routesOk || !attemptsOk) return null;

  const uniqueIds = items => new Set(items.map(item => item.id)).size === items.length;
  if (
    !uniqueIds(raw.sessions) ||
    !uniqueIds(raw.routes) ||
    !uniqueIds(raw.attempts)
  ) {
    return null;
  }

  return {
    version: STATE_VERSION,
    nextSessionSeq: normalizeCounter(raw.nextSessionSeq, raw.sessions),
    nextRouteSeq: normalizeCounter(raw.nextRouteSeq, raw.routes),
    nextAttemptSeq: normalizeCounter(raw.nextAttemptSeq, raw.attempts),
    sessions: raw.sessions,
    routes: raw.routes,
    attempts: raw.attempts,
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

module.exports = {
  STORE_KEY,
  STATE_VERSION,
  GYMS,
  FIXTURE_ROUTES,
  ROUTE_COLORS,
  GRADES,
  clone,
  formatLocalDate,
  formatLocalTime,
  todayLocalDate,
  isDateString,
  createInitialState,
  normalizeState,
  loadState,
  saveState
};
