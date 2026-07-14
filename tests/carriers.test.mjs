import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    throw new Error(`Unexpected import ${specifier} in pure module ${path}`);
  };
  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { getCarrierForwarding, CARRIERS } = await loadTsModule("lib/carriers.ts");
const NUM = "+14253689655";

test("codes use the 10-digit national number, not the 11-digit form with a leading 1", () => {
  const f = getCarrierForwarding("tmobile", NUM);
  for (const { code } of f.codes) {
    assert.ok(!code.includes("14253689655"), `code should not include the leading 1: ${code}`);
    assert.ok(code.includes("4253689655"), `code should include the 10-digit number: ${code}`);
  }
});

test("AT&T gets the verified one-dial all-conditional code", () => {
  const f = getCarrierForwarding("att", NUM);
  assert.equal(f.confidence, "known");
  assert.deepEqual(f.codes.map((c) => c.code), ["**004*4253689655#"]);
  assert.equal(f.cancelCode, "##004#");
});

test("T-Mobile uses the standard per-condition GSM codes", () => {
  const f = getCarrierForwarding("tmobile", NUM);
  assert.equal(f.confidence, "known");
  assert.deepEqual(
    f.codes.map((c) => c.code),
    ["*61*4253689655#", "*67*4253689655#", "*62*4253689655#"],
  );
});

test("Verizon uses its single *71 conditional code, not the generic ones", () => {
  const f = getCarrierForwarding("verizon", NUM);
  assert.equal(f.confidence, "known");
  assert.equal(f.codes.length, 1);
  assert.equal(f.codes[0].code, "*714253689655");
  assert.equal(f.cancelCode, "*73");
  assert.match(f.note, /single conditional-forwarding code/i);
});

test("unknown carrier => generic codes, clearly labeled, with MVNO guidance", () => {
  const f = getCarrierForwarding("other", NUM);
  assert.equal(f.confidence, "generic");
  assert.equal(f.codes[0].code, "*61*4253689655#");
  assert.match(f.note, /MVNOs usually follow their host network/);
});

test("an unrecognized id falls back to generic (never throws)", () => {
  const f = getCarrierForwarding("boost", NUM);
  assert.equal(f.confidence, "generic");
});

test("no usable relay number => no codes (avoids showing broken codes)", () => {
  const f = getCarrierForwarding("att", "");
  assert.deepEqual(f.codes, []);
});

test("carrier list covers the big three plus an escape hatch", () => {
  const ids = CARRIERS.map((c) => c.id);
  assert.deepEqual(ids, ["att", "tmobile", "verizon", "other"]);
});
