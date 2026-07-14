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

const { combineFullTest } = await loadTsModule("lib/full-test.ts");

const leg = (key, status) => ({ key, label: key === "forwarding" ? "Call forwarding" : "Texting", status });

test("all legs passed => verified", () => {
  const s = combineFullTest([leg("forwarding", "passed"), leg("sms", "passed")]);
  assert.equal(s.state, "verified");
  assert.equal(s.passedCount, 2);
  assert.equal(s.total, 2);
});

test("any failed => attention, naming the failed leg", () => {
  const s = combineFullTest([leg("forwarding", "passed"), leg("sms", "failed")]);
  assert.equal(s.state, "attention");
  assert.match(s.detail, /texting failed/);
});

test("failure outranks pending", () => {
  const s = combineFullTest([leg("forwarding", "pending"), leg("sms", "failed")]);
  assert.equal(s.state, "attention");
});

test("any pending (no failures) => running", () => {
  const s = combineFullTest([leg("forwarding", "pending"), leg("sms", "idle")]);
  assert.equal(s.state, "running");
});

test("all idle => idle prompt", () => {
  const s = combineFullTest([leg("forwarding", "idle"), leg("sms", "idle")]);
  assert.equal(s.state, "idle");
  assert.match(s.detail, /Run the 2 checks/);
});

test("single leg (direct mode: sms only)", () => {
  assert.equal(combineFullTest([leg("sms", "passed")]).state, "verified");
  assert.match(combineFullTest([leg("sms", "idle")]).detail, /Run the check below/);
});
