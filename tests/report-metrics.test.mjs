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

const { rate, formatPercent, median, formatResponseTime } = await loadTsModule("lib/report-metrics.ts");

test("rate returns null on a zero denominator (avoids misleading 0%)", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(3, 0), null);
  assert.equal(rate(3, 12), 0.25);
});

test("formatPercent rounds and shows dash for null", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(0.25), "25%");
  assert.equal(formatPercent(0.666), "67%");
});

test("median handles odd, even, and empty", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("median does not mutate its input", () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test("formatResponseTime scales seconds to a compact label", () => {
  assert.equal(formatResponseTime(null), "—");
  assert.equal(formatResponseTime(0.4), "instant");
  assert.equal(formatResponseTime(8), "8s");
  assert.equal(formatResponseTime(150), "3m");
  assert.equal(formatResponseTime(3600), "1h");
  assert.equal(formatResponseTime(90000), "1d");
});
