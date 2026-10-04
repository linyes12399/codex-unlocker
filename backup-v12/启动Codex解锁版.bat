@echo off
rem Keep this file ASCII-only: cmd misparses UTF-8 multibyte text in .bat files.
rem All user-facing Chinese messages are printed by codex-launcher.js.
setlocal
cd /d "%~dp0"
if not exist "%~dp0codex-launcher.js" (
  echo codex-launcher.js not found. Extract the whole zip first, then run this file again.
  pause
  exit /b 1
)

rem Prefer the Node.js bundled with the Store Codex app, then fall back to PATH.
set "NODE="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$p=(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation; if ($p) { Join-Path $p 'app\resources\cua_node\bin\node.exe' }"`) do if exist "%%i" set "NODE=%%i"
if not defined NODE for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo Node.js not found. Install Codex from the Microsoft Store, or install Node.js from https://nodejs.org
  pause
  exit /b 1
)

"%NODE%" "%~dp0codex-launcher.js" %*
if errorlevel 1 pause
