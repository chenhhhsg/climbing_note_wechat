/**
 * 「下次想爬」线路清单（T027）
 *
 * 用户在岩馆看中一条线但这次没爬完时，把这条长期线路收藏起来；下次进同一家岩馆，
 * 清单里就能看到这条线的原照片、累计把数、最近一条非空备注，点开还是同一个长期
 * 线路 ID，接着往原线上记把次。
 *
 * 数据模型：清单是独立的一份本机记录，只保存「哪些长期线路被收藏」以及收藏/归档时间，
 * 不复制线路、照片、把次或备注——那些仍然只在本机档案（utils/training-store.js）与
 * 照片索引（utils/training-photos.js）里有一份。因此：
 * - 清单按岩馆分组时，岩馆归属取自档案里那条线路的 gymId，不按名称、颜色或等级猜；
 *   同色同级的 A、B 两条线各自独立，收藏 A 不会让 B 出现；
 * - 撤下收藏、拆线归档都只改清单里的这一条，线路、照片文件、照片索引、把次、备注与
 *   跨日历史一律不动，归档后仍能按原线路 ID 回看；
 * - 清单条目里存的 gymId 只作参考，读取时以档案里的线路归属为准，因此不会串馆。
 *
 * 状态由档案推导，不单独存一份，避免两处不一致：
 * - 'wanted'    想爬：在活跃清单里（含顶绳、先锋完攀后仍可续记的线路）；
 * - 'completed' 已完成：关注的抱石首次完攀（沿用档案层 routeCompletion 的判定）；
 *   把那一把「改为未完成」后，下一条读取又会回到想爬，照片、把次与历史都不变；
 * - 'archived'  已归档：岩馆拆线，用户把这条从活跃清单归档，保留照片、把次与历史。
 *
 * 存储键（正式本机命名空间，受保护，普通清缓存不动）：
 *   climbingNote.training.v1.wishlist   下次想爬清单
 * 无键是正常的「还没收藏过」，返回空清单；键存在但损坏或版本不受支持时返回可见错误、
 * 保留原数据，并且此后所有写入口一律拒绝落盘（不会用空清单覆盖用户已保存的收藏）。
 *
 * 写操作都是「先读最新清单，再改这一条，然后落盘」，同一函数内同步完成，不把过时快照
 * 整体写回。每次写都以长期线路 ID 为键，因此重复点击、迟到回调与写失败后的重试都是
 * 幂等的：同一线路最多一条，不会出现重复项，也不会丢掉别的收藏。
 */
const store = require('./training-store.js');
const rules = require('./training-rules.js');

const WISHLIST_KEY = store.NAMESPACE + 'wishlist';
const WISHLIST_VERSION = 1;

// 可见错误文案：损坏与版本不支持要和「还没收藏过」区分开，页面据此提示并保留原清单。
const WISHLIST_BROKEN = '下次想爬清单格式损坏，为保护原清单未自动重建';
const WISHLIST_UNSUPPORTED = '下次想爬清单版本不受支持，请升级小程序后重试';
const WISHLIST_READ_FAILED = '读取下次想爬清单失败：';
const WISHLIST_WRITE_FAILED = '保存下次想爬清单失败：';

const STATUS_WANTED = 'wanted';
const STATUS_COMPLETED = 'completed';
const STATUS_ARCHIVED = 'archived';
const WISHLIST_STATUSES = [STATUS_WANTED, STATUS_COMPLETED, STATUS_ARCHIVED];
const STATUS_TEXT = {
  wanted: '想爬',
  completed: '已完成',
  archived: '已归档'
};

// 同组条目内先按状态排（想爬 → 已完成 → 已归档），再按最近加入的在前。
const STATUS_ORDER = {
  wanted: 0,
  completed: 1,
  archived: 2
};

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

/**
 * 收藏时间：调用方可以传入固定的 Date 或 ISO 字符串，便于离线测试注入时间；
 * 缺省取当前时间。只用于加入与归档时间，不参与任何判定。
 */
function timestamp(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (hasText(now)) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function createEmptyWishlist() {
  return { version: WISHLIST_VERSION, items: [] };
}

/**
 * 只接受当前版本、结构完整且同一线路只有一条的清单；损坏时返回 null，
 * 由调用方返回可见错误并保留原数据（不自动重建，避免把已收藏的线当成没收藏过）。
 */
function normalizeWishlist(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== WISHLIST_VERSION) return null;
  if (!Array.isArray(raw.items)) return null;

  const seen = new Set();
  const items = [];
  for (const item of raw.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (!hasText(item.routeId)) return null;
    if (seen.has(item.routeId)) return null;
    seen.add(item.routeId);
    if (!hasText(item.addedAt)) return null;
    if (item.gymId !== undefined && typeof item.gymId !== 'string') return null;
    if (item.archivedAt !== undefined && typeof item.archivedAt !== 'string') return null;
    items.push({
      routeId: item.routeId,
      gymId: hasText(item.gymId) ? item.gymId : '',
      addedAt: item.addedAt,
      archivedAt: hasText(item.archivedAt) ? item.archivedAt : ''
    });
  }
  return { version: WISHLIST_VERSION, items };
}

/**
 * 读取下次想爬清单。返回 { ok, error, present, corrupt, state }：
 * - 无键（还没收藏过）：ok:true、present:false、空清单，不报错；
 * - 解析或结构损坏：ok:false、corrupt:true、可见错误；原数据保持不动；
 * - 版本不受支持：ok:false、可见错误；原数据保持不动；
 * - 读取本身失败（getStorageSync 抛出）：ok:false、可见错误。
 * state 始终可用于只读展示（损坏时为空清单），但写入口在 ok:false 时一律拒绝落盘。
 */
function loadWishlist() {
  let raw;
  try {
    raw = wx.getStorageSync(WISHLIST_KEY);
  } catch (error) {
    return {
      ok: false,
      error: WISHLIST_READ_FAILED + errorText(error),
      present: false,
      corrupt: false,
      state: createEmptyWishlist()
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, error: '', present: false, corrupt: false, state: createEmptyWishlist() };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return {
      ok: false,
      error: WISHLIST_BROKEN,
      present: true,
      corrupt: true,
      state: createEmptyWishlist()
    };
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.version !== undefined &&
    parsed.version !== WISHLIST_VERSION
  ) {
    return {
      ok: false,
      error: WISHLIST_UNSUPPORTED,
      present: true,
      corrupt: true,
      state: createEmptyWishlist()
    };
  }

  const state = normalizeWishlist(parsed);
  if (!state) {
    return {
      ok: false,
      error: WISHLIST_BROKEN,
      present: true,
      corrupt: true,
      state: createEmptyWishlist()
    };
  }
  return { ok: true, error: '', present: true, corrupt: false, state };
}

/**
 * 落盘清单。失败只返回错误，不抛出、不重试其他写入。
 */
function saveWishlist(state) {
  try {
    wx.setStorageSync(WISHLIST_KEY, JSON.stringify(state));
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: WISHLIST_WRITE_FAILED + errorText(error) };
  }
}

function routeById(archive, routeId) {
  const routes = (archive && archive.routes) || [];
  if (!hasText(routeId)) return null;
  return routes.find(item => item.id === routeId) || null;
}

/**
 * 这条长期线在本机的累计把数与最近一条非空备注。
 *
 * 只统计已落盘的把次：还没落盘的「进行中」操作不计入（与底部统计同一口径）；
 * 「最近」按把次序号取最大的一条非空备注——序号在档案里全局递增，因此跨日、跨场次
 * 都能取到真正最近写下的那句备注，不按名称或颜色归并。
 */
function routeAttemptStats(archive, routeId) {
  const attempts = ((archive && archive.attempts) || []).filter(
    item => item.routeId === routeId
  );
  let latestNote = '';
  let latestSeq = -1;
  attempts.forEach(attempt => {
    if (typeof attempt.note !== 'string') return;
    const note = attempt.note.trim();
    if (!note) return;
    const seq = Number.isInteger(attempt.seq) ? attempt.seq : 0;
    if (seq >= latestSeq) {
      latestSeq = seq;
      latestNote = note;
    }
  });
  return {
    attemptCount: attempts.length,
    sendCount: attempts.filter(item => item.result === 'send').length,
    latestNote
  };
}

/**
 * 一条清单条目在页面上的样子：线路信息、累计把数、最近非空备注与状态。
 * 线路已不在当前档案里时返回 null（调用方跳过它，不猜、不补、不串馆）。
 */
function buildEntry(archive, item) {
  const route = routeById(archive, item.routeId);
  if (!route) return null;

  const completion = store.routeCompletion(archive, route.id);
  const stats = routeAttemptStats(archive, route.id);
  const archived = hasText(item.archivedAt);
  // 已归档优先：拆线后即使曾经完攀也不回到活跃清单。
  const status = archived
    ? STATUS_ARCHIVED
    : completion.completed
      ? STATUS_COMPLETED
      : STATUS_WANTED;

  return {
    routeId: route.id,
    gymId: route.gymId,
    gymName: store.gymName(archive, route.gymId),
    name: route.name,
    // 旧 V 级线路没有 climbType，按抱石只读展示，不回写档案。
    climbType: rules.climbTypeOf(route),
    grade: route.grade,
    colorName: route.colorName || '',
    colorHex: route.colorHex || '#dee2e6',
    status,
    statusText: STATUS_TEXT[status],
    archived,
    completed: status === STATUS_COMPLETED,
    attemptCount: stats.attemptCount,
    attemptCountText: stats.attemptCount + ' 把',
    sendCount: stats.sendCount,
    latestNote: stats.latestNote,
    hasNote: Boolean(stats.latestNote),
    addedAt: item.addedAt,
    archivedAt: item.archivedAt || ''
  };
}

function compareEntries(left, right) {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (byStatus !== 0) return byStatus;
  return right.addedAt.localeCompare(left.addedAt);
}

/**
 * 按岩馆分组的下次想爬清单（只读，不写盘、不改档案）。
 *
 * 返回 { ok, error, corrupt, present, groups, items, orphanCount }：
 * - groups 按岩馆名排序，馆内先想爬、再已完成、最后已归档；
 * - options.gymId 只取某一个岩馆（场内页按当前场次所属岩馆过滤）；
 * - 清单里有、但当前档案里已经没有这条线路时跳过（记在 orphanCount），
 *   不猜归属，也不让别的岩馆的线顶上来。
 */
function listWishlist(archive, options) {
  const data = options || {};
  const onlyGymId = hasText(data.gymId) ? data.gymId : '';
  const loaded = loadWishlist();

  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      corrupt: loaded.corrupt,
      present: loaded.present,
      groups: [],
      items: [],
      orphanCount: 0
    };
  }
  if (!archive) {
    return {
      ok: true,
      error: '',
      corrupt: false,
      present: loaded.present,
      groups: [],
      items: [],
      orphanCount: 0
    };
  }

  const byGym = new Map();
  const items = [];
  let orphanCount = 0;
  loaded.state.items.forEach(item => {
    const entry = buildEntry(archive, item);
    if (!entry) {
      orphanCount += 1;
      return;
    }
    if (onlyGymId && entry.gymId !== onlyGymId) return;
    items.push(entry);
    if (!byGym.has(entry.gymId)) byGym.set(entry.gymId, []);
    byGym.get(entry.gymId).push(entry);
  });

  const groups = [...byGym.keys()]
    .map(gymId => {
      const entries = byGym.get(gymId).slice().sort(compareEntries);
      return {
        gymId,
        gymName: entries[0].gymName,
        items: entries,
        wanted: entries.filter(entry => entry.status === STATUS_WANTED),
        completed: entries.filter(entry => entry.status === STATUS_COMPLETED),
        archived: entries.filter(entry => entry.status === STATUS_ARCHIVED),
        count: entries.length,
        countText: entries.length + ' 条'
      };
    })
    .sort((left, right) => left.gymName.localeCompare(right.gymName) || left.gymId.localeCompare(right.gymId));

  return {
    ok: true,
    error: '',
    corrupt: false,
    present: loaded.present,
    groups,
    items: items.sort(compareEntries),
    orphanCount
  };
}

/**
 * 单条线路的清单状态（线路详情页与场内页当前线路共用）。
 * 返回 { ok, error, entry }：entry 为 null 表示这条线不在清单里。
 */
function wishlistEntry(archive, routeId) {
  const loaded = loadWishlist();
  if (!loaded.ok) return { ok: false, error: loaded.error, entry: null };
  const id = hasText(routeId) ? routeId : '';
  const item = loaded.state.items.find(entry => entry.routeId === id) || null;
  if (!item || !archive) return { ok: true, error: '', entry: null };
  return { ok: true, error: '', entry: buildEntry(archive, item) };
}

/**
 * 一批长期线路的清单状态（T029 小结勾选用，只读）：整批只读一次清单，
 * 不必逐行读盘，也不写清单、不写档案、不改线路与把次。
 *
 * 返回 { ok, error, corrupt, present, entries }：entries 是以长期线路 ID 为键的 Map，
 * 只包含清单里真实存在的那几条（不在清单里的线路不在 Map 里，不猜）；
 * 每条的状态与 listWishlist 同源——已归档优先，其次是关注抱石的首次完攀
 * （completed），其余为想爬。档案缺失时只报告「在清单里」，不猜完成状态。
 * 清单损坏、版本不支持或读取失败时 ok:false、entries 为空，调用方据此显示
 * 可见错误并收回写入口（写入口自己也会拒绝）。
 */
function wishlistMembership(archive, routeIds) {
  const wanted = new Set((Array.isArray(routeIds) ? routeIds : []).filter(hasText));
  const loaded = loadWishlist();
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      corrupt: loaded.corrupt,
      present: loaded.present,
      entries: new Map()
    };
  }

  const entries = new Map();
  loaded.state.items.forEach(item => {
    if (!wanted.has(item.routeId)) return;
    const archived = hasText(item.archivedAt);
    const completion = archive ? store.routeCompletion(archive, item.routeId) : null;
    const status = archived
      ? STATUS_ARCHIVED
      : completion && completion.completed
        ? STATUS_COMPLETED
        : STATUS_WANTED;
    entries.set(item.routeId, {
      routeId: item.routeId,
      inList: true,
      status,
      statusText: STATUS_TEXT[status],
      archived,
      completed: status === STATUS_COMPLETED,
      addedAt: item.addedAt,
      archivedAt: item.archivedAt || ''
    });
  });

  return {
    ok: true,
    error: '',
    corrupt: false,
    present: loaded.present,
    entries
  };
}

/**
 * 条目在页面上的可操作状态：加入、撤下与拆线归档三个入口的显示条件只有这一份判定，
 * 线路详情页与场内页共用，因此两个页面不会出现互相矛盾的按钮。
 * entry 为 null（还没收藏）时给出「加入」入口；已归档只给「重新加入」与「撤下」。
 */
function wishlistActionView(entry) {
  if (!entry) {
    return {
      inList: false,
      status: '',
      statusText: '',
      archived: false,
      completed: false,
      canAdd: true,
      canRemove: false,
      canArchive: false,
      stateText: '还没加入下次想爬',
      hintText: '加入后，下次进这家岩馆就能从清单里按原线路 ID 直接续记，累计把数与最近备注都会带出来。'
    };
  }

  const archived = entry.status === STATUS_ARCHIVED;
  const completed = entry.status === STATUS_COMPLETED;
  return {
    inList: true,
    status: entry.status,
    statusText: entry.statusText,
    archived,
    completed,
    canAdd: archived,
    canRemove: true,
    canArchive: !archived,
    stateText: archived
      ? '已归档（岩馆拆线）'
      : completed
        ? '已完成 · 已从想爬移到已完成'
        : '想爬 · 在本馆清单里',
    hintText: archived
      ? '只从活跃清单归档；照片、把次与历史都保留，仍可按原线路 ID 回看。再想爬可以重新加入。'
      : completed
        ? '这条抱石已完攀，已从想爬移到已完成；把那一把改成未完成后会自动回到想爬，照片与把次不变。'
        : '下次进这家岩馆就能从清单里按原线路 ID 直接续记。'
  };
}

/**
 * 加入下次想爬。
 *
 * 返回 { ok, code, error, state, entry, duplicate }。code：
 *   added / duplicate（已在活跃清单，幂等）/ reactivated（把已归档的恢复成想爬）/
 *   missing-route / archive-unreadable / unreadable / write-failed。
 * 同一线路最多一条：重复点击、迟到回调与写失败重试都不会产生第二条；落盘失败时
 * 清单保持原样（不报已保存），重试同一条线路幂等。只写清单，不动线路、照片与把次。
 */
function addWishlist(routeId, options) {
  const data = options || {};
  const id = hasText(routeId) ? routeId : '';

  const loaded = loadWishlist();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, state: loaded.state, entry: null };
  }

  const archives = store.loadState();
  if (!archives.ok) {
    return {
      ok: false,
      code: 'archive-unreadable',
      error: archives.error,
      state: loaded.state,
      entry: null
    };
  }
  const route = routeById(archives.archive, id);
  if (!route) {
    return {
      ok: false,
      code: 'missing-route',
      error: '找不到这条线路，不能加入下次想爬',
      state: loaded.state,
      entry: null
    };
  }

  const existing = loaded.state.items.find(item => item.routeId === id) || null;
  const at = timestamp(data.now);

  // 已在活跃清单里：重复点击不写盘、不产生第二条。
  if (existing && !hasText(existing.archivedAt)) {
    return {
      ok: true,
      code: 'duplicate',
      duplicate: true,
      error: '',
      state: loaded.state,
      entry: buildEntry(archives.archive, existing)
    };
  }

  const next = clone(loaded.state);
  let target;
  if (existing) {
    // 已归档的重新加入＝「又要爬了」：恢复成想爬，仍是一条；归档时间清掉便于再次归档。
    target = next.items.find(item => item.routeId === id);
    target.archivedAt = '';
    target.addedAt = at;
  } else {
    target = { routeId: id, gymId: route.gymId, addedAt: at, archivedAt: '' };
    next.items.push(target);
  }

  const saved = saveWishlist(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, state: loaded.state, entry: null };
  }
  return {
    ok: true,
    code: existing ? 'reactivated' : 'added',
    duplicate: false,
    error: '',
    state: next,
    entry: buildEntry(archives.archive, target)
  };
}

/**
 * 撤下收藏：只从清单里移除这一条，线路、照片、把次、备注与跨日历史都不动。
 * 返回 { ok, code, error, state, removed }。code：
 *   removed / absent（本来就没有这一条，幂等）/ unreadable / write-failed。
 */
function removeWishlist(routeId) {
  const id = hasText(routeId) ? routeId : '';
  const loaded = loadWishlist();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, state: loaded.state, removed: false };
  }

  const existing = loaded.state.items.find(item => item.routeId === id) || null;
  if (!existing) {
    return { ok: true, code: 'absent', duplicate: true, error: '', state: loaded.state, removed: false };
  }

  const next = clone(loaded.state);
  next.items = next.items.filter(item => item.routeId !== id);
  const saved = saveWishlist(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, state: loaded.state, removed: false };
  }
  return { ok: true, code: 'removed', duplicate: false, error: '', state: next, removed: true };
}

/**
 * 拆线归档：岩馆把这条线拆了，从活跃清单移到已归档，历史仍可按原线路 ID 回看。
 * 只改清单里的这一条（archive 时间），照片文件、照片索引、把次、备注与历史一律不动。
 * 返回 { ok, code, error, state, entry }。code：
 *   archived / already-archived（幂等）/ missing（不在清单里）/ unreadable / write-failed。
 */
function archiveWishlist(routeId, options) {
  const data = options || {};
  const id = hasText(routeId) ? routeId : '';

  const loaded = loadWishlist();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, state: loaded.state, entry: null };
  }

  const existing = loaded.state.items.find(item => item.routeId === id) || null;
  if (!existing) {
    return {
      ok: false,
      code: 'missing',
      error: '这条线路不在下次想爬清单里，不能归档',
      state: loaded.state,
      entry: null
    };
  }

  const archives = store.loadState();
  if (hasText(existing.archivedAt)) {
    return {
      ok: true,
      code: 'already-archived',
      duplicate: true,
      error: '',
      state: loaded.state,
      entry: archives.ok ? buildEntry(archives.archive, existing) : null
    };
  }

  const next = clone(loaded.state);
  const target = next.items.find(item => item.routeId === id);
  target.archivedAt = timestamp(data.now);
  const saved = saveWishlist(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, state: loaded.state, entry: null };
  }
  return {
    ok: true,
    code: 'archived',
    duplicate: false,
    error: '',
    state: next,
    entry: archives.ok ? buildEntry(archives.archive, target) : null
  };
}

module.exports = {
  WISHLIST_KEY,
  WISHLIST_VERSION,
  WISHLIST_BROKEN,
  WISHLIST_UNSUPPORTED,
  WISHLIST_READ_FAILED,
  WISHLIST_WRITE_FAILED,
  STATUS_WANTED,
  STATUS_COMPLETED,
  STATUS_ARCHIVED,
  WISHLIST_STATUSES,
  STATUS_TEXT,
  STATUS_ORDER,
  createEmptyWishlist,
  normalizeWishlist,
  loadWishlist,
  saveWishlist,
  routeAttemptStats,
  listWishlist,
  wishlistEntry,
  wishlistMembership,
  wishlistActionView,
  addWishlist,
  removeWishlist,
  archiveWishlist
};
