@echo off
chcp 65001 >nul
rem 杀旧实例 -> 清锁 -> 重新拉起守护窗口；同样先补上 DSH 自带 Node 的 PATH。
set "PATH=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;%PATH%"
cd /d "%~dp0"
call restart.bat
