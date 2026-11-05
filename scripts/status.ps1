# 用法： .\scripts\status.ps1
# 查看所有任务的状态、正文哈希是否漂移、最近一次审核结论。

[CmdletBinding()]
param([string]$Repo = '.')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

$root = Get-RepoRoot $Repo
$tasksDir = Join-Path $root 'tasks'
if (-not (Test-Path -LiteralPath $tasksDir)) { throw "没有 tasks 目录：$tasksDir" }

$files = @(Get-ChildItem -LiteralPath $tasksDir -Filter 'T*.md' -File | Where-Object { $_.Name -match '^T[0-9]{3,6}\.md$' } | Sort-Object Name)
if ($files.Count -eq 0) {
    Write-Host '还没有任务。用 scripts\plan-task.ps1 生成第一份。'
    return
}

$rows = @()
foreach ($file in $files) {
    $task = Get-Task $file.FullName
    $id = [string]$task.Meta['id']
    if (-not $id) { $id = $file.BaseName }

    $title = ''
    $titleMatch = [regex]::Match($task.Body, '(?m)^#\s+(.+)$')
    if ($titleMatch.Success) { $title = $titleMatch.Groups[1].Value.Trim() }

    $drift = ''
    $approvedHash = [string]$task.Meta['approved_hash']
    if ($approvedHash.Length -gt 0 -and (Get-BodyHash $task.Body) -ne $approvedHash) {
        $drift = 'YES'
    }

    $verdictText = ''
    $verdict = Get-LatestVerdict -Repo $root -TaskId $id
    if ($verdict) { $verdictText = [string]$verdict.verdict }

    $rows += [pscustomobject]@{
        Id      = $id
        Status  = [string]$task.Meta['status']
        Verdict = $verdictText
        Drift   = $drift
        Title   = $title
    }
}

$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host 'Drift=YES 表示任务正文在批准后被修改，run-approved-task 会拒绝执行。'
