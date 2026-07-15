@echo off
setlocal

if "%~1"=="" (
  start "" powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\install-wizard.ps1" -RepositoryRoot "%~dp0." -HideConsole
  exit /b 0
)

title Codex Inter-Agent Messaging Installer - Console Mode

echo.
echo Codex Inter-Agent Messaging Installer - Console Mode
echo ====================================================
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
