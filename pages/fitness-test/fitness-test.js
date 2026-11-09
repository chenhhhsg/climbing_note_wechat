/**
 * 9c 攀岩体能自测页（T020）
 *
 * 从「我的 → 体能自测」进入，走通一次真实自测录入与复测比较：
 * 先看测什么、需要什么器材与动作标准（说明与算法来自 docs/product/9c攀岩体能自测-v0.1.md），
 * 再填测试日期、当日体重、指力与拉力各自的额外负重、核心动作与秒数、悬挂秒数，
 * 页面即时显示已有分项，四项填齐后显示总分与三对照。
 *
 * 数据层只用 utils/fitness-test.js（本机独立命名空间 climbingNote.fitness.v1.）：
 * - 本页不接云、不读旧记录、不写训练档案，也不上传原始数据与个人资料，断网可用；
 * - 保存＝新建一次录入（用本实例为该次录入生成的测试 ID，重试幂等，不重复）；
 *   已保存后再次保存＝原位修改那一条（只换输入与评分，不新增第二条）；
 *   「新建复测」开一次新的录入，另存一条；
 * - 落盘失败不报「已保存」：页面提示未保存，重试沿用同一个测试 ID；
 *   原记录保持不动，不丢原成绩。
 *
 * 自测不是记线路的前置条件：本页不创建线路、不写把次，也不改任何训练数据；
 * 抱石对照只是跨项目参考标签，不代表实际完攀能力。
 */
const fitness = require('../../utils/fitness-test.js');

const LOAD_STATE_LABELS = fitness.LOAD_STATES.map(item => item.label);
const CORE_ACTION_LABELS = fitness.CORE_ACTIONS.map(item => item.label);

/** 空表单：日期默认本地当天，其余留空（留空＝未测）。 */
function emptyForm(date) {
  return {
    date: date || fitness.todayLocalDate(),
    weightKg: '',
    fingerStateIndex: 0,
    fingerExtraKg: '',
    pullStateIndex: 0,
    pullExtraKg: '',
    coreActionIndex: -1,
    coreSeconds: '',
    hangSeconds: ''
  };
}

/** 已存记录 → 表单值（「修改」与保存后回填共用）。 */
function formFromRecord(record) {
  const stateIndex = value => {
    const index = fitness.LOAD_STATES.findIndex(entry => entry.value === value);
    return index === -1 ? 0 : index;
  };
  const actionIndex = record.core && record.core.action
    ? fitness.CORE_ACTIONS.findIndex(entry => entry.key === record.core.action)
    : -1;
  const secondsText = value => (value === null || value === undefined ? '' : String(value));
  return {
    date: record.date,
    weightKg: String(record.weightKg),
    fingerStateIndex: stateIndex(record.finger ? record.finger.state : 'untested'),
    fingerExtraKg: record.finger && record.finger.state === 'done' ? String(record.finger.extraKg) : '',
    pullStateIndex: stateIndex(record.pull ? record.pull.state : 'untested'),
    pullExtraKg: record.pull && record.pull.state === 'done' ? String(record.pull.extraKg) : '',
    coreActionIndex: actionIndex,
    coreSeconds: secondsText(record.core ? record.core.seconds : null),
    hangSeconds: secondsText(record.hang ? record.hang.seconds : null)
  };
}

/** 记录行摘要：四项各自的分项得分，便于在列表里一眼看出缺哪项。 */
function itemsTextOf(row) {
  return row.items.map(item => item.label + ' ' + item.pointsText).join(' · ');
}

function emptyPreview() {
  return {
    items: [],
    measuredCountText: '还没有已测分项',
    totalText: '四项都测后才显示总分',
    gradeLines: [],
    complete: false
  };
}

Page({
  data: {
    loadError: '',      // 本机自测记录损坏/版本不支持/读取失败时的可见报错
    storageError: '',   // 本次保存未落盘（不报已保存）
    notice: '',         // 说明性提示，不改数据

    // 说明区
    specVersionText: '9c 攀岩体能自测 v0.1',
    tableVersionText: '对照表 ' + fitness.TABLE_VERSION,

    // 表单
    formVisible: true,
    formTitle: '录入一次自测',
    editingText: '',
    date: '',
    weightKg: '',
    loadStateLabels: LOAD_STATE_LABELS,
    fingerStateIndex: 0,
    fingerExtraKg: '',
    fingerDone: false,
    pullStateIndex: 0,
    pullExtraKg: '',
    pullDone: false,
    coreActionLabels: CORE_ACTION_LABELS,
    coreActionIndex: -1,
    coreSeconds: '',
    hangSeconds: '',
    formError: '',

    // 即时结果
    preview: emptyPreview(),

    // 已保存记录与比较
    records: [],
    recordCountText: '还没有自测记录',
    archiveText: '',
    selectedIds: [],
    canCompare: false,
    comparison: null
  },

  onLoad() {
    // 本实例的临时状态，全部不落盘：
    // _draftId  当前这次录入的测试 ID（新建时为它生成一次，重试与再次保存都用它）；
    // _state    最近一次读到的本机自测记录（保存后同步更新，不整片写回）。
    this._draftId = '';
    this._state = fitness.createEmptyState();
    this.loadPage();
  },

  onShow() {
    // 只在记录可读时刷新已保存列表（表单里正在输入的内容不动）。
    if (this.data.loadError) return;
    this.refreshRecords();
  },

  /**
   * 读取本机自测记录（首次进入、重试读取、返回本页都走这里）。
   * 损坏或版本不支持时只显示错误，不写盘、不覆盖原数据。
   */
  loadPage() {
    const loaded = fitness.loadState();
    this._state = loaded.state;

    if (!loaded.ok) {
      this.setData({
        loadError: loaded.error,
        formVisible: false,
        editingText: '',
        preview: emptyPreview(),
        records: [],
        recordCountText: '自测记录不可读',
        archiveText: '',
        selectedIds: [],
        canCompare: false,
        comparison: null
      });
      return;
    }

    const form = emptyForm(this.data.date);
    this.setData(
      Object.assign({ loadError: '', formVisible: true, formError: '', storageError: '' }, form, {
        fingerDone: form.fingerStateIndex === 1,
        pullDone: form.pullStateIndex === 1,
        formTitle: '录入一次自测',
        editingText: ''
      })
    );
    this._draftId = fitness.newTestId();
    this.refreshPreview();
    this.refreshRecords();
  },

  retryLoad() {
    this.loadPage();
  },

  dismissStorageError() {
    this.setData({ storageError: '' });
  },

  dismissNotice() {
    this.setData({ notice: '' });
  },

  // ---------------------------------------------------------------- 表单输入

  formModel() {
    return {
      date: this.data.date,
      weightKg: this.data.weightKg,
      fingerState: fitness.LOAD_STATES[this.data.fingerStateIndex].value,
      fingerExtraKg: this.data.fingerExtraKg,
      pullState: fitness.LOAD_STATES[this.data.pullStateIndex].value,
      pullExtraKg: this.data.pullExtraKg,
      coreAction: this.data.coreActionIndex >= 0
        ? fitness.CORE_ACTIONS[this.data.coreActionIndex].key
        : '',
      coreSeconds: this.data.coreSeconds,
      hangSeconds: this.data.hangSeconds
    };
  },

  onDateChange(event) {
    const value = event && event.detail ? event.detail.value : '';
    this.setData({ date: value });
    this.refreshPreview();
  },

  onWeightInput(event) {
    this.setData({ weightKg: event.detail.value });
    this.refreshPreview();
  },

  onFingerStateChange(event) {
    const index = Number(event.detail.value);
    this.setData({ fingerStateIndex: index, fingerDone: index === 1 });
    this.refreshPreview();
  },

  onFingerExtraInput(event) {
    this.setData({ fingerExtraKg: event.detail.value });
    this.refreshPreview();
  },

  onPullStateChange(event) {
    const index = Number(event.detail.value);
    this.setData({ pullStateIndex: index, pullDone: index === 1 });
    this.refreshPreview();
  },

  onPullExtraInput(event) {
    this.setData({ pullExtraKg: event.detail.value });
    this.refreshPreview();
  },

  onCoreActionChange(event) {
    const index = Number(event.detail.value);
    this.setData({ coreActionIndex: index });
    this.refreshPreview();
  },

  onCoreSecondsInput(event) {
    this.setData({ coreSeconds: event.detail.value });
    this.refreshPreview();
  },

  onHangSecondsInput(event) {
    this.setData({ hangSeconds: event.detail.value });
    this.refreshPreview();
  },

  /** 即时结果：只按当前表单重算展示，不写盘。 */
  refreshPreview() {
    let evaluated;
    try {
      evaluated = fitness.evaluateForm(this.formModel());
    } catch (error) {
      return;
    }
    this.setData({
      preview: {
        items: evaluated.items.map(item => ({
          key: item.key,
          label: item.label,
          statusText: item.statusText,
          pointsText: item.pointsText,
          rawText: item.rawText,
          levelText: item.levelText || ''
        })),
        measuredCountText: '已测 ' + evaluated.measuredCount + ' / 4 项',
        totalText: evaluated.totalText,
        gradeLines: evaluated.gradeLines,
        complete: evaluated.complete
      }
    });
  },

  // ---------------------------------------------------------------- 保存与修改

  /**
   * 保存本次录入：第一次保存＝新建（测试 ID 已在本实例生成，重试幂等），
   * 已保存后再次保存＝原位修改那一条，不新增第二条。
   */
  saveTest() {
    if (!this._draftId) this._draftId = fitness.newTestId();
    const result = fitness.saveTest(this.formModel(), { testId: this._draftId });

    if (!result.ok) {
      this.setData({
        storageError: result.error,
        formError: result.code === 'invalid' ? result.error : '',
        notice: ''
      });
      return result;
    }

    this._state = result.state;
    this._draftId = result.record.id;
    const created = result.code === 'created';
    const form = formFromRecord(result.record);
    this.setData(
      Object.assign({}, form, {
        fingerDone: form.fingerStateIndex === 1,
        pullDone: form.pullStateIndex === 1,
        storageError: '',
        formError: '',
        formTitle: '修改这次录入',
        editingText: created
          ? '已保存，可继续改正这次录入（不新增第二条）'
          : '已更新这次录入',
        notice: created ? '已保存本次自测（只存本机）' : '已更新这次录入（只存本机）'
      })
    );
    this.refreshPreview();
    this.refreshRecords();
    // 已选中的两次比较也跟着重算：改正其中一条后，对比读数是新的。
    this.refreshComparison();
    return result;
  },

  /** 新建复测：开一次全新的录入，保存后另存一条。 */
  startNewTest() {
    this._draftId = fitness.newTestId();
    const form = emptyForm(this.data.date);
    this.setData(
      Object.assign({}, form, {
        fingerDone: false,
        pullDone: false,
        formTitle: '录入一次自测',
        editingText: '复测：保存后另存一条，不会改动已存记录',
        formError: '',
        storageError: '',
        notice: ''
      })
    );
    this.refreshPreview();
  },

  /** 「修改」：把已存记录读回表单，之后保存只更新这一条。 */
  editRecord(event) {
    const id = event && event.currentTarget ? event.currentTarget.dataset.id : '';
    const record = fitness.findTest(this._state, id);
    if (!record) {
      this.setData({ storageError: '找不到这条自测记录，可能已被清除' });
      return;
    }
    this._draftId = record.id;
    const form = formFromRecord(record);
    this.setData(
      Object.assign({}, form, {
        fingerDone: form.fingerStateIndex === 1,
        pullDone: form.pullStateIndex === 1,
        formTitle: '修改这次录入',
        editingText: '修改 ' + record.date + ' 的录入：保存只更新这一条，不新增',
        formError: '',
        storageError: '',
        notice: ''
      })
    );
    this.refreshPreview();
  },

  // ---------------------------------------------------------------- 记录与比较

  refreshRecords() {
    const rows = fitness.listTests(this._state).map(row => ({
      id: row.id,
      date: row.dateText,
      totalText: row.totalText,
      gradeText: row.gradeText,
      itemsText: itemsTextOf(row),
      tableVersionText: row.tableVersionText,
      selected: this.data.selectedIds.indexOf(row.id) !== -1
    }));
    this.setData({
      records: rows,
      recordCountText: rows.length ? '共 ' + rows.length + ' 条' : '还没有自测记录',
      archiveText: this._state.archiveId ? '自测档案 ' + this._state.archiveId : ''
    });
  },

  /** 选择两条记录做比较；已经选满两条时，新选的一条替换更早选中的那条。 */
  toggleCompare(event) {
    const id = event && event.currentTarget ? event.currentTarget.dataset.id : '';
    if (!id) return;
    const selected = this.data.selectedIds.slice();
    const index = selected.indexOf(id);
    let notice = '';
    if (index !== -1) {
      selected.splice(index, 1);
    } else {
      if (selected.length >= 2) {
        selected.shift();
        notice = '只比较最近选中的两次';
      }
      selected.push(id);
    }
    this.setData({ selectedIds: selected, notice: notice });
    this.refreshRecords();
    this.refreshComparison();
  },

  clearCompare() {
    this.setData({ selectedIds: [], canCompare: false, comparison: null });
    this.refreshRecords();
  },

  refreshComparison() {
    const selected = this.data.selectedIds;
    if (selected.length !== 2) {
      this.setData({ canCompare: false, comparison: null });
      return;
    }
    const compared = fitness.compareTests(this._state, selected[0], selected[1]);
    this.setData({
      canCompare: compared.ok,
      comparison: compared.ok ? compared : null,
      storageError: compared.ok ? '' : compared.error
    });
  }
});
