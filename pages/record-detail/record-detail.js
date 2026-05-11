/**
 * 记录详情页面
 * 显示单条记录详情，支持编辑、删除和 Project 状态管理
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const app = getApp();

Page({
  data: {
    record: null,
    loading: true,
    recordId: ''
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ recordId: options.id });
      this.loadRecord(options.id);
    }
  },

  onShow() {
    if (this.data.recordId) {
      this.loadRecord(this.data.recordId);
    }
  },

  async loadRecord(id) {
    this.setData({ loading: true });

    const res = await db.getRecordById(id);

    if (res.success) {
      const { climbTypeLabels, statusLabels } = app.globalData;
      const record = res.data;

      // Project 状态显示文本
      const projectStatusText = {
        active: '进行中',
        completed: '已完成',
        abandoned: '已放弃'
      };

      this.setData({
        record: {
          ...record,
          dateText: dateUtil.formatDateChinese(record.date),
          climbTypeLabel: climbTypeLabels[record.climbType] || record.climbType,
          statusLabel: statusLabels[record.status] || record.status,
          isCompleted: record.status === 'flash' || record.status === 'completed',
          projectStatusText: projectStatusText[record.projectStatus] || '进行中'
        },
        loading: false
      });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  editRecord() {
    wx.navigateTo({
      url: `/pages/add-record/add-record?id=${this.data.recordId}`
    });
  },

  /**
   * 更新 Project 状态
   */
  async updateProjectStatus(e) {
    const newStatus = e.currentTarget.dataset.status;
    const statusText = {
      completed: '已完成',
      abandoned: '已放弃',
      active: '进行中'
    };

    wx.showModal({
      title: '更新状态',
      content: `确定将此 Project 标记为"${statusText[newStatus]}"吗？`,
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '更新中...' });

        const updateData = { projectStatus: newStatus };

        // 如果标记为已完成，记录完成日期
        if (newStatus === 'completed') {
          updateData.completedDate = dateUtil.getToday();
        }

        const result = await db.updateRecord(this.data.recordId, updateData);

        wx.hideLoading();

        if (result.success) {
          wx.showToast({ title: '状态已更新', icon: 'success' });
          this.loadRecord(this.data.recordId);
        } else {
          wx.showToast({ title: '更新失败', icon: 'none' });
        }
      }
    });
  },

  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({ current: url, urls: this.data.record.images });
  },

  deleteRecord() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条攀岩记录吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#f44336',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...' });

        let imageDeleteFailed = false;

        // 1. 先删除关联的云存储图片
        if (this.data.record.images && this.data.record.images.length > 0) {
          wx.showLoading({ title: '删除图片中...' });
          const imgRes = await db.deleteImage(this.data.record.images);
          if (!imgRes.success) {
            console.error('[Delete] 图片删除失败:', imgRes.error);
            imageDeleteFailed = true;
          }
        }

        // 2. 再删除数据库记录
        wx.showLoading({ title: '删除记录中...' });
        const delRes = await db.deleteRecord(this.data.recordId);

        wx.hideLoading();

        if (delRes.success) {
          if (imageDeleteFailed) {
            wx.showToast({ title: '记录已删除，部分图片清理失败', icon: 'none', duration: 2000 });
          } else {
            wx.showToast({ title: '删除成功', icon: 'success' });
          }
          setTimeout(() => wx.navigateBack(), 1500);
        } else {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  }
});
