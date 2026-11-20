#!/bin/sh
# System.Native・System.IO.Compression.Native など（src/native/libs）を BrowserOS（wasm32-browseros-linux-musl）向けに静的ライブラリで組む。
# 環境変数は build-mono.sh と同じ。ほかに OpenSSL の頭（@progate/browser-openssl の wasm/include）を OPENSSL_INCLUDE で渡す
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out=${1:?output directory}
mkdir -p "$out"
cflags="-pthread -D_GNU_SOURCE=1 -I${ICU_INCLUDE:?ICU headers} -I$root/src/native/external/zlib"
cmake -G Ninja -S "$root/src/native/libs" -B "$out" \
  -DCMAKE_TOOLCHAIN_FILE="$here/toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$out/install" \
  -DCLR_CMAKE_TARGET_ARCH=wasm \
  -DCLI_CMAKE_PKG_RID=linux-wasm \
  -DCLI_CMAKE_FALLBACK_OS=linux \
  -DCLR_CMAKE_KEEP_NATIVE_SYMBOLS=1 \
  -DSTATIC_LIBS_ONLY=1 \
  -DFEATURE_DISTRO_AGNOSTIC_SSL=1 \
  -DOPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE:?OpenSSL headers}" \
  -DOPENSSL_CRYPTO_LIBRARY="$OPENSSL_INCLUDE/../wasm32-linux-musl/libcrypto.so.3" \
  -DOPENSSL_SSL_LIBRARY="$OPENSSL_INCLUDE/../wasm32-linux-musl/libssl.so.3" \
  -DUCURR_H="$ICU_INCLUDE" -DICUUC=icuuc -DICUI18N=icui18n \
  -DHAVE_SHM_OPEN_THAT_WORKS_WELL_ENOUGH_WITH_MMAP_EXITCODE=0 \
  -DHAVE_CLOCK_MONOTONIC_EXITCODE=0 \
  -DHAVE_CLOCK_REALTIME_EXITCODE=0 \
  -DZLIB_INCLUDE_DIR="$root/src/native/external/zlib" \
  -DZLIB_LIBRARY="$BROWSER_SYSROOT/usr/lib/wasm32-linux-musl/libz.so" \
  -DCMAKE_C_FLAGS="$cflags" \
  -DCMAKE_CXX_FLAGS="$cflags"
cmake --build "$out"
cmake --install "$out"
