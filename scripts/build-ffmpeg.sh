#!/bin/bash
set -euo pipefail

DEMUXERS=(
    "aac" "ac3" "aiff" "ape" "asf" "flac" "matroska"
    "mov" "mp3" "ogg" "wav" "wv" "amr" "au" "dts" "dtshd"
    "m4v" "mpc" "mpc8" "rm" "tak" "tta" "truehd"
    "dsf" "dff"
)

DECODERS=(
    "aac" "aac_latm" "ac3" "alac" "als" "ape" "flac" "mp3" "opus"
    "pcm_alaw" "pcm_f32be" "pcm_f32le" "pcm_f64be" "pcm_f64le"
    "pcm_mulaw" "pcm_s16be" "pcm_s16le" "pcm_s24be" "pcm_s24le"
    "pcm_s32be" "pcm_s32le" "pcm_s8" "pcm_u16be" "pcm_u16le"
    "pcm_u24be" "pcm_u24le" "pcm_u32be" "pcm_u32le" "pcm_u8"
    "vorbis" "wavpack" "wmalossless" "wmapro" "wmav1" "wmav2" "wmavoice"
    "amrnb" "amrwb" "cook" "dca" "eac3" "mlp" "mpc7" "mpc8"
    "ra_144" "ra_288" "shorten" "tak" "tta" "truehd"
    "dsd_lsbf" "dsd_msbf" "dsd_lsbf_planar" "dsd_msbf_planar"
)

EXTRA_FLAGS=""
for demuxer in "${DEMUXERS[@]}"; do
    EXTRA_FLAGS+=" --enable-demuxer=$demuxer"
done
for decoder in "${DECODERS[@]}"; do
    EXTRA_FLAGS+=" --enable-decoder=$decoder"
done

CONF_FLAGS=(
  --prefix=$INSTALL_DIR
  --target-os=none
  --arch=x86_32
  --enable-cross-compile
  --disable-asm
  --disable-debug
  --disable-doc
  --disable-programs

  --disable-everything
  --disable-network
  --disable-hwaccels
  --disable-encoders
  --disable-muxers
  --disable-avdevice
  --disable-postproc
  --disable-avfilter
  --disable-swscale

  --enable-avcodec
  --enable-avformat
  --enable-avutil
  --enable-swresample
  --enable-parsers
  --enable-protocol=file

  --nm=emnm
  --ar=emar
  --ranlib=emranlib
  --cc=emcc
  --cxx=em++
  --objcc=emcc
  --dep-cc=emcc

  --extra-cflags="$CFLAGS"
  --extra-cxxflags="$CXXFLAGS"

  --disable-pthreads
  --disable-w32threads
  --disable-os2threads
)

echo "Running emconfigure ./configure..."
emconfigure ./configure "${CONF_FLAGS[@]}" $EXTRA_FLAGS $@

echo "Compiling..."
emmake make -j$(nproc)

echo "Installing..."
emmake make install
