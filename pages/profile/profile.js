/**
 * 个人中心页面
 * 显示用户基础信息、数据导出和关于小程序
 */
const db = require('../../utils/db');
const app = getApp();

Page({
  data: {
    avatarUrl: '',
    nickName: '',
    hasUserInfo: false,
    isExporting: false,
    myInviteCode: ''
  },

  onLoad() {
    // 从缓存中恢复用户信息
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.nickName) {
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: userInfo.nickName,
        hasUserInfo: true
      });
      app.globalData.userInfo = userInfo;
    }
  },

  /**
   * 选择头像回调（新 API）
   */
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    this.setData({ avatarUrl });
    this.trySaveUserInfo();
  },

  /**
   * 昵称输入回调（新 API）
   */
  onNicknameInput(e) {
    this.setData({ nickName: e.detail.value });
  },

  /**
   * 昵称输入框失焦
   */
  onNicknameBlur(e) {
    this.setData({ nickName: e.detail.value });
    this.trySaveUserInfo();
  },

  /**
   * 尝试保存用户信息（头像和昵称都有值时自动保存）
   */
  trySaveUserInfo() {
    const { avatarUrl, nickName } = this.data;
    if (nickName) {
      const userInfo = { avatarUrl, nickName };
      this.setData({ hasUserInfo: true });
      app.globalData.userInfo = userInfo;
      wx.setStorageSync('userInfo', userInfo);
      wx.showToast({ title: '设置成功', icon: 'success' });
    }
  },

  /**
   * 数据导出
   */
  async exportData() {
    if (this.data.isExporting) return;

    this.setData({ isExporting: true });
    wx.showLoading({ title: '导出中...' });

    try {
      const res = await db.getSessions({ page: 1, pageSize: 1000 });

      if (res.success && res.data.list.length > 0) {
        const { climbTypeLabels, statusLabels } = app.globalData;

        const headers = ['日期', '地点', '攀岩类型', '难度等级', '完成状态', '尝试次数', '线路编号', '线路颜色', '区域', '线路备注'];
        const rows = [];

        res.data.list.forEach(session => {
          (session.routes || []).forEach(route => {
            rows.push([
              session.date,
              session.location || '',
              climbTypeLabels[route.climbType] || route.climbType || '',
              route.grade || '',
              statusLabels[route.status] || route.status || '',
              route.attempts || 1,
              route.routeName || '',
              route.routeColor || '',
              route.area || '',
              (route.notes || '').replace(/,/g, '，').replace(/\n/g, ' ')
            ]);
          });
        });

        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

        wx.setClipboardData({
          data: csvContent,
          success: () => {
            wx.hideLoading();
            wx.showModal({
              title: '导出成功',
              content: `已导出 ${res.data.list.length} 次攀岩、${rows.length} 条线路到剪贴板，可粘贴到 Excel 中查看。`,
              showCancel: false,
              confirmText: '知道了'
            });
          }
        });
      } else {
        wx.hideLoading();
        wx.showToast({ title: '暂无数据可导出', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '导出失败', icon: 'none' });
    }

    this.setData({ isExporting: false });
  },

  goToAbout() {
    wx.showModal({
      title: '关于攀笔',
      content: '攀笔是一款简洁的攀岩记录小程序，帮助你记录每一次攀登。\n\n版本：1.0.0\n\n功能特色：\n· 记录攀岩详情\n· 多维度数据统计\n· 图片上传\n· 数据导出',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  clearCache() {
    wx.showModal({
      title: '提示',
      content: '确定要清除缓存吗？这不会删除你的攀岩记录数据。',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorage({
            success: () => {
              this.setData({
                avatarUrl: '',
                nickName: '',
                hasUserInfo: false
              });
              wx.showToast({ title: '清除成功', icon: 'success' });
            }
          });
        }
      }
    });
  },

  feedback() {
    wx.showModal({
      title: '意见反馈',
      content: '如有问题或建议，请在下方留言',
      editable: true,
      placeholderText: '请输入你的反馈...',
      success: (res) => {
        if (res.confirm && res.content) {
          wx.showToast({ title: '感谢反馈', icon: 'success' });
        }
      }
    });
  },

  goToFriends() {
    wx.navigateTo({ url: '/pages/friends/friends' });
  },

  goToFriendFeed() {
    wx.navigateTo({ url: '/pages/friend-feed/friend-feed' });
  },

  async showInviteCode() {
    wx.showLoading({ title: '获取邀请码...' });
    const res = await db.callCloud('createFriendInvite');
    wx.hideLoading();

    if (res.success) {
      const code = res.data.inviteCode;
      this.setData({ myInviteCode: code });
      wx.showModal({
        title: '我的邀请码',
        content: `你的邀请码是：${code}\n\n分享给好友，对方在"我的好友"页面输入即可添加你。`,
        confirmText: '复制邀请码',
        cancelText: '关闭',
        success: (modalRes) => {
          if (modalRes.confirm) {
            wx.setClipboardData({
              data: code,
              success: () => wx.showToast({ title: '已复制', icon: 'success' })
            });
          }
        }
      });
    } else {
      wx.showToast({ title: res.error || '获取失败', icon: 'none' });
    }
  }
});
