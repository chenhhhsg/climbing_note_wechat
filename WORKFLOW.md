# Codex PM × ZCode Dev 协作流程

Codex 负责规划与审核，ZCode 负责实现，Git worktree 提供隔离。脚本不会自动合并、推送或部署。

## 目录

| 路径 | 作用 | 谁维护 |
|---|---|---|
| `AGENTS.md` | 两个 Agent 共同遵守的项目规范 | 人 |
| `ROADMAP.md` | 阶段目标与阻塞 | Codex |
| `roles/codex-pm.md` | 项目经理职责 | 人 |
| `roles/zcode-dev.md` | 开发工程师职责 | 人 |
| `tasks/T001.md` | 任务单（frontmatter 带状态与哈希） | Codex 起草，人批准 |
| `scripts/` | 协作脚本 | 人 |
| `pm-reports/` | 审核报告、裁决 JSON、运行日志 | 脚本生成 |

## 日常流程

### 1. 生成任务

```powershell
.\scripts\plan-task.ps1 -TaskId T002 -Requirement "支持从手机相册选择视频并在详情页播放"
```

Codex 以只读方式检查仓库，把任务草稿写到 `tasks/T002.md`，`status: draft`。
人工审查范围、验收标准和禁止项，可直接编辑该文件。

### 2. 批准

```powershell
.\scripts\approve-task.ps1 -TaskId T002
```

脚本检查必需章节，要求输入 `APPROVE-T002`，然后写入正文哈希与 `status: approved`。
提交任务单，worktree 才能读到它：

```powershell
git add tasks/T002.md AGENTS.md roles scripts tasks
git commit -m "chore(task): approve T002"
```

### 3. 开发 + 审核

```powershell
.\scripts\run-approved-task.ps1 -TaskId T002
```

脚本依次做：

1. 校验 `approved_hash` 与正文一致、主仓库干净、任务单已入库。
2. 在 `.worktrees\T002` 建 `feat/T002` 独立 worktree。
3. 要求输入 `RUN-T002` 后，ZCode 以 headless `--mode yolo` 执行任务。
4. 脚本自己再跑一次任务里的 `test_command`，留下真实输出。
5. Codex 以 `--sandbox read-only` 审核 worktree，输出报告与 `<verdict>` JSON。

产物在 `pm-reports/`：`T002-review.md`、`T002-verdict.json`、`T002-zcode.log`、`T002-worktree-status.txt`。

两个确认口令也可以作为参数传入，便于从 Codex 等非交互环境调用：

```powershell
.\scripts\approve-task.ps1 -TaskId T002 -ApproveToken APPROVE-T002
.\scripts\run-approved-task.ps1 -TaskId T002 -RunToken RUN-T002
```

### 4. 复审已有改动

```powershell
.\scripts\review-task.ps1 -TaskId T001
```

不建 worktree，直接审当前工作区（允许未提交改动）。适合审查历史成果或返工后复审。

注意：它会把工作区里与本任务无关的未跟踪文件判为“范围污染”。先提交基础设施或其他任务，再复审本任务，能得到更干净的结论。

### 5. 查看状态

```powershell
.\scripts\status.ps1
```

## Codex 主导模式（在 Codex 会话里驱动 ZCode）

如果你习惯在 Codex 里工作，可以让 Codex 当司机，ZCode 只负责开发：

1. Codex 自己读 `ROADMAP.md`、`tasks/`、上次裁决，写 `tasks/Txxx.md`。
2. 你审查并批准（`approve-task.ps1 -ApproveToken`），提交任务单。
3. Codex 运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-approved-task.ps1 -TaskId Txxx -RunToken RUN-Txxx -DevOnly
```

4. 脚本建 `.worktrees\Txxx`、调用 ZCode、跑验证命令后停下，不启动第二个 Codex。
5. Codex 在当前会话里读 diff、逐条核对验收标准，自己写 `pm-reports\Txxx-review.md` 和 `Txxx-verdict.json`。
6. Codex 更新任务状态与 `ROADMAP.md`，把结论交给你决定是否合并。

这样只有 Codex 一个"大脑"，ZCode 不参与判断，只执行任务单。

## 状态与结论

```text
draft ──approve──> approved ──run──> in_review ──人确认──> done
                        ^                 │
                        └── changes_requested
```

- `PASS`：验收项有证据支持；仍需人决定是否合并、何时真机验证。
- `CHANGES_REQUESTED`：报告里有具体返工项；改完再跑 `review-task.ps1`。
- `BLOCKED`：缺环境、缺权限或缺关键信息，先解决再继续。
- 没有 `<verdict>` 块：视为未审核，不得当作通过。

## 安全边界

- ZCode 的 `yolo` 不是安全沙箱，worktree 只隔离代码，不隔离本机文件与凭据。
- 第一次使用先在不含生产密钥的仓库验证；真实云环境只做只读核对。
- Codex 全程 `read-only`，脚本不会替它提升权限。
- 脚本不执行 `git push` / `merge` / `rebase` / 部署。

## 故障排查

| 现象 | 处理 |
|---|---|
| `codex` 返回 429 | 默认模型 `gpt-6-astra` 当前被限流；脚本默认用 `gpt-5.6-terra`，也可 `-Model` 指定 |
| 提示找不到 `zcode` | 脚本会自动回退到桌面版内置 CLI；手动使用可运行 `scripts\bin\zcode.cmd` |
| 脚本无法执行 | `powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1` |
| 中文乱码 | 本目录 `.ps1` 均为 UTF-8 with BOM；不要用记事本另存为 ANSI |
| ZCode 报 `无法定位 CLI ZCode Built-in Provider Config` | 启动环境没有继承桌面版的环境变量；脚本已显式指向 `resources\config\provider` 与 `~\.zcode\v2\provider_config.json`，确认这两个文件存在 |
| 任务被拒绝执行 | 正文在批准后改过；重新 `approve-task.ps1` |
| worktree 已存在 | 检查 `.worktrees\<任务号>`，确认后可删除目录与 `feat/<任务号>` 分支 |
