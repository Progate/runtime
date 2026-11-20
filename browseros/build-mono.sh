#!/bin/sh
# Mono のランタイム（libmonosgen-2.0・interp・コンポーネント）を BrowserOS（wasm32-browseros-linux-musl）向けに組む。
#
#   BROWSEROS_CC=<browser-cc の包み> BROWSEROS_CXX=<c++ の包み> BROWSEROS_AR=<llvm-ar> BROWSEROS_RANLIB=<llvm-ranlib> \
#   BROWSER_SYSROOT=<世界の sysroot> ICU_INCLUDE=<ICU の頭> sh browseros/build-mono.sh <出力のディレクトリ>
#
# Linux のプログラムとして組む（HOST_LINUX・HOST_WASM）。JIT は無く interp だけ、スレッドは有り（世界の libc.so の pthread）
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out=${1:?output directory}
mkdir -p "$out"
# ICU は世界に置かない。Linux と同じく System.Globalization.Native は実行時に libicu を dlopen する（無ければ InvariantGlobalization が要る）。
# 組むのに要るのは ICU の頭だけで、ICU_INCLUDE で渡す
cflags="-pthread -D_GNU_SOURCE=1 -fexceptions -I$root/src/native/public -I$root/src/mono/mono/eglib -I$root/src/native/external/zlib -I${ICU_INCLUDE:?ICU headers}"
cmake -G Ninja -S "$root/src/mono" -B "$out" \
  -DCMAKE_TOOLCHAIN_FILE="$here/toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$out/install" \
  -DCLR_CMAKE_HOST_ARCH=wasm \
  -DCLR_CMAKE_TARGET_ARCH=wasm \
  -DENABLE_MINIMAL=jit,sgen_major_marksweep_conc,sgen_split_nursery,sgen_gc_bridge,sgen_toggleref,sgen_debug_helpers,sgen_binary_protocol,logging,qcalls,debugger_agent,log_dest \
  -DENABLE_INTERP_LIB=1 \
  -DDISABLE_ICALL_TABLES=1 \
  -DENABLE_ICALL_EXPORT=1 \
  -DENABLE_WEBCIL=1 \
  -DSTATIC_COMPONENTS=1 \
  -DDISABLE_SHARED_LIBS=1 \
  -DDISABLE_EXECUTABLES=1 \
  -DMONO_COMPONENTS_RID=linux-wasm \
  -DFEATURE_PERFTRACING_DISABLE_PERFTRACING_LISTEN_PORTS=1 \
  -DFEATURE_PERFTRACING_DISABLE_DEFAULT_LISTEN_PORT=1 \
  -DFEATURE_PERFTRACING_DISABLE_CONNECT_PORTS=1 \
  -DZLIB_INCLUDE_DIR="$root/src/native/external/zlib" \
  -DZLIB_LIBRARY="$BROWSER_SYSROOT/usr/lib/wasm32-linux-musl/libz.so" \
  -DCMAKE_C_FLAGS="$cflags" \
  -DCMAKE_CXX_FLAGS="$cflags"
cmake --build "$out"
cmake --install "$out"
