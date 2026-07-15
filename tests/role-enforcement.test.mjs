import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Role enforcement: viewers are read-only. requireWriteAccessJson must reject
// viewers with 403 on every mutating route, and mutating handlers must bail
// before touching the database or Twilio when the guard rejects.

async function loadTsModule(path, mocks) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

// --- lib/auth.ts: requireWriteAccessJson ---

function accountUsersAdminFake(rowOrRows) {
  const rows = rowOrRows ? (Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]) : [];
  const makeBuilder = () => {
    const filters = [];
    const builder = {
      select: () => builder,
      eq: (column, value) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      ilike: (column, value) => {
        const normalized = String(value).replaceAll("\\_", "_").replaceAll("\\%", "%").toLowerCase();
        filters.push((row) => String(row[column] ?? "").toLowerCase() === normalized);
        return builder;
      },
      update: () => builder,
      is: () => builder,
      maybeSingle: async () => {
        const matches = rows.filter((row) => filters.every((filter) => filter(row)));
        return { data: matches[0] ?? null, error: null };
      },
      then: (resolve) => {
        const matches = rows.filter((row) => filters.every((filter) => filter(row)));
        return Promise.resolve({ data: matches, error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { from: () => makeBuilder() };
}

async function loadAuthModule({ role, user = { id: "user-1", email: "owner@example.com" } }) {
  const row = role
    ? { id: "au-1", account_id: "acct-1", user_id: "user-1", email: "owner@example.com", role }
    : null;

  return loadTsModule("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ getAll: () => [], set: () => {} }) },
    "next/navigation": {
      redirect: (url) => {
        throw new Error(`redirect:${url}`);
      },
    },
    "@supabase/ssr": {
      createServerClient: () => ({
        auth: {
          getUser: async () =>
            user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "no session" } },
        },
      }),
    },
    "@/lib/env": { env: { supabaseUrl: "http://localhost", supabaseAnonKey: "anon" } },
    "@/lib/supabase": {
      supabaseAdmin: accountUsersAdminFake(row),
      getAccountConfigByAccountId: async (accountId) => ({ accountId }),
    },
  });
}

test("requireWriteAccessJson rejects viewers with 403 and no session", async () => {
  const auth = await loadAuthModule({ role: "viewer" });
  const result = await auth.requireWriteAccessJson();

  assert.equal(result.session, null);
  assert.equal(result.response.status, 403);
  const body = await result.response.json();
  assert.equal(body.error, "Viewers have read-only access");
});

test("requireWriteAccessJson supports a custom viewer message", async () => {
  const auth = await loadAuthModule({ role: "viewer" });
  const result = await auth.requireWriteAccessJson("Viewers cannot send replies");

  assert.equal(result.response.status, 403);
  const body = await result.response.json();
  assert.equal(body.error, "Viewers cannot send replies");
});

test("requireWriteAccessJson passes owners and admins through", async () => {
  for (const role of ["owner", "admin"]) {
    const auth = await loadAuthModule({ role });
    const result = await auth.requireWriteAccessJson();

    assert.equal(result.response, null, `${role} should not be rejected`);
    assert.equal(result.session.role, role);
    assert.equal(result.session.accountId, "acct-1");
  }
});

test("requireWriteAccessJson returns 401 when unauthenticated", async () => {
  const auth = await loadAuthModule({ role: "viewer", user: null });
  const result = await auth.requireWriteAccessJson();

  assert.equal(result.session, null);
  assert.equal(result.response.status, 401);
});

// --- Route handlers bail before side effects when the guard rejects ---

function rejectedGuard() {
  return {
    session: null,
    response: Response.json({ error: "Viewers have read-only access" }, { status: 403 }),
  };
}

test("lead PATCH/DELETE use the write guard and never touch the database for viewers", async () => {
  let dbCalls = 0;

  const route = await loadTsModule("app/api/leads/[id]/route.ts", {
    "@/lib/auth": { requireWriteAccessJson: async () => rejectedGuard() },
    "@/lib/supabase": {
      updateLead: async () => {
        dbCalls += 1;
      },
      deleteLead: async () => {
        dbCalls += 1;
      },
    },
  });

  const params = Promise.resolve({ id: "lead-1" });
  const patch = await route.PATCH(
    new Request("http://test/api/leads/lead-1", { method: "PATCH", body: JSON.stringify({ status: "booked" }) }),
    { params },
  );
  const del = await route.DELETE(new Request("http://test/api/leads/lead-1", { method: "DELETE" }), { params });

  assert.equal(patch.status, 403);
  assert.equal(del.status, 403);
  assert.equal(dbCalls, 0);
});

test("reply route never sends SMS when the guard rejects", async () => {
  let sends = 0;

  const route = await loadTsModule("app/api/leads/[id]/reply/route.ts", {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({
        session: null,
        response: Response.json({ error: "Viewers cannot send replies" }, { status: 403 }),
      }),
    },
    "@/lib/supabase": {
      createMessageIfNew: async () => {},
      getLeadByIdForAccount: async () => null,
      isOptedOut: async () => false,
      updateLead: async () => {},
    },
    "@/lib/twilio": {
      phoneLast4: () => "0000",
      twilioClient: {
        messages: {
          create: async () => {
            sends += 1;
            return { sid: "SM_test" };
          },
        },
      },
    },
  });

  const response = await route.POST(
    new Request("http://test/api/leads/lead-1/reply", { method: "POST", body: JSON.stringify({ body: "hi" }) }),
    { params: Promise.resolve({ id: "lead-1" }) },
  );

  assert.equal(response.status, 403);
  assert.equal(sends, 0);
});

test("transcribe route never runs AI when the guard rejects", async () => {
  let transcriptions = 0;

  const route = await loadTsModule("app/api/leads/[id]/transcribe/route.ts", {
    "@/lib/auth": { requireWriteAccessJson: async () => rejectedGuard() },
    "@/lib/voicemail-ai": {
      transcribeLeadVoicemail: async () => {
        transcriptions += 1;
        return {};
      },
    },
  });

  const response = await route.POST(new Request("http://test/api/leads/lead-1/transcribe", { method: "POST" }), {
    params: Promise.resolve({ id: "lead-1" }),
  });

  assert.equal(response.status, 403);
  assert.equal(transcriptions, 0);
});

test("test-flow start endpoints require write access while status stays readable", async () => {
  const smsAuth = await loadTsModule("app/api/sms-test/_auth.ts", {
    "@/lib/auth": {
      requireAccountUserJson: "read-auth",
      requireWriteAccessJson: "write-auth",
    },
  });
  const healthAuth = await loadTsModule("app/api/health-check/_auth.ts", {
    "@/lib/auth": {
      requireAccountUserJson: "read-auth",
      requireWriteAccessJson: "write-auth",
    },
  });

  assert.equal(smsAuth.authorizeSmsTestRequest, "read-auth");
  assert.equal(smsAuth.authorizeSmsTestStart, "write-auth");
  assert.equal(healthAuth.authorizeHealthCheckRequest, "read-auth");
  assert.equal(healthAuth.authorizeHealthCheckStart, "write-auth");
});
