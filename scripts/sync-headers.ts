/**
 * @fileoverview 从 Docker 镜像中提取头文件，用于 C++ IntelliSense
 */

import { existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";

const BASE_DIR = "cpp/deps_headers";
const SYSROOT_DIR = `${BASE_DIR}/sysroot`;
const SYSTEM_DIR = `${BASE_DIR}/system`;
const FFMPEG_DIR = `${BASE_DIR}/ffmpeg`;

[SYSROOT_DIR, SYSTEM_DIR, FFMPEG_DIR].forEach((dir) => {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

console.log("-------------------------------------------------------");
console.log("1. 同步 Emscripten SDK 头文件");
console.log("-------------------------------------------------------");
console.log("🐳 正在从 Docker 镜像提取头文件...");

try {
	await $`docker create --name temp_emsdk_container emscripten/emsdk:4.0.22`;

	console.log(`📂 正在复制系统头文件 (system/include)...`);
	await $`docker cp temp_emsdk_container:/emsdk/upstream/emscripten/system/include/. ${SYSTEM_DIR}`;

	console.log(`📂 正在复制标准库头文件 (sysroot/include)...`);
	await $`docker cp temp_emsdk_container:/emsdk/upstream/emscripten/cache/sysroot/include/. ${SYSROOT_DIR}`;
} catch {
	console.error("❌ Emscripten 头文件同步失败");
	process.exit(1);
} finally {
	console.log("🧹 清理 Emscripten 临时容器...");
	await $`docker rm -f temp_emsdk_container`.quiet().nothrow();
}

console.log("\n-------------------------------------------------------");
console.log("2. 同步 FFmpeg 头文件");
console.log("-------------------------------------------------------");
console.log("🔨 正在构建 FFmpeg 阶段镜像 (这可能需要几分钟)...");

const env = { ...process.env, DOCKER_BUILDKIT: "1" };

try {
	await $`docker build --target ffmpeg-builder -t temp-ffmpeg-builder .`.env(
		env,
	);

	console.log("🐳 创建 FFmpeg 临时容器...");
	await $`docker create --name temp_ffmpeg_container temp-ffmpeg-builder`;

	console.log("📂 正在复制 FFmpeg 头文件...");
	await $`docker cp temp_ffmpeg_container:/opt/include/. ${FFMPEG_DIR}`;
} catch {
	console.error("❌ FFmpeg 头文件同步失败");
	process.exit(1);
} finally {
	console.log("🧹 清理 FFmpeg 临时容器...");
	await $`docker rm -f temp_ffmpeg_container`.quiet().nothrow();
	await $`docker rmi temp-ffmpeg-builder`.quiet().nothrow();
}

console.log(`\n✅ 所有头文件已同步到 ${BASE_DIR}`);
console.log("   请确保 .vscode/c_cpp_properties.json 已更新。");
