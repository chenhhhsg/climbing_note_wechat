/**
 * 旧记录详情页（T018：只读回看）
 *
 * 按原 `_id` 从既有的、本人有权限的云接口读取一条旧记录，显示它原来的字段与图片引用：
 * 日期、地点、类型、等级、状态、`attempts`、备注与图片。图片只预览，不做上传或删除。
 *
 * 只读边界（本单的核心约定）：
 * - 浏览不更新、不删除这条旧记录，不拆出逐把，也不把旧汇总并入本机训练统计；
 * - 「尝试 5 次、完成」只显示成一条历史汇总；
 * - 已知 `climbing_sessions.routes[]` 旧形状按原结构只读保留，不猜同色同级线路；
 * - 读取失败按「云环境不可用 / 没有权限 / 记录不存在 / 读取失败」显示有区别的状态，
 *   失败不触发任何回写、清空或覆盖本机训练档案；
 * - 旧记录按原 `_id` 路由（`?id=`），与本机长期线路的 `?routeId=` 分开，
 *   即使两者字符串相同也各自进入自己的详情。
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');

// 没有传 id（例如手输路由）时的状态：不猜、不请求。
const MISSING_ID_HINT = '没有指定要回看的旧记录。请从「旧记录」列表打开一条。';

Page({
  data: {
    recordId: '',
    state: 'loading',   // loading | ready | missing | empty | unavailable | denied | failed
    errorTitle: '',
    errorHint: '',
    view: null          // legacyRecordView 的只读视图
  },

  onLoad(options) {
    const id = (options && (options.id || options._id)) || '';
    this.setData({ recordId: id });

    if (!id) {
      this.setData({
        state: 'missing',
        errorTitle: '缺少旧记录 ID',
        errorHint: MISSING_ID_HINT
      });
      return;
    }
    this.loadRecord(id);
  },

  retryLoad() {
    if (!this.data.recordId) return;
    this.loadRecord(this.data.recordId);
  },

  /**
   * 按原 _id 读取一条旧记录并转成只读视图；失败只改变显示的提示，不写任何数据。
   */
  async loadRecord(id) {
    this.setData({ state: 'loading', errorTitle: '', errorHint: '', view: null });

    try {
      const res = await db.getRecordById(id);
      const view = db.legacyRecordView(res && res.data);

      if (!view.present) {
        // 读到了但拿不到可识别的记录：按空结果显示，不伪造字段、不补 0。
        this.setData({
          state: 'empty',
          errorTitle: '这条旧记录不存在',
          errorHint: '旧记录可能已被删除或不属于当前账号；本机训练历史不受影响。',
          view: null
        });
        return;
      }

      this.setData({
        state: 'ready',
        errorTitle: '',
        errorHint: '',
        view: {
          ...view,
          dateText: dateUtil.formatDateChinese(view.date)
        }
      });
    } catch (err) {
      console.error('读取旧记录失败：', err);
      const described = db.describeCloudError(err);
      const state = described.kind === 'not-found' ? 'empty' : described.kind;
      this.setData({
        state,
        errorTitle: described.title,
        errorHint: described.hint,
        view: null
      });
    }
  },

  /**
   * 预览原图片引用：只读，不改引用也不删除云文件。
   */
  previewImage(e) {
    const view = this.data.view;
    if (!view || view.images.length === 0) return;
    const url = e.currentTarget.dataset.url;
    wx.previewImage({
      current: url,
      urls: view.images
    });
  }
});
