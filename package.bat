@echo off
SETLOCAL EnableDelayedExpansion

echo ==========================================
echo    Packaging Tool Support Claude   
echo ==========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js first.
    pause
    exit /b 1
)

:: Check if node_modules exists, if not install
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Installing dependencies...
    call npm install
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
)

:: Compile/bundle the extension
echo [INFO] Bundling extension with esbuild...
call npm run vscode:prepublish
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Bundle compilation failed.
    pause
    exit /b 1
)

:: Package the extension into a .vsix file using vsce
echo [INFO] Packaging VS Code Extension (.vsix)...
:: Use npx to execute @vscode/vsce even if it's not installed globally
call npx @vscode/vsce package --no-yarn
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Packaging failed. Trying with --allow-missing-repository ...
    call npx @vscode/vsce package --allow-missing-repository --no-yarn
)

if %ERRORLEVEL% equ 0 (
    echo.
    echo ==========================================
    echo [SUCCESS] Package created successfully!
    echo ==========================================
) else (
    echo.
    echo [ERROR] Packaging failed.
)

pause
