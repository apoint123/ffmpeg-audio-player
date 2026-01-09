/**
 * @fileoverview 负责配置 (emconfigure) 和编译 (emmake) FFmpeg
 */

import { cpus } from "node:os";
import { $ } from "bun";

const DEMUXERS = [
	"aac",
	"ac3",
	"aiff",
	"ape",
	"asf",
	"flac",
	"matroska",
	"mov",
	"mp3",
	"ogg",
	"wav",
	"wv",
	"amr",
	"au",
	"dts",
	"dtshd",
	"m4v",
	"mpc",
	"mpc8",
	"rm",
	"tak",
	"tta",
	"truehd",
	"dsf",
	"dff",
];

const DECODERS = [
	"aac",
	"aac_latm",
	"ac3",
	"alac",
	"als",
	"ape",
	"flac",
	"mp3",
	"opus",
	"pcm_alaw",
	"pcm_f32be",
	"pcm_f32le",
	"pcm_f64be",
	"pcm_f64le",
	"pcm_mulaw",
	"pcm_s16be",
	"pcm_s16le",
	"pcm_s24be",
	"pcm_s24le",
	"pcm_s32be",
	"pcm_s32le",
	"pcm_s8",
	"pcm_u16be",
	"pcm_u16le",
	"pcm_u24be",
	"pcm_u24le",
	"pcm_u32be",
	"pcm_u32le",
	"pcm_u8",
	"vorbis",
	"wavpack",
	"wmalossless",
	"wmapro",
	"wmav1",
	"wmav2",
	"wmavoice",
	"amrnb",
	"amrwb",
	"cook",
	"dca",
	"eac3",
	"mlp",
	"mpc7",
	"mpc8",
	"ra_144",
	"ra_288",
	"shorten",
	"tak",
	"tta",
	"truehd",
	"dsd_lsbf",
	"dsd_msbf",
	"dsd_lsbf_planar",
	"dsd_msbf_planar",
];

const extraFlags = [
	...DEMUXERS.map((d) => `--enable-demuxer=${d}`),
	...DECODERS.map((d) => `--enable-decoder=${d}`),
];

const installDir = process.env.INSTALL_DIR || "/opt";

const confFlags = [
	`--prefix=${installDir}`,
	"--target-os=none",
	"--arch=x86_32",

	"--enable-cross-compile",
	"--disable-asm",
	"--disable-debug",
	"--disable-doc",
	"--disable-programs",

	"--disable-everything",
	"--disable-network",
	"--disable-hwaccels",
	"--disable-encoders",
	"--disable-muxers",
	"--disable-avdevice",
	"--disable-postproc",
	"--disable-avfilter",
	"--disable-swscale",

	"--enable-avcodec",
	"--enable-avformat",
	"--enable-avutil",
	"--enable-swresample",
	"--enable-parsers",
	"--enable-protocol=file",

	"--nm=emnm",
	"--ar=emar",
	"--ranlib=emranlib",
	"--cc=emcc",
	"--cxx=em++",
	"--objcc=emcc",
	"--dep-cc=emcc",

	`--extra-cflags=${process.env.CFLAGS || ""}`,
	`--extra-cxxflags=${process.env.CXXFLAGS || ""}`,

	"--disable-pthreads",
	"--disable-w32threads",
	"--disable-os2threads",
];

const userArgs = process.argv.slice(2);

console.log("Running emconfigure ./configure...");
console.log(
	`Configuration flags count: ${confFlags.length + extraFlags.length}`,
);

await $`emconfigure ./configure ${confFlags} ${extraFlags} ${userArgs}`;

console.log("Compiling...");
const jobs = cpus().length;
await $`emmake make -j${jobs}`;

console.log("Installing...");
await $`emmake make install`;

console.log("✅ FFmpeg build complete.");
