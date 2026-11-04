@echo off
chcp 65001 >nul
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0scripts\autostart.mjs"
