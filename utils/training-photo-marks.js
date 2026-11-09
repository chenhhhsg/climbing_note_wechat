/**
 * 线路主照片上的手法/脚法卡点标记（T028）
 *
 * 用户在主照片的某个岩点位置留一句提示（例如「左脚踩这里」），下次打开同一张原照片
 * 仍能指回同一个岩点。标记只是原照片上的一个相对位置加一句文字，不烧进照片、
 * 不上传、不生成第二份图片文件，也不参与任何完攀、把次或备注的判定。
 *
 * 归属：每条标记用「当前档案 + 长期线路 ID + 主照片 ID」三者一起标识。
 * - 同色同级的 A、B 两条线各有独立线路 ID，标记互不相干；
 * - 同一条线路换了（或移了）主照片后照片 ID 会变，旧标记不再落到新照片上；
 * - 更换主照片被取消时照片 ID 未变，原标记照旧显示。
 *
 * 位置：按原图归一化保存（x、y ∈ [0,1]，原点在原图左上角），不用屏幕像素。
 * 因此换屏、旋转、改用缩略图或跨天重开时，只要按当前显示框对原图做 aspectFit
 * 换算，标记就落回原图上同一个点；5 个显示逻辑像素以内的偏差即由此保证。
 * 点击落在照片外的留白（letterbox）上不生成标记。
 *
 * 存储键（正式本机命名空间，受保护，普通清缓存不动）：
 *   climbingNote.training.v1.photo-marks   卡点标记
 * 无键是正常的「还没标记过」，返回空标记；键存在但损坏或版本不受支持时返回可见错误、
 * 保留原数据，并且此后所有写入口一律拒绝落盘（不会用空标记覆盖用户已写的提示）。
 *
 * 写操作都是「先读最新标记，再改这一条，然后落盘」，同一函数内同步完成；以 markId
 * 为键，重复点击、迟到回调与写失败后的重试都幂等：同一 markId 不会变成两条，也不会
 * 影响别的标记。落盘失败时不报已保存，序号不消耗，重试拿到同一个稳定 ID。
 *
 * 新建另有一层「客户端操作身份」opId（沿用档案层把次 opId 的同一套语义）：页面为每个
 * 草稿生成一次 opId，同一次落点无论重试几次都传同一个。若这条 opId 已经落盘（写成功了
 * 但回执丢失、用户又点了一次），直接复用已落盘的那条，不再新建第二条——重试因此不会把
 * 一次落点写成一个半。同一 opId 带着别的照片/线路归回来时按冲突拒绝：不覆盖、也不新建。
 * 位置与文字相同的两份不同草稿各有自己的 opId，所以仍然是各自独立的两条标记。
 */
const store = require('./training-store.js');

const MARKS_KEY = store.NAMESPACE + 'photo-marks';
const MARKS_VERSION = 1;

// 可见错误文案：损坏与版本不支持要和「还没标记过」区分开，页面据此提示并保留原标记。
const MARKS_BROKEN = '照片卡点标记格式损坏，为保护原标记未自动重建';
const MARKS_UNSUPPORTED = '照片卡点标记版本不受支持，请升级小程序后重试';
const MARKS_READ_FAILED = '读取照片卡点标记失败：';
const MARKS_WRITE_FAILED = '保存照片卡点标记失败：';

// 手法与脚法两种卡点；默认脚法（主照片卡点最常用来写脚点）。
const MARK_KIND_FOOT = 'foot';
const MARK_KIND_HAND = 'hand';
const MARK_KINDS = [MARK_KIND_FOOT, MARK_KIND_HAND];
const MARK_KIND_TEXT = { foot: '脚法', hand: '手法' };
const DEFAULT_MARK_KIND = MARK_KIND_FOOT;

// 一句提示的字数上限：在照片上的小标签里读得完，不遮挡岩点。
const MARK_TEXT_MAX = 60;

const DRAFT_MARK_ID = 'mark-draft';

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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** 归一化位置：有限的 0..1 之间的数；越界或非数一律不接受。 */
function isRelative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 标记时间：调用方可以传入固定的 Date 或 ISO 字符串，便于离线测试注入时间；
 * 缺省取当前时间。只用于记录，不参与任何判定。
 */
function timestamp(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (hasText(now)) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function createEmptyMarks() {
  return { version: MARKS_VERSION, nextMarkSeq: 1, marks: [] };
}

/**
 * 只接受当前版本、结构完整且 ID/序号不重复的标记；损坏时返回 null，
 * 由调用方返回可见错误并保留原数据（不自动重建，避免把已写的提示当成没写过）。
 *
 * text 允许是空字符串（刚点下还没填字），也允许任意长度：读取不裁剪用户已写的字，
 * 只在写入时按上限收敛，避免读旧数据时被静默改写。
 */
function normalizeMarks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== MARKS_VERSION) return null;
  if (!isPositiveInteger(raw.nextMarkSeq)) return null;
  if (!Array.isArray(raw.marks)) return null;

  const ids = new Set();
  const seqs = new Set();
  const marks = [];
  let maxSeq = 0;
  for (const item of raw.marks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (!hasText(item.markId)) return null;
    if (!isPositiveInteger(item.seq)) return null;
    if (ids.has(item.markId) || seqs.has(item.seq)) return null;
    ids.add(item.markId);
    seqs.add(item.seq);
    if (!hasText(item.archiveId)) return null;
    if (!hasText(item.routeId)) return null;
    if (!hasText(item.photoId)) return null;
    if (MARK_KINDS.indexOf(item.kind) < 0) return null;
    if (!isRelative(item.x) || !isRelative(item.y)) return null;
    if (typeof item.text !== 'string') return null;
    if (item.opId !== undefined && typeof item.opId !== 'string') return null;
    if (!hasText(item.createdAt)) return null;
    if (item.updatedAt !== undefined && typeof item.updatedAt !== 'string') return null;
    maxSeq = Math.max(maxSeq, item.seq);
    marks.push({
      markId: item.markId,
      seq: item.seq,
      // 客户端操作身份：旧记录没有这一项时读成空串，照常显示与改写。
      opId: typeof item.opId === 'string' ? item.opId : '',
      archiveId: item.archiveId,
      routeId: item.routeId,
      photoId: item.photoId,
      kind: item.kind,
      x: item.x,
      y: item.y,
      text: item.text,
      createdAt: item.createdAt,
      updatedAt: hasText(item.updatedAt) ? item.updatedAt : item.createdAt
    });
  }
  // 序号必须严格向前，否则新标记会复用旧 ID。
  if (raw.nextMarkSeq <= maxSeq) return null;
  return { version: MARKS_VERSION, nextMarkSeq: raw.nextMarkSeq, marks };
}

/**
 * 读取卡点标记。返回 { ok, error, present, corrupt, state }：
 * - 无键（还没标记过）：ok:true、present:false、空标记，不报错；
 * - 解析或结构损坏：ok:false、corrupt:true、可见错误；原数据保持不动；
 * - 版本不受支持：ok:false、可见错误；原数据保持不动；
 * - 读取本身失败（getStorageSync 抛出）：ok:false、可见错误。
 * state 始终可用于只读展示（损坏时为空标记），但写入口在 ok:false 时一律拒绝落盘。
 */
function loadMarks() {
  let raw;
  try {
    raw = wx.getStorageSync(MARKS_KEY);
  } catch (error) {
    return {
      ok: false,
      error: MARKS_READ_FAILED + errorText(error),
      present: false,
      corrupt: false,
      state: createEmptyMarks()
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, error: '', present: false, corrupt: false, state: createEmptyMarks() };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return {
      ok: false,
      error: MARKS_BROKEN,
      present: true,
      corrupt: true,
      state: createEmptyMarks()
    };
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.version !== undefined &&
    parsed.version !== MARKS_VERSION
  ) {
    return {
      ok: false,
      error: MARKS_UNSUPPORTED,
      present: true,
      corrupt: true,
      state: createEmptyMarks()
    };
  }

  const state = normalizeMarks(parsed);
  if (!state) {
    return {
      ok: false,
      error: MARKS_BROKEN,
      present: true,
      corrupt: true,
      state: createEmptyMarks()
    };
  }
  return { ok: true, error: '', present: true, corrupt: false, state };
}

/**
 * 落盘标记。失败只返回错误，不抛出、不重试其他写入。
 */
function saveMarks(state) {
  try {
    wx.setStorageSync(MARKS_KEY, JSON.stringify(state));
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: MARKS_WRITE_FAILED + errorText(error) };
  }
}

// ---------------------------------------------------------------- 坐标换算
//
// 显示框里原图按 aspectFit（contain）摆放：等比缩放到刚好放进框内，短边方向留白。
// 标记按原图归一化保存，因此同一份标记在任意显示框里都能换回同一个原图位置。

function toPositive(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number;
}

/**
 * aspectFit 布局：把原图 (imageWidth × imageHeight) 等比装进显示框
 * (viewWidth × viewHeight)，返回缩放比、绘制尺寸与两侧留白偏移。
 */
function imageLayout(input) {
  const raw = input || {};
  const imageWidth = toPositive(raw.imageWidth);
  const imageHeight = toPositive(raw.imageHeight);
  const viewWidth = toPositive(raw.viewWidth);
  const viewHeight = toPositive(raw.viewHeight);
  if (!imageWidth || !imageHeight || !viewWidth || !viewHeight) {
    return { ok: false, error: '缺少原图或显示框尺寸，无法换算标记位置' };
  }
  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  return {
    ok: true,
    error: '',
    imageWidth,
    imageHeight,
    viewWidth,
    viewHeight,
    scale,
    drawWidth,
    drawHeight,
    // 留白偏移：横图在上下留白，竖图在左右留白。
    offsetX: (viewWidth - drawWidth) / 2,
    offsetY: (viewHeight - drawHeight) / 2
  };
}

/** 显示框内的点 → 原图归一化位置；落在留白上返回 null（不生成标记）。 */
function screenToImage(point, layout) {
  if (!point || !layout || !layout.ok) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const nx = (x - layout.offsetX) / layout.drawWidth;
  const ny = (y - layout.offsetY) / layout.drawHeight;
  if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
  return { x: nx, y: ny };
}

/** 原图归一化位置 → 显示框内的点。 */
function imageToScreen(point, layout) {
  if (!point || !layout || !layout.ok) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: layout.offsetX + x * layout.drawWidth,
    y: layout.offsetY + y * layout.drawHeight
  };
}

/** 原图归一化位置 → 原图像素位置（用于把标记与已知岩点像素对照）。 */
function originalPixelOf(point, imageInfo) {
  const size = imageSizeFromInfo(imageInfo);
  if (!size.ok || !point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x * size.width, y: y * size.height };
}

/** 归一化到 [0,1]，用于把点稳定地收在照片内。 */
function clampRelative(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function imageSizeFromInfo(info) {
  const raw = info || {};
  const width = toPositive(raw.width);
  const height = toPositive(raw.height);
  if (!width || !height) return { ok: false, error: '还没有读到照片尺寸' };
  return { ok: true, error: '', width, height };
}

function normalizeRect(rect) {
  const raw = rect || {};
  const left = Number(raw.left);
  const top = Number(raw.top);
  const width = toPositive(raw.width);
  const height = toPositive(raw.height);
  if (!Number.isFinite(left) || !Number.isFinite(top) || !width || !height) {
    return { ok: false, error: '还没有读到照片显示区域' };
  }
  return { ok: true, error: '', left, top, width, height };
}

/**
 * 从点击事件里取出触点坐标。
 *
 * 优先用触摸点的 clientX/clientY：微信里它与 boundingClientRect 同一坐标系
 * （相对可显示区域左上角），两者相减才是显示框内的位置。detail.x/y 相对文档，
 * 只在没有触摸点信息时兜底，避免在有滚动时把点位算偏。
 */
function pointFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const list = Array.isArray(event.changedTouches) && event.changedTouches.length
    ? event.changedTouches
    : Array.isArray(event.touches) && event.touches.length
      ? event.touches
      : null;
  if (list) {
    const touch = list[0] || {};
    const rawX = touch.clientX !== undefined ? touch.clientX : touch.pageX;
    const rawY = touch.clientY !== undefined ? touch.clientY : touch.pageY;
    const x = Number(rawX);
    const y = Number(rawY);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, source: 'touch' };
  }
  const detail = event.detail;
  if (detail && typeof detail === 'object') {
    const x = Number(detail.x);
    const y = Number(detail.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, source: 'detail' };
  }
  return null;
}

/**
 * 一次点击 → 原图归一化位置。页面把「显示框矩形 + 原图尺寸」交给这里，
 * 于是横图、竖图、两侧留白和换屏后的同一位置都由同一份换算决定。
 *
 * 返回 { ok, reason, error, point?, layout?, local? }。reason：
 *   no-point  没读到点击位置        no-image  没读到原图尺寸
 *   no-size   没读到显示框尺寸      letterbox 点在照片外的留白上（不生成标记）
 */
function markPointFromTap(event, rect, imageInfo) {
  const point = pointFromEvent(event);
  if (!point) {
    return { ok: false, reason: 'no-point', error: '没有读到点击位置，请再点一次' };
  }
  const size = imageSizeFromInfo(imageInfo);
  if (!size.ok) {
    return { ok: false, reason: 'no-image', error: '还没有读到照片尺寸，暂时不能标记' };
  }
  const box = normalizeRect(rect);
  if (!box.ok) {
    return { ok: false, reason: 'no-size', error: '还没有读到照片显示区域，请稍后再点' };
  }
  const layout = imageLayout({
    imageWidth: size.width,
    imageHeight: size.height,
    viewWidth: box.width,
    viewHeight: box.height
  });
  if (!layout.ok) {
    return { ok: false, reason: 'no-size', error: layout.error };
  }
  const local = { x: point.x - box.left, y: point.y - box.top };
  const relative = screenToImage(local, layout);
  if (!relative) {
    return {
      ok: false,
      reason: 'letterbox',
      error: '点在照片外的留白处，没有生成卡点',
      layout,
      local
    };
  }
  return {
    ok: true,
    reason: '',
    error: '',
    point: {
      x: clampRelative(relative.x),
      y: clampRelative(relative.y)
    },
    layout,
    local
  };
}

// ---------------------------------------------------------------- 读写
//
// 写入按「先读最新标记，再改这一条，然后落盘」同步完成。

function normalizeTarget(target) {
  const raw = target || {};
  if (!hasText(raw.archiveId) || !hasText(raw.routeId) || !hasText(raw.photoId)) return null;
  return { archiveId: raw.archiveId, routeId: raw.routeId, photoId: raw.photoId };
}

function normalizeKind(value) {
  return MARK_KINDS.indexOf(value) >= 0 ? value : '';
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MARK_TEXT_MAX);
}

function normalizePoint(x, y) {
  if (!isRelative(x) || !isRelative(y)) return null;
  return { x, y };
}

function compareMarks(left, right) {
  return left.seq - right.seq;
}

/**
 * 当前照片上的标记（只读，按序号升序）：档案、线路与照片三者都相同才算同一条。
 * 三者缺一即返回空数组——不能确认归属时宁可不显示，也不把标记落到别的线上。
 */
function marksForTarget(state, target) {
  const where = normalizeTarget(target);
  if (!where) return [];
  return ((state && state.marks) || [])
    .filter(
      mark =>
        mark.archiveId === where.archiveId &&
        mark.routeId === where.routeId &&
        mark.photoId === where.photoId
    )
    .sort(compareMarks)
    .map(clone);
}

/**
 * 同一条线路上、属于别的照片的标记数量：换图后旧标记不叠加到新照片上，
 * 但要能在界面上说明「另有 N 条属于这张线路的旧照片」，而不是无声消失。
 */
function countOtherPhotoMarks(state, target) {
  const raw = target || {};
  if (!hasText(raw.archiveId) || !hasText(raw.routeId) || !hasText(raw.photoId)) return 0;
  return ((state && state.marks) || []).filter(
    mark =>
      mark.archiveId === raw.archiveId &&
      mark.routeId === raw.routeId &&
      mark.photoId !== raw.photoId
  ).length;
}

/**
 * 读取当前照片上的标记（只读，不写盘）。返回
 * { ok, error, corrupt, present, marks, otherPhotoCount }。
 */
function listMarks(target) {
  const loaded = loadMarks();
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      corrupt: loaded.corrupt,
      present: loaded.present,
      marks: [],
      otherPhotoCount: 0
    };
  }
  return {
    ok: true,
    error: '',
    corrupt: false,
    present: loaded.present,
    marks: marksForTarget(loaded.state, target),
    otherPhotoCount: countOtherPhotoMarks(loaded.state, target)
  };
}

/** 按 markId 找一条（只读）。 */
function findMark(state, markId) {
  const id = hasText(markId) ? markId : '';
  return ((state && state.marks) || []).find(mark => mark.markId === id) || null;
}

/** 按客户端操作身份找一条（只读）：用于同一次落点重试时不重复新建。 */
function findMarkByOp(state, opId) {
  const id = hasText(opId) ? opId : '';
  if (!id) return null;
  return ((state && state.marks) || []).find(mark => mark.opId === id) || null;
}

/**
 * 新建一条卡点。
 *
 * 返回 { ok, code, error, mark, state }。code：
 *   added / duplicate（这条 opId 已经落盘，复用那一条，典型是写成功后回执丢失的重试）
 *   / invalid-target（缺档案/线路/照片）/ missing-photo / invalid-point
 *   / op-conflict（同一 opId 带着别的照片/线路归回来）/ unreadable / write-failed。
 * 落盘失败时序号不消耗：再点一次拿到的是同一个稳定 markId。
 */
function addMark(input) {
  const data = input || {};
  const where = normalizeTarget(data);
  if (!where) {
    return {
      ok: false,
      code: 'invalid-target',
      error: '缺少档案、线路或主照片标识，不能新建卡点',
      mark: null,
      state: createEmptyMarks()
    };
  }
  const point = normalizePoint(data.x, data.y);
  if (!point) {
    return {
      ok: false,
      code: 'invalid-point',
      error: '点的位置不在照片上，没有生成卡点',
      mark: null,
      state: createEmptyMarks()
    };
  }

  const loaded = loadMarks();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, mark: null, state: loaded.state };
  }

  // 同一个客户端操作身份：已经落盘就复用它（写成功但回执丢失的重试），不新建第二条。
  const opId = hasText(data.opId) ? data.opId : '';
  const persisted = opId ? findMarkByOp(loaded.state, opId) : null;
  if (persisted) {
    const sameTarget =
      persisted.archiveId === where.archiveId &&
      persisted.routeId === where.routeId &&
      persisted.photoId === where.photoId;
    if (sameTarget) {
      return {
        ok: true,
        code: 'duplicate',
        duplicate: true,
        error: '',
        mark: clone(persisted),
        state: loaded.state
      };
    }
    return {
      ok: false,
      code: 'op-conflict',
      error: '这次落点已经属于别的照片，没有重复保存',
      mark: null,
      state: loaded.state
    };
  }

  const kind = normalizeKind(data.kind) || DEFAULT_MARK_KIND;
  const at = timestamp(data.now);
  const next = clone(loaded.state);
  const seq = next.nextMarkSeq;
  const mark = {
    markId: 'mark-' + seq,
    seq,
    opId,
    archiveId: where.archiveId,
    routeId: where.routeId,
    photoId: where.photoId,
    kind,
    x: point.x,
    y: point.y,
    text: normalizeText(data.text),
    createdAt: at,
    updatedAt: at
  };
  next.nextMarkSeq = seq + 1;
  next.marks.push(mark);

  const saved = saveMarks(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, mark: null, state: loaded.state };
  }
  return { ok: true, code: 'added', error: '', mark: clone(mark), state: next };
}

/**
 * 修改一条卡点：改字、换手法/脚法，或移动位置。只改传进来的字段，
 * 归属（档案/线路/照片）、序号与创建时间都不变。
 *
 * 返回 { ok, code, error, mark, state }。code：
 *   updated / unchanged（这次的改动与现有值相同，幂等且不写盘）
 *   / missing（这条不存在，可能已被删除）/ invalid-point / invalid-kind
 *   / unreadable / write-failed。
 * 迟到回调或重复保存同一内容不会写第二次，也不会变成两条。
 */
function updateMark(input) {
  const data = input || {};
  const markId = hasText(data.markId) ? data.markId : '';

  const loaded = loadMarks();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, mark: null, state: loaded.state };
  }

  const existing = findMark(loaded.state, markId);
  if (!existing) {
    return {
      ok: false,
      code: 'missing',
      error: '这条卡点已经不在本机，可能已被删除',
      mark: null,
      state: loaded.state
    };
  }

  let point = null;
  if (data.x !== undefined || data.y !== undefined) {
    point = normalizePoint(data.x, data.y);
    if (!point) {
      return {
        ok: false,
        code: 'invalid-point',
        error: '新的位置不在照片上，位置没有改动',
        mark: null,
        state: loaded.state
      };
    }
  }

  let kind = '';
  if (data.kind !== undefined) {
    kind = normalizeKind(data.kind);
    if (!kind) {
      return {
        ok: false,
        code: 'invalid-kind',
        error: '手法/脚法取值不正确，没有改动',
        mark: null,
        state: loaded.state
      };
    }
  }

  const text = data.text === undefined ? existing.text : normalizeText(data.text);
  const nextPoint = point || { x: existing.x, y: existing.y };
  const nextKind = kind || existing.kind;
  const unchanged =
    nextPoint.x === existing.x &&
    nextPoint.y === existing.y &&
    nextKind === existing.kind &&
    text === existing.text;
  if (unchanged) {
    return {
      ok: true,
      code: 'unchanged',
      duplicate: true,
      error: '',
      mark: clone(existing),
      state: loaded.state
    };
  }

  const next = clone(loaded.state);
  const target = next.marks.find(mark => mark.markId === markId);
  target.x = nextPoint.x;
  target.y = nextPoint.y;
  target.kind = nextKind;
  target.text = text;
  target.updatedAt = timestamp(data.now);

  const saved = saveMarks(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, mark: null, state: loaded.state };
  }
  return { ok: true, code: 'updated', error: '', mark: clone(target), state: next };
}

/** 移动一条卡点：只改位置，文字与手法/脚法都不变。 */
function moveMark(input) {
  const data = input || {};
  return updateMark({
    markId: data.markId,
    x: data.x,
    y: data.y,
    now: data.now
  });
}

/**
 * 删除一条卡点：只删这一条，别的标记、照片与把次都不动。
 * 返回 { ok, code, error, removed, state }。code：
 *   removed / absent（本来就没有这一条，幂等且不写盘）/ unreadable / write-failed。
 */
function removeMark(markId) {
  const id = hasText(markId) ? markId : '';

  const loaded = loadMarks();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, removed: false, state: loaded.state };
  }

  const existing = findMark(loaded.state, id);
  if (!existing) {
    return { ok: true, code: 'absent', duplicate: true, error: '', removed: false, state: loaded.state };
  }

  const next = clone(loaded.state);
  next.marks = next.marks.filter(mark => mark.markId !== id);
  const saved = saveMarks(next);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, removed: false, state: loaded.state };
  }
  return { ok: true, code: 'removed', error: '', removed: true, state: next };
}

// ---------------------------------------------------------------- 展示
//
// 展示层只做「标记 + 当前布局 → 页面要渲染的行」，不读写存储、不改判定。

/**
 * 图上的标记行：序号、手法/脚法、文字与显示框内的像素位置。
 * 布局还没读到（layout.ok 为 false）时照常返回行，visible:false，由页面决定怎么提示。
 * options.draft 是「刚点下、还没保存」的草稿点；它只用于这次渲染，不落盘。
 */
function markPointsView(marks, layout, options) {
  const opts = options || {};
  const list = Array.isArray(marks) ? marks : [];
  const rows = list.map((mark, index) => {
    const screen = imageToScreen(mark, layout);
    return {
      markId: mark.markId,
      seq: mark.seq,
      index: index + 1,
      kind: mark.kind,
      kindText: MARK_KIND_TEXT[mark.kind] || '',
      text: mark.text,
      hasText: Boolean(mark.text),
      x: mark.x,
      y: mark.y,
      leftPx: screen ? screen.x : 0,
      topPx: screen ? screen.y : 0,
      visible: Boolean(screen),
      isSelected: opts.selectedMarkId === mark.markId,
      isMoving: opts.movingMarkId === mark.markId,
      isDraft: false
    };
  });

  const draft = opts.draft;
  if (draft && isRelative(draft.x) && isRelative(draft.y)) {
    const screen = imageToScreen(draft, layout);
    rows.push({
      markId: DRAFT_MARK_ID,
      seq: 0,
      index: rows.length + 1,
      kind: normalizeKind(draft.kind) || DEFAULT_MARK_KIND,
      kindText: MARK_KIND_TEXT[normalizeKind(draft.kind) || DEFAULT_MARK_KIND],
      text: typeof draft.text === 'string' ? draft.text : '',
      hasText: hasText(draft.text),
      x: draft.x,
      y: draft.y,
      leftPx: screen ? screen.x : 0,
      topPx: screen ? screen.y : 0,
      visible: Boolean(screen),
      isSelected: false,
      isMoving: false,
      isDraft: true
    });
  }
  return rows;
}

/**
 * 文字清单行：不依赖照片能不能显示，原图缺失或离线时也能读回已写的提示。
 */
function markListRows(marks) {
  return (Array.isArray(marks) ? marks : []).map((mark, index) => ({
    markId: mark.markId,
    seq: mark.seq,
    index: index + 1,
    kind: mark.kind,
    kindText: MARK_KIND_TEXT[mark.kind] || '',
    text: mark.text,
    hasText: Boolean(mark.text),
    textText: mark.text || '（还没写字）',
    createdAt: mark.createdAt,
    updatedAt: mark.updatedAt
  }));
}

function markCountText(marks) {
  const count = Array.isArray(marks) ? marks.length : 0;
  return count > 0 ? count + ' 条卡点' : '';
}

const MARK_KINDS_VIEW = MARK_KINDS.map(kind => ({ value: kind, text: MARK_KIND_TEXT[kind] }));

module.exports = {
  MARKS_KEY,
  MARKS_VERSION,
  MARKS_BROKEN,
  MARKS_UNSUPPORTED,
  MARKS_READ_FAILED,
  MARKS_WRITE_FAILED,
  MARK_KIND_FOOT,
  MARK_KIND_HAND,
  MARK_KINDS,
  MARK_KINDS_VIEW,
  MARK_KIND_TEXT,
  DEFAULT_MARK_KIND,
  MARK_TEXT_MAX,
  DRAFT_MARK_ID,
  createEmptyMarks,
  normalizeMarks,
  loadMarks,
  saveMarks,
  marksForTarget,
  countOtherPhotoMarks,
  listMarks,
  findMark,
  findMarkByOp,
  addMark,
  updateMark,
  moveMark,
  removeMark,
  imageLayout,
  screenToImage,
  imageToScreen,
  originalPixelOf,
  clampRelative,
  imageSizeFromInfo,
  normalizeRect,
  pointFromEvent,
  markPointFromTap,
  markPointsView,
  markListRows,
  markCountText
};
