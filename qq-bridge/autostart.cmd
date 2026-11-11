@echo off
chcp 65001 >nul
rem ASCII-only launcher to avoid cmd codepage issues.
rem Real logic lives in scripts\autostart.mjs
set "NODE=C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0scripts\autostart.mjs"
