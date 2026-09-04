import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// The real, dependency-free owner-alert sender resolver, for tests that load
// lib/missed-call.ts or lib/twilio.ts with an explicit mock map.
export async function loadOwnerAlerts() {
  const source = await readFile(new URL("../../lib/owner-alerts.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: "lib/owner-alerts.ts" })
    .runInThisContext()(() => ({}), module, module.exports);
  return module.exports;
}
