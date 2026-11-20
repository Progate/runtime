#!/bin/sh
# BrowserOS の Mono のホスト（src/mono/browseros/host.c）を組んでリンクする。
#
#   sh browseros/link-host.sh <Mono を組んだ所> <native/libs を組んだ所> <生成した表のディレクトリ> <出力の wasm>
#
# 生成した表（pinvoke-table.h・wasm_m2n_invoke.g.h）は WasmAppBuilder の ManagedToNativeGenerator で、動かすアセンブリから作る
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
mono=${1:?mono build}
libs=${2:?native libs build}
gen=${3:?generated tables}
out=${4:?output}
lib=$mono/install/lib
"$BROWSEROS_CC" -O2 -pthread -D_GNU_SOURCE=1 \
  -I"$mono/install/include/mono-2.0" -I"$root/src/mono/browseros" -I"$gen" \
  -Wno-incompatible-library-redeclaration -Wno-deprecated-non-prototype \
  -c "$root/src/mono/browseros/host.c" -o "$gen/host.o"
"$BROWSEROS_CC" -pthread -o "$out" "$gen/host.o" \
  "$lib/libmono-ee-interp.a" \
  "$lib/libmono-icall-table.a" \
  "$lib/libmono-component-hot_reload-stub-static.a" \
  "$lib/libmono-component-debugger-stub-static.a" \
  "$lib/libmono-component-diagnostics_tracing-stub-static.a" \
  "$lib/libmono-component-marshal-ilgen-static.a" \
  "$lib/libmonosgen-2.0.a" \
  "$lib/libmono-wasm-nosimd.a" \
  "$libs/install/lib/libSystem.Native.a" \
  "$libs/install/lib/libSystem.IO.Compression.Native.a" \
  "$libs/install/lib/libSystem.Globalization.Native.a" \
  "$libs/install/lib/libSystem.Security.Cryptography.Native.OpenSsl.a" \
  -lz -lm -ldl
