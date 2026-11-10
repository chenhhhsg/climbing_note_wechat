/**
 * 下次想爬独立清单页（T035）
 *
 * 首页的「下次想爬」收成一行入口（标题 + 数量）后，整份清单搬到本页：按岩馆分组，
 * 每条线写明状态（想爬 / 已完成 / 已归档（岩馆拆线））、等级与线路色、累计把数与最近一条
 * 非空备注；点开某一条按**原长期线路 ID**进线路资料，看它的原照片、卡点、跨日历史，
 * 再用资料页已有的「当天再记」显式选择适用场次继续这条线。
 *
 * 数据层只用既有两份本机记录，不新建存储、不建并行收藏表、不迁移照片：
 * - utils/training-store.js 是本机档案（线路、把数、备注、场次）；
 * - utils/training-wishlist.js 是按「档案 ID + 长期线路 ID」定位的清单。
 * 分组、状态与把数口径全部来自 listWishlist，与本页之外的小结勾选、线路资料共用同一份，
 * 本页不另算一遍，也不缓存成第二份数据。
 *
 * 只读：本页没有任何写入口——加入、撤下与拆线归档都在线路资料页和小结勾选里。打开本页、
 * 返回、点开某一条线路、重试读取都不写本机档案、不动清单、不动照片索引；清单损坏时显示
 * 可见失败与重试入口，原数据保持原样（清单层自己也会拒绝用空清单覆盖）。
 *
 * 归属核对（T035）：从首页过来时带上渲染那一页所用的 archiveId。本机档案已经换成另一份
 * （档案被重置、换了账号，或另一份档案里恰好有同名线路 ID 与同名岩馆）时一律不展示任何
 * 清单，只给可见状态与返回入口——绝不拿当前档案里同名的线路顶替；本机还没有落盘档案时
 * 谈不上归属，照常按空清单显示。
 */
const store = require('../../utils/training-store.js');
const wishlist = require('../../utils/training-wishlist.js');

const ROUTE_URL = '/pages/training-route/training-route';
const HOME_URL = '/pages/index/index';

Page({
  data: {
    ready: false,
    loadError: '',   // 本机档案损坏/版本不支持/读取失败的可见报错
    claimError: '',  // 入口带来的档案 ID 与本机档案不一致（换档后不再顶替展示）
    listError: '',   // 清单损坏/版本不受支持/读取失败：显示失败与重试，原清单不动

    // 按岩馆分组的只读清单（口径与小结勾选、线路资料完全一致）
    groups: [],
    itemCount: 0,
    hasItems: false,
    countText: ''
  },

  onLoad(query) {
    const data = query || {};
    // 入口带下来的原归属：首页渲染那一行时用的是哪一份本机档案。
    this._archiveIdClaim = data.archiveId || data.archiveid || '';
    this.loadList();
  },

  onShow() {
    if (!this.data.ready) return;
    // 从小结勾选或线路资料返回本页：按最新档案与清单重算同一份结果，不改任何数据。
    this.loadList();
  },

  /**
   * 从本机档案与清单重新读一遍本页内容（首次进入、返回本页、损坏后重试都走这里）。
   * 只读：不写档案、不写清单、不动照片文件与照片索引。
   */
  loadList() {
    const loaded = store.loadState();
    this.archive = loaded.archive || null;

    if (!loaded.ok) {
      this.setData(this.clearedView({ loadError: loaded.error }));
      return;
    }

    // 串档：入口记下的档案 ID 与本机现在这一份不同 → 不展示任何清单条目。
    // 本机还没有落盘档案（present 为假）时不谈归属，按空清单显示。
    if (loaded.present && this._archiveIdClaim && this._archiveIdClaim !== loaded.archive.archiveId) {
      this.setData(
        this.clearedView({
          claimError:
            '这份清单属于另一份本机档案，未展示任何条目；请从当前首页重新打开「下次想爬」。'
        })
      );
      return;
    }

    const listed = wishlist.listWishlist(loaded.archive);
    if (!listed.ok) {
      // 清单损坏、版本不受支持或读取失败：显示失败与重试，不拿空清单冒充「还没收藏」。
      this.setData(
        this.clearedView({
          listError: listed.error
        })
      );
      return;
    }

    const groups = listed.groups.map(group => ({
      gymId: group.gymId,
      gymName: group.gymName,
      countText: group.countText,
      items: group.items.map(entry => ({
        routeId: entry.routeId,
        name: entry.name,
        climbType: entry.climbType,
        grade: entry.grade,
        colorName: entry.colorName,
        colorHex: entry.colorHex,
        status: entry.status,
        statusText: entry.statusText,
        attemptCountText: entry.attemptCountText,
        latestNote: entry.latestNote,
        hasNote: entry.hasNote
      }))
    }));

    this.setData({
      ready: true,
      loadError: '',
      claimError: '',
      listError: '',
      groups,
      itemCount: listed.items.length,
      hasItems: listed.items.length > 0,
      countText: listed.items.length
        ? '共 ' + listed.items.length + ' 条 · ' + groups.length + ' 家岩馆'
        : '0 条'
    });
  },

  /**
   * 清空展示并保留可见状态：读档失败、换档与清单损坏都走这里，
   * 三种状态各自只有一句话，不混成同一段文案。
   */
  clearedView(state) {
    const next = state || {};
    return {
      ready: true,
      loadError: next.loadError || '',
      claimError: next.claimError || '',
      listError: next.listError || '',
      groups: [],
      itemCount: 0,
      hasItems: false,
      countText: ''
    };
  },

  /** 重试读取：重新读一次档案与清单，不写盘、不重建任何记录。 */
  retryLoad() {
    this.loadList();
  },

  /**
   * 点开清单里的一条线：按原长期线路 ID 打开线路资料，看它的原照片、卡点与跨日历史。
   * 只是导航：不关联场次、不选线路、不写任何键，「当天再记」仍须在资料页显式选择适用场次。
   */
  openRoute(event) {
    const routeId = event && event.currentTarget && event.currentTarget.dataset.routeId;
    if (!routeId) return;
    wx.navigateTo({
      url: ROUTE_URL + '?routeId=' + routeId
    });
  },

  /**
   * 返回首页：正常路径是从首页进来，返回上一页即可；直接进入本页（例如编译时指定页面）
   * 没有可返回的页面，显式切回首页 tab。
   */
  goHome() {
    if (typeof wx.navigateBack === 'function') {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (typeof wx.switchTab === 'function') wx.switchTab({ url: HOME_URL });
        }
      });
      return;
    }
    if (typeof wx.switchTab === 'function') wx.switchTab({ url: HOME_URL });
  }
});
