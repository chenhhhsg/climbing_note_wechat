# 用法： .\scripts\plan-task.ps1 -TaskId T002 -Requirement "支持从手机相册选视频并播放"
# 只读调用 Codex 生成任务草稿，不修改业务代码。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TaskId,
    [Parameter(Mandatory = $true)][string]$Requirement,
    [string]$Repo = '.',
    [string]$Model = 'gpt-5.6-terra',
    [string]$Effort = 'high'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-Console

if ($TaskId -notmatch '^T[0-9]{3,6}$') { throw 'TaskId 形如 T001。' }

$root = Get-RepoRoot $Repo
$taskFile = Join-Path $root ("tasks\{0}.md" -f $TaskId)
if (Test-Path -LiteralPath $taskFile) { throw "任务已存在，拒绝覆盖：$taskFile" }

$pmRole = ''
$pmRolePath = Join-Path $root 'roles\codex-pm.md'
if (Test-Path -LiteralPath $pmRolePath) { $pmRole = Read-Utf8 $pmRolePath }

$head = (& git -C $root rev-parse --short HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法读取当前提交。' }

$prompt = @"
$pmRole

现在是规划阶段：只读检查仓库，不修改任何文件，不创建迁移、部署或提交。

仓库：$root
当前提交：$head
用户需求：$Requirement

请先阅读 AGENTS.md、ROADMAP.md、tasks/TEMPLATE.md，以及需求涉及到的现有代码。
然后输出一份任务单正文（Markdown），遵守以下要求：

1. 不要输出 frontmatter，脚本会自动添加。
2. 必须包含这些二级标题：背景与问题；开发范围（允许修改）；禁止变更；验收标准；建议验证命令；测试与人工验证边界；回滚办法。
3. 验收标准必须可观察、可验证，优先给出具体命令或编号用例，不能写“体验良好”这类无法判定的条件。
4. 明确列出需要先阅读的旧代码路径，以及本次明确不改的部分。
5. 真机、云环境、模型准确率等无法离线验证的内容，写进“测试与人工验证边界”，不要写成验收通过条件。
6. 最后单独一行输出建议的改动范围，格式严格为：SCOPE: 路径1, 路径2
"@

$reportsDir = Join-Path $root 'pm-reports'
New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
$draft = Join-Path $reportsDir ("{0}-plan-draft.md" -f $TaskId)
$log = Join-Path $reportsDir ("{0}-plan.log" -f $TaskId)

Write-Host "调用 Codex 生成任务草稿（模型 $Model，只读）..." -ForegroundColor Cyan
Invoke-Codex -Repo $root -Prompt $prompt -OutFile $draft -LogFile $log -Model $Model -Effort $Effort | Out-Null

$body = Read-Utf8 $draft
if (-not $body -or $body.Trim().Length -eq 0) { throw "Codex 没有返回任务正文：$draft" }

$scope = @()
$scopeMatch = [regex]::Match($body, '(?m)^SCOPE:\s*(.+)$')
if ($scopeMatch.Success) {
    $scope = @($scopeMatch.Groups[1].Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    $body = [regex]::Replace($body, '(?m)^SCOPE:\s*.+\r?\n?', '')
}

$front = New-Object System.Collections.Generic.List[string]
$front.Add('---')
$front.Add(('id: ' + $TaskId))
$front.Add('status: draft')
$front.Add('owner: zcode')
$front.Add(('baseline: ' + $head))
$front.Add('scope:')
foreach ($item in $scope) { $front.Add(('  - ' + $item)) }
$front.Add('test_command: ')
$front.Add('approved_hash: ')
$front.Add('approved_at: ')
$front.Add(('spec: '))
$front.Add('---')

$content = ($front -join "`r`n") + "`r`n`r`n" + $body.Trim() + "`r`n"
Write-Utf8 $taskFile $content

Write-Host ''
Write-Host ("任务草稿：{0}" -f $taskFile) -ForegroundColor Green
if ($scope.Count -gt 0) { Write-Host ("建议范围：{0}" -f ($scope -join ' | ')) }
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host ("  1. 人工审查任务单，必要时直接编辑 tasks\{0}.md" -f $TaskId)
Write-Host ("  2. .\scripts\approve-task.ps1 -TaskId {0}" -f $TaskId)
Write-Host ("  3. git add tasks/{0}.md; git commit -m `"chore(task): approve {0}`"" -f $TaskId)
