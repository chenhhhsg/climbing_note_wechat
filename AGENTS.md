# 攀笔（Climbing Note）项目规范

本文件同时被 Codex 与 ZCode 读取。角色边界见 `roles/`，协作流程见 `WORKFLOW.md`。

## 项目

- 微信原生小程序，源码根目录即本仓库；云开发目录 `cloudbase/`。
- 2026-11-21 进度。2026-11-20 复审三批已通过手机验收并合入主线，覆盖修补、现场页面调整和文本备份与恢复。真实云接通、迁移与模型复盘另行排期。路线图见 `ROADMAP.md`。
- 本地环境：Windows + PowerShell 5.1 + Node 24。离线测试用 `node --test`。

## 硬性约束

- 不擅自更换技术栈（不改写为 uni-app / Flutter），不迁移数据库。
- 旧数据（`climbing_records`、`climbing_sessions.routes[]`、历史 attempts、好友权限）只做兼容读取，不删除、不改写、不伪造迁移。
- 不提交密钥、云环境凭据、真实用户视频或个人数据。
- 不自动 `git push`、`merge`、`rebase --force`、部署云函数、修改 AppID 或云环境 ID。
- 用户体感与 AI 推测分开存储；视频时间戳必须对应原视频。

## 开发规则

- 只做 `tasks/` 中 `status: approved` 的任务；范围外的问题记下来交回项目经理，不顺手改。
- 修改前先读任务单的范围、禁止项和验收标准。
- 完成后必须报告：改了哪些文件、执行了哪些命令、真实输出、哪些未验证。
- 离线测试通过只代表页面逻辑通过；真机、云环境、模型准确率必须单独标注 `待验`。

## 任务与审核

- 任务单 frontmatter 字段：`id` / `status` / `owner` / `baseline` / `scope` / `test_command` / `approved_hash`。
- 状态流转：`draft → approved → in_review → done`；返工走 `changes_requested → approved`。
- Codex 只读巡检与评审，输出 `PASS` / `CHANGES_REQUESTED` / `BLOCKED` 和证据；不得修改业务代码。
- 脚本不自动合并、推送或部署；最终由人确认。
