/**
 * @fileoverview 构建 wasm 文件，并移动到 public 目录
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const JS_OUTPUT_DIR = "src/assets";
const WASM_OUTPUT_DIR = "public";

if (!existsSync(JS_OUTPUT_DIR)) mkdirSync(JS_OUTPUT_DIR, { recursive: true });
if (!existsSync(WASM_OUTPUT_DIR))
	mkdirSync(WASM_OUTPUT_DIR, { recursive: true });

console.log("🐳 开始 Docker 构建...");

const env = { ...process.env, DOCKER_BUILDKIT: "1" };

try {
	await $`docker build --platform linux/amd64 --output type=local,dest=${JS_OUTPUT_DIR} .`.env(
		env,
	);
} catch {
	console.error("❌ Docker 构建失败，请检查上方错误日志。");
	process.exit(1);
}

const wasmSource = join(JS_OUTPUT_DIR, "ffmpeg.wasm");
const wasmDest = join(WASM_OUTPUT_DIR, "ffmpeg.wasm");

if (existsSync(wasmSource)) {
	console.log(`📂 正在移动 WASM 文件到 ${WASM_OUTPUT_DIR} ...`);
	renameSync(wasmSource, wasmDest);
} else {
	console.error("❌ 错误：构建产物中未找到 ffmpeg.wasm");
	process.exit(1);
}

console.log("✅ 构建完成！");
