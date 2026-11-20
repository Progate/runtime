// .NET 8 の ManagedToNativeGenerator は、関数ポインターを引数に持つ P/Invoke（SystemNative_RegisterForSigChld など）の
// 宣言を書かずに、表には名前を載せる。表から引くのはアドレスだけなので、宣言の無い名前に型の無い宣言を足す。
//
//   node browseros/complete-pinvoke-table.mjs <pinvoke-table.h>
import {readFileSync, writeFileSync} from 'node:fs'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')
const declared = new Set([...text.matchAll(/^\S.*?\b(\w+) \(/gm)].map((match) => match[1]))
const missing = [...new Set([...text.matchAll(/\{"(\w+)", (\w+)\}/g)].map((match) => match[2]))].filter((name) => !declared.has(name))
if (missing.length > 0) {
  const declarations = missing.map((name) => `void ${name} (void);`).join('\n')
  writeFileSync(path, text.replace('// GENERATED FILE, DO NOT MODIFY\n', `// GENERATED FILE, DO NOT MODIFY\n${declarations}\n`))
}
console.log(`declared ${missing.length} P/Invoke(s) the generator left without a prototype: ${missing.join(', ')}`)
