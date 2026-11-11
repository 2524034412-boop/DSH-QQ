@echo off
chcp 936 >nul
title qq-bridge 一键开启对接
set "NODE=C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo ================================================
echo   qq-bridge 一键开启对接
echo   将依次检查并启动: DSH ^> QQ ^> SnowLuma ^> 对齐端口 ^> 桥接 ^> 看门狗
echo ================================================
echo.
"%NODE%" "%~dp0scripts\autostart.mjs"
echo.
if /i "%~1"=="--no-pause" exit /b 0
echo 按任意键关闭窗口...
pause >nul
