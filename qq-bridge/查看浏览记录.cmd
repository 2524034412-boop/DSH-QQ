@echo off
chcp 936 >nul
title 她刷到的B站
set "NODE=C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0scripts\bili-report.mjs"
start "" notepad "%~dp0浏览记录.txt"
