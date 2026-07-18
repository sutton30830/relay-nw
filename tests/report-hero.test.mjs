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

const { computeReportHero } = await loadTsModule("lib/report-hero.ts");

function hero(overrides) {
  return computeReportHero({
    booked: 0,
    bookedMissingValue: 0,
    recoveredCents: 0,
    missedCalls: 0,
    typicalJobValueCents: null,
    ...overrides,
  });
}

test("entered booked values lead with booked dollars", () => {
  assert.deepEqual(hero({ booked: 3, recoveredCents: 420000 }), {
    kind: "entered_value",
    figure: "$4,200",
    unitLine: "booked from Relay leads",
    subLine: "3 jobs currently marked booked.",
    footnote: "Based on job values you entered.",
    scale: "strong",
  });
});

test("partial booked values lead with at least framing when no typical value is set", () => {
  assert.deepEqual(hero({ booked: 5, bookedMissingValue: 2, recoveredCents: 420000 }), {
    kind: "partial_value",
    figure: "at least $4,200",
    unitLine: "booked from Relay leads",
    subLine: "3 of 5 booked jobs have values — add the rest.",
    footnote: "Based on job values you entered.",
    scale: "strong",
  });
});

test("partial booked values can estimate only the missing jobs when typical value is set", () => {
  assert.deepEqual(
    hero({ booked: 5, bookedMissingValue: 2, recoveredCents: 420000, typicalJobValueCents: 60000 }),
    {
      kind: "estimated_value",
      figure: "≈ $5,400",
      unitLine: "booked from Relay leads",
      subLine: "$4,200 entered · 2 jobs estimated at your typical value",
      footnote: "Based on job values you entered. Estimated using your typical job value of $600 — set in Settings.",
      scale: "strong",
      estimateLabel: "Estimate",
    },
  );
});

test("bookings with no values lead with job count when no typical value is set", () => {
  assert.deepEqual(hero({ booked: 3, bookedMissingValue: 3 }), {
    kind: "booked_without_value",
    figure: "3",
    unitLine: "jobs booked from Relay leads",
    subLine: "Add job values to see dollars recovered.",
    footnote: null,
    scale: "count",
  });
});

test("bookings with no values can estimate from typical job value", () => {
  assert.deepEqual(hero({ booked: 3, bookedMissingValue: 3, typicalJobValueCents: 120000 }), {
    kind: "estimated_value",
    figure: "≈ $3,600",
    unitLine: "estimated from your typical job value",
    subLine: "3 jobs booked from Relay leads.",
    footnote: "Estimated using your typical job value of $1,200 — set in Settings.",
    scale: "strong",
    estimateLabel: "Estimate",
  });
});

test("leads without bookings lead with live inbox count", () => {
  assert.deepEqual(hero({ missedCalls: 12 }), {
    kind: "calls_caught",
    figure: "12",
    unitLine: "leads in your inbox",
    subLine: "Mark booked jobs to track recovery.",
    footnote: null,
    scale: "count",
  });
});

test("empty account gets a reduced young-account state", () => {
  assert.deepEqual(hero({}), {
    kind: "empty",
    figure: "No recovered jobs yet",
    unitLine: "Reports will fill in as Relay catches missed calls.",
    subLine: "Once Relay catches leads and you mark booked jobs, the value will show here.",
    footnote: null,
    scale: "quiet",
  });
});

test("hero never renders a giant zero dollar figure", () => {
  const states = [
    hero({ booked: 3, bookedMissingValue: 3 }),
    hero({ missedCalls: 12 }),
    hero({}),
    hero({ booked: 2, bookedMissingValue: 2, recoveredCents: 0, typicalJobValueCents: 0 }),
  ];

  for (const state of states) {
    assert.notEqual(state.figure, "$0");
    assert.doesNotMatch(state.figure, /^\$0\b/);
  }
});
