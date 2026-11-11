@echo off
chcp 65001 >nul
rem 本机没有全局 Node，这里把 DSH 自带的 Node 运行时加进 PATH，
rem 再交给仓库自带的 start.bat（守护模式：崩溃 5 秒后自动重启）。
set "PATH=C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;%PATH%"
cd /d "%~dp0"
call start.bat
