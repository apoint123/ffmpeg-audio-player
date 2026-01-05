#!/bin/bash
set -e

JS_OUTPUT_DIR="src/assets"
WASM_OUTPUT_DIR="public"

mkdir -p "$JS_OUTPUT_DIR"
mkdir -p "$WASM_OUTPUT_DIR"

echo "🐳 开始 Docker 构建..."

DOCKER_BUILDKIT=1 docker build \
    --platform linux/amd64 \
    --output type=local,dest="$JS_OUTPUT_DIR" \
    .

if [ -f "$JS_OUTPUT_DIR/decode-audio.wasm" ]; then
    echo "📂 正在移动 WASM 文件到 $WASM_OUTPUT_DIR ..."
    mv "$JS_OUTPUT_DIR/decode-audio.wasm" "$WASM_OUTPUT_DIR/"
else
    echo "❌ 错误：构建产物中未找到 decode-audio.wasm"
    exit 1
fi

echo "✅ 构建完成！"
