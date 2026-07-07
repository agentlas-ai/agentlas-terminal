# agentlas 터미널 CLI 설치 (Windows, 미검증 — best effort).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# %LOCALAPPDATA%\Agentlas\bin\agentlas.cmd 를 만들고 PATH 안내를 출력한다.
$ErrorActionPreference = "Stop"

$pkgRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $pkgRoot "bin\agentlas.cjs"
if (-not (Test-Path $launcher)) { throw "런처를 찾을 수 없습니다: $launcher" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node 가 필요합니다 (https://nodejs.org)" }

$dir = Join-Path $env:LOCALAPPDATA "Agentlas\bin"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir "agentlas.cmd"
# .cmd 셸림: PowerShell 실행 정책과 무관하게 동작한다.
"@echo off`r`nnode `"$launcher`" %*`r`n" | Set-Content -Path $target -Encoding ASCII

Write-Host "설치됨: $target"
$onPath = ($env:Path -split ";") -contains $dir
if (-not $onPath) {
  Write-Host "PATH에 $dir 를 추가하세요 (시스템 설정 → 환경 변수)."
}
& $target --where
