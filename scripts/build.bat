@echo off
setlocal

chcp 65001 >nul

set "JS_OUTPUT_DIR=src\assets"
set "WASM_OUTPUT_DIR=public"

if not exist "%JS_OUTPUT_DIR%" mkdir "%JS_OUTPUT_DIR%"
if not exist "%WASM_OUTPUT_DIR%" mkdir "%WASM_OUTPUT_DIR%"

echo 🐳 开始 Docker 构建...

set "DOCKER_BUILDKIT=1"

docker build ^
    --platform linux/amd64 ^
    --output type=local,dest="%JS_OUTPUT_DIR%" ^
    .

if %errorlevel% neq 0 (
    echo ❌ Docker 构建失败，请检查错误日志。
    exit /b %errorlevel%
)

if exist "%JS_OUTPUT_DIR%\decode-audio.wasm" (
    echo 📂 正在移动 WASM 文件到 %WASM_OUTPUT_DIR% ...
    move /Y "%JS_OUTPUT_DIR%\decode-audio.wasm" "%WASM_OUTPUT_DIR%\" >nul
) else (
    echo ❌ 错误：构建产物中未找到 decode-audio.wasm
    exit /b 1
)

echo ✅ 构建完成！

endlocal
