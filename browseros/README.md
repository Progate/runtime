# .NET（Mono）を BrowserOS のプログラムにする

BrowserOS（`wasm32-browseros-linux-musl`。Linux の syscall と musl の wasm32）の上で、Mono のランタイムを Linux の
プログラムとして動かすための変更。上流 dotnet/runtime の v8.0.20 の上に積んでいる。

Mono は wasm を「ブラウザー（emscripten）」か「WASI」のどちらかとして扱い、`HOST_WASM` を OS の意味（スレッドが無い・
シグナルが無い・mmap が無い）でも使っている。BrowserOS では OS は Linux なので、`HOST_LINUX` と `HOST_WASM` を両方立て、
OS の意味の分岐をブラウザー・WASI だけに絞った。wasm の命令の決まり（JIT が無く interp で動く・ネイティブ ⇔ interp の
呼び出しは型ごとの表で渡す）は `HOST_WASM` のまま使う。

## 組み方

dotnet の msbuild を通さず、Mono と `src/native/libs` の CMake を直に回す。

| スクリプト | 中身 |
| --- | --- |
| `toolchain.cmake` | CMake の道具（`CMAKE_SYSTEM_NAME=Linux`・`CMAKE_SYSTEM_PROCESSOR=wasm32`） |
| `build-mono.sh` | `libmonosgen-2.0.a`・`libmono-ee-interp.a`・コンポーネントなど（LTO） |
| `build-native-libs.sh` | `libSystem.Native.a`・`libSystem.IO.Compression.Native.a`・`libSystem.Globalization.Native.a`・`libSystem.Security.Cryptography.Native.OpenSsl.a` |
| `complete-pinvoke-table.mjs` | .NET 8 の ManagedToNativeGenerator が宣言を書き落とす P/Invoke に宣言を足す |
| `link-host.sh` | ホスト（`src/mono/browseros/host.c`）を組んでリンクする |

道具は @progate/browser-editor の `scripts/browseros-toolchain.mjs`（browser-cc と世界の sysroot）、使い方は
@progate/browser-csharp の `scripts/build-wasm.mjs` にある。

## 変えたところ

- `eng/native/configureplatform.cmake`・`configurecompiler.cmake`: Linux の `wasm32` を受け付ける（musl）
- `src/mono/CMakeLists.txt`: wasm では perf の jitdump を組まない（JIT が無い）。スレッドの値は `__thread` で持つ
  （`MONO_KEYWORD_THREAD`。`pthread_getspecific` だと sgen の割り当てや interp の文脈を読むたびに libc.so への呼び出しになる）
- スレッド: `mono-threads.h` の後ろ側の選び方。BrowserOS は POSIX の後ろ側（pthread・`pthread_getattr_np`）
- finalizer・sgen の背景の仕事: ブラウザーだけが主スレッドの仕事の列で回す。BrowserOS は本物の finalizer スレッド
- `mono-dl`・`mono-mmap`: BrowserOS は `dlopen(3)`・`mmap(2)`
- `mono-signal-handler.h`: BrowserOS は `sigaction(2)` の `siginfo_t`
- `mini-wasm.c`: `mono_arch_ip_from_context` は wasm の位置を知らないので NULL を返す（シグナルのハンドラーが呼ぶ）
- emscripten 専用のもの（`mini-wasm-debugger.c`・eventpipe の wasm の口・diagnostics server）はブラウザーだけで組む
- `src/native/libs/CMakeLists.txt`: GSSAPI が無いので `System.Net.Security.Native` は組まない。暗号は Linux の配布物と
  同じく `libssl.so.3` を dlopen する形（`FEATURE_DISTRO_AGNOSTIC_SSL`）
- `src/mono/browseros/host.c`: `dotnet app.dll [args]` と同じ形のホスト
