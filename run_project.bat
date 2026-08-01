@echo off
title ESP32-CAM Stream Server
echo ===================================================
echo Starting ESP32-CAM Stream Server...
echo ===================================================

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

:: Check if node_modules folder exists, if not, run npm install
if not exist node_modules (
    echo [INFO] node_modules not found. Running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Open the dashboard in browser
echo [INFO] Opening Dashboard at http://localhost:3000
start http://localhost:3000

:: Start the node server
echo [INFO] Starting the signaling server...
node server.js

echo [INFO] Server stopped. Exiting...
exit
