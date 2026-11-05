/**
 * 弱网演练 · 本地模拟保存端（测试替身）
 *
 * 只服务于 devtools/gym-log 独立试用工程，不接云环境、不读正式记录：
 * - 账本写在单独缓存键里，与客户端的待确认操作分开；
 * - 以客户端操作 ID（opId）为幂等键：同一操作重复或并发提交只入账一次；
 * - 可显式设置“下一次保存丢失回执”：先把记录写进账本，再向客户端返回失败，
 *   用来模拟保存端已入账、客户端却没收到确认的真实弱网情况。
 *
 * 账本是本机存储，不代表真实服务端事务；跨设备、权限与真实并发仍待验。
 */
const LEDGER_KEY = 'climbingNote.gymLogTrial.saveLedger.v1';
const LEDGER_VERSION = 1;

const LEDGER_BROKEN = '模拟保存账本格式损坏，请重置本地试用数据';
const LEDGER_WRITE_FAILED = '模拟保存账本写入失败：';

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
    hasText(value.receivedAt)
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
 * 幂等提交一次尝试。
 *
 * 返回：
 * - { ok: true, duplicate: false } 首次入账
 * - { ok: true, duplicate: true }  同一 opId 已入账，直接复用原记录
 * - { ok: false, receiptLost: true } 已入账，但本次回执按演练设置丢失
 * - { ok: false, error }           没有入账（校验失败、账本损坏或写入失败）
 */
function submitOperation(operation) {
  const invalid = operationError(operation);
  if (invalid) return { ok: false, error: invalid };

  const loaded = loadLedger();
  if (loaded.error) return { ok: false, error: loaded.error };

  const ledger = loaded.ledger;
  const existing = ledger.records.find(
    record => record.opId === operation.opId
  );
  if (existing) {
    return { ok: true, duplicate: true, record: clone(existing) };
  }

  const record = {
    opId: operation.opId,
    sessionId: operation.sessionId,
    routeId: operation.routeId,
    result: operation.result,
    note: typeof operation.note === 'string' ? operation.note : '',
    receivedAt: new Date().toISOString()
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

module.exports = {
  LEDGER_KEY,
  LEDGER_VERSION,
  LEDGER_BROKEN,
  createEmptyLedger,
  normalizeLedger,
  loadLedger,
  saveLedger,
  submitOperation,
  armReceiptLoss,
  disarmReceiptLoss,
  readReceiptLossArm,
  resetLedger
};
