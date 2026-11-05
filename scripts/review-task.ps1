# 用法： .\scripts\review-task.ps1 -TaskId T001
# 对当前工作区（允许未提交改动）做只读审核，适合审查已有成果或返工后的复审。
# 不创建 worktree，不修改任何文件。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskId,
    [string]$Repo = '.',
    [string]$Model = 'gpt-5.6-terra',
    [string]$Effort = 'high',
    [string]$Baseline = '',
    [string]$TestCommand = '',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

if ($TaskId -notmatch '^T[0-9]{3,6}$') { throw 'TaskId 形如 T001。' }

$root = Get-RepoRoot $Repo
$taskPath = Join-Path $root ("tasks\{0}.md" -f $TaskId)
$task = Get-Task $taskPath

if (-not $Baseline) { $Baseline = [string]$task.Meta['baseline'] }
if (-not $Baseline) { $Baseline = (& git -C $root rev-parse --short HEAD).Trim() }
& git -C $root rev-parse --verify --quiet ($Baseline + '^{commit}') | Out-Null
if ($LASTEXITCODE -ne 0) { throw "基线提交无效：$Baseline" }

$scope = Get-ScopeArgs $task
$scopeText = '全部改动'
$diffPaths = ''
if ($scope.Count -gt 0) {
    $scopeText = ($scope -join ', ')
    $diffPaths = '-- ' + (($scope | ForEach-Object { '"' + $_ + '"' }) -join ' ')
}
$diffCommand = ('git diff ' + $Baseline + ' ' + $diffPaths).Trim()

if (-not $TestCommand) { $TestCommand = [string]$task.Meta['test_command'] }

$test = [pscustomobject]@{ Skipped = $true; ExitCode = $null; Command = ''; Output = '' }
if (-not $SkipTests) {
    Write-Host '运行验证命令（脚本侧独立执行）...' -ForegroundColor Cyan
    $test = Invoke-TestCommand -WorkDir $root -Command $TestCommand
    if ($test.Skipped) {
        Write-Host '任务未提供 test_command，已跳过。'
    } else {
        Write-Host $test.Output
        Write-Host ("验证命令退出码：{0}" -f $test.ExitCode)
    }
}

$testOutput = $test.Output
if ($testOutput.Length -gt 12000) {
    $testOutput = $testOutput.Substring(0, 4000) + "`n...[输出已截断]...`n" + $testOutput.Substring($testOutput.Length - 7000)
}

$pmRole = ''
$pmRolePath = Join-Path $root 'roles\codex-pm.md'
if (Test-Path -LiteralPath $pmRolePath) { $pmRole = Read-Utf8 $pmRolePath }

$reviewPrompt = @"
$pmRole

这是审核阶段，只读。禁止修改任何文件，禁止 git commit / merge / push / 部署。

任务单：tasks/$TaskId.md
仓库：$root
基线提交：$Baseline
改动范围：$scopeText
当前工作区可能包含未提交改动与未跟踪文件，以工作区实际内容为准。

验证命令：$TestCommand
脚本侧执行结果（退出码 $($test.ExitCode)）：
$testOutput

请按以下步骤工作：
1. 阅读 AGENTS.md 和任务单，列出验收标准。
2. 运行：git status --short --untracked-files=all；$diffCommand；git diff --stat $Baseline。未跟踪的新文件直接读取内容。
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
Invoke-Codex -Repo $root -Prompt $reviewPrompt -OutFile $reviewFile -LogFile $reviewLog -Model $Model -Effort $Effort | Out-Null

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
Write-Host ("审核报告：{0}" -f $reviewFile)
if ($verdict) { Write-Host ("审核结论：{0}" -f $verdict.verdict) -ForegroundColor Yellow }
Write-Host '本脚本只读，未修改任何代码。'
