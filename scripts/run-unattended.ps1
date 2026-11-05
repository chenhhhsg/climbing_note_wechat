# 用法：
#   .\scripts\run-unattended.ps1 -TaskId T003 -MaxAttempts 3 -RunToken RUN-T003
#   可选自动合并：-AutoMerge -MergeToken MERGE-T003
#   只演练不执行：-DryRun
#
# 无人值守地跑完一个已批准任务：ZCode 实现 -> 脚本跑测试 -> Codex 审核 ->
# 若 CHANGES_REQUESTED 则带着返工要求再来一轮，直到 PASS / BLOCKED / 次数用尽。
# 不 push、不部署。AutoMerge 仅在 PASS 且改动全部在 scope 内时执行。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskId,
    [string]$Repo = '.',
    [string]$Model = 'gpt-5.6-terra',
    [string]$Effort = 'high',
    [int]$MaxAttempts = 3,
    [string]$RunToken = '',
    [switch]$AutoMerge,
    [string]$MergeToken = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

if ($TaskId -notmatch '^T[0-9]{3,6}$') { throw 'TaskId 形如 T001。' }
if ($MaxAttempts -lt 1) { throw 'MaxAttempts 至少为 1。' }

$root = Get-RepoRoot $Repo
$taskPath = Join-Path $root ("tasks\{0}.md" -f $TaskId)
$task = Get-Task $taskPath

$status = [string]$task.Meta['status']
$approvedHash = [string]$task.Meta['approved_hash']
$hashOk = ($approvedHash.Length -gt 0 -and (Get-BodyHash $task.Body) -eq $approvedHash)
$scope = Get-ScopeArgs $task
$testCommand = [string]$task.Meta['test_command']

$base = (& git -C $root rev-parse HEAD).Trim()
$branch = ('feat/' + $TaskId)
$worktree = Join-Path $root ('.worktrees\' + $TaskId)

$title = $TaskId
$titleMatch = [regex]::Match($task.Body, '(?m)^#\s+(.+)$')
if ($titleMatch.Success) { $title = $titleMatch.Groups[1].Value.Trim() }

if ($DryRun) {
    Write-Host '=== DRY RUN ===' -ForegroundColor Cyan
    Write-Host ("任务：{0}" -f $TaskId)
    Write-Host ("状态：{0}（需要 approved）" -f $status)
    Write-Host ("哈希匹配：{0}" -f $hashOk)
    Write-Host ("基线：{0}" -f $base)
    Write-Host ("工作区：{0}（存在：{1}）" -f $worktree, (Test-Path -LiteralPath $worktree))
    Write-Host ("范围：{0}" -f ($(if ($scope.Count -gt 0) { $scope -join ' | ' } else { '未声明' })))
    Write-Host ("测试：{0}" -f $testCommand)
    Write-Host ("最多尝试：{0}" -f $MaxAttempts)
    Write-Host ("自动合并：{0}" -f [bool]$AutoMerge)
    return
}

if ($status -ne 'approved') { throw "任务状态不是 approved，拒绝无人值守执行（当前：$status）。" }
if (-not $hashOk) { throw '任务正文在批准后被修改，拒绝执行。请重新批准。' }
Assert-CleanTree $root
Assert-Tracked $root 'AGENTS.md'
Assert-Tracked $root ("tasks/{0}.md" -f $TaskId)

$expectedToken = ('RUN-' + $TaskId)
if ($RunToken.Length -gt 0) {
    if ($RunToken -cne $expectedToken) { throw ("运行口令不正确，应为 {0}。" -f $expectedToken) }
} else {
    $answer = Read-Host ("输入 {0} 开始无人值守执行" -f $expectedToken)
    if ($answer -cne $expectedToken) { Write-Host '已取消。'; return }
}

if ($AutoMerge) {
    $expectedMerge = ('MERGE-' + $TaskId)
    if ($MergeToken.Length -gt 0) {
        if ($MergeToken -cne $expectedMerge) { throw ("合并口令不正确，应为 {0}。不会自动合并。" -f $expectedMerge) }
    } else {
        throw ('启用了 -AutoMerge 但没有提供 -MergeToken {0}。' -f $expectedMerge)
    }
}

# ---- worktree：存在则复用，便于中断后续跑 ----
if (Test-Path -LiteralPath $worktree) {
    $currentBranch = (& git -C $worktree rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -ne $branch) { throw ("worktree 已存在但分支是 {0}，期望 {1}。" -f $currentBranch, $branch) }
    Write-Host ("复用 worktree：{0}（分支 {1}）" -f $worktree, $branch) -ForegroundColor Cyan
} else {
    & git -C $root show-ref --verify --quiet ('refs/heads/' + $branch)
    if ($LASTEXITCODE -eq 0) {
        & git -C $root worktree add $worktree $branch
    } else {
        & git -C $root worktree add -b $branch $worktree $base
    }
    if ($LASTEXITCODE -ne 0) { throw 'git worktree add 失败。' }
    Write-Host ("创建工作区：{0}（分支 {1}）" -f $worktree, $branch) -ForegroundColor Cyan
}

$devRole = ''
$devRolePath = Join-Path $root 'roles\zcode-dev.md'
if (Test-Path -LiteralPath $devRolePath) { $devRole = Read-Utf8 $devRolePath }

$pmRole = ''
$pmRolePath = Join-Path $root 'roles\codex-pm.md'
if (Test-Path -LiteralPath $pmRolePath) { $pmRole = Read-Utf8 $pmRolePath }

$startedAt = Get-Date
$attempts = @()
$finalVerdict = $null
$finalReport = Join-Path $root ("pm-reports\{0}-review.md" -f $TaskId)
$fatal = $null

try {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Write-Host ''
        Write-Host ("=== 第 {0}/{1} 轮 ===" -f $attempt, $MaxAttempts) -ForegroundColor Cyan

        $rework = ''
        $lastVerdict = $null
        if ($attempts.Count -gt 0) { $lastVerdict = $attempts[$attempts.Count - 1].Verdict }
        if ($lastVerdict) {
            $issues = @($lastVerdict.blocking_issues)
            $failed = @($lastVerdict.criteria | Where-Object { $_.result -ne 'PASS' })
            $rework = "上一轮审核结论是 CHANGES_REQUESTED。只修下面这些问题，不要扩大范围，不要重写无关代码：`n"
            foreach ($issue in $issues) { $rework += ("- " + $issue + "`n") }
            foreach ($item in $failed) { $rework += ("- [" + $item.id + "] " + $item.evidence + "`n") }
            $lastReview = Join-Path $root ("pm-reports\{0}-attempt{1}-review.md" -f $TaskId, ($attempt - 1))
            if (Test-Path -LiteralPath $lastReview) { $rework += ("完整报告：pm-reports/{0}-attempt{1}-review.md`n" -f $TaskId, ($attempt - 1)) }
        }

        $devPrompt = @"
$devRole

工作目录：$worktree
任务单：tasks/$TaskId.md
这是第 $attempt 次尝试（最多 $MaxAttempts 次）。

$rework

要求：
- 先读 AGENTS.md 和任务单，只在批准范围内修改。
- 实际运行任务单给出的验证命令，如实报告结果，不得声称未执行的测试已通过。
- 不修改任务单的 status / approved_hash，不修改 pm-reports。
- 不 git push / merge / rebase / 部署，不访问真实用户数据。
"@

        $zLog = Join-Path $root ("pm-reports\{0}-zcode-attempt{1}.log" -f $TaskId, $attempt)
        $zcode = Invoke-Zcode -WorkDir $worktree -Prompt $devPrompt -LogFile $zLog -Mode 'yolo'
        Write-Host ("ZCode 退出码：{0}" -f $zcode.ExitCode) -ForegroundColor Cyan

        if ($zcode.ExitCode -ne 0) {
            $attempts += [pscustomobject]@{
                Attempt = $attempt; ZcodeExit = $zcode.ExitCode; TestExit = $null
                Verdict = 'BLOCKED'; Issues = @('ZCode 非 0 退出，疑似环境问题'); Report = $zLog
            }
            break
        }

        $test = Invoke-TestCommand -WorkDir $worktree -Command $testCommand
        if (-not $test.Skipped) {
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

        $reviewPrompt = @"
$pmRole

这是审核阶段，只读。禁止修改任何文件，禁止 git commit / merge / push / 部署。

任务单：tasks/$TaskId.md
开发工作区：$worktree
基线提交：$base
改动范围：$scopeText
本次是第 $attempt 轮审核（最多 $MaxAttempts 轮）。
ZCode 退出码：$($zcode.ExitCode)

验证命令：$testCommand
脚本侧执行结果（退出码 $($test.ExitCode)）：
$testOutput

请：
1. 阅读 AGENTS.md 和任务单，列出验收标准。
2. 在开发工作区运行：git status --short --untracked-files=all；$diffCommand；git diff --stat $base。未跟踪的新文件直接读取内容。
3. 逐条核对验收标准，只依据实际代码和命令输出，不推测。
4. 检查越界改动、密钥或真实数据、旧数据兼容性、测试是否真正覆盖声明的行为。
5. 单独列出未验证项（真机、开发者工具、云环境、模型准确率等）。

输出 Markdown 报告，包含：## 结论；## 逐条验收；## 越界与风险；## 未验证项；## 返工要求（仅在 CHANGES_REQUESTED 或 BLOCKED 时）。
报告最后必须紧跟：
<verdict>
{"task_id":"$TaskId","verdict":"PASS|CHANGES_REQUESTED|BLOCKED","criteria":[{"id":"...","result":"PASS|FAIL|UNVERIFIED","evidence":"..."}],"blocking_issues":[],"unverified":[],"summary":"..."}
</verdict>
"@

        $attemptReview = Join-Path $root ("pm-reports\{0}-attempt{1}-review.md" -f $TaskId, $attempt)
        $attemptLog = Join-Path $root ("pm-reports\{0}-review-attempt{1}.log" -f $TaskId, $attempt)
        Invoke-Codex -Repo $worktree -Prompt $reviewPrompt -OutFile $attemptReview -LogFile $attemptLog -Model $Model -Effort $Effort | Out-Null

        $reportText = Read-Utf8 $attemptReview
        $verdict = Get-Verdict $reportText
        if (-not $verdict) {
            $attempts += [pscustomobject]@{
                Attempt = $attempt; ZcodeExit = $zcode.ExitCode; TestExit = $test.ExitCode
                Verdict = 'UNKNOWN'; Issues = @('无法解析 <verdict>'); Report = $attemptReview
            }
            break
        }

        $attempts += [pscustomobject]@{
            Attempt = $attempt; ZcodeExit = $zcode.ExitCode; TestExit = $test.ExitCode
            Verdict = [string]$verdict.verdict; Issues = @($verdict.blocking_issues); Report = $attemptReview
        }

        Copy-Item -LiteralPath $attemptReview -Destination $finalReport -Force
        $verdictFile = Join-Path $root ("pm-reports\{0}-verdict.json" -f $TaskId)
        Write-Utf8 $verdictFile ($verdict | ConvertTo-Json -Depth 8)

        if ($verdict.verdict -eq 'PASS') { $finalVerdict = $verdict; break }
        if ($verdict.verdict -eq 'BLOCKED') { $finalVerdict = $verdict; break }
    }
} catch {
    $fatal = $_
}

# ---- 改动范围检查 ----
$changedPaths = @()
$statusText = ''
if (Test-Path -LiteralPath $worktree) {
    $statusText = (@(& git -c core.quotePath=false -C $worktree status --porcelain --untracked-files=all) -join "`n")
    foreach ($line in ($statusText -split "`n")) {
        if ($line.Length -lt 4) { continue }
        $p = $line.Substring(3).Trim()
        if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1].Trim('"') } else { $p = $p.Trim('"') }
        $changedPaths += $p
    }
}

$outOfScope = @()
if ($scope.Count -gt 0) {
    foreach ($p in $changedPaths) {
        $ok = $false
        foreach ($s in $scope) {
            $s2 = $s.TrimEnd('/')
            if ($p -eq $s2 -or $p.StartsWith($s2 + '/')) { $ok = $true; break }
        }
        if (-not $ok) { $outOfScope += $p }
    }
}

# ---- 可选自动合并 ----
$merged = $false
$mergeNote = '未启用自动合并；worktree 保留，等待人工确认。'
if ($AutoMerge) {
    if (-not $finalVerdict -or $finalVerdict.verdict -ne 'PASS') {
        $mergeNote = '未合并：最终裁决不是 PASS。'
    } elseif ($outOfScope.Count -gt 0) {
        $mergeNote = ('未合并：存在超出 scope 的改动：' + ($outOfScope -join ', '))
    } else {
        try {
            & git -C $worktree add -A
            & git -C $worktree commit -m ("feat({0}): {1}" -f $TaskId, $title) | Out-Null
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw "worktree commit 失败（{0}）" -f $LASTEXITCODE }
            & git -C $root merge --no-ff $branch -m ("merge: {0} {1}" -f $TaskId, $title)
            if ($LASTEXITCODE -ne 0) {
                & git -C $root merge --abort 2>$null | Out-Null
                throw '合并冲突，已 abort。'
            }
            $raw = Read-Utf8 $taskPath
            $raw = Set-FrontmatterField $raw 'status' 'done'
            Write-Utf8 $taskPath $raw
            & git -C $root add ("tasks/{0}.md" -f $TaskId)
            & git -C $root commit -m ("chore(task): {0} done" -f $TaskId) | Out-Null
            & git -C $root worktree remove $worktree
            & git -C $root branch -d $branch
            $merged = $true
            $mergeNote = '已合并到 main，worktree 与分支已清理。未 push。'
        } catch {
            $mergeNote = ('合并失败：' + $_.Exception.Message + ' worktree 保留。')
        }
    }
}

# ---- 无人值守报告 ----
$finishedAt = Get-Date
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# ' + $TaskId + ' 无人值守运行报告')
$lines.Add('')
$lines.Add('- 任务：' + $title)
$lines.Add('- 开始：' + $startedAt.ToString('yyyy-MM-dd HH:mm:ss'))
$lines.Add('- 结束：' + $finishedAt.ToString('yyyy-MM-dd HH:mm:ss'))
$lines.Add('- 基线：' + $base)
$lines.Add('- 工作区：' + $worktree)
$lines.Add('- 最多次数：' + $MaxAttempts)
$lines.Add('- 自动合并：' + [bool]$AutoMerge)
$lines.Add('')
$lines.Add('## 每轮结果')
$lines.Add('')
$lines.Add('| 轮次 | ZCode | 测试 | 裁决 | 主要问题 |')
$lines.Add('|---|---|---|---|---|')
foreach ($a in $attempts) {
    $issueText = (@($a.Issues) -join '；')
    if ($issueText.Length -gt 160) { $issueText = $issueText.Substring(0, 160) + '…' }
    $lines.Add(('| {0} | {1} | {2} | {3} | {4} |' -f $a.Attempt, $a.ZcodeExit, $a.TestExit, $a.Verdict, $issueText))
}
$lines.Add('')
$lines.Add('## 改动文件')
$lines.Add('')
if ($changedPaths.Count -eq 0) { $lines.Add('（无改动）') } else { foreach ($p in $changedPaths) { $lines.Add('- ' + $p) } }
$lines.Add('')
$lines.Add('## 范围检查')
$lines.Add('')
if ($outOfScope.Count -eq 0) { $lines.Add('所有改动都在任务 scope 内。') } else { $lines.Add('超出 scope：'); foreach ($p in $outOfScope) { $lines.Add('- ' + $p) } }
$lines.Add('')
$lines.Add('## 合并')
$lines.Add('')
$lines.Add($mergeNote)
$lines.Add('')
$lines.Add('## 未验证项')
$lines.Add('')
if ($finalVerdict -and $finalVerdict.unverified) { foreach ($u in $finalVerdict.unverified) { $lines.Add('- ' + $u) } } else { $lines.Add('（见各轮报告）') }
$lines.Add('')
$lines.Add('## 异常')
$lines.Add('')
if ($fatal) { $lines.Add($fatal.Exception.Message) } else { $lines.Add('无。') }
$lines.Add('')
$lines.Add('## 你回来先看')
$lines.Add('')
$lines.Add('1. 本报告与 `pm-reports\' + $TaskId + '-review.md`')
$lines.Add('2. `git -C "' + $worktree + '" status --short` 和对应 diff')
$lines.Add('3. 真机/开发者工具仍需人工验证，离线通过不代表真机通过')

$summaryPath = Join-Path $root ("pm-reports\{0}-unattended.md" -f $TaskId)
Write-Utf8 $summaryPath ($lines -join "`r`n")

Write-Host ''
Write-Host '=== 无人值守结束 ===' -ForegroundColor Green
Write-Host ("最终裁决：{0}" -f $(if ($finalVerdict) { $finalVerdict.verdict } else { '未完成/异常' })) -ForegroundColor Yellow
Write-Host ("报告：{0}" -f $summaryPath)
Write-Host ("worktree：{0}" -f $worktree)
Write-Host $mergeNote
if ($fatal) { Write-Host ("异常：" + $fatal.Exception.Message) -ForegroundColor Red }
Write-Host '不 push、不部署。'
