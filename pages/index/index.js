/**
 * 首页 - 显示基础统计和最近记录
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const app = getApp();

Page({
  data: {
    recentRecords: [],
    loading: true,
    isEmpty: false,

    // 基础统计
    stats: {
      monthClimbs: 0,
      maxGrade: '-',
      completionRate: 0
    },
    statsLoading: true
  },

  onLoad() {
    this.loadData();
  },

  onShow() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true, statsLoading: true });

    // 并行加载记录和统计
    const [recordsRes, statsRes] = await Promise.all([
      db.getRecentRecords(3),
      db.getStats()
    ]);

    // 处理记录
    if (recordsRes.success) {
      const { climbTypeLabels, statusLabels } = app.globalData;

      const records = recordsRes.data.map(record => ({
        ...record,
        dateText: dateUtil.getRelativeTime(record.date),
        climbTypeLabel: climbTypeLabels[record.climbType] || record.climbType,
        statusLabel: statusLabels[record.status] || record.status,
        isCompleted: record.status === 'flash' || record.status === 'completed'
      }));

      this.setData({
        recentRecords: records,
        isEmpty: records.length === 0,
        loading: false
      });
    } else {
      this.setData({ loading: false });
    }

    // 处理统计
    if (statsRes.success) {
      this.setData({
        stats: {
          monthClimbs: statsRes.data.monthClimbs,
          maxGrade: statsRes.data.maxGrade || '-',
          completionRate: statsRes.data.completionRate
        },
        statsLoading: false
      });
    } else {
      this.setData({ statsLoading: false });
    }
  },

  goToAddRecord() {
    wx.navigateTo({ url: '/pages/add-record/add-record' });
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/record-detail/record-detail?id=${id}` });
  },

  goToList() {
    wx.switchTab({ url: '/pages/record-list/record-list' });
  },

  goToStats() {
    wx.switchTab({ url: '/pages/stats/stats' });
  }
});
