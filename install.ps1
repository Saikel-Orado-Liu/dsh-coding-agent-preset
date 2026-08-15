# install.ps1 — 将「编码模式」预设的两个自研包部署到当前 DSH
#
# 用法：
#   pwsh -File "D:\Projects\dsh-plugins\dsh-coding-agent-preset\install.ps1"
#
# 什么时候需要运行：
#   - 首次安装（或克隆本仓库后）
#   - DSH harness 升级后（harness node_modules 被重建，包会丢失）
#
# 部署目标（两处都要）：
#   1. harness 的 node_modules（当前 npx 缓存）：包的权威运行时位置。
#   2. ~/.dsh/profiles/node_modules：预设行的解析基准是 ~/.dsh/profiles/web/，
#      向上找到的第一个 node_modules 就是 profiles/node_modules；官方包以
#      junction 形式存在那里，本地新增包同样需要落位（真实副本）。
#
# 预设行通过子路径引用（dsh-terminal-pwsh/lib/index.js），
# 不依赖 package.json 的 main/exports 入口解析，加载稳定。
#
# 注意：预设文件本身（agent.cordis.yml / preset.yml）不在此脚本范围，
# 需手动放置到 ~/.dsh/.agent-presets/coding/（或由用户预设目录管理）。

$ErrorActionPreference = 'Stop'

function Find-HarnessNodeModules {
  # 1) 显式参数
  if ($Harness -and (Test-Path $Harness)) { return $Harness }
  # 2) npx 缓存（dsh 官方安装位置）：找到 @deepseek-ai/dsh 包目录，取其 node_modules 根
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $npxRoot) {
    $dsh = Get-ChildItem -Path $npxRoot -Directory -Recurse -Filter 'dsh' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'dsh' -and $_.Parent.Name -eq '@deepseek-ai' -and (Test-Path (Join-Path $_.FullName 'package.json')) } |
      Select-Object -First 1
    if ($dsh) { return $dsh.Parent.Parent.FullName }
  }
  throw "无法定位 DSH harness 的 node_modules，请用 -Harness <路径> 显式指定"
}

$harnessModules = Find-HarnessNodeModules
$profileModules = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgs = @('dsh-terminal-pwsh', 'dsh-tool-pwsh-persistent')

$targets = @($harnessModules, $profileModules) | Select-Object -Unique

foreach ($pkg in $pkgs) {
  $from = Join-Path $src "packages\$pkg"
  if (-not (Test-Path $from)) { throw "缺少源码目录: $from" }
  foreach ($root in $targets) {
    $to = Join-Path $root $pkg
    if (-not (Test-Path $root)) { Write-Host "skip (missing root): $root"; continue }
    if (Test-Path $to) { Remove-Item -Path $to -Recurse -Force }
    Copy-Item -Path $from -Destination $to -Recurse -Force
    Write-Host "installed: $to"
  }
}

Write-Host '完成。请在 DSH 中新建/重启一个「编码模式」会话使预设生效。'
