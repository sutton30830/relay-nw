import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/api/ops/stage/route.ts", import.meta.url), "utf8");

test("operator stage route only permits operator-managed technical states", () => {
  assert.match(source, /setting_up: \{ status: "setting_up"/);
  assert.match(source, /paused: \{ status: "paused"/);
  assert.match(source, /closed: \{ status: "closed"/);
  assert.doesNotMatch(source, /ready_to_activate|carrier_review|requirements_needed/);
});
