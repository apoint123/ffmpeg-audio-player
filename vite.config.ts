import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
	plugins: [
		dts({
			tsconfigPath: "./tsconfig.json",
		}),
	],
	server: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "FFmpegAudioPlayer",
			fileName: "ffmpeg-audio-player",
		},
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src/"),
		},
	},
});
