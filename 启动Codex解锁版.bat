@echo off
rem ============================================================================
rem Entry point of the Codex unlock launcher (Windows).
rem Keep this file ASCII-only and CRLF: cmd.exe misparses UTF-8 multibyte text
rem in .bat files, and every Chinese message is printed by codex-launcher.js.
rem Exit codes passed through to the caller: 0 started, 1 failed,
rem 2 something the user should read (the window stays open in both cases).
rem ============================================================================
setlocal EnableExtensions
rem pushd instead of cd so that running from a network share works too.
pushd "%~dp0"

rem --- E1: the launcher script is missing (zip was not extracted?) ------------
if not exist "%~dp0codex-launcher.js" goto :e1

rem --- Node.js: bundled with Codex when possible, PATH as the last resort -----
call "%~dp0lib\find-node.cmd"
if not defined NODE goto :e2

rem The launcher copies this path into the shortcut it creates, so the icon
rem always points back at this very folder (and follows it when it moves).
set "CODEX_LAUNCHER_BAT=%~f0"

"%NODE%" "%~dp0codex-launcher.js" %*
rem Save the code before pause: pause would overwrite errorlevel.
set "RC=%errorlevel%"
popd
if "%RC%"=="0" exit /b 0
goto :pause_and_exit

:e1
echo [E1] codex-launcher.js was not found next to this file.
echo [E1] Please extract the whole zip archive first, then run this file again.
call :openhelp
set "RC=1"
goto :pause_and_exit

:e2
echo [E2] No usable Node.js was found on this computer.
echo [E2] Install the official Codex app (Microsoft Store or openai.com),
echo [E2] or install Node.js from https://nodejs.org, then run this file again.
call :openhelp
set "RC=1"
goto :pause_and_exit

rem ----------------------------------------------------------------------------
rem Keep the window open so the user can read the message, except when an
rem automated test asked us not to (CODEX_LAUNCHER_NO_PAUSE=1, tests only).
rem ----------------------------------------------------------------------------
:pause_and_exit
if "%CODEX_LAUNCHER_NO_PAUSE%"=="1" exit /b %RC%
echo.
pause
exit /b %RC%

rem ----------------------------------------------------------------------------
rem Show the manual when something is missing.  The manual is the only .txt
rem shipped next to this file; its name is Chinese, so it is matched with a
rem wildcard to keep this .bat pure ASCII.
rem ----------------------------------------------------------------------------
:openhelp
if not exist "%~dp0*.txt" exit /b 0
for %%f in ("%~dp0*.txt") do start "" notepad "%%~ff"
exit /b 0
