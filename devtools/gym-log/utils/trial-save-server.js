/**
 * 弱网演练 · 本地模拟保存端（测试替身）
 *
 * 只服务于 devtools/gym-log 独立试用工程，不接云环境、不读正式记录：
 * - 账本写在单独缓存键里，与客户端的待确认操作分开；
 * - 以客户端操作 ID（opId）为幂等键：同一操作重复或并发提交只入账一次；
 * - 归属与线路类型只认试用数据里的权威线路和当前上下文：请求里的
 *   climbType / ownerId / datasetId 可以被省略或伪造，一律不参与判定；
 * - 重置世代不同（重置或切换数据集后复用同 opId/sessionId 的迟到旧请求）直接
 *   拒绝，不入账也不消费新数据的待确认与把次。
 * - 抱石（含缺 climbType 的旧 V 级线路）首次完攀只记一次：同一「试用用户 +
 *   当前数据集 + 长期线路 ID」已有完攀（账本记录、已确认把次或仍在待确认的
 *   完攀）时，不同操作 ID 的新结果（完攀或未完成）都不再入账；
 * - 可显式设置“下一次保存丢失回执”：先把记录写进账本，再向客户端返回失败，
 *   用来模拟保存端已入账、客户端却没收到确认的真实弱网情况。
 *
 * 正式服务端由账号与线路档案裁决归属和类型；这里以本机试用数据代替那份权威，
 * 客户端的声明不是凭据。账本是本机存储，不代表真实服务端事务；
 * 跨设备、权限与真实并发仍待验。
 */
const routeRules = require('./route-rules.js');
const store = require('./store.js');
const trialProfile = require('./trial-profile.js');

const LEDGER_KEY = 'climbingNote.gymLogTrial.saveLedger.v1';
const LEDGER_VERSION = 1;

const LEDGER_BROKEN = '模拟保存账本格式损坏，请重置本地试用数据';
const LEDGER_WRITE_FAILED = '模拟保存账本写入失败：';
const ALREADY_SENT = '该抱石线路已完攀，不能重复入账';
const PENDING_SEND = '该抱石线路的完攀还在待确认，请先处理原把次';
const OP_ID_CONFLICT =
  '操作 ID 已被其他线路或归属使用，请重置本地试用数据后再试';
const STATE_UNREADABLE = '本地试用数据不可读，暂时无法确认线路归属：';
const STALE_CONTEXT =
  '这条保存来自已重置或已切换的试用数据（编号会被新数据复用），不再入账';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function createEmptyLedger() {
  return {
    version: LEDGER_VERSION,
    records: [],
    loseNextReceipt: false
  };
}

function isRecord(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    hasText(value.opId) &&
    hasText(value.sessionId) &&
    hasText(value.routeId) &&
    (value.result === 'fail' || value.result === 'send') &&
    typeof value.note === 'string' &&
    hasText(value.receivedAt) &&
    // 归属与类型是后加的字段：旧账本没有它们时仍按可读处理，不判定损坏。
    (value.climbType === undefined || typeof value.climbType === 'string') &&
    (value.ownerId === undefined || typeof value.ownerId === 'string') &&
    (value.datasetId === undefined || typeof value.datasetId === 'string') &&
    (value.generation === undefined || typeof value.generation === 'string')
  );
}

/**
 * 只接受当前版本、结构完整的账本；损坏时不静默重建，避免把已入账记录当没发生。
 */
function normalizeLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== LEDGER_VERSION) return null;
  if (!Array.isArray(raw.records) || !raw.records.every(isRecord)) return null;

  const opIds = new Set(raw.records.map(record => record.opId));
  if (opIds.size !== raw.records.length) return null;

  return {
    version: LEDGER_VERSION,
    records: raw.records,
    loseNextReceipt: raw.loseNextReceipt === true
  };
}

function loadLedger() {
  let raw;
  try {
    raw = wx.getStorageSync(LEDGER_KEY);
  } catch (error) {
    return {
      ledger: createEmptyLedger(),
      error: '读取模拟保存账本失败：' + errorText(error)
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { ledger: createEmptyLedger(), error: '' };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { ledger: createEmptyLedger(), error: LEDGER_BROKEN };
  }

  const ledger = normalizeLedger(parsed);
  if (!ledger) return { ledger: createEmptyLedger(), error: LEDGER_BROKEN };
  return { ledger, error: '' };
}

function saveLedger(ledger) {
  try {
    wx.setStorageSync(LEDGER_KEY, JSON.stringify(ledger));
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: LEDGER_WRITE_FAILED + errorText(error) };
  }
}

function operationError(operation) {
  if (!operation || typeof operation !== 'object') return '保存请求为空';
  if (!hasText(operation.opId)) return '保存请求缺少操作 ID';
  if (!hasText(operation.sessionId)) return '保存请求缺少场次归属';
  if (!hasText(operation.routeId)) return '保存请求缺少线路归属';
  if (operation.result !== 'fail' && operation.result !== 'send') {
    return '保存请求的结果无效';
  }
  return '';
}

/**
 * 账本记录的归属：带新字段的记录按自己的字段比对；旧账本没有 ownerId/datasetId，
 * 按当前上下文读取——它能照样阻止同一线路的重复入账，也不会被别的归属牵连。
 */
function recordOwnership(record, ownership) {
  return {
    ownerId: hasText(record.ownerId) ? record.ownerId : ownership.ownerId,
    datasetId: hasText(record.datasetId)
      ? record.datasetId
      : ownership.datasetId,
    routeId: record.routeId
  };
}

/**
 * 一条账本记录是否属于这次保存的同一归属（用户 + 数据集 + 长期线路 ID）。
 */
function isSameOperationScope(record, ownership) {
  return routeRules.isSameSendOwner(
    recordOwnership(record, ownership),
    ownership
  );
}

function findLedgerSend(ledger, ownership) {
  const found = ledger.records.find(
    record =>
      record.result === 'send' && isSameOperationScope(record, ownership)
  );
  return found || null;
}

/**
 * 权威保存上下文：线路类型、归属与完攀证据都从试用数据与当前上下文取，
 * 不看请求里可省略或可伪造的 climbType / ownerId / datasetId。
 * - 线路：按 routeId 在试用数据的线路表里查，类型以线路自身的 climbType 为准
 *   （缺字段的旧 V 级线路按抱石读取）；试用数据里没有这条线路时无从判定类型，
 *   只按操作 ID 幂等，不加抱石规则；
 * - 归属：当前本机试用用户 + 当前数据集 + 长期线路 ID；
 * - 完攀证据：试用数据里已确认完攀的把次，以及这条线路仍在待确认的完攀
 *   （别的操作 ID，即还没确认的另一把）。
 * 试用数据不可读时返回错误，不靠请求声明继续入账。
 */
function resolveSaveContext(operation) {
  const loaded = store.loadState();
  if (loaded.error) {
    return { error: STATE_UNREADABLE + loaded.error };
  }

  const state = loaded.state;
  const route =
    state.routes.find(item => item.id === operation.routeId) || null;
  const ownership = {
    ownerId: trialProfile.TRIAL_OWNER_ID,
    datasetId: state.datasetId,
    routeId: operation.routeId
  };
  const isBoulder = Boolean(route) && routeRules.isBoulderRoute(route);

  return {
    error: '',
    route,
    isBoulder,
    ownership,
    // 当前编号空间的世代：用来识别重置/切换后复用同编号的迟到旧请求。
    generation: hasText(state.generation) ? state.generation : '',
    // 记录里存权威线路的类型，作为排查线索；判定不读这个字段。
    climbType: route ? routeRules.climbTypeOf(route) : '',
    confirmedSend: isBoulder
      ? (state.attempts || []).some(
          item => item.routeId === operation.routeId && item.result === 'send'
        )
      : false,
    pendingSend: isBoulder
      ? (state.pendingSaves || []).some(
          item =>
            item.routeId === operation.routeId &&
            item.result === 'send' &&
            item.opId !== operation.opId
        )
      : false
  };
}

/**
 * 幂等提交一次尝试。
 *
 * 返回：
 * - { ok: true, duplicate: false } 首次入账
 * - { ok: true, duplicate: true }  同一 opId、同一线路同一归属已入账，复用原记录
 * - { ok: false, alreadySent: true } 同一归属的抱石线路已有完攀，本条不入账
 * - { ok: false, pendingSend: true } 同一线路的完攀还在待确认，本条不入账
 * - { ok: false, opIdConflict: true } 该 opId 已用于别的线路或别的归属，不能给出确认
 * - { ok: false, stale: true }      来自已重置/已切换的旧编号空间，不入账也不动新数据
 * - { ok: false, receiptLost: true } 已入账，但本次回执按演练设置丢失
 * - { ok: false, error }           没有入账（校验失败、账本损坏、数据不可读或写入失败）
 */
function submitOperation(operation) {
  const invalid = operationError(operation);
  if (invalid) return { ok: false, error: invalid };

  const loaded = loadLedger();
  if (loaded.error) return { ok: false, error: loaded.error };

  const ledger = loaded.ledger;
  const context = resolveSaveContext(operation);
  if (context.error) return { ok: false, error: context.error };

  // 重置或切换试用数据后到达的旧请求：新数据会从头发放 opId/sessionId，
  // 同 opId、同线路、同场次都可能被复用，但世代不同，说明它属于已被换掉的编号空间。
  // 一律不入账——也不参与下面的操作 ID 幂等，避免拿新数据的记录当旧请求的确认，
  // 更不能消费、删除或覆盖新的待确认与把次。旧请求不带世代时按原行为兼容处理。
  if (
    hasText(operation.generation) &&
    hasText(context.generation) &&
    operation.generation !== context.generation
  ) {
    return { ok: false, stale: true, error: STALE_CONTEXT };
  }

  // 幂等只覆盖「同一条线路、同一归属」的原操作：被复制到别的线路或别的归属时
  // 不能拿旧记录当确认，否则客户端会以为这一把已经保存。
  const existing = ledger.records.find(
    record => record.opId === operation.opId
  );
  if (existing) {
    if (!isSameOperationScope(existing, context.ownership)) {
      return { ok: false, opIdConflict: true, error: OP_ID_CONFLICT };
    }
    return { ok: true, duplicate: true, record: clone(existing) };
  }

  // 抱石首次完攀：账本里的完攀、试用数据里已确认的完攀，以及还没确认的完攀
  // 都算这条线已经有完攀，任何新操作 ID 的完攀或未完成都不再入账。
  if (context.isBoulder) {
    const recorded = findLedgerSend(ledger, context.ownership);
    if (recorded) {
      return {
        ok: false,
        alreadySent: true,
        record: clone(recorded),
        error: ALREADY_SENT
      };
    }
    if (context.confirmedSend) {
      return { ok: false, alreadySent: true, error: ALREADY_SENT };
    }
    if (context.pendingSend) {
      return { ok: false, pendingSend: true, error: PENDING_SEND };
    }
  }

  const record = {
    opId: operation.opId,
    sessionId: operation.sessionId,
    routeId: operation.routeId,
    result: operation.result,
    note: typeof operation.note === 'string' ? operation.note : '',
    receivedAt: new Date().toISOString(),
    // 归属与类型取权威上下文，不照抄请求里的声明。
    climbType: context.climbType,
    ownerId: context.ownership.ownerId,
    datasetId: context.ownership.datasetId,
    // 记录属于哪一次编号空间，作为排查线索；判定不读这个字段。
    generation: context.generation
  };
  ledger.records.push(record);

  // 注入只作用于这一次保存：账本先落盘，随后才丢掉回执。
  const losesReceipt = ledger.loseNextReceipt === true;
  if (losesReceipt) ledger.loseNextReceipt = false;

  const saved = saveLedger(ledger);
  if (!saved.ok) {
    // 写入失败时账本没有变化，注入标记也不会被消耗。
    return { ok: false, error: saved.error };
  }

  if (losesReceipt) {
    return {
      ok: false,
      receiptLost: true,
      record: clone(record),
      error: '模拟回执丢失：保存端账本已入账，但客户端没有收到确认'
    };
  }

  return { ok: true, duplicate: false, record: clone(record) };
}

function armReceiptLoss() {
  const loaded = loadLedger();
  if (loaded.error) return { ok: false, error: loaded.error };

  const ledger = loaded.ledger;
  ledger.loseNextReceipt = true;
  return saveLedger(ledger);
}

function disarmReceiptLoss() {
  const loaded = loadLedger();
  if (loaded.error) return { ok: false, error: loaded.error };

  const ledger = loaded.ledger;
  ledger.loseNextReceipt = false;
  return saveLedger(ledger);
}

function readReceiptLossArm() {
  const loaded = loadLedger();
  return {
    armed: !loaded.error && loaded.ledger.loseNextReceipt === true,
    error: loaded.error
  };
}

/**
 * 重置本地试用数据时一并清空模拟账本，避免序号从头开始后与旧账本撞键，
 * 把新尝试误判成重复操作。
 */
function resetLedger() {
  return saveLedger(createEmptyLedger());
}

/**
 * 重置失败时恢复重置前的账本原文，避免客户端状态还在、账本却已被清空。
 * raw 为空表示原本没有账本；恢复失败只返回错误，不重试其他写入。
 */
function restoreLedger(raw) {
  try {
    if (raw === undefined || raw === null || raw === '') {
      wx.removeStorageSync(LEDGER_KEY);
      return { ok: true, error: '' };
    }
    wx.setStorageSync(LEDGER_KEY, raw);
    return { ok: true, error: '' };
  } catch (error) {
    return {
      ok: false,
      error: '恢复模拟保存账本失败：' + errorText(error)
    };
  }
}

module.exports = {
  LEDGER_KEY,
  LEDGER_VERSION,
  LEDGER_BROKEN,
  ALREADY_SENT,
  PENDING_SEND,
  OP_ID_CONFLICT,
  STALE_CONTEXT,
  createEmptyLedger,
  normalizeLedger,
  loadLedger,
  saveLedger,
  submitOperation,
  armReceiptLoss,
  disarmReceiptLoss,
  readReceiptLossArm,
  resetLedger,
  restoreLedger
};
