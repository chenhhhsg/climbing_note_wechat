/**
 * T051 整场删除的档案层回归测试
 *
 * 用隔离的微信本地存储替身驱动真实 utils/training-store.js：
 * 覆盖目标场次与本场关联/全部把次（含已撤回）的一次写入移出、同日同馆接续、
 * 同日不同馆与跨日保留、当前/非当前场、编号补号、原 ID 与单调计数器、
 * 等数量内容变化的过期确认、持久待办阻塞、写前失败/回执丢失/重读失败的确认语义，
 * 以及重复确认和带原场次 ID 的迟到保存不能复活记录。
 *
 * 媒体引用、视频副本与页面交互不在本文件（T052/T053）；这里只用档案层与只读小结投影。
 *
 * 运行：node --test tests/training-session-delete-store.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const D1 = '2026-11-09';
const D2 = '2026-11-10';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入故障 ----
const storage = new Map();
const fault = {
  setFailAt: 0,
  setCount: 0,
  loseResponseAt: 0,
  getFailAt: 0,
  getCount: 0
};

function resetStorage() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
  fault.getFailAt = 0;
  fault.getCount = 0;
}

global.wx = {
  getStorageSync(key) {
    fault.getCount += 1;
    if (fault.getFailAt && fault.getCount === fault.getFailAt) {
      throw new Error('getStorageSync:fail injected at call ' + fault.getCount);
    }
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    storage.set(key, value);
    // 写成功之后才失败：键里已是新档案，但调用方只看到失败。
    if (fault.loseResponseAt && fault.setCount === fault.loseResponseAt) {
      throw new Error('setStorageSync:fail after durable write injected');
    }
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  }
};

const store = require(STORE_JS);
const summary = require(SUMMARY_JS);

function storedArchive() {
  const raw = storage.get(ARCHIVE_KEY);
  return raw === undefined ? null : JSON.parse(raw);
}

function writeRawArchive(archive) {
  storage.set(ARCHIVE_KEY, JSON.stringify(archive));
}

function startTraining(gymName, date, now) {
  const started = store.startSession({ gymName, date, now });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function addRoute(sessionId, name, climbType, grade) {
  const created = store.createRoute({ sessionId, name, climbType, grade });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function addAttempt(sessionId, routeId, result, note) {
  const saved = store.saveAttempt({ sessionId, routeId, result, note });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

/**
 * 隔离合成档案：
 *   session-1 A 馆 D1（目标）：两条线、四条把次，其中第二把完攀已撤回；
 *   session-2 B 馆 D1（同日不同馆）；
 *   session-3 A 馆 D1（同日同馆后一场，与 session-1 复用 route-1）；
 *   session-4 A 馆 D2（上一日/跨日）。
 * 全局内部 seq 按启动顺序单调递增，原 ID 在后几场里不被复用。
 */
function seedFixture() {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 9, 8, 0));
  const r1 = addRoute(s1.id, 'A顶绳线', '顶绳', '5.10a');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '第一把');
  const a2 = addAttempt(s1.id, r1.id, 'send', '第二把');
  const a3 = addAttempt(s1.id, r1.id, 'send', '第三把');
  const r2 = addRoute(s1.id, 'A抱石线', '抱石', 'V3');
  const a4 = addAttempt(s1.id, r2.id, 'fail', '第四把');

  const s2 = startTraining('B馆', D1, new Date(2026, 10, 9, 9, 0));
  const r3 = addRoute(s2.id, 'B抱石线', '抱石', 'V2');
  const a5 = addAttempt(s2.id, r3.id, 'send', 'B馆完攀');

  const s3 = startTraining('A馆', D1, new Date(2026, 10, 9, 10, 0));
  const r4 = addRoute(s3.id, 'A第二场抱石', '抱石', 'V4');
  // 两条场次复用同一条长期线路：saveAttempt 会幂等补上 session-3 → route-1 的关联。
  const a6 = addAttempt(s3.id, r1.id, 'fail', '共享线路');
  const a7 = addAttempt(s3.id, r4.id, 'send', '第二场完攀');

  const s4 = startTraining('A馆', D2, new Date(2026, 10, 10, 8, 0));
  const r5 = addRoute(s4.id, '次日抱石', '抱石', 'V1');
  const a8 = addAttempt(s4.id, r5.id, 'fail', '次日');

  const undone = store.undoAttempt(a2.id, { sessionId: s1.id, routeId: r1.id });
  assert.equal(undone.ok, true, undone.error);

  const archive = storedArchive();
  return {
    archiveId: archive.archiveId,
    s1,
    s2,
    s3,
    s4,
    r1,
    r2,
    r3,
    r4,
    r5,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8
  };
}

function byId(items, id) {
  return items.find(item => item.id === id) || null;
}

beforeEach(() => {
  resetStorage();
});

// ------------------------------------------------------------------ *
// 只读确认快照
// ------------------------------------------------------------------ *

test('T051 快照按原档案与原场次给出日期、岩馆、场次、线路和全部把次（含已撤回）', () => {
  const f = seedFixture();
  store.selectSession(f.s1.id);
  fault.setCount = 0;
  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });

  assert.equal(inspected.ok, true);
  assert.equal(inspected.code, 'ready');
  assert.equal(inspected.present, true);
  assert.equal(inspected.canDelete, true);
  assert.equal(inspected.pending.total, 0);
  assert.match(inspected.snapshot.token, /^[0-9a-f]{16}$/);

  assert.equal(inspected.target.sessionId, f.s1.id);
  assert.equal(inspected.target.date, D1);
  assert.equal(inspected.target.gymId, f.r1.gymId);
  assert.equal(inspected.target.gymName, 'A馆');
  assert.equal(inspected.target.seq, f.s1.seq);
  // 同日编号跨岩馆统一计算：session-1 是当日第 1 场。
  assert.equal(inspected.target.label, '第 1 场');
  assert.equal(inspected.target.isActive, true);

  assert.equal(inspected.snapshot.routeCount, 2);
  assert.deepEqual(inspected.snapshot.routeIds.slice().sort(), [f.r1.id, f.r2.id].sort());
  assert.equal(inspected.snapshot.attemptCount, 4);
  assert.equal(inspected.snapshot.effectiveAttemptCount, 3);
  assert.equal(inspected.snapshot.undoneAttemptCount, 1);
  assert.equal(inspected.snapshot.sendCount, 1);
  assert.deepEqual(
    inspected.snapshot.attemptIds.slice().sort(),
    [f.a1.id, f.a2.id, f.a3.id, f.a4.id].sort()
  );

  // 只读：快照不落盘。
  assert.equal(fault.setCount, 0);
});

test('T051 快照缺失、档案 ID 不符或目标消失都有独立可判别结果', () => {
  const f = seedFixture();
  fault.setCount = 0;

  const incomplete = store.inspectSessionDeletion({ archiveId: f.archiveId });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'incomplete-request');

  const mismatch = store.inspectSessionDeletion({
    archiveId: 'archive-other',
    sessionId: f.s1.id
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'archive-mismatch');
  assert.equal(fault.setCount, 0);

  const missing = store.inspectSessionDeletion({ archiveId: f.archiveId, sessionId: 'session-404' });
  assert.equal(missing.ok, true);
  assert.equal(missing.code, 'missing');
  assert.equal(missing.present, false);
  assert.equal(missing.canDelete, false);
  assert.equal(missing.cleanlyAbsent, true);
  assert.equal(fault.setCount, 0);
});

// ------------------------------------------------------------------ *
// 一次提交：精确移出与接续
// ------------------------------------------------------------------ *

test('T051 删除当前场只移出目标场次、本场关联和全部把次，接续同日同馆最近一场', () => {
  const f = seedFixture();
  // 当前选择落在目标场次，并选一条只属于该场的线路（route-2），用于核对失效指针清理。
  store.selectSession(f.s1.id);
  store.selectRoute(f.r2.id);
  const before = storedArchive();
  const photoIndex = '{"version":1,"keep":["route-1","route-2"]}';
  storage.set(PHOTO_KEY, photoIndex);

  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  assert.equal(inspected.code, 'ready');

  fault.setCount = 0;
  const result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });

  // 成功只写一次档案。
  assert.equal(fault.setCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'removed');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.written, true);
  assert.equal(result.removed, true);
  assert.equal(result.receiptLost, false);
  assert.equal(result.unknown, false);
  assert.deepEqual(
    result.removedAttemptIds.slice().sort(),
    [f.a1.id, f.a2.id, f.a3.id, f.a4.id].sort()
  );
  assert.deepEqual(result.removedRouteIds.slice().sort(), [f.r1.id, f.r2.id].sort());
  assert.equal(result.successor.id, f.s3.id);
  assert.equal(result.activeSessionId, f.s3.id);
  // route-2 只属于被删场次：接续场不含它，线路指针清空。
  assert.equal(result.activeRouteId, '');

  const after = storedArchive();
  // 场次：目标消失，其他原 ID 与内部 seq 保持原值。
  assert.deepEqual(
    after.sessions.map(item => ({ id: item.id, seq: item.seq })),
    [
      { id: f.s2.id, seq: f.s2.seq },
      { id: f.s3.id, seq: f.s3.seq },
      { id: f.s4.id, seq: f.s4.seq }
    ]
  );
  // 目标场的关联与全部把次（含已撤回）移出；其他场次关联/把次一个字段都不动。
  assert.equal(after.sessionRoutes.some(link => link.sessionId === f.s1.id), false);
  assert.equal(after.attempts.some(item => item.sessionId === f.s1.id), false);
  assert.deepEqual(
    after.sessionRoutes.filter(link => link.sessionId === f.s3.id),
    before.sessionRoutes.filter(link => link.sessionId === f.s3.id)
  );
  assert.deepEqual(
    after.attempts.filter(item => item.sessionId !== f.s1.id),
    before.attempts.filter(item => item.sessionId !== f.s1.id)
  );
  // 同日不同馆与跨日场次原样保留。
  assert.deepEqual(byId(after.sessions, f.s2.id), byId(before.sessions, f.s2.id));
  assert.deepEqual(byId(after.sessions, f.s4.id), byId(before.sessions, f.s4.id));
  assert.deepEqual(after.attempts.filter(item => item.sessionId === f.s2.id), [
    before.attempts.find(item => item.id === f.a5.id)
  ]);
  // 长期线路、岩馆、照片索引与单调计数器都不动。
  assert.deepEqual(after.routes, before.routes);
  assert.deepEqual(after.gyms, before.gyms);
  assert.equal(storage.get(PHOTO_KEY), photoIndex);
  assert.equal(after.nextGymSeq, before.nextGymSeq);
  assert.equal(after.nextSessionSeq, before.nextSessionSeq);
  assert.equal(after.nextRouteSeq, before.nextRouteSeq);
  assert.equal(after.nextAttemptSeq, before.nextAttemptSeq);

  // 同日显示编号按既有规则补号，其他 ID/seq 不变；跨日仍从第 1 场起。
  const rows = {};
  summary.buildSessionList(after).days.forEach(day => {
    day.gyms.forEach(group => {
      group.sessions.forEach(row => {
        rows[row.id] = row;
      });
    });
  });
  assert.equal(rows[f.s1.id], undefined);
  assert.equal(rows[f.s2.id].label, '第 1 场');
  assert.equal(rows[f.s3.id].label, '第 2 场');
  assert.equal(rows[f.s4.id].label, '第 1 场');
  assert.equal(rows[f.s2.id].seq, f.s2.seq);
  assert.equal(rows[f.s3.id].seq, f.s3.seq);

  // 只读投影同步扣除目标场：共享线路只剩接续场那一把。
  const session3 = summary.buildSessionSummary(after, f.s3.id);
  assert.equal(session3.attemptCount, 2);
  assert.equal(session3.routeCount, 2);
  const history = store.routeHistory(after, f.r1.id);
  assert.equal(history.sessionCount, 1);
  assert.equal(history.groups[0].sessionId, f.s3.id);
  assert.equal(history.attemptCount, 1);
  assert.ok(store.routesWithHistory(after).some(row => row.id === f.r1.id));
});

test('T051 删除当前场时，接续场仍关联原线路则保留线路指针', () => {
  const f = seedFixture();
  store.selectSession(f.s1.id);
  // route-1 同时关联 session-1 与 session-3；删除 session-1 后接续到 session-3，指针仍有效。
  store.selectRoute(f.r1.id);
  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  const result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.activeSessionId, f.s3.id);
  assert.equal(result.activeRouteId, f.r1.id);
  assert.equal(
    storedArchive().sessionRoutes.some(
      link => link.sessionId === f.s3.id && link.routeId === f.r1.id
    ),
    true
  );
});

test('T051 删除非当前场保留原当前选择，其他场次与把次保持原值', () => {
  const f = seedFixture();
  store.selectSession(f.s2.id);
  store.selectRoute(f.r3.id);
  const before = storedArchive();

  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s3.id
  });
  const result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s3.id,
    snapshot: inspected.snapshot.token
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.code, 'removed');
  assert.equal(result.successor, null);
  assert.equal(result.activeSessionId, f.s2.id);
  assert.equal(result.activeRouteId, f.r3.id);

  const after = storedArchive();
  assert.equal(after.activeSessionId, f.s2.id);
  assert.equal(after.activeRouteId, f.r3.id);
  assert.deepEqual(byId(after.sessions, f.s1.id), byId(before.sessions, f.s1.id));
  assert.deepEqual(byId(after.sessions, f.s2.id), byId(before.sessions, f.s2.id));
  assert.deepEqual(
    after.attempts.filter(item => item.sessionId === f.s1.id),
    before.attempts.filter(item => item.sessionId === f.s1.id)
  );
  assert.equal(after.attempts.some(item => item.sessionId === f.s3.id), false);
  // 共享线路在 session-1 的关联不受影响。
  assert.equal(
    after.sessionRoutes.some(
      link => link.sessionId === f.s1.id && link.routeId === f.r1.id
    ),
    true
  );
  assert.equal(
    after.sessionRoutes.some(link => link.sessionId === f.s3.id),
    false
  );
});

test('T051 删除最后一场清空当前选择，之后新建使用新的场次 ID', () => {
  resetStorage();
  const s1 = startTraining('独馆', D1, new Date(2026, 10, 9, 8, 0));
  const r1 = addRoute(s1.id, '唯一线路', '抱石', 'V2');
  const archiveId = storedArchive().archiveId;

  const first = store.inspectSessionDeletion({ archiveId, sessionId: s1.id });
  assert.equal(first.snapshot.routeCount, 1);
  assert.equal(first.snapshot.attemptCount, 0);
  const removed = store.commitSessionDeletion({
    archiveId,
    sessionId: s1.id,
    snapshot: first.snapshot
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.activeSessionId, '');
  assert.equal(removed.activeRouteId, '');
  assert.equal(removed.successor, null);

  const emptyArchive = storedArchive();
  assert.equal(emptyArchive.sessions.length, 0);
  assert.equal(emptyArchive.sessionRoutes.length, 0);
  // 长期线路保留，不被当作场次数据清理。
  assert.ok(byId(emptyArchive.routes, r1.id));
  assert.equal(emptyArchive.nextSessionSeq, s1.seq + 1);

  const s2 = startTraining('独馆', D1, new Date(2026, 10, 9, 9, 0));
  assert.equal(s2.id, 'session-2');
  assert.notEqual(s2.id, s1.id);
  assert.equal(s2.seq, s1.seq + 1);

  // 空场（无线路、无把次）也能确认并删除。
  const emptyInspect = store.inspectSessionDeletion({ archiveId, sessionId: s2.id });
  assert.equal(emptyInspect.snapshot.routeCount, 0);
  assert.equal(emptyInspect.snapshot.attemptCount, 0);
  const emptyRemoved = store.commitSessionDeletion({
    archiveId,
    sessionId: s2.id,
    snapshot: emptyInspect.snapshot
  });
  assert.equal(emptyRemoved.ok, true, emptyRemoved.error);
  assert.equal(emptyRemoved.activeSessionId, '');

  const s3 = startTraining('独馆', D1, new Date(2026, 10, 9, 10, 0));
  assert.equal(s3.id, 'session-3');
  assert.equal(s3.seq, s2.seq + 1);
  assert.equal(store.sessionLabel(storedArchive(), s3), '第 1 场');
});

// ------------------------------------------------------------------ *
// 过期确认：数量不变但内容变化
// ------------------------------------------------------------------ *

test('T051 把数不变的备注、结果、原把、撤回标记或换线变化都要求重新确认', () => {
  const scenarios = [
    {
      name: '备注',
      mutate(raw, f) {
        raw.attempts.find(item => item.id === f.a1.id).note = '改过的备注';
      }
    },
    {
      name: '结果',
      mutate(raw, f) {
        const target = raw.attempts.find(item => item.id === f.a1.id);
        target.result = target.result === 'fail' ? 'send' : 'fail';
      }
    },
    {
      name: '原把 ID',
      mutate(raw, f) {
        raw.attempts.find(item => item.id === f.a1.id).id = 'op-replaced-same-count';
      }
    },
    {
      name: '撤回标记',
      mutate(raw, f) {
        const target = raw.attempts.find(item => item.id === f.a3.id);
        target.undoneAt = '2026-11-09T12:00:00.000Z';
        target.rev = (target.rev || 0) + 1;
      }
    },
    {
      name: '场内线路',
      mutate(raw, f) {
        const link = raw.sessionRoutes.find(
          item => item.sessionId === f.s1.id && item.routeId === f.r2.id
        );
        link.routeId = f.r5.id;
      }
    }
  ];

  scenarios.forEach(scenario => {
    resetStorage();
    const f = seedFixture();
    const inspected = store.inspectSessionDeletion({
      archiveId: f.archiveId,
      sessionId: f.s1.id
    });
    assert.equal(inspected.code, 'ready', scenario.name);

    const raw = storedArchive();
    scenario.mutate(raw, f);
    writeRawArchive(raw);
    const changed = JSON.stringify(raw);

    fault.setCount = 0;
    const result = store.commitSessionDeletion({
      archiveId: f.archiveId,
      sessionId: f.s1.id,
      snapshot: inspected.snapshot
    });

    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.code, 'stale', scenario.name);
    assert.equal(result.written, false, scenario.name);
    assert.equal(result.removed, false, scenario.name);
    assert.equal(result.unknown, false, scenario.name);
    assert.equal(fault.setCount, 0, scenario.name);
    assert.equal(JSON.stringify(storedArchive()), changed, scenario.name);
    assert.ok(
      storedArchive().sessions.some(item => item.id === f.s1.id),
      scenario.name
    );
  });
});

// ------------------------------------------------------------------ *
// 持久待办阻塞
// ------------------------------------------------------------------ *

test('T051 本场有持久待办时拒绝删除并给出可操作提示', () => {
  const cases = [
    {
      name: '待保存',
      add(raw, f) {
        raw.pendingSaves.push({
          opId: 'op-pending-save',
          seq: raw.nextAttemptSeq,
          sessionId: f.s1.id,
          routeId: f.r1.id,
          result: 'fail',
          note: '',
          createdAt: '2026-11-09T08:30:00.000Z'
        });
      },
      category: 'saves'
    },
    {
      name: '更正',
      add(raw, f) {
        raw.pendingCorrections.push({
          attemptId: f.a3.id,
          sessionId: f.s1.id,
          routeId: f.r1.id,
          createdAt: '2026-11-09T08:30:00.000Z'
        });
      },
      category: 'corrections'
    },
    {
      name: '撤回',
      add(raw, f) {
        raw.pendingUndos.push({
          opId: 'op-pending-undo',
          attemptId: f.a1.id,
          sessionId: f.s1.id,
          routeId: f.r1.id,
          createdAt: '2026-11-09T08:30:00.000Z'
        });
      },
      category: 'undos'
    },
    {
      name: '恢复',
      add(raw, f) {
        raw.pendingRestores.push({
          opId: 'op-pending-restore',
          attemptId: f.a2.id,
          sessionId: f.s1.id,
          routeId: f.r1.id,
          createdAt: '2026-11-09T08:30:00.000Z'
        });
      },
      category: 'restores'
    }
  ];

  cases.forEach(item => {
    resetStorage();
    const f = seedFixture();
    const raw = storedArchive();
    item.add(raw, f);
    writeRawArchive(raw);
    const before = JSON.stringify(raw);

    const inspected = store.inspectSessionDeletion({
      archiveId: f.archiveId,
      sessionId: f.s1.id
    });
    assert.equal(inspected.ok, true, item.name);
    assert.equal(inspected.code, 'pending', item.name);
    assert.equal(inspected.canDelete, false, item.name);
    assert.equal(inspected.pending[item.category], 1, item.name);
    assert.equal(inspected.pending.total, 1, item.name);
    assert.ok(inspected.pending.text.length > 0, item.name);

    fault.setCount = 0;
    const result = store.commitSessionDeletion({
      archiveId: f.archiveId,
      sessionId: f.s1.id,
      snapshot: inspected.snapshot
    });
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, 'pending', item.name);
    assert.equal(result.written, false, item.name);
    assert.equal(result.removed, false, item.name);
    assert.equal(fault.setCount, 0, item.name);
    assert.equal(JSON.stringify(storedArchive()), before, item.name);
  });
});

// ------------------------------------------------------------------ *
// 写入失败、回执丢失与未知
// ------------------------------------------------------------------ *

test('T051 写前失败、回执丢失、重读失败与预读失败分别给出可复验结果', () => {
  // 1) 写前失败：重读仍能看到原场次，明确未写入。
  resetStorage();
  let f = seedFixture();
  let inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  let before = storage.get(ARCHIVE_KEY);
  fault.setCount = 0;
  fault.setFailAt = 1;
  let result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'write-failed');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.written, false);
  assert.equal(result.removed, false);
  assert.equal(result.unknown, false);
  assert.equal(storage.get(ARCHIVE_KEY), before);
  assert.ok(storedArchive().sessions.some(item => item.id === f.s1.id));

  // 2) 写成功但回执丢失：重读同一档案确认完整移出，按成功返回。
  resetStorage();
  f = seedFixture();
  inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  fault.setCount = 0;
  fault.loseResponseAt = 1;
  result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'removed-receipt-lost');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.written, true);
  assert.equal(result.removed, true);
  assert.equal(result.receiptLost, true);
  assert.equal(result.unknown, false);
  assert.equal(storedArchive().sessions.some(item => item.id === f.s1.id), false);

  // 3) 写失败后重读也失败：不报已完成，状态保持未知。
  resetStorage();
  f = seedFixture();
  inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  fault.setCount = 0;
  fault.setFailAt = 1;
  fault.getCount = 0;
  fault.getFailAt = 2;
  result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'write-failed-unverified');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.written, false);
  assert.equal(result.removed, null);
  assert.equal(result.unknown, true);

  // 4) 预读失败：没有写档案，也不猜记录状态。
  resetStorage();
  f = seedFixture();
  inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  before = storage.get(ARCHIVE_KEY);
  fault.setCount = 0;
  fault.getCount = 0;
  fault.getFailAt = 1;
  result = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unreadable');
  assert.equal(result.writeAttempted, false);
  assert.equal(result.written, false);
  assert.equal(result.removed, null);
  assert.equal(result.unknown, true);
  assert.equal(fault.setCount, 0);
  assert.equal(storage.get(ARCHIVE_KEY), before);
});

test('T051 缺少快照或档案 ID 不符时不写档案', () => {
  const f = seedFixture();
  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  const before = storage.get(ARCHIVE_KEY);

  fault.setCount = 0;
  const incomplete = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'incomplete-request');
  assert.equal(fault.setCount, 0);

  const mismatch = store.commitSessionDeletion({
    archiveId: 'archive-other',
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'archive-mismatch');
  assert.equal(mismatch.unknown, true);
  assert.equal(fault.setCount, 0);
  assert.equal(storage.get(ARCHIVE_KEY), before);
});

// ------------------------------------------------------------------ *
// 重复确认与迟到保存
// ------------------------------------------------------------------ *

test('T051 重复确认只回读已删除结果，带原场次 ID 的迟到保存不能复活记录', () => {
  const f = seedFixture();
  store.selectSession(f.s1.id);
  const inspected = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  const first = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(first.ok, true, first.error);

  const afterFirst = storedArchive();
  const attemptCountAfterFirst = afterFirst.attempts.length;

  // 同一个旧快照再确认一次：目标已不在，不写档案、不新增任何把次。
  fault.setCount = 0;
  const repeat = store.commitSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    snapshot: inspected.snapshot
  });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.code, 'already-removed');
  assert.equal(repeat.writeAttempted, false);
  assert.equal(repeat.written, false);
  assert.equal(repeat.removed, true);
  assert.equal(repeat.unknown, false);
  assert.equal(fault.setCount, 0);
  assert.deepEqual(storedArchive(), afterFirst);

  const repeatInspect = store.inspectSessionDeletion({
    archiveId: f.archiveId,
    sessionId: f.s1.id
  });
  assert.equal(repeatInspect.code, 'missing');
  assert.equal(repeatInspect.cleanlyAbsent, true);

  // 迟到的原保存带着原场次 ID：接续场已是 session-3，但它不能把这一把写进接续场，
  // 也不能用被删掉的 opId 复活原记录。
  const late = store.saveAttempt({
    archiveId: f.archiveId,
    sessionId: f.s1.id,
    routeId: f.r1.id,
    result: 'fail',
    note: '迟到回调',
    opId: f.a1.id
  });
  assert.equal(late.ok, false);
  assert.match(late.error, /找不到这场训练/);

  const afterLate = storedArchive();
  assert.equal(afterLate.attempts.length, attemptCountAfterFirst);
  assert.equal(afterLate.attempts.some(item => item.id === f.a1.id), false);
  assert.equal(afterLate.attempts.some(item => item.sessionId === f.s1.id), false);
  assert.equal(
    afterLate.attempts.some(item => item.sessionId === f.s3.id && item.id === f.a1.id),
    false
  );
  assert.equal(afterLate.activeSessionId, f.s3.id);
});
