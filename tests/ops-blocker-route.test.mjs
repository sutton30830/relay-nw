import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/ops/blocker/route.ts", import.meta.url),
  "utf8",
);
const sql = await readFile(
  new URL("../docs/migrations/2026-07-23-phase2-operations-blockers.sql", import.meta.url),
  "utf8",
);

test("blocker persistence is role-protected, bounded, and audited atomically", () => {
  assert.match(route, /requirePlatformOperatorWrite/);
  assert.match(route, /setAccountOpsBlocker/);
  assert.match(route, /recordPlatformAuditEvent/);
  assert.match(route, /note\.length < 5/);
  assert.match(route, /\.slice\(0, 240\)/);
  assert.match(sql, /create or replace function public\.set_account_ops_blocker/);
  assert.match(sql, /insert into public\.account_audit_events/);
  assert.match(sql, /to service_role/);
  assert.match(sql, /from public, anon, authenticated/);
});

test("clearing a blocker clears both note and timestamp", () => {
  assert.match(
    sql,
    /ops_blocker_note = case when p_blocked_by = 'none' then null else v_note end/,
  );
  assert.match(
    sql,
    /when p_blocked_by = 'none' then null/,
  );
  assert.match(
    sql,
    /ops_blocked_since = v_next_blocked_since/,
  );
});
