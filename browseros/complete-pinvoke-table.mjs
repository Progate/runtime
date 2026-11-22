// .NET 8 の ManagedToNativeGenerator（src/tasks/WasmAppBuilder/PInvokeTableGenerator.cs）が作った pinvoke-table.h を、
// ホストが静的にリンクするネイティブのライブラリと突き合わせて補う。
//
//   node browseros/complete-pinvoke-table.mjs <pinvoke-table.h> [--assemblies <dir> ...] [<モジュール>=<静的ライブラリ.a> ...]
//   例: node browseros/complete-pinvoke-table.mjs gen/pinvoke-table.h --assemblies framework --assemblies app \
//         libSystem.Native=libs/install/lib/libSystem.Native.a
//
// 生成器は、関数ポインターを引数に取る P/Invoke（SystemNative_SetTerminalInvalidationHandler・SystemNative_RegisterForSigChld・
// SystemNative_SetPosixSignalHandler など）を、引数の型を読めないとして Skip にし、表から落とす（GenPInvokeDecl の
// TryIsMethodGetParametersUnsupported）。落ちた名前を呼ぶと、Mono は表に無いので EntryPointNotFoundException を投げる。
// たとえば System.Console は標準出力が端末のときにだけ SetTerminalInvalidationHandler を呼ぶので、端末の無い所では動き、
// 端末に書いたとたんに落ちる。表から引くのはアドレスだけで、interp からの呼び方は引数の wasm の型（関数ポインターは i32）で
// 決まるので、静的ライブラリにある関数を名前で全部載せれば足りる。
//
// 足す名前は、そのモジュールの表に生成器が載せた名前の接頭辞（`SystemNative_` など）で始まり、静的ライブラリが定義し、
// 動かすアセンブリ（生成器に渡したのと同じ --assemblies のディレクトリの .dll）の名前の表に現れるもの。アセンブリが呼ばない関数まで
// 載せると、それを定義するオブジェクトがリンクに引き込まれ、世界に無い関数を参照して wasm-ld が止まることがある。
// 宣言は型の無い `void <名前> (void);` で足す（表はアドレスを取るだけなので、型は使われない）。
import {readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * アセンブリ（.dll）の中身をつないだもの。P/Invoke の入口の名前は、メタデータの名前の表に NUL 終わりの UTF-8 で入る
 *
 * @param {string[]} directories .dll を置いたディレクトリ
 * @returns {string} 中身（latin1 で読んだもの）
 */
export const assemblyText = (directories) =>
  directories
    .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.dll')).map((name) => join(dir, name)))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('\0')

/**
 * 静的ライブラリの索引から、定義されている大域の名前を読む。
 *
 * llvm-ar は、Linux では GNU 形式（索引のメンバーの名前が `/`）、macOS では BSD 形式（`__.SYMDEF`）で書くので、両方を読む
 *
 * @param {string} path 静的ライブラリのパス
 * @returns {string[]} 定義されている名前
 */
export const archiveSymbols = (path) => {
  const data = readFileSync(path)
  if (data.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error(`${path}: 静的ライブラリ（!<arch>）ではありません`)
  let offset = 8
  while (offset + 60 <= data.length) {
    let name = data.toString('latin1', offset, offset + 16).trimEnd()
    const size = Number.parseInt(data.toString('latin1', offset + 48, offset + 58).trim(), 10)
    let body = offset + 60
    let bodySize = size
    // BSD 形式の長い名前（`#1/<長さ>`）は、中身の先頭にその長さの名前が入る
    const long = /^#1\/(\d+)$/.exec(name)
    if (long) {
      const length = Number(long[1])
      name = data.toString('latin1', body, body + length).replace(/\0+$/, '')
      body += length
      bodySize -= length
    }
    if (name === '/') {
      const count = data.readUInt32BE(body)
      return data.toString('latin1', body + 4 + count * 4, body + bodySize).split('\0').slice(0, count)
    }
    if (name.startsWith('__.SYMDEF')) {
      const ranlibBytes = data.readUInt32LE(body)
      const strings = body + 4 + ranlibBytes + 4
      const names = []
      for (let entry = body + 4; entry < body + 4 + ranlibBytes; entry += 8) {
        const start = strings + data.readUInt32LE(entry)
        names.push(data.toString('latin1', start, data.indexOf(0, start)))
      }
      return names
    }
    offset = offset + 60 + size + (size % 2)
  }
  throw new Error(`${path}: 名前の索引がありません。ranlib で索引を付けてください`)
}

/**
 * 表を補う
 *
 * @param {string} text pinvoke-table.h の中身
 * @param {Record<string, string[]>} libraries モジュール（`libSystem.Native`）ごとの、静的ライブラリが定義する名前
 * @param {string | undefined} assemblies 動かすアセンブリの中身（→ assemblyText）。渡すと、その中に名前が現れるものだけを足す
 * @returns {{text: string, declared: string[], added: string[]}} 補った中身と、宣言を足した名前・表に足した名前
 */
export const completePinvokeTable = (text, libraries, assemblies) => {
  let out = text
  const added = []
  for (const [module, symbols] of Object.entries(libraries)) {
    const head = `static PinvokeImport ${module.replaceAll('.', '_')}_imports [] = {\n`
    const start = out.indexOf(head)
    if (start < 0) throw new Error(`${head.trim()} が pinvoke-table.h にありません`)
    const end = out.indexOf('{NULL, NULL}\n', start)
    const listed = new Set([...out.slice(start, end).matchAll(/\{"(\w+)", \w+\}/g)].map((match) => match[1]))
    const prefixes = [...new Set([...listed].filter((name) => name.includes('_')).map((name) => name.slice(0, name.indexOf('_') + 1)))]
    const missing = [...new Set(symbols)]
      .filter((name) => !listed.has(name) && prefixes.some((prefix) => name.startsWith(prefix)))
      .filter((name) => assemblies === undefined || assemblies.includes(`\0${name}\0`))
      .sort()
    if (missing.length === 0) continue
    const rows = missing.map((name) => `{"${name}", ${name}}, // ${module} (skipped by the generator)\n`).join('')
    out = out.slice(0, end) + rows + out.slice(end)
    added.push(...missing)
  }
  // 足した名前と、生成器が表に載せたのに宣言を書かなかった名前（EnumCalendarInfo など）に、型の無い宣言を足す
  const declaredNames = new Set([...out.matchAll(/^\S.*?\b(\w+) \(/gm)].map((match) => match[1]))
  const undeclared = [...new Set([...out.matchAll(/\{"(\w+)", (\w+)\}/g)].map((match) => match[2]))].filter(
    (name) => !declaredNames.has(name),
  )
  if (undeclared.length > 0) {
    const declarations = undeclared.map((name) => `void ${name} (void);`).join('\n')
    out = out.replace('// GENERATED FILE, DO NOT MODIFY\n', `// GENERATED FILE, DO NOT MODIFY\n${declarations}\n`)
  }
  return {text: out, declared: undeclared, added}
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [path, ...rest] = process.argv.slice(2)
  const directories = []
  const pairs = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--assemblies') directories.push(rest[++i])
    else pairs.push(rest[i])
  }
  const libraries = Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf('=')
      if (at < 0) throw new Error(`<モジュール>=<静的ライブラリ.a> の形で渡してください: ${pair}`)
      return [pair.slice(0, at), archiveSymbols(pair.slice(at + 1))]
    }),
  )
  const result = completePinvokeTable(
    readFileSync(path, 'utf8'),
    libraries,
    directories.length > 0 ? assemblyText(directories) : undefined,
  )
  writeFileSync(path, result.text)
  console.log(`added ${result.added.length} P/Invoke(s) the generator skipped: ${result.added.join(', ')}`)
  console.log(`declared ${result.declared.length} P/Invoke(s) without a prototype: ${result.declared.join(', ')}`)
}
