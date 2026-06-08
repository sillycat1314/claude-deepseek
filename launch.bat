@echo off
chcp 65001 >nul
title Claude Code + DeepSeek V4 Pro
echo ============================================
echo   Claude Code ^(DeepSeek V4 Pro^)
echo ============================================
echo.

set ANTHROPIC_BASE_URL=http://127.0.0.1:8384
set ANTHROPIC_API_KEY=deepseek-proxy
set NODE_TLS_REJECT_UNAUTHORIZED=0

echo [1/3] Starting proxy...
start "Claude-Proxy" /min cmd /c "node C:\Users\1\.qclaw\workspace-agent-2a024211\claude-proxy\proxy.mjs"

echo [2/3] Waiting for proxy to be ready...
timeout /t 3 /nobreak >nul

echo [3/3] Launching Claude Code...
echo.
claude --dangerously-skip-permissions

echo.
echo ============================================
echo   Claude Code session ended.
echo ============================================
pause
