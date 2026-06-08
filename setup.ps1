# Claude Code + DeepSeek V4 Pro - One-Command Setup
# Run: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Claude Code + DeepSeek V4 Pro Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxyPath = Join-Path $repoDir "proxy.mjs"

# ── 1. Check Node.js ──
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVer = node --version 2>&1
    Write-Host "       Node $nodeVer OK" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found. Please install Node.js first:" -ForegroundColor Red
    Write-Host "       https://nodejs.org/en/download" -ForegroundColor Red
    exit 1
}

# ── 2. Install Claude Code ──
Write-Host "[2/5] Installing Claude Code..." -ForegroundColor Yellow
try {
    $claudeVer = claude --version 2>&1
    Write-Host "       Claude Code already installed: $claudeVer" -ForegroundColor Green
} catch {
    Write-Host "       Installing Claude Code via npm..." -ForegroundColor Yellow
    npm install -g @anthropic-ai/claude-code@latest 2>&1
    Write-Host "       Claude Code installed OK" -ForegroundColor Green
}

# ── 3. Set environment variables ──
Write-Host "[3/5] Setting environment variables..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://127.0.0.1:8384", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "deepseek-proxy", "User")
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8384"
$env:ANTHROPIC_API_KEY = "deepseek-proxy"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
Write-Host "       ANTHROPIC_BASE_URL = http://127.0.0.1:8384" -ForegroundColor Green
Write-Host "       ANTHROPIC_API_KEY = deepseek-proxy" -ForegroundColor Green

# ── 4. Add hosts entry ──
Write-Host "[4/5] Configuring hosts (platform.claude.com -> 127.0.0.1)..." -ForegroundColor Yellow
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsContent = Get-Content $hostsPath -Raw -ErrorAction SilentlyContinue
if ($hostsContent -match "platform\.claude\.com") {
    Write-Host "       hosts entry already exists" -ForegroundColor Green
} else {
    try {
        Add-Content -Path $hostsPath -Value "`r`n127.0.0.1 platform.claude.com" -ErrorAction Stop
        Write-Host "       hosts entry added OK" -ForegroundColor Green
    } catch {
        Write-Host "       WARNING: Need admin rights for hosts file." -ForegroundColor Yellow
        Write-Host "       Run this command as admin:" -ForegroundColor Yellow
        Write-Host '       Add-Content "$env:SystemRoot\System32\drivers\etc\hosts" "`n127.0.0.1 platform.claude.com"' -ForegroundColor Yellow
    }
}

# ── 5. Verify ──
Write-Host "[5/5] Testing..." -ForegroundColor Yellow
Write-Host "       Starting proxy for verification..."
$proxyJob = Start-Job -ScriptBlock {
    param($path)
    node $path 2>&1
} -ArgumentList $proxyPath

Start-Sleep -Seconds 3
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8384/v1/models" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
        Write-Host "       Proxy OK (port 8384)" -ForegroundColor Green
    }
} catch {
    Write-Host "       WARNING: Proxy failed to start on 8384" -ForegroundColor Red
    Write-Host "       $_" -ForegroundColor Red
}

Stop-Job -Job $proxyJob -ErrorAction SilentlyContinue
Remove-Job -Job $proxyJob -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To launch Claude Code:" -ForegroundColor Yellow
Write-Host "    Method 1: Double-click launch.bat" -ForegroundColor White
Write-Host "    Method 2: claude --dangerously-skip-permissions" -ForegroundColor White
Write-Host ""
