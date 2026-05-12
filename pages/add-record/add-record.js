/**
 * 添加攀岩 Session 页面
 * 一次进馆 = 一条记录，包含多条线路
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    // Session 基础信息
    date: '',
    location: '',
    notes: '',
    visibility: 'private',

    // 线路列表
    routes: [],

    // 线路表单（弹层）
    showRouteForm: false,
    editingRouteIndex: -1,
    routeForm: {
      climbType: 'boulder',
      grade: '',
      status: 'flash',
      attempts: 1,
      routeColor: '',
      routeName: '',
      area: '',
      notes: '',
      images: []
    },

    // 选项
    climbTypes: [],
    climbTypeLabels: {},
    statusTags: [
      { value: 'flash', label: 'Flash', icon: '⚡' },
      { value: 'completed', label: '完成', icon: '✅' },
      { value: 'failed', label: '未完成', icon: '❌' },
      { value: 'project', label: 'Project', icon: '🎯' }
    ],
    statusLabels: {},
    gradeOptions: [],
    colorOptions: ['红', '蓝', '绿', '黄', '黑', '白', '紫', '橙', '粉', '灰'],

    // UI
    isSubmitting: false,

    // 编辑模式
    editingSessionId: '',
    isLoadingSession: false
  },

  onLoad(options) {
    const { climbTypes, climbTypeLabels, statusLabels } = app.globalData;
    this.setData({
      date: dateUtil.getToday(),
      climbTypes,
      climbTypeLabels,
      statusLabels
    });
    this.updateGradeOptions('boulder');

    // 编辑模式：加载已有 Session
    if (options.id) {
      this.setData({ editingSessionId: options.id });
      this.loadSessionForEdit(options.id);
    }
  },

  // ============================================
  // Session 基础信息
  // ============================================

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  onLocationInput(e) {
    this.setData({ location: e.detail.value });
  },

  onNotesInput(e) {
    this.setData({ notes: e.detail.value });
  },

  onVisibilitySelect(e) {
    this.setData({ visibility: e.currentTarget.dataset.value });
  },

  /**
   * 编辑模式：加载已有 Session 数据
   */
  async loadSessionForEdit(id) {
    this.setData({ isLoadingSession: true });
    wx.showLoading({ title: '加载中...' });

    const res = await db.getSessionById(id);
    wx.hideLoading();

    if (res.success) {
      const session = res.data;
      this.setData({
        date: session.date || dateUtil.getToday(),
        location: session.location || '',
        notes: session.notes || '',
        visibility: session.visibility || 'private',
        routes: (session.routes || []).map(r => ({
          id: r.id,
          climbType: r.climbType || 'boulder',
          grade: r.grade || '',
          status: r.status || 'completed',
          attempts: r.attempts || 1,
          routeColor: r.routeColor || '',
          routeName: r.routeName || '',
          area: r.area || '',
          notes: r.notes || '',
          images: r.images || []
        })),
        isLoadingSession: false
      });
    } else {
      this.setData({ isLoadingSession: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // ============================================
  // 线路表单
  // ============================================

  openAddRouteForm() {
    this.setData({
      showRouteForm: true,
      editingRouteIndex: -1,
      routeForm: {
        climbType: 'boulder',
        grade: '',
        status: 'flash',
        attempts: 1,
        routeColor: '',
        routeName: '',
        area: '',
        notes: '',
        images: []
      }
    });
    this.updateGradeOptions('boulder');
  },

  openEditRouteForm(e) {
    const index = e.currentTarget.dataset.index;
    const route = this.data.routes[index];
    this.setData({
      showRouteForm: true,
      editingRouteIndex: index,
      routeForm: { ...route, images: [...route.images] }
    });
    this.updateGradeOptions(route.climbType);
  },

  closeRouteForm() {
    this.setData({ showRouteForm: false });
  },

  onPanelTap() {
    // 阻止事件冒泡到 mask，防止误关闭弹层
  },

  onRouteClimbTypeChange(e) {
    const climbType = this.data.climbTypes[e.detail.value];
    const routeForm = { ...this.data.routeForm, climbType, grade: '' };
    this.setData({ routeForm });
    this.updateGradeOptions(climbType);
  },

  onRouteGradeChange(e) {
    const grade = this.data.gradeOptions[e.detail.value];
    this.setData({ 'routeForm.grade': grade });
  },

  onRouteStatusSelect(e) {
    this.setData({ 'routeForm.status': e.currentTarget.dataset.status });
  },

  onRouteAttemptsPlus() {
    this.setData({ 'routeForm.attempts': this.data.routeForm.attempts + 1 });
  },

  onRouteAttemptsMinus() {
    if (this.data.routeForm.attempts > 1) {
      this.setData({ 'routeForm.attempts': this.data.routeForm.attempts - 1 });
    }
  },

  onRouteAttemptsInput(e) {
    const val = parseInt(e.detail.value) || 1;
    this.setData({ 'routeForm.attempts': Math.max(1, val) });
  },

  onRouteColorSelect(e) {
    const color = e.currentTarget.dataset.color;
    const current = this.data.routeForm.routeColor;
    this.setData({ 'routeForm.routeColor': current === color ? '' : color });
  },

  onRouteNameInput(e) {
    this.setData({ 'routeForm.routeName': e.detail.value });
  },

  onRouteAreaInput(e) {
    this.setData({ 'routeForm.routeArea': e.detail.value });
  },

  onRouteNotesInput(e) {
    this.setData({ 'routeForm.notes': e.detail.value });
  },

  // 线路表单中的 area 字段
  onRouteAreaChange(e) {
    this.setData({ 'routeForm.area': e.detail.value });
  },

  // ============================================
  // 线路图片
  // ============================================

  chooseRouteImage() {
    const remaining = 6 - this.data.routeForm.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多6张图片', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(f => f.tempFilePath);
        this.setData({
          'routeForm.images': [...this.data.routeForm.images, ...newImages]
        });
      }
    });
  },

  deleteRouteImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.routeForm.images];
    images.splice(index, 1);
    this.setData({ 'routeForm.images': images });
  },

  previewRouteImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.url,
      urls: this.data.routeForm.images
    });
  },

  // ============================================
  // 线路增删改
  // ============================================

  confirmRouteForm() {
    const form = this.data.routeForm;
    if (!form.grade) {
      wx.showToast({ title: '请选择难度', icon: 'none' });
      return;
    }

    const route = {
      id: form.id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      climbType: form.climbType,
      grade: form.grade,
      status: form.status,
      attempts: form.attempts,
      routeColor: form.routeColor,
      routeName: form.routeName,
      area: form.area,
      notes: form.notes,
      images: form.images
    };

    const routes = [...this.data.routes];
    const idx = this.data.editingRouteIndex;

    if (idx >= 0) {
      routes[idx] = route;
    } else {
      routes.push(route);
    }

    this.setData({
      routes,
      showRouteForm: false
    });

    wx.showToast({ title: idx >= 0 ? '线路已更新' : '线路已添加', icon: 'success' });
  },

  deleteRoute(e) {
    const index = e.currentTarget.dataset.index;
    wx.showModal({
      title: '确认删除',
      content: `确定删除第 ${index + 1} 条线路吗？`,
      confirmColor: '#f44336',
      success: (res) => {
        if (!res.confirm) return;
        const routes = [...this.data.routes];
        routes.splice(index, 1);
        this.setData({ routes });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  // ============================================
  // 辅助
  // ============================================

  updateGradeOptions(climbType) {
    const grades = gradeUtil.getGradeOptions(climbType);
    this.setData({ gradeOptions: grades.map(g => g.value) });
  },

  getStatusLabel(status) {
    const map = this.data.statusLabels;
    return map[status] || status;
  },

  isCompleted(status) {
    return status === 'flash' || status === 'completed';
  },

  // ============================================
  // 保存 Session
  // ============================================

  async submitSession() {
    // 校验
    if (!this.data.date) {
      wx.showToast({ title: '请选择日期', icon: 'none' });
      return;
    }
    if (!this.data.location) {
      wx.showToast({ title: '请输入岩馆/地点', icon: 'none' });
      return;
    }
    if (this.data.routes.length === 0) {
      wx.showToast({ title: '请至少添加一条线路', icon: 'none' });
      return;
    }
    if (this.data.isSubmitting) return;

    this.setData({ isSubmitting: true });

    try {
      // 收集所有需要上传的图片（localPaths only）
      const allLocalImages = [];
      this.data.routes.forEach(route => {
        route.images.forEach(img => {
          if (!img.startsWith('cloud://')) {
            allLocalImages.push(img);
          }
        });
      });

      // 上传图片
      const pathToFileID = {};
      if (allLocalImages.length > 0) {
        for (let i = 0; i < allLocalImages.length; i++) {
          wx.showLoading({ title: `上传图片 ${i + 1}/${allLocalImages.length}...` });
          const res = await db.uploadImage(allLocalImages[i]);
          if (!res.success) {
            wx.hideLoading();
            wx.showToast({ title: `第${i + 1}张图片上传失败`, icon: 'none' });
            this.setData({ isSubmitting: false });
            return;
          }
          pathToFileID[allLocalImages[i]] = res.data;
        }
      }

      // 替换 routes 中的图片路径为 fileID
      const routes = this.data.routes.map(route => ({
        ...route,
        images: route.images.map(img => pathToFileID[img] || img)
      }));

      // 保存 Session（新建或更新）
      wx.showLoading({ title: '保存中...' });
      const sessionData = {
        date: this.data.date,
        location: this.data.location,
        notes: this.data.notes,
        visibility: this.data.visibility,
        routes
      };

      let res;
      if (this.data.editingSessionId) {
        res = await db.updateSession(this.data.editingSessionId, sessionData);
      } else {
        res = await db.createSession(sessionData);
      }

      wx.hideLoading();

      if (res.success) {
        wx.showToast({ title: this.data.editingSessionId ? '更新成功' : '保存成功', icon: 'success' });
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages.length > 1) {
            wx.navigateBack();
          } else {
            wx.switchTab({ url: '/pages/record-list/record-list' });
          }
        }, 1500);
      } else {
        wx.showToast({ title: '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
      console.error('[Submit]', err);
    }

    this.setData({ isSubmitting: false });
  }
});
