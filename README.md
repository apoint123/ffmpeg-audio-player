# FFmpeg Audio Player

A browser-based audio player powered by FFmpeg and WebAssembly. Supports a vast array of audio formats by decoding them off the main thread.

## 🛠️ Prerequisites

* **Docker**: Required to compile the C++ FFmpeg code to WASM.
* **Bun**: Required as the package manager and runtime for build scripts.

## 🚀 Build & Run

### 1. Install Dependencies

First, install the project dependencies (including the build script tools).

```bash
bun install

```

### 2. Compile WASM

We use TypeScript scripts running on Bun to handle the Docker build process. This command will:

1. Build the Docker image with Emscripten and FFmpeg.
2. Compile the C++ code to WASM.
3. Place the artifacts (`ffmpeg.js` and `ffmpeg.wasm`) into the correct directories.

```bash
# Cross-platform build command (Windows/Linux/macOS)
bun run build:wasm

```

### 3. Run Development Server (Demo)

Start the React demo to test the player.

```bash
bun dev

```

## 💻 C++ Development (Optional)

If you are modifying the C++ code (`cpp/audio-decode.cpp`), you can synchronize the system and FFmpeg headers from the Docker container to your local machine. This enables **IntelliSense** and code completion in editors like VS Code.

```bash
# Extracts headers from Docker to cpp/deps_headers/
bun run sync:headers

```

> **Note:** Ensure your `.vscode/c_cpp_properties.json` or `compile_commands.json` points to the `cpp/deps_headers` directory.

You can find a react demo in [Demo.tsx](./src/Demo.tsx).

## LICENSE

[GPL v3](./LICENSE)