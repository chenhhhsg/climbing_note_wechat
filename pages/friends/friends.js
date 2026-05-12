/**
 * 好友列表页
 * 展示好友列表、输入邀请码添加好友、删除好友
 */
const db = require('../../utils/db');

Page({
  data: {
    friends: [],
    loading: true,
    inviteCodeInput: '',
    isAdding: false,
    myInviteCode: ''
  },

  onLoad() {
    this.initData();
  },

  onShow() {
    this.loadFriends();
  },

  async initData() {
    const userRes = await db.callCloud('loginOrCreateUser');
    if (userRes.success) {
      this.setData({ myInviteCode: userRes.data.inviteCode || '' });
    }
  },

  async loadFriends() {
    this.setData({ loading: true });
    const res = await db.callCloud('getMyFriends');
    if (res.success) {
      this.setData({ friends: res.data, loading: false });
    } else {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onInviteCodeInput(e) {
    this.setData({ inviteCodeInput: e.detail.value.toUpperCase() });
  },

  async addFriend() {
    const code = this.data.inviteCodeInput.trim();
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' });
      return;
    }
    if (this.data.isAdding) return;

    this.setData({ isAdding: true });
    wx.showLoading({ title: '添加中...' });

    const res = await db.callCloud('acceptFriendInvite', { inviteCode: code });
    wx.hideLoading();

    if (res.success) {
      wx.showToast({ title: `已添加 ${res.data.friendNickName}`, icon: 'success' });
      this.setData({ inviteCodeInput: '' });
      this.loadFriends();
    } else {
      wx.showToast({ title: res.error || '添加失败', icon: 'none' });
    }

    this.setData({ isAdding: false });
  },

  viewFriendFeed(e) {
    const openid = e.currentTarget.dataset.openid;
    wx.navigateTo({
      url: `/pages/friend-feed/friend-feed?friendOpenid=${openid}`
    });
  },

  removeFriend(e) {
    const { openid, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除好友',
      content: `确定要删除好友"${name}"吗？删除后将无法查看对方的好友可见记录。`,
      confirmText: '删除',
      confirmColor: '#f44336',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...' });
        const delRes = await db.callCloud('removeFriend', { friendOpenid: openid });
        wx.hideLoading();

        if (delRes.success) {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadFriends();
        } else {
          wx.showToast({ title: delRes.error || '删除失败', icon: 'none' });
        }
      }
    });
  },

  copyInviteCode() {
    if (!this.data.myInviteCode) return;
    wx.setClipboardData({
      data: this.data.myInviteCode,
      success: () => wx.showToast({ title: '已复制邀请码', icon: 'success' })
    });
  }
});
