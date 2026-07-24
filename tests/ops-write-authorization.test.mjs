import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mutatingOpsRoutes = [
  "app/api/ops/billing/reconcile/route.ts",
  "app/api/ops/billing/refund/route.ts",
  "app/api/ops/billing/route.ts",
  "app/api/ops/blocker/route.ts",
  "app/api/ops/calls/route.ts",
  "app/api/ops/carrier/route.ts",
  "app/api/ops/kickoff/route.ts",
  "app/api/ops/profile/route.ts",
  "app/api/ops/setup-requests/route.ts",
  "app/api/ops/team/route.ts",
  "app/api/ops/twilio/assign/route.ts",
];

test("every mutating Operations route requires operator write access", async () => {
  for (const path of mutatingOpsRoutes) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");

    assert.match(source, /import \{ requirePlatformOperatorWrite \} from "@\/lib\/auth"/);
    assert.match(source, /await requirePlatformOperatorWrite\(\)/);
    assert.doesNotMatch(source, /await requirePlatformOperator\(\)/);
  }
});
