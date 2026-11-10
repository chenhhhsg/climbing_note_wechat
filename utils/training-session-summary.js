/**
 * 本次攀爬小结（T029）
 *
 * 离馆时按**本场**回看：这一场爬了哪些线、共几把、哪些完攀，并可就地勾选
 * 「下次想继续」的未完成线路（写入 T027 的「下次想爬」清单，见 utils/training-wishlist.js）。
 *
 * 数据来源只有 T016 的正式本机档案（utils/training-store.js）里**有效**的把次
 * （archive.attempts 中未撤回的那些，T032），按场次稳定 ID（sessionId）过滤：
 * - 已撤回的那一把不在小结里：不贡献把数、本场完攀把数、最近有效备注与勾选状态；
 *   恢复后又回到原来的位置（沿用原 ID、原序号与原备注）；
 * - 「进行中」的待保存操作（archive.pendingSaves）还没提交，不计入把数，只单独给一个
 *   待保存计数让页面提示，因此小结里不会出现「点了结果却先算一把」的假读数；
 * - 旧云汇总（climbing_records）、旧 climbing_sessions 与 9c 自测成绩都不在本机档案里，
 *   本文件不读取它们，也不把它们并进本场把数；
 * - 把次按 routeId 去重：同一条线在同一场里记了几把就是几把，但只算一条线路；同色同级
 *   的 A、B 两条线各占一行，绝不按名称、颜色或等级归并，也不串馆；
 * - 抱石的完攀线路沿用档案层 routeCompletion 的判定（抱石首次完攀后不再新增）；顶绳和
 *   先锋可重复完攀，因此「本场完攀把数」与「本场完攀线路数」分开给出。
 *
 * 完全只读：本文件不读也不写任何存储键、不结束也不新建场次，页面打开、返回、重开再算
 * 都得到同一份结果。原位更正（把原完攀改为未完成）改的是原把次本身，因此小结把数不变、
 * 完攀随原记录一起更新——每次都按最新档案重算，不做任何缓存。
 *
 * 场次不存在时 known:false；线路已不在档案里的把次仍计入把数与完攀把数（与底部全档案
 * 统计共用同一口径，因此两处各场把数一致），只是不参与去重线路，另行记在
 * orphanAttemptCount 里，不猜、不补归属。
 */
const store = require('./training-store.js');
const rules = require('./training-rules.js');

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 一行线路的完攀文案：整条线的状态优先（已完攀 / 完攀待确认），否则本场有完攀把次时
 * 说明「本场完攀」（顶绳、先锋可重复完攀，不入档案层的 completed）。
 */
function routeStateText(completion, sendCount) {
  if (completion && completion.completed) return '已完攀';
  if (completion && completion.closed) return '完攀待确认';
  return sendCount > 0 ? '本场完攀' : '';
}

function emptySummary(sessionId) {
  return {
    known: false,
    sessionId: hasText(sessionId) ? sessionId : '',
    gymId: '',
    gymName: '',
    date: '',
    seq: 0,
    label: '',
    sameDayCount: 0,
    isEmpty: true,
    attemptCount: 0,
    attemptCountText: '0 把',
    routeCount: 0,
    routeCountText: '0 条线',
    sendCount: 0,
    sendCountText: '',
    sentRouteCount: 0,
    failCount: 0,
    pendingCount: 0,
    pendingCountText: '',
    orphanAttemptCount: 0,
    pickableCount: 0,
    summaryText: '0 条线 · 0 把',
    routes: []
  };
}

/**
 * 本场小结（纯函数，只读传入的档案，不读盘、不写盘）。
 *
 * 返回 { known, sessionId, gymId, gymName, date, seq, label, sameDayCount, isEmpty,
 *        attemptCount, attemptCountText, routeCount, routeCountText, sendCount,
 *        sendCountText, sentRouteCount, failCount, pendingCount, pendingCountText,
 *        orphanAttemptCount, pickableCount, summaryText, routes }。
 *
 * routes 每行：线路信息、本场把数与完攀把数、整条线的完成状态与文案，
 * pickable 表示本场未完成（可在小结里勾选「下次想爬」）；组内按本场第一把的序号排
 * （先爬的在前），同一起点再按长期线路序号与线路 ID，重开结果一致。
 */
function buildSessionSummary(archive, sessionId) {
  const id = hasText(sessionId) ? sessionId : '';
  const session = archive
    ? (archive.sessions || []).find(item => item.id === id) || null
    : null;
  if (!session) return emptySummary(id);

  const routesById = new Map((archive.routes || []).map(item => [item.id, item]));
  // 只算有效把次：已撤回的那一把既不算把数，也不算线路、完攀与最近备注。
  const attempts = rules
    .effectiveAttempts(archive.attempts)
    .filter(item => item.sessionId === session.id)
    .sort((left, right) => (left.seq || 0) - (right.seq || 0));

  // 按长期线路 ID 去重：同一条线在本场的所有把次归到一行。
  const byRoute = new Map();
  let sendCount = 0;
  let orphanAttemptCount = 0;
  attempts.forEach(attempt => {
    if (attempt.result === 'send') sendCount += 1;
    const route = routesById.get(attempt.routeId) || null;
    if (!route) {
      // 线路已不在档案里：把数照算，但不猜它叫什么、也不并进别的线。
      orphanAttemptCount += 1;
      return;
    }
    if (!byRoute.has(route.id)) byRoute.set(route.id, { route, attempts: [] });
    byRoute.get(route.id).attempts.push(attempt);
  });

  const routes = [...byRoute.values()]
    .map(entry => {
      const route = entry.route;
      const routeSendCount = entry.attempts.filter(item => item.result === 'send').length;
      const completion = store.routeCompletion(archive, route.id);
      // 「最近备注」按把次序号取最大的一条非空备注：序号在档案里全局递增。
      const latest = entry.attempts.reduce(
        (acc, item) => {
          const note = typeof item.note === 'string' ? item.note.trim() : '';
          if (!note) return acc;
          const seq = Number.isInteger(item.seq) ? item.seq : 0;
          return seq >= acc.seq ? { seq, note } : acc;
        },
        { seq: -1, note: '' }
      );
      return {
        routeId: route.id,
        seq: route.seq || 0,
        name: route.name,
        // 旧 V 级线路没有 climbType，按抱石只读展示，不回写档案。
        climbType: rules.climbTypeOf(route),
        grade: route.grade,
        colorName: route.colorName || '',
        colorHex: route.colorHex || '#dee2e6',
        firstSeq: entry.attempts[0].seq || 0,
        attemptCount: entry.attempts.length,
        attemptCountText: entry.attempts.length + ' 把',
        sendCount: routeSendCount,
        hasSend: routeSendCount > 0,
        completed: Boolean(completion.completed),
        closed: Boolean(completion.closed),
        stateText: routeStateText(completion, routeSendCount),
        // 本场没爬完的线才在小结里直接勾选：已完攀的线按 T027 语义归到「已完成」，
        // 仍可在下方清单里加入，避免两种状态互相打架。
        pickable: routeSendCount === 0,
        latestNote: latest.note,
        hasNote: Boolean(latest.note)
      };
    })
    .sort(
      (left, right) =>
        left.firstSeq - right.firstSeq ||
        left.seq - right.seq ||
        (left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0)
    );

  const attemptCount = attempts.length;
  const pendingCount = (archive.pendingSaves || []).filter(
    item => item.sessionId === session.id
  ).length;
  const sentRouteCount = routes.filter(row => row.hasSend).length;
  const pickableCount = routes.filter(row => row.pickable).length;
  const sameDayCount = (archive.sessions || []).filter(
    item => item.date === session.date
  ).length;

  return {
    known: true,
    sessionId: session.id,
    gymId: session.gymId,
    gymName: store.gymName(archive, session.gymId),
    date: session.date,
    seq: session.seq,
    label: store.sessionLabel(archive, session),
    sameDayCount,
    isEmpty: attemptCount === 0,
    attemptCount,
    attemptCountText: attemptCount + ' 把',
    routeCount: routes.length,
    routeCountText: routes.length + ' 条线',
    sendCount,
    sendCountText: sendCount > 0 ? '完攀 ' + sendCount + ' 把' : '',
    sentRouteCount,
    failCount: attemptCount - sendCount,
    pendingCount,
    pendingCountText: pendingCount > 0
      ? '本场还有 ' + pendingCount + ' 把待保存，未计入小结把数。'
      : '',
    orphanAttemptCount,
    pickableCount,
    summaryText:
      routes.length + ' 条线 · ' + attemptCount + ' 把' +
      (sendCount > 0 ? ' · 完攀 ' + sendCount + ' 把' : ''),
    routes
  };
}

module.exports = {
  buildSessionSummary
};
