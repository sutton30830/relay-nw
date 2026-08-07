import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("only the placeholder environment example is tracked", () => {
  const tracked = execFileSync("git", ["ls-files", ".env*"], {
    cwd: root,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);

  assert.deepEqual(tracked, [".env.example"]);
});

test("the environment example contains placeholders, never credential-shaped values", async () => {
  const example = await read(".env.example");
  const credentialPatterns = [
    /sk_live_[A-Za-z0-9]{16,}/,
    /whsec_[A-Za-z0-9]{16,}/,
    /re_[A-Za-z0-9]{20,}/,
    /AC[0-9a-fA-F]{32}/,
    /SK[0-9a-fA-F]{32}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];

  for (const pattern of credentialPatterns) {
    assert.doesNotMatch(example, pattern);
  }
});

test("schema setup cannot silently grant Operations access to a named identity", async () => {
  for (const path of ["supabase.sql", "docs/sql/phase-7a-platform-operators.sql"]) {
    const sql = await read(path);
    assert.doesNotMatch(sql, /where\s+lower\(email\)\s*=/i);
  }
});

test("sensitive Operations reads are required platform audit events", async () => {
  const accountPage = await read("app/ops/accounts/[id]/page.tsx");
  const monitoringPage = await read("app/ops/monitoring/page.tsx");

  assert.match(accountPage, /action:\s*OPS_ACTIONS\.accountRead/);
  assert.match(accountPage, /recordPlatformAuditEvent\([\s\S]*?\},\s*\{\s*required:\s*true\s*\}\)/);
  assert.match(monitoringPage, /action:\s*OPS_ACTIONS\.diagnosticsRead/);
  assert.match(monitoringPage, /recordPlatformAuditEvent\([\s\S]*?\},\s*\{\s*required:\s*true\s*\}\)/);
});
