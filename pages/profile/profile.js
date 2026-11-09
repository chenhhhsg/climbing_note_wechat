/**
 * 个人中心页面
 * 显示用户基础信息和关于小程序
 */
const app = getApp();
const trainingStore = require('../../utils/training-store.js');

Page({
  data: {
    userInfo: null,
    hasUserInfo: false
  },

  onLoad() {
    // 检查是否已获取用户信息
    if (app.globalData.userInfo) {
      this.setData({
        userInfo: app.globalData.userInfo,
        hasUserInfo: true
      });
    }
  },

  /**
   * 获取用户信息
   */
  getUserProfile() {
    wx.getUserProfile({
      desc: '用于完善个人资料',
      success: (res) => {
        app.globalData.userInfo = res.userInfo;
        this.setData({
          userInfo: res.userInfo,
          hasUserInfo: true
        });
      },
      fail: (err) => {
        console.log('获取用户信息失败：', err);
      }
    });
  },

  /**
   * 跳转到关于页面
   */
  goToAbout() {
    wx.showModal({
      title: '关于攀笔',
      content: '攀笔是一款简洁的攀岩记录小程序，帮助你记录每一次攀登。\n\n版本：1.0.0',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 清除缓存
   *
   * T016：普通清缓存只清可重建的派生缓存，不再整片清空微信本地存储。
   * 本机训练档案、线路主照片索引、正在进行的操作以及命名空间外的其他键
   * （旧试用工程、旧云缓存）都保持原样，本地原图也不在这里删除。
   */
  clearCache() {
    wx.showModal({
      title: '提示',
      content: '确定要清除缓存吗？本机训练记录与照片不会被清除。',
      success: (res) => {
        if (!res.confirm) return;
        const result = trainingStore.clearRebuildableStorage();
        if (!result.ok) {
          wx.showToast({
            title: '清除失败',
            icon: 'none'
          });
          return;
        }
        wx.showToast({
          title: '清除成功',
          icon: 'success'
        });
      }
    });
  },

  /**
   * 意见反馈
   */
  feedback() {
    wx.showModal({
      title: '意见反馈',
      content: '如有问题或建议，请在下方留言',
      editable: true,
      placeholderText: '请输入你的反馈...',
      success: (res) => {
        if (res.confirm && res.content) {
          // 这里可以将反馈发送到云数据库
          wx.showToast({
            title: '感谢反馈',
            icon: 'success'
          });
        }
      }
    });
  }
});
