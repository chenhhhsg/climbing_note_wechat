# 用法： .\scripts\approve-task.ps1 -TaskId T002
# 校验任务单结构，记录正文哈希，把 draft 翻成 approved。需要人工输入确认口令。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskId,
    [string]$Repo = '.',
    [string]$ApproveToken = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

$root = Get-RepoRoot $Repo
$taskPath = Join-Path $root ("tasks\{0}.md" -f $TaskId)
$task = Get-Task $taskPath

$status = [string]$task.Meta['status']
if ($status -ne 'draft') { throw "只有 draft 任务可以批准，当前状态：$status" }

$required = @('背景与问题', '开发范围（允许修改）', '禁止变更', '验收标准', '建议验证命令', '测试与人工验证边界', '回滚办法')
$missing = @()
foreach ($section in $required) {
    if ($task.Body -notmatch ('(?m)^##\s*' + [regex]::Escape($section))) { $missing += $section }
}
if ($missing.Count -gt 0) { throw ("任务单缺少章节：" + ($missing -join '、')) }

if ($task.Body -notmatch '(?m)^\s*-\s*\[\s*\]\s*\S') { throw '验收标准为空，拒绝批准。' }

$scope = Get-ScopeArgs $task
if ($scope.Count -eq 0) { throw '任务没有声明 scope，拒绝批准。' }

Write-Host ("任务：{0}" -f $TaskId) -ForegroundColor Cyan
$titleMatch = [regex]::Match($task.Body, '(?m)^#\s+(.+)$')
if ($titleMatch.Success) { Write-Host ("标题：{0}" -f $titleMatch.Groups[1].Value.Trim()) }
Write-Host ("基线：{0}" -f $task.Meta['baseline'])
Write-Host ("范围：{0}" -f ($scope -join ' | '))
Write-Host ("测试：{0}" -f $task.Meta['test_command'])

$expected = ("APPROVE-" + $TaskId)
if ($ApproveToken.Length -gt 0) {
    if ($ApproveToken -cne $expected) { throw "批准口令不正确，应为 $expected。任务未改动。" }
    Write-Host ("批准口令已提供：{0}" -f $expected)
} else {
    $answer = Read-Host ("输入 APPROVE-{0} 完成批准" -f $TaskId)
    if ($answer -cne $expected) {
        Write-Host '已取消，任务未改动。'
        exit 1
    }
}

$hash = Get-BodyHash $task.Body
$raw = Set-FrontmatterField $task.Raw 'status' 'approved'
$raw = Set-FrontmatterField $raw 'approved_hash' $hash
$raw = Set-FrontmatterField $raw 'approved_at' (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
Write-Utf8 $taskPath $raw

Write-Host ''
Write-Host ("已批准：{0}（正文哈希 {1}）" -f $TaskId, $hash.Substring(0, 12)) -ForegroundColor Green
Write-Host '下一步：提交任务单，保证 worktree 能读到它：' -ForegroundColor Yellow
Write-Host ("  git add tasks/{0}.md AGENTS.md roles scripts tasks" -f $TaskId)
Write-Host ("  git commit -m `"chore(task): approve {0}`"" -f $TaskId)
