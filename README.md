# FFmpeg Audio Player

A browser-based audio player powered by FFmpeg. Supports a vast array of audio formats.

## 🛠️ Prerequisites

* **Docker**: Required to compile the C++ FFmpeg code to WASM.
* **Node.js** and **Bun**: For the React frontend demo.

## 🚀 Build & Run

### 1. Compile WASM

```bash
chmod +x scripts/build.sh

# Run the build script
# This compiles the C++ code and places:
# - decode-audio.js -> src/assets/
# - decode-audio.wasm -> public/
./scripts/build.sh

# or bat if you are on Windows:
./scripts/build.bat

```

### 2. Install Dependencies

```bash
bun install
```

### 3. Run Development Server (Demo)

```bash
bun dev
```

## 🖥️ Usage

### 1. Basic Initialization

To start using the player, you need to instantiate the `FFmpegAudioPlayer` class. You must provide a **worker factory function** that returns a new Web Worker instance. This is required to handle the FFmpeg decoding off the main thread.

```typescript
import { FFmpegAudioPlayer } from "./FFmpegAudioPlayer";
// Assuming you are using Vite/Webpack to import the worker
import AudioWorker from "./workers/audio.worker?worker";

// Initialize the player
const player = new FFmpegAudioPlayer(() => new AudioWorker());

```

### 2. Loading and Controlling Audio

```typescript
// Load a file
const onFileSelected = (file: File) => {
  player.load(file);
};

// Basic controls
player.play();           // Start playback
player.pause();          // Pause playback
player.seek(30);         // Seek to 30 seconds
player.setVolume(0.5);   // Set volume (0.0 to 1.0)

```

### 3. Event Handling

```typescript
// Listen for state changes (idle, loading, ready, playing, paused, error)
player.addEventListener("stateChange", (e) => {
  console.log("Player State:", e.detail);
});

// Listen for playback time updates
player.addEventListener("timeUpdate", (e) => {
  const currentTime = e.detail; // in seconds
  console.log("Current Time:", currentTime);
});

// Listen for duration availability
player.addEventListener("durationChange", (e) => {
  console.log("Total Duration:", e.detail);
});

// Listen for errors
player.addEventListener("error", (e) => {
  console.error("Player Error:", e.detail);
});

// Listen for track end
player.addEventListener("ended", () => {
  console.log("Playback finished");
});

```

### 4. Audio Visualization

```typescript
const analyser = player.analyser;
if (analyser) {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);
  // Use dataArray to draw on a Canvas...
}

```

You can find a react demo in [Demo.tsx](./src/Demo.tsx).
