# 用法： .\scripts\run-approved-task.ps1 -TaskId T002
# 在独立 worktree 中调用 ZCode 开发，再由 Codex 只读审核。不会自动合并、推送或部署。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskId,
    [string]$Repo = '.',
    [string]$Model = 'gpt-5.6-terra',
    [string]$Effort = 'high',
    [string]$TestCommand = '',
    [string]$RunToken = '',
    [switch]$DevOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

if ($TaskId -notmatch '^T[0-9]{3,6}$') { throw 'TaskId 形如 T001。' }

$root = Get-RepoRoot $Repo
$taskPath = Join-Path $root ("tasks\{0}.md" -f $TaskId)
$task = Get-Task $taskPath

$status = [string]$task.Meta['status']
if ($status -ne 'approved') { throw "任务状态不是 approved，拒绝执行（当前：$status）。" }

$approvedHash = [string]$task.Meta['approved_hash']
if ($approvedHash.Length -eq 0) { throw '任务缺少 approved_hash，请用 approve-task.ps1 重新批准。' }
if ((Get-BodyHash $task.Body) -ne $approvedHash) { throw '任务正文在批准后被修改，拒绝执行。请重新批准。' }

Assert-CleanTree $root
Assert-Tracked $root 'AGENTS.md'
Assert-Tracked $root ("tasks/{0}.md" -f $TaskId)

$base = (& git -C $root rev-parse HEAD).Trim()
$branch = ('feat/' + $TaskId)
$workRoot = Join-Path $root '.worktrees'
$worktree = Join-Path $workRoot $TaskId

if (Test-Path -LiteralPath $worktree) { throw "工作区已存在：$worktree。先检查或手动删除。" }
& git -C $root show-ref --verify --quiet ("refs/heads/" + $branch)
if ($LASTEXITCODE -eq 0) { throw "分支已存在：$branch。请先处理旧分支或 worktree。" }

$scope = Get-ScopeArgs $task
if (-not $TestCommand) { $TestCommand = [string]$task.Meta['test_command'] }

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
& git -C $root worktree add -b $branch $worktree $base
if ($LASTEXITCODE -ne 0) { throw 'git worktree add 失败。' }
Write-Host ("工作区：{0}" -f $worktree) -ForegroundColor Cyan
Write-Host ("分支：{0}（基线 {1}）" -f $branch, $base)

Write-Warning 'ZCode 将以 --mode yolo 运行。这不是安全沙箱，请确认工作区与提示词中不含生产密钥。'
$expectedRunToken = ('RUN-' + $TaskId)
if ($RunToken.Length -gt 0) {
    if ($RunToken -cne $expectedRunToken) { throw ("运行口令不正确，应为 {0}。worktree 已创建但未执行 ZCode。" -f $expectedRunToken) }
    Write-Host ("运行口令已提供：{0}" -f $expectedRunToken)
} else {
    $answer = Read-Host ("输入 RUN-{0} 开始开发" -f $TaskId)
    if ($answer -cne $expectedRunToken) {
        Write-Host ("已取消。worktree 保留在：{0}" -f $worktree)
        exit 1
    }
}

$devRole = ''
$devRolePath = Join-Path $root 'roles\zcode-dev.md'
if (Test-Path -LiteralPath $devRolePath) { $devRole = Read-Utf8 $devRolePath }

$devPrompt = @"
$devRole

工作目录：$worktree
任务单：tasks/$TaskId.md

先读 AGENTS.md 和任务单，只在批准范围内修改。要求：
- 实际运行任务单给出的验证命令，如实报告结果，不得声称未执行的测试已通过。
- 不修改任务单的 status / approved_hash，不修改 pm-reports。
- 不 git push / merge / rebase / 部署，不访问真实用户数据。
- 完成后简要列出：改动文件、执行的命令、真实结果、未验证项。
"@

$zcodeLog = Join-Path $root ("pm-reports\{0}-zcode.log" -f $TaskId)
Write-Host ''
Write-Host '调用 ZCode 开发...' -ForegroundColor Cyan
$zcode = Invoke-Zcode -WorkDir $worktree -Prompt $devPrompt -LogFile $zcodeLog -Mode 'yolo'
Write-Host ("ZCode 退出码：{0}" -f $zcode.ExitCode) -ForegroundColor Cyan

$statusLines = @(& git -C $worktree status --short --untracked-files=all)
$diffStat = @(& git -C $worktree diff --stat $base)
$evidenceFile = Join-Path $root ("pm-reports\{0}-worktree-status.txt" -f $TaskId)
Write-Utf8 $evidenceFile ("## git status`r`n" + ($statusLines -join "`n") + "`r`n`r`n## diff --stat`r`n" + ($diffStat -join "`n"))

Write-Host ''
Write-Host '运行验证命令（脚本侧独立执行）...' -ForegroundColor Cyan
$test = Invoke-TestCommand -WorkDir $worktree -Command $TestCommand
if ($test.Skipped) {
    Write-Host '任务未提供 test_command，已跳过。'
} else {
    Write-Host $test.Output
    Write-Host ("验证命令退出码：{0}" -f $test.ExitCode)
}

$testOutput = $test.Output
if ($testOutput.Length -gt 12000) {
    $testOutput = $testOutput.Substring(0, 4000) + "`n...[输出已截断]...`n" + $testOutput.Substring($testOutput.Length - 7000)
}
$scopeText = '全部改动'
$diffPaths = ''
if ($scope.Count -gt 0) {
    $scopeText = ($scope -join ', ')
    $diffPaths = '-- ' + (($scope | ForEach-Object { '"' + $_ + '"' }) -join ' ')
}
$diffCommand = ('git diff ' + $base + ' ' + $diffPaths).Trim()

if ($DevOnly) {
    Write-Host ''
    Write-Host '=== 开发完成（未审核，-DevOnly）===' -ForegroundColor Green
    Write-Host ("工作区：{0}" -f $worktree)
    Write-Host ("分支：{0}（基线 {1}）" -f $branch, $base)
    Write-Host ("Git 状态：{0}" -f $evidenceFile)
    Write-Host ("ZCode 退出码：{0}" -f $zcode.ExitCode)
    Write-Host ''
    Write-Host '交回项目经理审核。建议命令：' -ForegroundColor Yellow
    Write-Host ('  git -C "{0}" status --short --untracked-files=all' -f $worktree)
    Write-Host ('  {0}' -f $diffCommand)
    Write-Host '审核结论写入 pm-reports\<任务号>-review.md 和 -verdict.json，不要自动合并或推送。'
    exit 0
}

$pmRole = ''
$pmRolePath = Join-Path $root 'roles\codex-pm.md'
if (Test-Path -LiteralPath $pmRolePath) { $pmRole = Read-Utf8 $pmRolePath }

$reviewPrompt = @"
$pmRole

这是审核阶段，只读。禁止修改任何文件，禁止 git commit / merge / push / 部署。

任务单：tasks/$TaskId.md
开发工作区：$worktree
基线提交：$base
改动范围：$scopeText
ZCode 退出码：$($zcode.ExitCode)
ZCode 原始日志：pm-reports/$TaskId-zcode.log

验证命令：$TestCommand
脚本侧执行结果（退出码 $($test.ExitCode)）：
$testOutput

请按以下步骤工作：
1. 阅读 AGENTS.md 和任务单，列出验收标准。
2. 在开发工作区运行：git status --short --untracked-files=all；$diffCommand；git diff --stat $base。未跟踪的新文件直接读取内容。
3. 逐条核对验收标准，只依据实际代码和命令输出，不推测。
4. 检查是否有超出范围的改动、密钥或真实数据、旧数据兼容性问题、测试是否真正覆盖声明的行为。
5. 单独列出未验证项（真机、开发者工具、云环境、模型准确率等）。

输出 Markdown 报告，包含：
## 结论
## 逐条验收（表格：编号 / 结果 / 证据）
## 越界与风险
## 未验证项
## 返工要求（仅在 CHANGES_REQUESTED 或 BLOCKED 时）

报告最后必须紧跟以下块，不要放进代码围栏：
<verdict>
{"task_id":"$TaskId","verdict":"PASS|CHANGES_REQUESTED|BLOCKED","criteria":[{"id":"...","result":"PASS|FAIL|UNVERIFIED","evidence":"..."}],"blocking_issues":[],"unverified":[],"summary":"..."}
</verdict>
"@

$reviewFile = Join-Path $root ("pm-reports\{0}-review.md" -f $TaskId)
$reviewLog = Join-Path $root ("pm-reports\{0}-review.log" -f $TaskId)

Write-Host ''
Write-Host '调用 Codex 只读审核...' -ForegroundColor Cyan
Invoke-Codex -Repo $worktree -Prompt $reviewPrompt -OutFile $reviewFile -LogFile $reviewLog -Model $Model -Effort $Effort | Out-Null

$report = Read-Utf8 $reviewFile
$verdict = Get-Verdict $report
$verdictFile = Join-Path $root ("pm-reports\{0}-verdict.json" -f $TaskId)
if ($verdict) {
    Write-Utf8 $verdictFile ($verdict | ConvertTo-Json -Depth 8)
} else {
    Write-Warning '未能从报告中解析 <verdict> 块，请人工阅读报告，不要当作通过。'
}

Write-Host ''
Write-Host '=== 完成 ===' -ForegroundColor Green
Write-Host ("ZCode 退出码：{0}" -f $zcode.ExitCode)
Write-Host ("工作区：{0}" -f $worktree)
Write-Host ("Git 状态：{0}" -f $evidenceFile)
Write-Host ("审核报告：{0}" -f $reviewFile)
if ($verdict) { Write-Host ("审核结论：{0}" -f $verdict.verdict) -ForegroundColor Yellow }
Write-Host '脚本不会合并、推送或发布。请人工审阅 diff 与报告后再决定。'
