/**
 * @fileoverview 一个测试用途的网页播放器
 * @author GEMINI
 */

import type React from "react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { FFmpegAudioPlayer } from "@/FFmpegAudioPlayer";
import type { PlayerState } from "@/types";
import AudioWorker from "@/workers/audio.worker?worker";

const formatTime = (seconds: number) => {
	if (!Number.isFinite(seconds)) return "00:00";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

export const AudioPlayerDemo: React.FC = () => {
	const playerRef = useRef<FFmpegAudioPlayer | null>(null);
	const isDraggingRef = useRef(false);
	const isSeekingRef = useRef(false);

	const [playerState, setPlayerState] = useState<PlayerState>("idle");
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const [metadata, setMetadata] = useState<Record<string, string>>({});
	const [formatInfo, setFormatInfo] = useState<{
		rate: number;
		ch: number;
		enc: string;
		bit: number;
	} | null>(null);
	const [coverUrl, setCoverUrl] = useState<string | null>(null);
	const [volume, setVolume] = useState(1.0);

	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const animationRef = useRef<number>(0);

	useEffect(() => {
		return () => {
			if (coverUrl) {
				URL.revokeObjectURL(coverUrl);
				console.log("已释放封面内存:", coverUrl);
			}
		};
	}, [coverUrl]);

	useEffect(() => {
		const player = new FFmpegAudioPlayer(() => new AudioWorker());
		playerRef.current = player;

		const handleLoadStart = () => {
			setPlayerState("loading");
			setErrorMsg(null);
		};

		const handleLoadedMetadata = () => {
			const info = player.audioInfo;
			if (info) {
				setMetadata(info.metadata || {});
				setCoverUrl(info.coverUrl || null);
				setFormatInfo({
					rate: info.sampleRate,
					ch: info.channels,
					enc: info.encoding,
					bit: info.bitsPerSample,
				});
				setDuration(info.duration);
			}
		};

		const handleCanPlay = () => {
			setPlayerState((prev) => (prev === "playing" ? "playing" : "ready"));
		};

		const handlePlay = () => {
			setPlayerState("playing");
		};

		const handlePause = () => {
			setPlayerState("paused");
		};

		const handleSeeking = () => {
			isSeekingRef.current = true;
		};

		const handleSeeked = () => {
			isSeekingRef.current = false;
		};

		const handleTimeUpdate = (e: CustomEvent<number>) => {
			if (!isDraggingRef.current && !isSeekingRef.current) {
				setCurrentTime(e.detail);
			}
		};

		const handleDurationChange = (e: CustomEvent<number>) => {
			setDuration(e.detail);
		};

		const handleError = (e: CustomEvent<string>) => {
			setErrorMsg(e.detail);
			setPlayerState("error");
		};

		const handleEnded = () => {
			setPlayerState("idle");
			if (!isDraggingRef.current) setCurrentTime(0);
		};

		player.addEventListener("loadstart", handleLoadStart);
		player.addEventListener("loadedmetadata", handleLoadedMetadata);
		player.addEventListener("canplay", handleCanPlay);
		player.addEventListener("play", handlePlay);
		player.addEventListener("playing", handlePlay);
		player.addEventListener("pause", handlePause);
		player.addEventListener("seeking", handleSeeking);
		player.addEventListener("seeked", handleSeeked);
		player.addEventListener("timeupdate", handleTimeUpdate);
		player.addEventListener("durationchange", handleDurationChange);
		player.addEventListener("error", handleError);
		player.addEventListener("ended", handleEnded);

		return () => {
			player.removeEventListener("loadstart", handleLoadStart);
			player.removeEventListener("loadedmetadata", handleLoadedMetadata);
			player.removeEventListener("canplay", handleCanPlay);
			player.removeEventListener("play", handlePlay);
			player.removeEventListener("playing", handlePlay);
			player.removeEventListener("pause", handlePause);
			player.removeEventListener("seeking", handleSeeking);
			player.removeEventListener("seeked", handleSeeked);
			player.removeEventListener("timeupdate", handleTimeUpdate);
			player.removeEventListener("durationchange", handleDurationChange);
			player.removeEventListener("error", handleError);
			player.removeEventListener("ended", handleEnded);

			player.destroy();
		};
	}, []);

	useEffect(() => {
		const renderFrame = () => {
			if (playerRef.current?.analyser && canvasRef.current) {
				const analyser = playerRef.current.analyser;
				const canvas = canvasRef.current;
				const ctx = canvas.getContext("2d");

				if (ctx) {
					const bufferLength = analyser.frequencyBinCount;
					const dataArray = new Uint8Array(bufferLength);

					analyser.getByteFrequencyData(dataArray);

					ctx.clearRect(0, 0, canvas.width, canvas.height);

					const barWidth = (canvas.width / bufferLength) * 2.5;
					let barHeight = 0;
					let x = 0;

					for (let i = 0; i < bufferLength; i++) {
						barHeight = (dataArray[i] ?? 0) / 2;

						ctx.fillStyle = `rgb(${barHeight + 100}, 50, 50)`;
						ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

						x += barWidth + 1;
					}
				}
			}
			animationRef.current = requestAnimationFrame(renderFrame);
		};

		renderFrame();

		return () => {
			cancelAnimationFrame(animationRef.current);
		};
	}, []);

	const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file && playerRef.current) {
			setErrorMsg(null);
			setCurrentTime(0);
			setDuration(0);
			setMetadata({});
			setCoverUrl(null);
			setFormatInfo(null);
			playerRef.current.load(file);
		}
	};

	const togglePlay = () => {
		if (!playerRef.current) return;
		if (playerState === "playing") {
			playerRef.current.pause();
		} else {
			// ready, paused, idle, etc.
			playerRef.current.play();
		}
	};

	const handleSliderChange = (e: ChangeEvent<HTMLInputElement>) => {
		const time = Number(e.target.value);
		isDraggingRef.current = true;
		setCurrentTime(time);
	};

	const handleSliderCommit = () => {
		if (playerRef.current) {
			console.log(`[Demo] Commit seek to ${currentTime}`);
			playerRef.current.seek(currentTime);
		}
		isDraggingRef.current = false;
	};

	const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
		const newVolume = Number(e.target.value);
		setVolume(newVolume);
		if (playerRef.current) {
			playerRef.current.setVolume(newVolume);
		}
	};

	const isReady = ["ready", "playing", "paused"].includes(playerState);
	const isLoading = playerState === "loading";

	return (
		<div
			style={{
				padding: "20px",
				maxWidth: "600px",
				margin: "0 auto",
				fontFamily: "sans-serif",
			}}
		>
			<h2>FFmpeg Audio Decoder Demo</h2>

			<div style={{ marginBottom: "20px" }}>
				<input
					type="file"
					accept="audio/*"
					onChange={handleFileChange}
					disabled={isLoading}
				/>
			</div>

			<div style={{ marginBottom: "10px" }}>
				Status:{" "}
				<span
					style={{
						fontWeight: "bold",
						color: playerState === "error" ? "red" : "green",
					}}
				>
					{playerState.toUpperCase()}
				</span>
			</div>

			{errorMsg && (
				<div
					style={{
						color: "red",
						marginBottom: "10px",
						padding: "10px",
						background: "#ffe6e6",
						borderRadius: "4px",
					}}
				>
					Error: {errorMsg}
				</div>
			)}

			<div
				style={{
					opacity: isReady ? 1 : 0.5,
					pointerEvents: isReady ? "auto" : "none",
					border: "1px solid #ddd",
					padding: "20px",
					borderRadius: "8px",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						marginBottom: "15px",
					}}
				>
					<button
						type="button"
						onClick={togglePlay}
						style={{
							padding: "10px 20px",
							fontSize: "16px",
							cursor: "pointer",
							marginRight: "15px",
						}}
					>
						{playerState === "playing" ? "Pause" : "Play"}
					</button>

					<span style={{ fontSize: "14px", fontFamily: "monospace" }}>
						{formatTime(currentTime)} / {formatTime(duration)}
					</span>
				</div>

				<div style={{ display: "flex", alignItems: "center" }}>
					<input
						type="range"
						min={0}
						max={duration || 100}
						step={0.1}
						value={currentTime}
						onChange={handleSliderChange}
						onMouseUp={handleSliderCommit}
						onTouchEnd={handleSliderCommit}
						style={{ width: "100%", cursor: "pointer" }}
					/>
				</div>
			</div>
			<div style={{ marginTop: 10, fontSize: 12, color: "#888" }}>
				Time: {currentTime.toFixed(2)}
			</div>

			<div
				style={{
					marginTop: "15px",
					display: "flex",
					alignItems: "center",
					gap: "10px",
					padding: "10px",
					background: "#f0f0f0",
					borderRadius: "8px",
				}}
			>
				<span style={{ fontSize: "14px", fontWeight: "bold" }}>Volume:</span>
				<input
					type="range"
					min={0}
					max={1}
					step={0.01}
					value={volume}
					onChange={handleVolumeChange}
					style={{ cursor: "pointer", flex: 1 }}
				/>
				<span style={{ fontSize: "12px", width: "35px" }}>
					{Math.round(volume * 100)}%
				</span>
			</div>

			<div
				style={{
					marginTop: "20px",
					background: "#222",
					borderRadius: "8px",
					overflow: "hidden",
				}}
			>
				<canvas
					ref={canvasRef}
					width={600}
					height={100}
					style={{ width: "100%", height: "100px", display: "block" }}
				/>
			</div>

			<div
				style={{
					display: "flex",
					gap: "20px",
					marginTop: "20px",
					padding: "15px",
					background: "#f9f9f9",
					borderRadius: "8px",
				}}
			>
				<div
					style={{
						width: "120px",
						height: "120px",
						background: "#eee",
						borderRadius: "4px",
						overflow: "hidden",
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					{coverUrl ? (
						<img
							src={coverUrl}
							alt="Cover"
							style={{ width: "100%", height: "100%", objectFit: "cover" }}
						/>
					) : (
						<span style={{ color: "#ccc", fontSize: "12px" }}>No Cover</span>
					)}
				</div>

				<div style={{ flex: 1 }}>
					<h3 style={{ marginTop: 0, fontSize: "16px" }}>Track Info</h3>

					{formatInfo && (
						<div
							style={{
								marginBottom: "10px",
								fontSize: "12px",
								color: "#666",
								display: "flex",
								gap: "10px",
							}}
						>
							<span
								style={{
									background: "#e0e0e0",
									padding: "2px 6px",
									borderRadius: "4px",
								}}
							>
								{formatInfo.enc}
							</span>
							<span>{formatInfo.rate} Hz</span>
							<span>{formatInfo.ch} Channels</span>
							<span
								style={{
									border: "1px solid #ddd",
									padding: "0 4px",
									borderRadius: "4px",
								}}
							>
								{formatInfo.bit > 0 ? `${formatInfo.bit}-bit` : "N/A"}
							</span>
						</div>
					)}

					<ul
						style={{
							listStyle: "none",
							padding: 0,
							margin: 0,
							fontSize: "14px",
						}}
					>
						{Object.entries(metadata).map(([key, value]) => (
							<li key={key} style={{ marginBottom: "4px" }}>
								<strong style={{ color: "#555" }}>{key}: </strong> {value}
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
};

export default AudioPlayerDemo;
