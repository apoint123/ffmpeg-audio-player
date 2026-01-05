#!/bin/bash
set -e

BASE_DIR="cpp/deps_headers"
SYSROOT_DIR="$BASE_DIR/sysroot"
SYSTEM_DIR="$BASE_DIR/system"
FFMPEG_DIR="$BASE_DIR/ffmpeg"

mkdir -p "$SYSROOT_DIR"
mkdir -p "$SYSTEM_DIR"
mkdir -p "$FFMPEG_DIR"

echo "-------------------------------------------------------"
echo "1. 同步 Emscripten SDK 头文件"
echo "-------------------------------------------------------"
echo "🐳 正在从 Docker 镜像 emscripten/emsdk:4.0.22 提取头文件..."

docker create --name temp_emsdk_container emscripten/emsdk:4.0.22

echo "📂 正在复制系统头文件 (system/include)..."
docker cp temp_emsdk_container:/emsdk/upstream/emscripten/system/include "$SYSTEM_DIR"

echo "📂 正在复制标准库头文件 (sysroot/include)..."
docker cp temp_emsdk_container:/emsdk/upstream/emscripten/cache/sysroot/include "$SYSROOT_DIR"

echo "🧹 清理 Emscripten 临时容器..."
docker rm temp_emsdk_container

echo ""
echo "-------------------------------------------------------"
echo "2. 同步 FFmpeg 头文件"
echo "-------------------------------------------------------"
echo "🔨 正在构建 FFmpeg 阶段镜像 (这可能需要几分钟)..."

DOCKER_BUILDKIT=1 docker build --target ffmpeg-builder -t temp-ffmpeg-builder .

echo "🐳 创建 FFmpeg 临时容器..."
docker create --name temp_ffmpeg_container temp-ffmpeg-builder

echo "📂 正在复制 FFmpeg 头文件..."
docker cp temp_ffmpeg_container:/opt/include/. "$FFMPEG_DIR"

echo "🧹 清理 FFmpeg 临时容器..."
docker rm temp_ffmpeg_container
# docker rmi temp-ffmpeg-builder

echo ""
echo "✅ 所有头文件已同步到 $BASE_DIR"
echo "   请确保 .vscode/c_cpp_properties.json 已更新。"
