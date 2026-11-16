@echo off
REM ORBIT launcher - double-click this file to start everything.
REM Keeps the window open on failure so the error is readable.
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ORBIT needs Node.js 20 or newer.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

title ORBIT

node tools\launch.mjs %*
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo   ORBIT stopped with an error ^(code %EXIT_CODE%^).
  echo   The messages above explain what went wrong.
  echo.
  pause
)

exit /b %EXIT_CODE%
