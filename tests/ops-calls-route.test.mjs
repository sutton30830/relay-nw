import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/api/ops/calls/route.ts", import.meta.url), "utf8");

test("operator call route only permits explicit hold and reopen controls", () => {
  assert.match(source, /setting_up: \{ status: "setting_up", label: "Call setup resumed"/);
  assert.match(source, /paused: \{ status: "paused", label: "Calls paused"/);
  assert.doesNotMatch(source, /closed: \{ status: "closed"/);
  assert.match(source, /call_control/);
  assert.match(source, /ops\.calls\.hold_changed/);
  assert.doesNotMatch(source, /ready_to_activate|carrier_review|requirements_needed/);
});
