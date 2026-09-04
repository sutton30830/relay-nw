import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
const realRequire = createRequire(import.meta.url);
export async function loadContactModule(path, mocks = {}) {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`, { filename: path }).runInThisContext()((name) => {
    if (name in mocks) return mocks[name];
    if (name === "server-only") return {};
    if (name === "libphonenumber-js/max") return realRequire(name);
    throw new Error(`Missing mock ${name} for ${path}`);
  }, module, module.exports);
  return module.exports;
}
export const phoneFixtures = [
  ["+12065550101", "+12065550101"], [" (206) 555-0101 ", "+12065550101"],
  ["1.206.555.0101", "+12065550101"], ["+44 20 7946 0018", "+442079460018"],
  ["\t206 555 0101\r\n", "+12065550101"], ["+1 (206) 555-0101", "+12065550101"],
  ["2065550101 ext 9", null], ["Mom 2065550101", null], ["anonymous", null],
  ["5550101", null], ["02079460018", null], ["+1206555010123456", null],
  ["++12065550101", null], ["20+65550101", null], ["+0123456789", null],
  ["1065550101", null], ["2061550101", null], ["", null], [null, null], ["\u00a02065550101\u00a0", null],
];
export async function loadContactService(supabaseAdmin, placeholder = false) {
  const pure = await loadContactModule("lib/contacts.ts");
  const service = await loadContactModule("lib/supabase/contacts.ts", {
    "@/lib/contacts": pure,
    "./client": { supabaseAdmin, isPlaceholderSupabaseConfig: () => placeholder },
    "./tenant": { assertAccountId: (id) => { if (!id) throw new Error("Account required"); return id; } },
  });
  return { pure, service };
}
