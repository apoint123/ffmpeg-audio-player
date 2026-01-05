import type {
	AudioDecoderModule,
	AudioStreamDecoder,
	WorkerRequest,
	WorkerResponse,
} from "@/types";
import createAudioDecoderCore from "../assets/decode-audio.js";

let ffmpegModule: AudioDecoderModule | null = null;
let decoder: AudioStreamDecoder | null = null;
let mountDir: string = "";
let isDecoding = false;
let isPaused = false;
let currentId: number = 0;
let currentChunkSize = 4096;

async function getModule(): Promise<AudioDecoderModule> {
	if (ffmpegModule) return ffmpegModule;

	ffmpegModule = (await createAudioDecoderCore({
		locateFile: (path: string) => {
			if (path.endsWith(".wasm")) {
				return "/decode-audio.wasm";
			}
			return path;
		},
		print: (text: string) => console.log("[WASM]", text),
		printErr: (text: string) => console.error("[WASM Error]", text),
	})) as AudioDecoderModule;

	return ffmpegModule;
}

function postResponse(msg: WorkerResponse, transfer: Transferable[] = []) {
	self.postMessage(msg, transfer);
}

const processNextChunk = () => {
	if (!isDecoding || !decoder) return;
	if (isPaused) return;

	try {
		const result = decoder.readChunk(currentChunkSize);

		if (result.status.status < 0) {
			throw new Error(`Decode error: ${result.status.error}`);
		}

		const samplesView = result.samples;

		if (samplesView.length > 0) {
			const chunkData = samplesView.slice();

			postResponse(
				{
					id: currentId,
					type: "CHUNK",
					data: chunkData,
				},
				[chunkData.buffer],
			);
		}

		const isEOF = result.isEOF;

		if (isEOF) {
			isDecoding = false;
			postResponse({ id: currentId, type: "EOF" });
		} else {
			setTimeout(processNextChunk, 0);
		}
	} catch (e) {
		postResponse({ id: currentId, type: "ERROR", error: (e as Error).message });
		cleanupTask();
	}
};

const cleanupTask = () => {
	isDecoding = false;
	if (decoder) {
		decoder.close();
		decoder.delete();
		decoder = null;
	}
	if (ffmpegModule && mountDir) {
		try {
			ffmpegModule.FS.unmount(mountDir);
			ffmpegModule.FS.rmdir(mountDir);
		} catch (e) {
			console.warn("清理时出错", e);
		}
		mountDir = "";
	}
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
	const req = e.data;

	if (req.type === "PAUSE") {
		isPaused = true;
		return;
	}

	if (req.type === "RESUME") {
		if (isPaused && isDecoding) {
			isPaused = false;
			processNextChunk();
		}
		return;
	}

	if (req.type === "SEEK") {
		if (!decoder) return;
		try {
			const result = decoder.seek(req.seekTime);
			if (result.status < 0) throw new Error(result.error);
			currentId = req.id;

			postResponse({ id: req.id, type: "SEEK_DONE", time: req.seekTime });

			isPaused = false;
			isDecoding = true;
			processNextChunk();
		} catch (e) {
			console.error("Seek error", e);
			postResponse({
				id: req.id,
				type: "ERROR",
				error: (e as Error).message,
			});
		}
		return;
	}

	if (req.type === "INIT") {
		cleanupTask();

		currentId = req.id;
		currentChunkSize = req.chunkSize;
		isDecoding = true;
		isPaused = false;

		try {
			const module = await getModule();

			mountDir = `/input_${req.id}`;
			try {
				module.FS.mkdir(mountDir);
			} catch (e) {
				console.warn(`挂载文件失败 ${e}`);
			}

			const WORKERFS = module.FS.filesystems.WORKERFS;
			module.FS.mount(WORKERFS, { files: [req.file] }, mountDir);
			const filePath = `${mountDir}/${req.file.name}`;

			decoder = new module.AudioStreamDecoder();
			const props = decoder.init(filePath);

			if (props.status.status < 0) throw new Error(props.status.error);

			const metadataObj: Record<string, string> = {};
			const keysList = props.metadata.keys();
			for (let i = 0; i < keysList.size(); i++) {
				const key = keysList.get(i);
				metadataObj[key] = props.metadata.get(key);
			}
			keysList.delete();

			let coverUrl: string | undefined;
			const coverVector = props.coverArt;
			const coverSize = coverVector.size();

			if (coverSize > 0) {
				const coverArray = new Uint8Array(coverSize);
				for (let i = 0; i < coverSize; i++) {
					coverArray[i] = coverVector.get(i);
				}
				const blob = new Blob([coverArray]);
				coverUrl = URL.createObjectURL(blob);
			}

			if (props.metadata?.delete) {
				props.metadata.delete();
			}

			if (props.coverArt?.delete) {
				props.coverArt.delete();
			}

			postResponse({
				id: req.id,
				type: "METADATA",
				sampleRate: props.sampleRate,
				channels: props.channelCount,
				duration: props.duration,
				metadata: metadataObj,
				encoding: props.encoding,
				coverUrl: coverUrl,
				bitsPerSample: props.bitsPerSample,
			});

			processNextChunk();
		} catch (err) {
			postResponse({
				id: req.id,
				type: "ERROR",
				error: (err as Error).message,
			});
			cleanupTask();
		}
	}
};
