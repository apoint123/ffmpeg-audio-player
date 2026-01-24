# syntax=docker/dockerfile:1

FROM emscripten/emsdk:4.0.22 AS emsdk-base
ENV INSTALL_DIR=/opt
ENV FFMPEG_VERSION=n8.0.1
ENV CFLAGS="-I$INSTALL_DIR/include -O3"
ENV CXXFLAGS="$CFLAGS"
ENV LDFLAGS="-L$INSTALL_DIR/lib"
ENV PKG_CONFIG_PATH=$INSTALL_DIR/lib/pkgconfig

RUN apt-get update && \
    apt-get install -y pkg-config autoconf automake libtool make build-essential curl unzip cmake

ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN curl -fsSL https://bun.sh/install | bash

FROM emsdk-base AS soundtouch-builder
ENV SOUNDTOUCH_VERSION=2.4.0
WORKDIR /src

RUN curl -fsSL -o soundtouch.tar.gz https://codeberg.org/soundtouch/soundtouch/archive/${SOUNDTOUCH_VERSION}.tar.gz && \
    mkdir soundtouch && \
    tar -xzf soundtouch.tar.gz -C soundtouch --strip-components=1

WORKDIR /src/soundtouch

RUN mkdir build && cd build && \
    emcmake cmake .. \
    -DCMAKE_INSTALL_PREFIX=$INSTALL_DIR \
    -DCMAKE_BUILD_TYPE=Release \
    -DSOUNDTOUCH_INTEGER_SAMPLES=OFF \
    -DBUILD_SHARED_LIBS=OFF && \
    emmake make -j$(nproc) && \
    emmake make install

FROM emsdk-base AS ffmpeg-base
ADD https://github.com/FFmpeg/FFmpeg.git#$FFMPEG_VERSION /src

FROM ffmpeg-base AS ffmpeg-builder
COPY scripts/build-ffmpeg.ts /src/build-ffmpeg.ts
WORKDIR /src

RUN bun run /src/build-ffmpeg.ts

FROM emsdk-base AS wasm-builder

COPY --from=ffmpeg-builder /opt/lib /opt/lib
COPY --from=ffmpeg-builder /opt/include /opt/include
COPY --from=ffmpeg-builder /opt/lib/pkgconfig /opt/lib/pkgconfig

COPY --from=soundtouch-builder /opt/lib /opt/lib
COPY --from=soundtouch-builder /opt/include /opt/include
COPY --from=soundtouch-builder /opt/lib/pkgconfig /opt/lib/pkgconfig

WORKDIR /app
COPY cpp/audio-decode.cpp /app/audio-decode.cpp

# -g1 --closure 0 用来阻止混淆 JS 胶水代码
ENV EMCC_FLAGS="-O3 -flto -g1 --closure 0"
ENV EMCC_OPTS="-s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createAudioDecoderCore -s ENVIRONMENT=web,worker -s EXPORTED_RUNTIME_METHODS=[\"FS\",\"HEAPU8\"] -lworkerfs.js"
ENV INCLUDES="-I/opt/include -I/opt/include/soundtouch"
ENV LIBS="-L/opt/lib -lavformat -lavcodec -lavutil -lswresample -lSoundTouch"

RUN emcc /app/audio-decode.cpp \
    $INCLUDES $LIBS \
    $EMCC_FLAGS $EMCC_OPTS --bind \
    -o /app/decode-audio.js

FROM scratch AS exportor
COPY --from=wasm-builder /app/decode-audio.js /
COPY --from=wasm-builder /app/decode-audio.wasm /
