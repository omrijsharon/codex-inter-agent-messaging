@echo off
setlocal
title Codex Inter-Agent Messaging Installer

echo.
echo Codex Inter-Agent Messaging Installer
echo =====================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-plugin.ps1" %*
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%INSTALL_EXIT_CODE%"=="0" (
  echo Installer finished successfully.
) else (
  echo Installer failed with exit code %INSTALL_EXIT_CODE%.
)

if not defined CODEX_INTER_AGENT_INSTALL_NO_PAUSE pause
exit /b %INSTALL_EXIT_CODE%
