@echo off
rem 双击启动串口采集器（后台无窗口）。日志在 ..\state\serial-env.log
rem 先跑一次自检：scripts\serial-env.ps1 -Test
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0serial-env.ps1" %*