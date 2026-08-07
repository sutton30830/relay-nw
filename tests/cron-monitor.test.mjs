import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadCronMonitor(captureCheckIn) {
  const source = await readFile(new URL("../lib/cron-monitor.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier === "server-only") return {};
    if (specifier === "@sentry/nextjs") return { captureCheckIn };
    throw new Error(`Missing mock for ${specifier}`);
  };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`)
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const base = {
  slug: "relay-test-cron",
  schedule: { type: "crontab", value: "*/5 * * * *" },
  checkInMarginMinutes: 2,
  maxRuntimeMinutes: 5,
};

test("cron monitoring records an externally visible successful check-in", async () => {
  const checkIns = [];
  const { withCronMonitor } = await loadCronMonitor((checkIn, config) => {
    checkIns.push({ checkIn, config });
    return "check-in-1";
  });
  const response = await withCronMonitor({
    ...base,
    run: async () => Response.json({ ok: true }),
  });

  assert.equal(response.status, 200);
  assert.equal(checkIns[0].checkIn.status, "in_progress");
  assert.equal(checkIns[0].config.failureIssueThreshold, 1);
  assert.equal(checkIns[1].checkIn.status, "ok");
});

test("a non-2xx cron response records an external failure check-in", async () => {
  const checkIns = [];
  const { withCronMonitor } = await loadCronMonitor((checkIn) => {
    checkIns.push(checkIn);
    return "check-in-2";
  });
  const response = await withCronMonitor({
    ...base,
    run: async () => Response.json({ ok: false }, { status: 502 }),
  });

  assert.equal(response.status, 502);
  assert.equal(checkIns.at(-1).status, "error");
});

test("a thrown cron failure records error and remains visible to the route", async () => {
  const checkIns = [];
  const { withCronMonitor } = await loadCronMonitor((checkIn) => {
    checkIns.push(checkIn);
    return "check-in-3";
  });

  await assert.rejects(withCronMonitor({
    ...base,
    run: async () => { throw new Error("database down"); },
  }), /database down/);
  assert.equal(checkIns.at(-1).status, "error");
});
