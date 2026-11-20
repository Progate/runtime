// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

/*
 * BrowserOS（wasm32-browseros-linux-musl）の Mono のホスト。`dotnet app.dll [args]` と同じく、管理コードの入口のアセンブリを
 * 渡されて実行する Linux のプログラムである。
 *
 *   host <app.dll> [args...]
 *
 * - 枠組みのアセンブリ（System.Private.CoreLib など）は DOTNET_FRAMEWORK_DIR（既定は BROWSEROS_FRAMEWORK_DIR）から、
 *   アプリのアセンブリは app.dll と同じディレクトリから読む
 * - 実行は interp だけ（wasm には JIT が無い）。ネイティブ ⇔ interp の呼び出しは、アプリを組むときに WasmAppBuilder の
 *   ManagedToNativeGenerator が作る表（pinvoke-table.h・wasm_m2n_invoke.g.h）で渡す。wasm の関数は型ごとに呼び方が決まって
 *   いて、任意の型の関数ポインターを interp から呼べないため
 * - P/Invoke の先は、表にあるもの（静的にリンクした libSystem.Native など）を先に、無ければ dlopen(3) で探す
 *
 * src/mono/wasi/runtime/driver.c をもとにしている
 */

#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mono/metadata/appdomain.h>
#include <mono/metadata/assembly.h>
#include <mono/metadata/class.h>
#include <mono/metadata/environment.h>
#include <mono/metadata/image.h>
#include <mono/metadata/loader.h>
#include <mono/metadata/mono-debug.h>
#include <mono/metadata/mono-private-unstable.h>
#include <mono/metadata/object.h>
#include <mono/metadata/threads.h>
#include <mono/utils/mono-dl-fallback.h>
#include <mono/utils/mono-logger.h>
#include <mono/jit/jit.h>
#include <mono/jit/mono-private-unstable.h>

#ifndef BROWSEROS_FRAMEWORK_DIR
#define BROWSEROS_FRAMEWORK_DIR "/usr/lib/dotnet/shared/Microsoft.NETCore.App/8.0.20"
#endif

#include "pinvoke.h"

typedef void *(*MonoWasmGetNativeToInterpTramp) (MonoMethod *method, void *extra_arg);
void mono_wasm_install_get_native_to_interp_tramp (MonoWasmGetNativeToInterpTramp cb);

void mono_ee_interp_init (const char *opts);
void mono_marshal_ilgen_init (void);
void mono_method_builder_ilgen_init (void);
void mono_sgen_mono_ilgen_init (void);
void mono_icall_table_init (void);
void mono_trace_init (void);
int32_t mini_parse_debug_option (const char *option);

#include "pinvoke-table.h"
#include "wasm_m2n_invoke.g.h"

/* sgen は wasm ではこれが 0 のあいだ GC を止める（ブラウザーのホストが切り替える）。BrowserOS ではいつも走らせる */
int mono_wasm_enable_gc = 1;

void
mono_wasm_pinvoke_vararg_stub (void)
{
	/* 可変長引数の P/Invoke の印 */
}

static void *
pinvoke_table_of (const char *name)
{
	for (size_t i = 0; i < sizeof (pinvoke_tables) / sizeof (void *); ++i) {
		if (!strcmp (name, pinvoke_names [i]))
			return pinvoke_tables [i];
	}
	return NULL;
}

static bool
is_pinvoke_table (void *handle)
{
	for (size_t i = 0; i < sizeof (pinvoke_tables) / sizeof (void *); ++i) {
		if (pinvoke_tables [i] == handle)
			return true;
	}
	return false;
}

static void *
host_dl_load (const char *name, int flags, char **err, void *user_data)
{
	void *table = pinvoke_table_of (name);
	if (table)
		return table;
	return dlopen (name, flags);
}

static void *
host_dl_symbol (void *handle, const char *name, char **err, void *user_data)
{
	if (!is_pinvoke_table (handle))
		return dlsym (handle, name);
	PinvokeImport *table = (PinvokeImport *)handle;
	for (int i = 0; table [i].name; ++i) {
		if (!strcmp (table [i].name, name))
			return table [i].func;
	}
	return NULL;
}

/*
 * ネイティブから interp へ入る口（UnmanagedCallersOnly・コールバック）。表は "<アセンブリ>_<クラス>_<メソッド>" で引く
 */
static void *
native_to_interp (MonoMethod *method, void *extra_arg)
{
	MonoClass *klass = mono_method_get_class (method);
	MonoImage *image = mono_class_get_image (klass);
	MonoAssemblyName *aname = mono_assembly_get_name (mono_image_get_assembly (image));
	char key [256];
	snprintf (key, sizeof (key), "%s_%s_%s", mono_assembly_name_get_name (aname), mono_class_get_name (klass), mono_method_get_name (method));
	for (char *p = key; *p; ++p) {
		if (*p == '.')
			*p = '_';
	}
	for (size_t i = 0; i < sizeof (wasm_native_to_interp_map) / sizeof (void *); ++i) {
		if (!strcmp (wasm_native_to_interp_map [i], key)) {
			wasm_native_to_interp_ftndescs [i] = *(InterpFtnDesc *)extra_arg;
			return wasm_native_to_interp_funcs [i];
		}
	}
	return NULL;
}

static char *
directory_of (const char *path)
{
	char *copy = strdup (path);
	char *slash = strrchr (copy, '/');
	if (!slash)
		return strdup (".");
	if (slash == copy)
		slash [1] = 0;
	else
		*slash = 0;
	return copy;
}

int
main (int argc, char *argv [])
{
	if (argc < 2) {
		fprintf (stderr, "usage: %s <app.dll> [args...]\n", argv [0]);
		return 2;
	}
	char app_path [PATH_MAX];
	if (!realpath (argv [1], app_path)) {
		fprintf (stderr, "%s: cannot open %s: %s\n", argv [0], argv [1], strerror (errno));
		return 2;
	}
	char *app_dir = directory_of (app_path);
	const char *framework_dir = getenv ("DOTNET_FRAMEWORK_DIR");
	if (!framework_dir || !*framework_dir)
		framework_dir = BROWSEROS_FRAMEWORK_DIR;

	/* アプリのディレクトリを先に、枠組みを後に探す（dotnet の probing と同じ順） */
	size_t paths_len = strlen (app_dir) + strlen (framework_dir) + 2;
	char *paths = malloc (paths_len);
	snprintf (paths, paths_len, "%s:%s", app_dir, framework_dir);
	mono_set_assemblies_path (paths);

	const char *invariant = getenv ("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT");
	const char *keys [] = {"APP_CONTEXT_BASE_DIRECTORY", "RUNTIME_IDENTIFIER", "System.Globalization.Invariant"};
	char base_dir [PATH_MAX];
	snprintf (base_dir, sizeof (base_dir), "%s/", app_dir);
	const char *values [] = {base_dir, "linux-wasm", (invariant && (!strcmp (invariant, "1") || !strcmp (invariant, "true"))) ? "true" : "false"};
	monovm_initialize (3, keys, values);

	mini_parse_debug_option ("top-runtime-invoke-unhandled");
	mono_dl_fallback_register (host_dl_load, host_dl_symbol, NULL, NULL);
	mono_wasm_install_get_native_to_interp_tramp (native_to_interp);
	mono_wasm_install_interp_to_native_callback (mono_wasm_interp_to_native_callback);
	mono_jit_set_aot_mode (MONO_AOT_MODE_INTERP_ONLY);
	mono_icall_table_init ();
	mono_ee_interp_init ("");
	mono_marshal_ilgen_init ();
	mono_method_builder_ilgen_init ();
	mono_sgen_mono_ilgen_init ();
	mono_trace_init ();

	MonoDomain *domain = mono_jit_init_version ("mono", NULL);
	mono_thread_set_main (mono_thread_current ());

	MonoAssembly *assembly = mono_assembly_open (app_path, NULL);
	if (!assembly) {
		fprintf (stderr, "%s: cannot load %s\n", argv [0], app_path);
		return 1;
	}
	MonoImage *image = mono_assembly_get_image (assembly);
	uint32_t entry = mono_image_get_entry_point (image);
	if (!entry) {
		fprintf (stderr, "%s: %s has no entry point\n", argv [0], app_path);
		return 1;
	}
	mono_domain_ensure_entry_assembly (domain, assembly);
	MonoMethod *method = mono_get_method (image, entry, NULL);
	/* 管理コードの args は app.dll の後ろ（argv [0] は app.dll にする） */
	argv [1] = app_path;
	int code = mono_jit_exec (domain, assembly, argc - 1, &argv [1]);
	(void)method;
	return mono_environment_exitcode_get () ? mono_environment_exitcode_get () : code;
}
