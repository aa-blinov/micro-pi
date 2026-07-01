@echo off
rem Release launcher (Windows) - runs the pre-built dist/index.js bundle.
rem See bin/cast (the macOS/Linux equivalent) for why --no-deprecation
rem and CAST_CWD are both here.
setlocal
set "CAST_CWD=%CD%"
node --no-deprecation "%~dp0..\dist\index.js" %*
