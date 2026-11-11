@echo off
chcp 936 >nul
title qq-bridge һ�������Խ�
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo ================================================
echo   qq-bridge һ�������Խ�
echo   �����μ�鲢����: DSH ^> QQ ^> SnowLuma ^> ����˿� ^> �Ž� ^> ���Ź�
echo ================================================
echo.
"%NODE%" "%~dp0scripts\autostart.mjs"
echo.
if /i "%~1"=="--no-pause" exit /b 0
echo ��������رմ���...
pause >nul
