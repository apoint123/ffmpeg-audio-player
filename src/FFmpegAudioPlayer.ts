import type {
	AudioMetadata,
	PlayerEventMap,
	PlayerState,
	WorkerRequest,
	WorkerResponse,
} from "./types";
import { SharedRingBuffer } from "./utils/SharedRingBuffer";
import { type GetDetail, TypedEventTarget } from "./utils/TypedEventTarget";

const HIGH_WATER_MARK = 30;
const LOW_WATER_MARK = 10;
const FADE_DURATION = 0.15;
const SEEK_FADE_DURATION = 0.05;
const IDX_SEEK_GEN = 4;

type FFmpegPlayerEventMap = {
	[K in keyof PlayerEventMap]: CustomEvent<PlayerEventMap[K]>;
};

export class FFmpegAudioPlayer extends TypedEventTarget<FFmpegPlayerEventMap> {
	private worker: Worker | null = null;
	private audioCtx: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	public analyser: AnalyserNode | null = null;
	private metadata: AudioMetadata | null = null;

	private playerState: PlayerState = "idle";
	private nextStartTime = 0;
	private isWorkerPaused = false;
	private activeSources: AudioBufferSourceNode[] = [];
	private isDecodingFinished = false;
	private targetVolume = 1.0;
	private currentTempo = 1.0;

	/** 锚点时刻的 AudioContext 时间 */
	private anchorWallTime = 0;
	/** 锚点时刻的 音频资源 时间（00:00） */
	private anchorSourceTime = 0;

	/** 用于存储 seek 操作的 resolve 函数 */
	private pendingSeekResolve:
		| ((value: void | PromiseLike<void>) => void)
		| null = null;

	/** 标记当前 seek 是否不需要淡入淡出，用于 setTempo/setPitch */
	private isImmediateSeek = false;

	private timeUpdateFrameId: number = 0;
	private currentMessageId = 0;

	private ringBuffer: SharedRingBuffer | null = null;
	private sabHeader: Int32Array | null = null;
	private fetchController: AbortController | null = null;
	private isStreaming = false;
	private currentUrl: string | null = null;
	private fileSize = 0;

	private pendingExports = new Map<
		number,
		{ resolve: (blob: Blob) => void; reject: (err: Error) => void }
	>();

	constructor(private workerFactory: () => Worker) {
		super();
	}

	public get state() {
		return this.playerState;
	}
	public get duration() {
		return this.metadata?.duration || 0;
	}
	public get currentTime() {
		if (!this.audioCtx) return 0;
		const wallDelta = this.audioCtx.currentTime - this.anchorWallTime;
		const currentPosition =
			this.anchorSourceTime + wallDelta * this.currentTempo;
		return Math.max(0, currentPosition);
	}
	public get volume() {
		return this.targetVolume;
	}
	public get audioInfo() {
		return this.metadata;
	}

	public async load(file: File) {
		this.reset();
		this.dispatch("loadstart");

		try {
			await this.initAudioContext();

			this.worker = this.workerFactory();
			this.setupWorkerListeners();

			this.currentMessageId = Date.now();
			this.isStreaming = false;

			this.postToWorker({
				type: "INIT",
				id: this.currentMessageId,
				file,
				chunkSize: 4096 * 8,
			});
		} catch (e) {
			this.dispatch("error", (e as Error).message);
		}
	}

	public async loadSrc(url: string) {
		this.reset();
		this.dispatch("loadstart");

		try {
			await this.initAudioContext();

			const response = await fetch(url, { method: "HEAD" });
			if (!response.ok) {
				throw new Error(`Failed to fetch metadata: ${response.statusText}`);
			}
			const contentLength = response.headers.get("Content-Length");
			if (!contentLength) {
				throw new Error("Content-Length header is missing");
			}

			this.fileSize = parseInt(contentLength, 10);
			this.currentUrl = url;

			const BUFFER_SIZE = 2 * 1024 * 1024;
			this.ringBuffer = SharedRingBuffer.create(BUFFER_SIZE);

			const sab = this.ringBuffer.sharedArrayBuffer;
			this.sabHeader = new Int32Array(sab, 0, IDX_SEEK_GEN + 1);

			this.worker = this.workerFactory();
			this.setupWorkerListeners();

			this.currentMessageId = Date.now();
			this.isStreaming = true;

			this.postToWorker({
				type: "INIT_STREAM",
				id: this.currentMessageId,
				fileSize: this.fileSize,
				sab: sab,
				chunkSize: 4096 * 8,
			});

			this.runFetchLoop(url, 0, this.fileSize);
		} catch (e) {
			this.dispatch("error", (e as Error).message);
		}
	}

	private async runFetchLoop(
		url: string,
		startOffset: number,
		totalSize: number,
	) {
		if (this.fetchController) {
			this.fetchController.abort();
		}
		this.fetchController = new AbortController();
		const signal = this.fetchController.signal;

		if (startOffset >= totalSize) {
			this.ringBuffer?.setEOF();
			this.notifyWorkerSeek();
			return;
		}

		try {
			const safeStartOffset = Math.floor(startOffset);
			const response = await fetch(url, {
				headers: {
					Range: `bytes=${safeStartOffset}-`,
				},
				signal,
			});

			if (response.status === 416) {
				this.ringBuffer?.setEOF();
				this.notifyWorkerSeek();
				return;
			}

			if (!response.ok && response.status !== 206) {
				throw new Error(
					`Fetch failed: ${response.status} ${response.statusText}`,
				);
			}

			if (!response.body) throw new Error("Response body is null");

			const reader = response.body.getReader();

			this.notifyWorkerSeek();

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					this.ringBuffer?.setEOF();
					break;
				}

				if (value && this.ringBuffer) {
					await this.ringBuffer.write(value);
				}

				if (signal.aborted) break;
			}
		} catch (err: unknown) {
			if ((err as Error).name === "AbortError") {
				// ignore
			} else {
				this.dispatch("error", `Network error: ${(err as Error).message}`);
			}
		}
	}

	public async play() {
		if (!this.audioCtx || !this.masterGain) return;

		this.dispatch("play");

		if (this.audioCtx.state === "suspended") {
			await this.audioCtx.resume();
		}

		if (this.worker && this.isWorkerPaused) {
			this.postToWorker({ type: "RESUME", id: this.currentMessageId });
			this.isWorkerPaused = false;
		}

		this.rampGain(this.targetVolume, FADE_DURATION);

		this.dispatch("playing");
		this.startTimeUpdate();
	}

	public async pause() {
		if (!this.audioCtx || !this.masterGain) return;

		this.dispatch("pause");
		this.stopTimeUpdate();

		if (this.worker) {
			this.postToWorker({ type: "PAUSE", id: this.currentMessageId });
			this.isWorkerPaused = true;
		}

		this.rampGain(0, FADE_DURATION);

		await new Promise((resolve) => setTimeout(resolve, FADE_DURATION * 1000));

		if (this.playerState === "paused" && this.audioCtx.state === "running") {
			await this.audioCtx.suspend();
		}
	}

	/**
	 * 跳转到指定的时间
	 * @param time 指定的时间，单位为秒
	 * @param immediate 是否跳过淡入淡出立刻跳转
	 * @returns 如果跳转操作完成，包括淡入淡出完成，则 resolve
	 */
	public async seek(time: number, immediate = false) {
		if (!this.worker || !this.audioCtx || !this.metadata || !this.masterGain)
			return;

		if (this.pendingSeekResolve) {
			this.pendingSeekResolve();
			this.pendingSeekResolve = null;
		}

		this.dispatch("seeking");
		this.isImmediateSeek = immediate;

		if (!immediate) {
			this.rampGain(0, SEEK_FADE_DURATION);
			await new Promise((resolve) =>
				setTimeout(resolve, SEEK_FADE_DURATION * 1000),
			);
		} else {
			this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
			this.masterGain.gain.value = 0;
		}

		this.stopActiveSources();
		this.activeSources = [];
		this.currentMessageId = Date.now();

		const seekPromise = new Promise<void>((resolve) => {
			this.pendingSeekResolve = resolve;
		});

		this.postToWorker({
			type: "SEEK",
			id: this.currentMessageId,
			seekTime: time,
		});

		this.isDecodingFinished = false;

		// 等待 Worker 处理完成 (SEEK_DONE事件)
		await seekPromise;

		this.dispatch("timeupdate", time);
	}

	public setVolume(val: number) {
		this.targetVolume = Math.max(0, Math.min(1, val));

		if (this.masterGain && this.playerState === "playing" && this.audioCtx) {
			this.rampGain(this.targetVolume, 0.05);
		}

		this.dispatch("volumechange", this.targetVolume);
	}

	public async setTempo(tempo: number) {
		if (!this.worker) return;
		const trueTime = this.currentTime;
		this.postToWorker({ type: "SET_TEMPO", value: tempo });
		this.currentTempo = tempo;
		await this.seek(trueTime, true);
	}

	public async setPitch(pitch: number) {
		if (!this.worker) return;
		const trueTime = this.currentTime;
		this.postToWorker({ type: "SET_PITCH", value: pitch });
		await this.seek(trueTime, true);
	}

	public async resetTempoAndPitch() {
		if (!this.worker) return;
		const trueTime = this.currentTime;
		this.currentTempo = 1.0;
		this.postToWorker({ type: "SET_TEMPO", value: 1.0 });
		this.postToWorker({ type: "SET_PITCH", value: 1.0 });
		await this.seek(trueTime, true);
	}

	public async exportAsWav(file: File): Promise<Blob> {
		if (!this.worker) throw new Error("Worker not initialized");
		const exportId = Date.now();
		return new Promise<Blob>((resolve, reject) => {
			this.pendingExports.set(exportId, { resolve, reject });
			this.postToWorker({
				type: "EXPORT_WAV",
				id: exportId,
				file: file,
			});
		});
	}

	private async initAudioContext() {
		if (!this.audioCtx) {
			const AudioContextCtor =
				// biome-ignore lint/suspicious/noExplicitAny: 兼容
				window.AudioContext || (window as any).webkitAudioContext;
			this.audioCtx = new AudioContextCtor();

			this.masterGain = this.audioCtx.createGain();
			this.masterGain.gain.value = 0;

			this.analyser = this.audioCtx.createAnalyser();
			this.analyser.fftSize = 2048;

			this.analyser.connect(this.masterGain);
			this.masterGain.connect(this.audioCtx.destination);
		}
		if (this.audioCtx.state === "running") {
			await this.audioCtx.suspend();
		}
	}

	private setupWorkerListeners() {
		if (!this.worker) return;

		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const resp = event.data;

			if (resp.type === "EXPORT_WAV_DONE") {
				const pending = this.pendingExports.get(resp.id);
				if (pending) {
					pending.resolve(resp.blob);
					this.pendingExports.delete(resp.id);
				}
				return;
			}
			if (resp.type === "ERROR" && this.pendingExports.has(resp.id)) {
				const pending = this.pendingExports.get(resp.id);
				if (pending) {
					pending.reject(new Error(resp.error));
					this.pendingExports.delete(resp.id);
				}
				return;
			}

			if (resp.type === "SEEK_NET") {
				if (this.isStreaming && this.ringBuffer && this.currentUrl) {
					if (this.fetchController) {
						this.fetchController.abort();
					}
					this.ringBuffer.reset();
					this.runFetchLoop(this.currentUrl, resp.seekOffset, this.fileSize);
				}
				return;
			}

			if (resp.id !== this.currentMessageId) return;

			switch (resp.type) {
				case "ERROR":
					this.dispatch("error", resp.error);
					break;
				case "METADATA":
					this.metadata = {
						sampleRate: resp.sampleRate,
						channels: resp.channels,
						duration: resp.duration,
						metadata: resp.metadata,
						encoding: resp.encoding,
						coverUrl: resp.coverUrl,
						bitsPerSample: resp.bitsPerSample,
					};
					if (this.audioCtx) {
						const now = this.audioCtx.currentTime;
						this.syncTimeAnchor(now, 0);
						this.nextStartTime = now;
					}
					this.dispatch("durationchange", resp.duration);
					this.dispatch("loadedmetadata");
					this.dispatch("canplay");
					break;
				case "CHUNK":
					if (this.metadata) {
						this.scheduleChunk(
							resp.data,
							this.metadata.sampleRate,
							this.metadata.channels,
							resp.startTime,
						);

						if (this.audioCtx) {
							const bufferedDuration =
								this.nextStartTime - this.audioCtx.currentTime;
							if (bufferedDuration > HIGH_WATER_MARK && !this.isWorkerPaused) {
								this.postToWorker({
									type: "PAUSE",
									id: this.currentMessageId,
								});
								this.isWorkerPaused = true;
							}
						}
					}
					break;
				case "EOF":
					this.isDecodingFinished = true;
					this.checkIfEnded();
					break;
				case "SEEK_DONE":
					if (this.audioCtx && this.masterGain) {
						const now = this.audioCtx.currentTime;
						this.isWorkerPaused = false;
						this.nextStartTime = now;
						this.syncTimeAnchor(now, resp.time);

						if (this.playerState === "playing") {
							this.masterGain.gain.cancelScheduledValues(now);

							if (this.isImmediateSeek) {
								this.masterGain.gain.setValueAtTime(this.targetVolume, now);
							} else {
								this.masterGain.gain.setValueAtTime(0, now);
								this.masterGain.gain.linearRampToValueAtTime(
									this.targetVolume,
									now + SEEK_FADE_DURATION,
								);
							}
						}
					}

					this.dispatch("seeked");

					if (this.pendingSeekResolve) {
						this.pendingSeekResolve();
						this.pendingSeekResolve = null;
					}
					break;
			}
		};
	}

	private notifyWorkerSeek() {
		if (this.sabHeader) {
			Atomics.add(this.sabHeader, IDX_SEEK_GEN, 1);
			Atomics.notify(this.sabHeader, IDX_SEEK_GEN, 1);
		}
	}

	private postToWorker(msg: WorkerRequest) {
		this.worker?.postMessage(msg);
	}

	private scheduleChunk(
		planarData: Float32Array,
		sampleRate: number,
		channels: number,
		chunkStartTime: number,
	) {
		if (!this.audioCtx || !this.masterGain || !this.analyser) return;
		const ctx = this.audioCtx;

		const safeChannels = channels || 1;
		const frameCount = planarData.length / safeChannels;

		const audioBuffer = ctx.createBuffer(safeChannels, frameCount, sampleRate);

		for (let ch = 0; ch < safeChannels; ch++) {
			const chData = audioBuffer.getChannelData(ch);
			const start = ch * frameCount;
			chData.set(planarData.subarray(start, start + frameCount));
		}

		const now = this.audioCtx.currentTime;

		if (this.nextStartTime < now) {
			this.nextStartTime = now;
		}

		this.syncTimeAnchor(this.nextStartTime, chunkStartTime);

		const source = ctx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.analyser);

		source.start(this.nextStartTime);

		this.nextStartTime += audioBuffer.duration;

		this.activeSources.push(source);

		source.onended = () => {
			this.activeSources = this.activeSources.filter((s) => s !== source);

			if (this.audioCtx && !this.isDecodingFinished) {
				const bufferedDuration = this.nextStartTime - this.audioCtx.currentTime;
				if (bufferedDuration < LOW_WATER_MARK && this.isWorkerPaused) {
					this.postToWorker({ type: "RESUME", id: this.currentMessageId });
					this.isWorkerPaused = false;
				}
			}

			if (this.activeSources.length === 0) {
				if (this.isDecodingFinished) {
					this.checkIfEnded();
				} else if (this.playerState === "playing") {
					this.dispatch("waiting");
				}
			}

			this.checkIfEnded();
		};
	}

	private checkIfEnded() {
		if (this.state !== "playing") return;
		if (this.activeSources.length > 0) return;
		if (!this.isDecodingFinished) return;

		this.dispatch("ended");
	}

	private syncTimeAnchor(wallTime: number, sourceTime: number) {
		this.anchorWallTime = wallTime;
		this.anchorSourceTime = sourceTime;
	}

	private rampGain(target: number, duration: number) {
		if (!this.masterGain || !this.audioCtx) return;
		const now = this.audioCtx.currentTime;
		this.masterGain.gain.cancelScheduledValues(now);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
		this.masterGain.gain.linearRampToValueAtTime(target, now + duration);
	}

	private stopActiveSources() {
		this.activeSources.forEach((source) => {
			try {
				source.stop();
			} catch {
				// ignore
			}
		});
		this.activeSources = [];
	}

	private startTimeUpdate() {
		this.stopTimeUpdate();
		const tick = () => {
			if (this.state === "playing") {
				this.dispatch("timeupdate", this.currentTime);
				this.timeUpdateFrameId = requestAnimationFrame(tick);
			}
		};
		this.timeUpdateFrameId = requestAnimationFrame(tick);
	}

	private stopTimeUpdate() {
		if (this.timeUpdateFrameId) {
			cancelAnimationFrame(this.timeUpdateFrameId);
			this.timeUpdateFrameId = 0;
		}
	}

	public override dispatch<K extends keyof FFmpegPlayerEventMap>(
		type: K,
		...args: GetDetail<FFmpegPlayerEventMap[K]> extends undefined
			? [detail?: GetDetail<FFmpegPlayerEventMap[K]>]
			: [detail: GetDetail<FFmpegPlayerEventMap[K]>]
	): boolean {
		switch (type) {
			case "loadstart":
				this.playerState = "loading";
				break;
			case "canplay":
			case "loadedmetadata":
				if (this.playerState !== "playing" && this.playerState !== "error") {
					this.playerState = "ready";
				}
				break;
			case "playing":
				this.playerState = "playing";
				break;
			case "pause":
				this.playerState = "paused";
				break;
			case "ended":
				this.playerState = "idle";
				break;
			case "error":
				this.playerState = "error";
				break;
			case "emptied":
				this.playerState = "idle";
				break;
		}
		return super.dispatch(type, ...args);
	}

	private reset() {
		this.stopTimeUpdate();
		this.audioCtx?.suspend();
		this.stopActiveSources();
		this.activeSources = [];

		this.metadata = null;
		this.isWorkerPaused = false;
		this.isDecodingFinished = false;
		this.nextStartTime = this.audioCtx ? this.audioCtx.currentTime : 0;

		if (this.masterGain) {
			this.masterGain.gain.cancelScheduledValues(0);
			this.masterGain.gain.value = 0;
		}

		if (this.fetchController) {
			this.fetchController.abort();
			this.fetchController = null;
		}
		this.isStreaming = false;
		this.ringBuffer = null;
		this.sabHeader = null;

		this.dispatch("emptied");
	}

	public destroy() {
		this.reset();
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		if (this.audioCtx) {
			this.audioCtx.close();
			this.audioCtx = null;
			this.masterGain = null;
			this.analyser = null;
		}
	}
}
