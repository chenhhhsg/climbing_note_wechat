/**
 * 记录详情页面
 * 显示单条记录详情，支持删除
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');

Page({
  data: {
    record: null,       // 记录数据
    loading: true,      // 加载状态
    recordId: ''        // 记录ID
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ recordId: options.id });
      this.loadRecord(options.id);
    }
  },

  /**
   * 加载记录详情
   */
  async loadRecord(id) {
    this.setData({ loading: true });
    try {
      const res = await db.getRecordById(id);
      const record = res.data;

      // 格化数据
      record.dateText = dateUtil.formatDateChinese(record.date);
      record.createTimeText = dateUtil.formatDateChinese(record.createTime);

      this.setData({
        record: record,
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
   * 预览图片
   */
  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({
      current: url,
      urls: this.data.record.images
    });
  },

  /**
   * 删除记录
   */
  deleteRecord() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条攀岩记录吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#f44336',
      success: async (res) => {
        if (res.confirm) {
          try {
            wx.showLoading({ title: '删除中...' });

            // 删除关联的图片
            if (this.data.record.images && this.data.record.images.length > 0) {
              await db.deleteImage(this.data.record.images);
            }

            // 删除记录
            await db.deleteRecord(this.data.recordId);

            wx.hideLoading();
            wx.showToast({
              title: '删除成功',
              icon: 'success'
            });

            // 返回上一页
            setTimeout(() => {
              wx.navigateBack();
            }, 1500);

          } catch (err) {
            console.error('删除失败：', err);
            wx.hideLoading();
            wx.showToast({
              title: '删除失败',
              icon: 'none'
            });
          }
        }
      }
    });
  }
});
