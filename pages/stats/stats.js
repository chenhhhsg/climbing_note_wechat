/**
 * 统计页面（T022：从底部「统计」查看本机把数与实际完攀）
 *
 * 本机读数全部来自 T016 的正式本机档案（utils/training-store.js）的只读入口：
 * - 只统计**已提交**的把次（archive.attempts）。「进行中」的待保存操作
 *   （pendingSaves）还没落盘，不计入；旧云汇总与 9c 自测等级也不计入。
 * - 本机把数、完攀、未完成与完成率共用同一分母（本机已提交把次数），
 *   取整沿用原来的 Math.round(...%，无把次时为 0。
 * - 本月按把次所属场次的**训练日期**计算，只比较本机本地年月，不跨时区解析。
 * - 地点按岩馆（场次所属 gymId 的名称）、类型按长期线路（route.climbType）关联；
 *   馆名是用户输入，分布按无原型字典（Object.create(null)）计数，constructor、
 *   __proto__ 这类合法名字也只按自己计数，不会被继承键顶掉或算成函数字串；
 *   最高难度按 V 级（抱石）与 YDS（顶绳/先锋）分开显示，不把两套难度混成一条。
 *
 * 本机数字先算先显示，且完全同步、不依赖网络；旧云汇总单独一段只读展示
 * （db.getAllRecords），断网、旧云拒绝、空数据或迟到回传都只影响这一段，
 * 既不遮挡也不覆盖上面本机读数的数字。
 *
 * 只读：进入、下拉刷新、切回 tab 与冷启动都重新读取当前档案，但从不写盘，
 * 损坏档案也保持原字节（可见报错并与真实空档区分）。
 */
const db = require('../../utils/db');
const gradeUtil = require('../../utils/grade');
const store = require('../../utils/training-store');

const UNKNOWN_GYM = '未填写岩馆';

// 本机档案不可读时先把读数归零：错误态由 archiveError 显示，不拿 0 冒充空档。
const EMPTY_READING = {
  isEmpty: true,
  totalAttempts: 0,
  monthAttempts: 0,
  sendCount: 0,
  failCount: 0,
  completionRate: 0,
  monthCompletionRate: 0,
  boulderMaxGrade: '',
  ropeMaxGrade: '',
  hasMaxGrade: false,
  gymRows: [],
  typeRows: []
};

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

/**
 * 本机当月键（YYYY-MM）：只看本机本地日期，便于离线测试注入固定时间。
 */
function localMonthKey(now) {
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
}

function monthKeyOf(dateString) {
  return typeof dateString === 'string' ? dateString.slice(0, 7) : '';
}

function rate(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * 分布行：同一分母（本机已提交把次数），数量多的在前，同数量按名称稳定排序。
 */
function rowsFromCounts(counts, total) {
  return Object.keys(counts)
    .map(name => ({ name: name, count: counts[name], percentage: rate(counts[name], total) }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
}

/**
 * 计数表：岩馆名与线路类型都是用户输入/档案里的字符串，用无原型字典按名计数。
 * 普通对象会按继承键计数（constructor、__proto__、toString 这些合法馆名会被算成
 * 继承来的函数或直接丢失），无原型字典只认自己写进去的键，每个馆名各算各的。
 */
function createCounts() {
  return Object.create(null);
}

function countUp(counts, name) {
  counts[name] = (counts[name] || 0) + 1;
}

/**
 * 按本机已提交把次汇总（纯函数，不读盘、不写盘）。
 *
 * 归属场次缺失的把次跳过（不猜日期与岩馆）；线路缺失时仍计入把数与完攀，
 * 只是不参与地点/类型/最高难度。旧云记录、待保存操作与 9c 成绩都不在这里。
 */
function buildLocalStats(archive, now) {
  const month = localMonthKey(now);
  const sessionsById = new Map((archive.sessions || []).map(item => [item.id, item]));
  const routesById = new Map((archive.routes || []).map(item => [item.id, item]));

  let total = 0;
  let sends = 0;
  let fails = 0;
  let monthTotal = 0;
  let monthSends = 0;
  const gymCounts = createCounts();
  const typeCounts = createCounts();
  const boulderGrades = [];
  const ropeGrades = [];

  (archive.attempts || []).forEach(attempt => {
    const session = sessionsById.get(attempt.sessionId);
    if (!session) return;

    total += 1;
    const isSend = attempt.result === 'send';
    if (isSend) sends += 1;
    else fails += 1;
    if (monthKeyOf(session.date) === month) {
      monthTotal += 1;
      if (isSend) monthSends += 1;
    }

    const gymName = store.gymName(archive, session.gymId) || UNKNOWN_GYM;
    countUp(gymCounts, gymName);

    const route = routesById.get(attempt.routeId);
    if (route) {
      const isBoulder = store.isBoulderRoute(route);
      const type = isBoulder ? '抱石' : route.climbType;
      countUp(typeCounts, type);
      if (isBoulder) boulderGrades.push(route.grade);
      else ropeGrades.push(route.grade);
    }
  });

  const boulderMaxGrade = gradeUtil.getMaxGrade(boulderGrades);
  const ropeMaxGrade = gradeUtil.getMaxGrade(ropeGrades);

  return {
    total: total,
    sends: sends,
    fails: fails,
    monthTotal: monthTotal,
    monthSends: monthSends,
    completionRate: rate(sends, total),
    monthCompletionRate: rate(monthSends, monthTotal),
    // getMaxGrade 对空数组返回 '-'，这里换成空串，交给页面决定是否展示。
    boulderMaxGrade: boulderMaxGrade === '-' ? '' : boulderMaxGrade,
    ropeMaxGrade: ropeMaxGrade === '-' ? '' : ropeMaxGrade,
    hasMaxGrade: boulderMaxGrade !== '-' || ropeMaxGrade !== '-',
    gymRows: rowsFromCounts(gymCounts, total),
    typeRows: rowsFromCounts(typeCounts, total),
    hasLocalData: total > 0
  };
}

Page({
  data: {
    loading: true,
    // 本机档案损坏/版本不支持/读取失败时的可见报错；空串表示可读。
    archiveError: '',
    isEmpty: true,

    // 本机读数（只含已提交把次，同一分母）
    totalAttempts: 0,
    monthAttempts: 0,
    sendCount: 0,
    failCount: 0,
    completionRate: 0,
    monthCompletionRate: 0,
    boulderMaxGrade: '',
    ropeMaxGrade: '',
    hasMaxGrade: false,
    gymRows: [],
    typeRows: [],

    // 旧云汇总（只读、单列来源；失败或延迟都不影响上面的本机读数）
    legacyLoading: false,
    legacyState: 'idle', // idle | loading | ok | empty | error
    legacyRecordCount: 0,
    legacyError: '',
    legacyHint: db.LEGACY_SUMMARY_HINT
  },

  onLoad() {
    this.loadStats();
  },

  // 每次显示（冷启动、返回 tab、切回统计）都重读当前档案
  onShow() {
    this.loadStats();
  },

  onPullDownRefresh() {
    return Promise.resolve(this.loadStats()).then(() => {
      if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh();
    });
  },

  /**
   * 加载统计：本机读数同步先出，再单独请求旧云汇总。
   */
  loadStats() {
    this.setData({ loading: true });

    const loaded = store.loadState();
    if (!loaded.ok) {
      // 损坏或版本不支持：显示读取失败并保留原字节，不显示 0 冒充真实空档。
      this.setData(Object.assign({ loading: false, archiveError: loaded.error }, EMPTY_READING));
      return this.loadLegacyStats();
    }

    const stats = buildLocalStats(loaded.archive, new Date());
    this.setData({
      loading: false,
      archiveError: '',
      isEmpty: !stats.hasLocalData,
      totalAttempts: stats.total,
      monthAttempts: stats.monthTotal,
      sendCount: stats.sends,
      failCount: stats.fails,
      completionRate: stats.completionRate,
      monthCompletionRate: stats.monthCompletionRate,
      boulderMaxGrade: stats.boulderMaxGrade,
      ropeMaxGrade: stats.ropeMaxGrade,
      hasMaxGrade: stats.hasMaxGrade,
      gymRows: stats.gymRows,
      typeRows: stats.typeRows
    });

    return this.loadLegacyStats();
  },

  /**
   * 旧云汇总（只读）：只显示原记录的条数与读只说明，不拆分逐次尝试、
   * 不计入本机把数，也不向旧库写回。用请求序号丢弃迟到回执。
   */
  loadLegacyStats() {
    this._legacyToken = (this._legacyToken || 0) + 1;
    const token = this._legacyToken;
    this.setData({ legacyLoading: true, legacyState: 'loading' });

    return db.getAllRecords().then(res => {
      if (token !== this._legacyToken) return;
      const records = res && Array.isArray(res.data) ? res.data : [];
      this.setData({
        legacyLoading: false,
        legacyState: records.length > 0 ? 'ok' : 'empty',
        legacyRecordCount: records.length,
        legacyError: ''
      });
    }).catch(err => {
      if (token !== this._legacyToken) return;
      console.error('加载旧云汇总失败：', err);
      const view = db.describeCloudError(err);
      this.setData({
        legacyLoading: false,
        legacyState: 'error',
        legacyRecordCount: 0,
        legacyError: view.title + '：' + view.hint
      });
    });
  }
});
