@echo off
rem ============================================================================
rem find-node.cmd - pick a usable Node.js for the Codex unlock launcher.
rem
rem Keep this file ASCII-only and CRLF: cmd.exe misparses UTF-8 multibyte text
rem in .cmd files, and every Chinese message is printed by codex-launcher.js.
rem
rem Usage, from the entry scripts next to lib\:
rem     call "<folder of this script>\lib\find-node.cmd"
rem     if not defined NODE ...      <-- NODE is set here when a node was found
rem On success the variable NODE holds the full path of the chosen node.exe;
rem when nothing suitable was found NODE stays empty and the caller prints [E2].
rem
rem Candidates, in this order: CODEX_NODE, the path the launcher cached in
rem %USERPROFILE%\ChatGPT-Patched\node-path.txt (v14), the Store package read
rem through reg.exe, the Store package through PowerShell, the runtime the app
rem downloaded for itself, the usual install folders, whatever is on PATH.
rem
rem Rules that this file depends on (verified against cmd.exe on Windows 11):
rem   * no setlocal - the variable would not survive back to the caller;
rem   * no delayed expansion;
rem   * never expand a path variable without double quotes, a value with an
rem     ampersand would be split into two commands;
rem   * Program Files (x86) is only parsable while quoted, so keep the
rem     goto/call structure below instead of parenthesised blocks;
rem   * the cached path lives in a file that any program may edit, so it is
rem     whitelisted byte by byte before it is read (see :cand2).
rem ============================================================================

set "NODE="
set "TRY="
set "CACHEF="
set "CACHEV="

rem --- 1) explicit override: CODEX_NODE ---------------------------------------
if not defined CODEX_NODE goto :cand2
call :try "%CODEX_NODE%"
if defined NODE goto :done

:cand2
rem --- 2) node.exe the launcher used on an earlier start (v14, no subprocess) --
rem  The launcher writes %USERPROFILE%\ChatGPT-Patched\node-path.txt after a
rem  successful start, so this candidate costs one file read instead of the
rem  registry or PowerShell queries below.  That file is user-writable, so the
rem  whole file is whitelisted first: findstr reports a clean file only when it
rem  contains nothing but [A-Za-z0-9_. :\/-] and line breaks.  Such a file cannot
rem  carry & | < > ^ % ! " ( ) or non-ASCII bytes, and the value therefore
rem  cannot break out of the quotes around :try below.  Anything else (a bad
rem  byte anywhere, an empty file, or a path :try rejects) falls through to the
rem  original chain: the cache can only make startup faster, never break the
rem  launcher.  The class must match the launcher's NODE_PATH_SAFE_RE exactly
rem  (it allows a forward slash) so a path the launcher writes is accepted here.
rem  findstr needs the class to hold two literal backslashes - with one it
rem  matches every path and the cache would never be used.
set "CACHEF=%USERPROFILE%\ChatGPT-Patched\node-path.txt"
if not exist "%CACHEF%" goto :cand3
rem  A directory with that name would make for /f below print "The system cannot
rem  find the file ..." to stderr; "if exist <path>\" is true only for
rem  directories, so bail out early and keep the console clean.
if exist "%CACHEF%\" goto :cand3
findstr /r /c:"[^A-Za-z0-9_. :\\/-]" "%CACHEF%" >nul 2>nul
rem  errorlevel 2 means findstr itself failed (unreadable file): read nothing.
rem  Only a clean file (errorlevel 1 = no line matched) is read.
if errorlevel 2 goto :cand3
if errorlevel 1 goto :cand2read
goto :cand3
:cand2read
rem  First line only (the launcher writes exactly one line).  for /f is used
rem  instead of set /p because it also reads a last line without CRLF.
for /f "usebackq delims=" %%i in ("%CACHEF%") do if not defined CACHEV set "CACHEV=%%i"
if defined CACHEV call :trycache "%CACHEV%"
if defined NODE goto :done

:cand3
rem --- 3) Microsoft Store package, read from the registry (no PowerShell) -----
rem  reg query prints "    PackageRootFolder    REG_SZ    <path>", so with
rem  "tokens=2,*" the value type lands in %%a and the path in %%b.
rem  Two findstr passes are needed: the key name line also contains
rem  "OpenAI.Codex_", so keep only the line that carries the value too.
rem  Uninstalled versions can leave stale entries: :trypkg drops any root without
rem  app\resources\app.asar and keeps trying the remaining hits.
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages" /s /v PackageRootFolder 2^>nul ^| findstr /i /c:"OpenAI.Codex_" ^| findstr /i /c:"PackageRootFolder"') do if not defined NODE call :trypkg "%%b"
if defined NODE goto :done

:cand4
rem --- 4) same Store package through PowerShell (when reg.exe is locked down) -
for /f "usebackq delims=" %%i in (`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p=(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation; if ($p) { Join-Path $p 'app\resources\cua_node\bin\node.exe' }" 2^>nul`) do if not defined NODE call :try "%%i"
if defined NODE goto :done

:cand5
rem --- 5) node runtime that the app downloaded for itself ---------------------
if not exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\" goto :cand6
for /d %%d in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if not defined NODE call :try "%%d\bin\node.exe"
if defined NODE goto :done

:cand6
rem --- 6) Codex installed in the usual places ---------------------------------
rem  <dir>\resources\... is the portable layout and <dir>\app\resources\... the
rem  packaged one; :checkdir probes both.  for /d matches directory names that
rem  contain codex/chatgpt/openai and stays silent when nothing matches.
for /d %%d in ("%LOCALAPPDATA%\Programs\*codex*" "%LOCALAPPDATA%\Programs\*chatgpt*" "%LOCALAPPDATA%\Programs\*openai*" "%ProgramFiles%\*codex*" "%ProgramFiles%\*chatgpt*" "%ProgramFiles%\*openai*" "%ProgramFiles(x86)%\*codex*" "%ProgramFiles(x86)%\*chatgpt*" "%ProgramFiles(x86)%\*openai*") do call :checkdir "%%d"
if defined NODE goto :done

:cand7
rem --- 7) whatever Node.js is on PATH ----------------------------------------
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE call :try "%%i"

:done
exit /b 0

rem ----------------------------------------------------------------------------
rem :trycache <path> - accept a cached path only when it ends in node.exe, then
rem hand it to :try as usual.  :try alone accepts any existing file that starts
rem successfully (cmd.exe passes its check), which is fine for the candidates
rem above (they are always built as ...\node.exe) but not for the cache file:
rem it lives in a writable folder, and :try would ShellExecute a non-executable
rem like a .txt document.  Requiring the node.exe ending matches what the
rem launcher writes (spec 5.8) and keeps a wrong cache entry a harmless miss.
rem ----------------------------------------------------------------------------
:trycache
if /i not "%~nx1"=="node.exe" exit /b 1
call :try "%~1"
exit /b 0

rem ----------------------------------------------------------------------------
rem :try <path> - accept the candidate only when it is a real node.exe that
rem reports major version 18 or newer (the launcher needs a modern runtime).
rem Nothing is echoed here: all messages come from codex-launcher.js.
rem ----------------------------------------------------------------------------
:try
set "TRY=%~1"
if not exist "%TRY%" exit /b 1
"%TRY%" -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" >nul 2>nul
if errorlevel 1 exit /b 1
set "NODE=%TRY%"
exit /b 0

rem ----------------------------------------------------------------------------
rem :trypkg <package root> - a Store package root coming from the registry: only
rem accept it when app\resources\app.asar exists (leftovers of uninstalled
rem versions have none), then probe the node.exe that ships with the package.
rem The launcher uses the same two checks when it falls back to reg.exe.
rem ----------------------------------------------------------------------------
:trypkg
if not exist "%~1\app\resources\app.asar" exit /b 1
call :try "%~1\app\resources\cua_node\bin\node.exe"
exit /b 0

rem ----------------------------------------------------------------------------
rem :checkdir <dir> - probe the two known layouts below a candidate install dir
rem ----------------------------------------------------------------------------
:checkdir
if not exist "%~1\" exit /b 1
call :try "%~1\resources\cua_node\bin\node.exe"
if defined NODE exit /b 0
call :try "%~1\app\resources\cua_node\bin\node.exe"
exit /b 0
