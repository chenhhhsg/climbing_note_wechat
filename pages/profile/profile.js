/**
 * 个人中心页面
 * 显示用户基础信息和关于小程序
 */
const app = getApp();

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
   */
  clearCache() {
    wx.showModal({
      title: '提示',
      content: '确定要清除缓存吗？',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorage({
            success: () => {
              wx.showToast({
                title: '清除成功',
                icon: 'success'
              });
            }
          });
        }
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
