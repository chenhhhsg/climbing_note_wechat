/**
 * 首页 - 显示最近记录和快捷添加按钮
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');

Page({
  data: {
    recentRecords: [],  // 最近的记录
    loading: true,      // 加载状态
    isEmpty: false      // 是否无数据
  },

  onLoad() {
    this.loadRecentRecords();
  },

  // 每次显示页面时刷新数据
  onShow() {
    this.loadRecentRecords();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadRecentRecords().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 加载最近的攀岩记录
   */
  async loadRecentRecords() {
    this.setData({ loading: true });
    try {
      const res = await db.getRecentRecords(5);
      const records = res.data.map(record => ({
        ...record,
        // 格式化日期显示
        dateText: dateUtil.getRelativeTime(record.date),
        // 格式化创建时间
        createTimeText: dateUtil.formatDateChinese(record.createTime)
      }));

      this.setData({
        recentRecords: records,
        isEmpty: records.length === 0,
        loading: false
      });
    } catch (err) {
      console.error('加载记录失败：', err);
      this.setData({ loading: false });
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  /**
   * 跳转到添加记录页面
   */
  goToAddRecord() {
    wx.navigateTo({
      url: '/pages/add-record/add-record'
    });
  },

  /**
   * 跳转到记录详情
   */
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/record-detail/record-detail?id=${id}`
    });
  },

  /**
   * 跳转到记录列表
   */
  goToList() {
    wx.switchTab({
      url: '/pages/record-list/record-list'
    });
  }
});
