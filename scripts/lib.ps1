# 共享函数库：编码、工具解析、任务单读写、证据收集。
# 本文件必须以 UTF-8 with BOM 保存，Windows PowerShell 5.1 才能正确解析中文。

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Initialize-Console {
    try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
    try { [Console]::InputEncoding = $script:Utf8NoBom } catch { }
    $global:OutputEncoding = $script:Utf8NoBom
}

function Write-Utf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Text
    )
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Read-Utf8 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Get-RepoRoot {
    param([string]$Path = (Get-Location).Path)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $top = & git -C $resolved rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $top) { throw "不是 Git 仓库：$resolved" }
    return (Resolve-Path -LiteralPath ([string]$top).Trim()).Path
}

function Get-ApplicationCommand {
    param([Parameter(Mandatory = $true)][string]$Name)
    $all = @(Get-Command $Name -All -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return $null }

    $preferred = @()
    foreach ($item in $all) {
        $source = [string]$item.Source
        if ($source -match '\.(exe|cmd|bat)$') { $preferred += $item }
    }
    if ($preferred.Count -gt 0) { return $preferred[0] }

    foreach ($item in $all) {
        if ($item.CommandType -eq 'Application') { return $item }
    }
    return $all[0]
}

function Resolve-CodexCli {
    $cmd = Get-ApplicationCommand 'codex'
    if (-not $cmd) { throw '找不到 codex CLI。先在 PowerShell 中确认 codex --version 可用。' }
    return @{ File = $cmd.Source; Prefix = @() }
}

function Resolve-ZcodeCli {
    $cmd = Get-ApplicationCommand 'zcode'
    if ($cmd) { return @{ File = $cmd.Source; Prefix = @() } }

    $node = Get-ApplicationCommand 'node'
    if (-not $node) { throw '找不到 node，无法调用 ZCode 内置 CLI。' }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\ZCode\resources\glm\zcode.cjs')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return @{ File = $node.Source; Prefix = @($candidate) }
        }
    }
    throw '找不到 ZCode CLI：PATH 中没有 zcode，也没有找到内置 zcode.cjs。'
}

function Get-Task {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "找不到任务文件：$Path" }
    $raw = Read-Utf8 $Path
    $match = [regex]::Match($raw, '(?s)^\uFEFF?---\r?\n(.*?)\r?\n---\r?\n')
    if (-not $match.Success) { throw "任务文件缺少 frontmatter：$Path" }

    $front = $match.Groups[1].Value
    $body = $raw.Substring($match.Length)
    $meta = @{}
    $listKey = $null

    foreach ($line in ($front -split "\r?\n")) {
        if ($line.Trim().Length -eq 0) { continue }
        if ($line -match '^\s*#') { continue }
        if ($null -ne $listKey -and $line -match '^\s*-\s+(.+)$') {
            $meta[$listKey] = @($meta[$listKey]) + $matches[1].Trim()
            continue
        }
        if ($line -match '^([A-Za-z0-9_]+)\s*:\s*(.*)$') {
            $key = $matches[1]
            $value = $matches[2].Trim()
            if ($value.Length -eq 0) {
                $listKey = $key
                $meta[$key] = @()
            } else {
                $listKey = $null
                $meta[$key] = $value
            }
        }
    }

    return [pscustomobject]@{
        Path = $Path
        Raw  = $raw
        Meta = $meta
        Body = $body
    }
}

function Get-ScopeArgs {
    param($Task)
    $scope = $Task.Meta['scope']
    if ($null -eq $scope) { return @() }
    if ($scope -is [string]) {
        if ($scope.Trim().Length -eq 0) { return @() }
        return @($scope.Trim())
    }
    return @($scope)
}

function Get-BodyHash {
    param([string]$Body)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $normalized = $Body -replace "`r`n", "`n"
        $bytes = $script:Utf8NoBom.GetBytes($normalized.Trim())
        $hash = $sha.ComputeHash($bytes)
        $hex = ([BitConverter]::ToString($hash)) -replace '-', ''
        return $hex.ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Set-FrontmatterField {
    param(
        [Parameter(Mandatory = $true)][string]$Raw,
        [Parameter(Mandatory = $true)][string]$Key,
        [AllowEmptyString()][string]$Value
    )
    $match = [regex]::Match($Raw, '(?s)^(\uFEFF?---\r?\n)(.*?)(\r?\n---\r?\n)')
    if (-not $match.Success) { throw '任务文件缺少 frontmatter。' }

    $head = $match.Groups[1].Value
    $front = $match.Groups[2].Value
    $tail = $match.Groups[3].Value
    $lines = @($front -split "\r?\n")
    $pattern = '^' + [regex]::Escape($Key) + '\s*:'
    $replaced = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = $Key + ': ' + $Value
            $replaced = $true
            break
        }
    }
    if (-not $replaced) { $lines = @($lines + ($Key + ': ' + $Value)) }

    return $head + ($lines -join "`r`n") + $tail + $Raw.Substring($match.Length)
}

function Assert-CleanTree {
    param([Parameter(Mandatory = $true)][string]$Repo)
    $status = @(& git -C $Repo status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'git status 执行失败。' }
    $dirty = @($status | Where-Object { $_ -and $_.Trim().Length -gt 0 })
    if ($dirty.Count -gt 0) {
        $sample = ($dirty | Select-Object -First 10) -join "`n"
        throw ("主仓库有未提交改动，worktree 基线会不一致。请先提交或 stash：`n" + $sample)
    }
}

function Assert-Tracked {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )
    & git -C $Repo ls-files --error-unmatch -- $RelativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "文件未纳入 Git：$RelativePath（先 git add 并 commit）" }
}

function ConvertTo-OutputText {
    param($Item)
    if ($null -eq $Item) { return '' }
    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        return [string]$Item.Exception.Message
    }
    return [string]$Item
}

function Invoke-Codex {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Prompt,
        [string]$OutFile,
        [string]$LogFile,
        [string]$Model,
        [string]$Effort = 'high'
    )
    if ($OutFile) {
        $parent = Split-Path -Parent $OutFile
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }
    if ($LogFile) {
        $parent = Split-Path -Parent $LogFile
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }
    $cli = Resolve-CodexCli
    $argv = @('exec', '-C', $Repo, '--sandbox', 'read-only', '--color', 'never')
    if ($OutFile) { $argv += @('-o', $OutFile) }
    if ($Model) { $argv += @('-m', $Model) }
    if ($Effort) { $argv += @('-c', ('model_reasoning_effort={0}' -f $Effort)) }
    $argv += '-'

    $lines = New-Object System.Collections.Generic.List[string]
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Prompt | & $cli.File @argv 2>&1 | ForEach-Object {
            $text = ConvertTo-OutputText $_
            $lines.Add($text)
            Write-Host $text
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $output = ($lines -join "`n")
    if ($LogFile) { Write-Utf8 $LogFile $output }

    if ($code -ne 0) {
        if ($output -match '429|Too Many Requests') {
            throw 'Codex 被限流（429）。稍后重试，或换模型：-Model gpt-5.6-terra。'
        }
        throw "Codex 执行失败，退出码 $code。日志：$LogFile"
    }
    if ($OutFile -and -not (Test-Path -LiteralPath $OutFile)) {
        throw "Codex 没有生成结果文件：$OutFile"
    }
    return $output
}

function Invoke-Zcode {
    param(
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$Prompt,
        [string]$LogFile,
        [string]$Mode = 'yolo'
    )
    $cli = Resolve-ZcodeCli

    # 桌面版 CLI 在部分宿主环境（例如被其它 Agent 的沙箱启动）会按 resources\glm\provider
    # 推断内置配置，实际文件在 resources\config\provider。显式传路径，避免启动即失败。
    $builtinConfig = Join-Path $env:LOCALAPPDATA 'Programs\ZCode\resources\config\provider\zcode-builtin.json'
    $personalConfig = Join-Path $env:USERPROFILE '.zcode\v2\provider_config.json'
    if (-not $env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE -and (Test-Path -LiteralPath $builtinConfig)) {
        $env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = $builtinConfig
    }
    if (-not $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE -and (Test-Path -LiteralPath $personalConfig)) {
        $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = $personalConfig
    }

    $argv = @()
    if ($cli.Prefix.Count -gt 0) { $argv += $cli.Prefix }
    $argv += @('-p', $Prompt, '--cwd', $WorkDir, '--mode', $Mode, '--json', '--no-color')

    if ($LogFile) {
        $parent = Split-Path -Parent $LogFile
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $cli.File @argv 2>&1 | ForEach-Object {
            $text = ConvertTo-OutputText $_
            $lines.Add($text)
            Write-Host $text
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $output = ($lines -join "`n")
    if ($LogFile) { Write-Utf8 $LogFile $output }

    $json = $null
    try { $json = $output | ConvertFrom-Json } catch { }

    return [pscustomobject]@{
        ExitCode = $code
        Output   = $output
        Json     = $json
    }
}

function Invoke-TestCommand {
    param(
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [AllowEmptyString()][string]$Command
    )
    if (-not $Command -or $Command.Trim().Length -eq 0) {
        return [pscustomobject]@{ Skipped = $true; ExitCode = $null; Command = ''; Output = '' }
    }
    Push-Location -LiteralPath $WorkDir
    try {
        $output = & cmd /c $Command 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $text = (@($output) | ForEach-Object { ConvertTo-OutputText $_ }) -join "`n"
    return [pscustomobject]@{
        Skipped  = $false
        ExitCode = $code
        Command  = $Command
        Output   = $text
    }
}

function Get-Verdict {
    param([string]$Text)
    if (-not $Text) { return $null }
    $match = [regex]::Match($Text, '(?s)<verdict>\s*(.*?)\s*</verdict>')
    if (-not $match.Success) { return $null }
    $raw = $match.Groups[1].Value.Trim()
    $raw = [regex]::Replace($raw, '^```(json)?\s*', '')
    $raw = [regex]::Replace($raw, '\s*```$', '')
    try { return ($raw.Trim() | ConvertFrom-Json) } catch { return $null }
}

function Get-LatestVerdict {
    param([string]$Repo, [string]$TaskId)
    $path = Join-Path $Repo ("pm-reports\{0}-verdict.json" -f $TaskId)
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ((Read-Utf8 $path) | ConvertFrom-Json) } catch { return $null }
}
