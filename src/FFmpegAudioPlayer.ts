import type {
	AudioMetadata,
	PlayerEventMap,
	PlayerState,
	WorkerRequest,
	WorkerResponse,
} from "./types";

const HIGH_WATER_MARK = 30;
const LOW_WATER_MARK = 10;
const FADE_DURATION = 0.15;
const SEEK_FADE_DURATION = 0.05;

export class FFmpegAudioPlayer extends EventTarget {
	private worker: Worker | null = null;
	private audioCtx: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private metadata: AudioMetadata | null = null;

	private playerState: PlayerState = "idle";
	private nextStartTime = 0;
	private timeOffset = 0;
	private isWorkerPaused = false;
	private activeSources: AudioBufferSourceNode[] = [];
	private isDecodingFinished = false;
	private targetVolume = 1.0;

	private flowControlInterval: number = 0;
	private timeUpdateFrameId: number = 0;
	private currentMessageId = 0;

	public analyser: AnalyserNode | null = null;

	constructor(private workerFactory: () => Worker) {
		super();
	}

	public override addEventListener<K extends keyof PlayerEventMap>(
		type: K,
		listener: (ev: CustomEvent<PlayerEventMap[K]>) => void,
		options?: boolean | AddEventListenerOptions,
	): void;
	public override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	public override addEventListener(
		type: string,
		listener:
			| EventListenerOrEventListenerObject
			| ((ev: CustomEvent<unknown>) => void)
			| null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(
			type,
			listener as EventListenerOrEventListenerObject,
			options,
		);
	}

	public override removeEventListener<K extends keyof PlayerEventMap>(
		type: K,
		listener: (ev: CustomEvent<PlayerEventMap[K]>) => void,
		options?: boolean | EventListenerOptions,
	): void;
	public override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	public override removeEventListener(
		type: string,
		listener:
			| EventListenerOrEventListenerObject
			| ((ev: CustomEvent<unknown>) => void)
			| null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(
			type,
			listener as EventListenerOrEventListenerObject,
			options,
		);
	}

	private dispatch<K extends keyof PlayerEventMap>(
		type: K,
		detail?: PlayerEventMap[K],
	) {
		const event = new CustomEvent(type, { detail });
		this.dispatchEvent(event);
	}

	public get state() {
		return this.playerState;
	}
	public get duration() {
		return this.metadata?.duration || 0;
	}
	public get currentTime() {
		if (!this.audioCtx) return 0;
		return Math.max(0, this.audioCtx.currentTime - this.timeOffset);
	}
	public get audioInfo() {
		return this.metadata;
	}

	private postToWorker(msg: WorkerRequest) {
		this.worker?.postMessage(msg);
	}

	public async load(file: File) {
		this.reset();
		this.setState("loading");

		try {
			if (!this.audioCtx) {
				const AudioContext = window.AudioContext;
				this.audioCtx = new AudioContext();

				this.masterGain = this.audioCtx.createGain();
				this.masterGain.gain.value = 0;

				this.analyser = this.audioCtx.createAnalyser();
				this.analyser.fftSize = 2048;

				this.analyser.connect(this.masterGain);
				this.masterGain.connect(this.audioCtx.destination);
			}

			if (this.audioCtx.state === "suspended") {
				await this.audioCtx.resume();
			}

			this.worker = this.workerFactory();
			this.setupWorkerListeners();

			this.startFlowControl();

			this.currentMessageId = Date.now();
			this.postToWorker({
				type: "INIT",
				id: this.currentMessageId,
				file,
				chunkSize: 4096 * 8,
			});
		} catch (e) {
			this.handleError((e as Error).message);
		}
	}

	public async play() {
		if (!this.audioCtx || !this.masterGain) return;

		if (this.audioCtx.state === "suspended") {
			await this.audioCtx.resume();
		}

		if (this.worker && this.isWorkerPaused) {
			this.worker.postMessage({ type: "RESUME", id: this.currentMessageId });
			this.isWorkerPaused = false;
		}

		const now = this.audioCtx.currentTime;
		this.masterGain.gain.cancelScheduledValues(now);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
		this.masterGain.gain.linearRampToValueAtTime(
			this.targetVolume,
			now + FADE_DURATION,
		);

		this.setState("playing");
		this.startTimeUpdate();
	}

	public async pause() {
		if (!this.audioCtx || !this.masterGain) return;

		this.setState("paused");
		this.stopTimeUpdate();

		if (this.worker) {
			this.postToWorker({ type: "PAUSE", id: this.currentMessageId });
			this.isWorkerPaused = true;
		}

		const now = this.audioCtx.currentTime;
		this.masterGain.gain.cancelScheduledValues(now);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
		this.masterGain.gain.linearRampToValueAtTime(0, now + FADE_DURATION);

		await new Promise((resolve) => setTimeout(resolve, FADE_DURATION * 1000));

		if (this.playerState === "paused" && this.audioCtx.state === "running") {
			await this.audioCtx.suspend();
		}
	}

	public async seek(time: number) {
		if (!this.worker || !this.audioCtx || !this.metadata || !this.masterGain)
			return;

		const now = this.audioCtx.currentTime;

		this.masterGain.gain.cancelScheduledValues(now);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
		this.masterGain.gain.linearRampToValueAtTime(0, now + SEEK_FADE_DURATION);

		await new Promise((resolve) =>
			setTimeout(resolve, SEEK_FADE_DURATION * 1000),
		);

		this.activeSources.forEach((s) => {
			try {
				s.stop();
			} catch (e) {
				this.handleError((e as Error).message);
			}
		});
		this.activeSources = [];
		this.currentMessageId = Date.now();

		this.postToWorker({
			type: "SEEK",
			id: this.currentMessageId,
			seekTime: time,
		});
		this.isDecodingFinished = false;

		this.dispatch("timeUpdate", time);
	}

	public setVolume(val: number) {
		this.targetVolume = Math.max(0, Math.min(1, val));

		if (this.masterGain && this.playerState === "playing" && this.audioCtx) {
			const now = this.audioCtx.currentTime;
			this.masterGain.gain.cancelScheduledValues(now);
			this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
			this.masterGain.gain.linearRampToValueAtTime(
				this.targetVolume,
				now + 0.05,
			);
		}
	}

	public destroy() {
		this.reset();

		if (this.audioCtx) {
			this.audioCtx.close();
			this.audioCtx = null;
			this.masterGain = null;
		}
	}

	private reset() {
		this.stopTimeUpdate();
		clearInterval(this.flowControlInterval);

		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}

		this.activeSources.forEach((source) => {
			try {
				source.stop();
			} catch {
				// 忽略已停止的错误
			}
		});
		this.activeSources = [];

		this.metadata = null;
		this.nextStartTime = 0;
		this.timeOffset = 0;
		this.isWorkerPaused = false;
		this.isDecodingFinished = false;
		this.timeOffset = this.audioCtx ? this.audioCtx.currentTime : 0;
		this.nextStartTime = this.timeOffset;

		if (this.masterGain) {
			this.masterGain.gain.cancelScheduledValues(0);
			this.masterGain.gain.value = 0;
		}

		this.setState("idle");
	}

	private setState(newState: PlayerState) {
		if (this.playerState === newState) return;
		this.playerState = newState;
		this.dispatch("stateChange", newState);
	}

	private handleError(msg: string) {
		console.error("[FFmpegAudioPlayer]", msg);
		this.setState("error");
		this.dispatch("error", msg);
	}

	private setupWorkerListeners() {
		if (!this.worker) return;

		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const resp = event.data;
			if (resp.id !== this.currentMessageId) return;

			switch (resp.type) {
				case "ERROR":
					this.handleError(resp.error);
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
						this.timeOffset = now;
						this.nextStartTime = now;
					}
					this.dispatch("durationChange", resp.duration);
					this.setState("ready");
					this.play();
					break;
				case "CHUNK":
					if (this.metadata) {
						this.scheduleChunk(
							resp.data,
							this.metadata.sampleRate,
							this.metadata.channels,
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
						this.nextStartTime = now;
						this.timeOffset = now - resp.time;
						this.isWorkerPaused = false;

						if (this.playerState === "playing") {
							this.masterGain.gain.cancelScheduledValues(now);
							this.masterGain.gain.setValueAtTime(0, now);
							this.masterGain.gain.linearRampToValueAtTime(
								this.targetVolume,
								now + SEEK_FADE_DURATION,
							);
						}
					}
					break;
			}
		};
	}

	private scheduleChunk(
		planarData: Float32Array,
		sampleRate: number,
		channels: number,
	) {
		if (!this.audioCtx || !this.masterGain || !this.analyser) return;
		const ctx = this.audioCtx;
		const safeChannels = channels || 1;
		const frameCount = planarData.length / safeChannels;

		const audioBuffer = ctx.createBuffer(safeChannels, frameCount, sampleRate);

		for (let ch = 0; ch < safeChannels; ch++) {
			const chData = audioBuffer.getChannelData(ch);

			const start = ch * frameCount;
			const end = start + frameCount;

			chData.set(planarData.subarray(start, end));
		}

		const source = ctx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.analyser);

		const scheduleTime = Math.max(ctx.currentTime, this.nextStartTime);

		source.start(scheduleTime);
		this.nextStartTime = scheduleTime + audioBuffer.duration;

		this.activeSources.push(source);
		source.onended = () => {
			this.activeSources = this.activeSources.filter((s) => s !== source);
			this.checkIfEnded();
		};
	}

	private checkIfEnded() {
		if (this.state !== "playing") return;
		if (this.activeSources.length > 0) return;
		if (!this.isDecodingFinished) return;

		this.setState("idle");
		this.dispatch("ended");
	}

	private startFlowControl() {
		this.flowControlInterval = window.setInterval(() => {
			if (!this.worker || !this.audioCtx) return;

			const bufferedDuration = this.nextStartTime - this.audioCtx.currentTime;

			if (bufferedDuration > HIGH_WATER_MARK && !this.isWorkerPaused) {
				this.postToWorker({ type: "PAUSE", id: this.currentMessageId });
				this.isWorkerPaused = true;
			} else if (bufferedDuration < LOW_WATER_MARK && this.isWorkerPaused) {
				this.postToWorker({ type: "RESUME", id: this.currentMessageId });
				this.isWorkerPaused = false;
			}
		}, 1000);
	}

	private startTimeUpdate() {
		this.stopTimeUpdate();
		const tick = () => {
			if (this.state === "playing") {
				this.dispatch("timeUpdate", this.currentTime);
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
}
