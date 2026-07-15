import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

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

function makeSupabaseAdmin(rows) {
  const updates = [];

  function makeBuilder() {
    const filters = [];
    let updatePayload = null;

    const builder = {
      select: () => builder,
      eq: (column, value) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      ilike: (column, pattern) => {
        const exact = String(pattern).replaceAll("\\_", "_").replaceAll("\\%", "%").toLowerCase();
        filters.push((row) => String(row[column] ?? "").toLowerCase() === exact);
        return builder;
      },
      update: (payload) => {
        updatePayload = payload;
        return builder;
      },
      is: (column, value) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      maybeSingle: async () => {
        const matches = rows.filter((row) => filters.every((filter) => filter(row)));
        return { data: matches[0] ?? null, error: null };
      },
      then: (resolve) => {
        if (updatePayload) {
          for (const row of rows.filter((item) => filters.every((filter) => filter(item)))) {
            Object.assign(row, updatePayload);
            updates.push({ id: row.id, payload: updatePayload });
          }

          return Promise.resolve({ data: null, error: null }).then(resolve);
        }

        const matches = rows.filter((row) => filters.every((filter) => filter(row)));
        return Promise.resolve({ data: matches, error: null }).then(resolve);
      },
    };

    return builder;
  }

  return {
    updates,
    client: {
      from: () => makeBuilder(),
    },
  };
}

function makeAuthMocks({ rows, cookieValue = null, user = { id: "user-1", email: "owner@example.com" } }) {
  const supabase = makeSupabaseAdmin(rows);
  const accountConfigs = new Map([
    ["acct-a", { accountId: "acct-a", accountSlug: "alpha", businessName: "Alpha Plumbing" }],
    ["acct-b", { accountId: "acct-b", accountSlug: "bravo", businessName: "Bravo Drains" }],
  ]);
  const cookieSets = [];

  return {
    mocks: {
      "next/headers": {
        cookies: async () => ({
          get: (name) => (name === "relay_selected_account" && cookieValue ? { value: cookieValue } : undefined),
          getAll: () => [],
          set: (...args) => cookieSets.push(args),
        }),
      },
      "next/navigation": {
        redirect: (target) => {
          throw new Error(`redirect:${target}`);
        },
      },
      "@supabase/ssr": {
        createServerClient: () => ({
          auth: {
            getUser: async () =>
              user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "no user" } },
          },
        }),
      },
      "@/lib/env": {
        env: {
          defaultAccountSlug: "relay-nw",
          supabaseUrl: "http://localhost",
          supabaseAnonKey: "anon",
        },
      },
      "@/lib/supabase": {
        supabaseAdmin: supabase.client,
        getAccountConfigByAccountId: async (accountId) => accountConfigs.get(accountId) ?? null,
      },
    },
    updates: supabase.updates,
    cookieSets,
  };
}

function membership(overrides) {
  return {
    id: "membership",
    account_id: "acct-a",
    user_id: "user-1",
    email: "owner@example.com",
    role: "owner",
    ...overrides,
  };
}

test("one Supabase user can belong to multiple account_users rows", async () => {
  const { mocks } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a", role: "owner" }),
      membership({ id: "au-b", account_id: "acct-b", role: "admin" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const resolution = await auth.resolveAccountUserSessionForUser({ id: "user-1", email: "owner@example.com" });

  assert.equal(resolution.status, "ambiguous");
  assert.deepEqual(resolution.memberships.map((item) => item.accountId), ["acct-a", "acct-b"]);
});

test("same email invited to two accounts binds both memberships without throwing", async () => {
  const { mocks, updates } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a", user_id: null }),
      membership({ id: "au-b", account_id: "acct-b", user_id: null }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const memberships = await auth.getAccountMembershipsForUser({ id: "user-1", email: "owner@example.com" });

  assert.deepEqual(memberships.map((item) => item.accountId), ["acct-a", "acct-b"]);
  assert.deepEqual(updates.map((item) => item.id).sort(), ["au-a", "au-b"]);
});

test("single-account users still resolve directly", async () => {
  const { mocks } = makeAuthMocks({
    rows: [membership({ id: "au-a", account_id: "acct-a", role: "admin" })],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const resolution = await auth.resolveAccountUserSessionForUser({ id: "user-1", email: "owner@example.com" });

  assert.equal(resolution.status, "single_account");
  assert.equal(resolution.session.accountId, "acct-a");
  assert.equal(resolution.session.role, "admin");
});

test("single-account users are not blocked by a stale selected-account cookie", async () => {
  const { mocks } = makeAuthMocks({
    rows: [membership({ id: "au-a", account_id: "acct-a", role: "admin" })],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const resolution = await auth.resolveAccountUserSessionForUser(
    { id: "user-1", email: "owner@example.com" },
    "acct-stale",
  );

  assert.equal(resolution.status, "single_account");
  assert.equal(resolution.session.accountId, "acct-a");
});

test("multi-account user without selected account is treated as ambiguous", async () => {
  const { mocks } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a" }),
      membership({ id: "au-b", account_id: "acct-b" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const resolution = await auth.resolveAccountUserSessionForUser({ id: "user-1", email: "owner@example.com" });

  assert.equal(resolution.status, "ambiguous");
});

test("selected account must belong to the user", async () => {
  const { mocks } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a" }),
      membership({ id: "au-b", account_id: "acct-b" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const resolution = await auth.resolveAccountUserSessionForUser(
    { id: "user-1", email: "owner@example.com" },
    "acct-missing",
  );

  assert.equal(resolution.status, "invalid_selection");
  assert.equal(resolution.selectedAccount, "acct-missing");
});

test("selected account determines role", async () => {
  const { mocks } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a", role: "owner" }),
      membership({ id: "au-b", account_id: "acct-b", role: "viewer" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const byId = await auth.resolveAccountUserSessionForUser({ id: "user-1", email: "owner@example.com" }, "acct-b");
  const bySlug = await auth.resolveAccountUserSessionForUser({ id: "user-1", email: "owner@example.com" }, "bravo");

  assert.equal(byId.status, "selected_account");
  assert.equal(byId.session.accountId, "acct-b");
  assert.equal(byId.session.role, "viewer");
  assert.equal(bySlug.status, "selected_account");
  assert.equal(bySlug.session.role, "viewer");
});

test("JSON auth fails closed when multi-account selection is ambiguous", async () => {
  const { mocks } = makeAuthMocks({
    rows: [
      membership({ id: "au-a", account_id: "acct-a" }),
      membership({ id: "au-b", account_id: "acct-b" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const result = await auth.requireAccountUserJson();

  assert.equal(result.session, null);
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json()).error, "Choose an account before continuing");
});

test("viewer write restrictions still pass for the selected account", async () => {
  const { mocks } = makeAuthMocks({
    cookieValue: "acct-b",
    rows: [
      membership({ id: "au-a", account_id: "acct-a", role: "owner" }),
      membership({ id: "au-b", account_id: "acct-b", role: "viewer" }),
    ],
  });
  const auth = await loadTsModule("lib/auth.ts", mocks);

  const result = await auth.requireWriteAccessJson();

  assert.equal(result.session, null);
  assert.equal(result.response.status, 403);
  assert.equal((await result.response.json()).error, "Viewers have read-only access");
});

test("account selection route sets the selected account cookie and returns to next", async () => {
  const cookieSets = [];
  const route = await loadTsModule("app/api/auth/select-account/route.ts", {
    "next/headers": {
      cookies: async () => ({
        set: (...args) => cookieSets.push(args),
      }),
    },
    "next/navigation": {
      redirect: (target) => {
        throw new Error(`redirect:${target}`);
      },
    },
    "@/lib/auth": {
      createSupabaseAuthServerClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.com" } }, error: null }),
        },
      }),
      resolveAccountUserSessionForUser: async (_user, selectedAccount) => ({
        status: "selected_account",
        session: { accountId: selectedAccount },
      }),
      setSelectedAccountCookie: (cookieStore, accountId) => {
        cookieStore.set("relay_selected_account", accountId, { httpOnly: true, sameSite: "lax" });
      },
      clearSelectedAccountCookie: () => {},
    },
  });
  const form = new FormData();
  form.set("accountId", "acct-b");
  form.set("next", "/settings");

  await assert.rejects(
    () => route.POST(new Request("http://relay.test/api/auth/select-account", { method: "POST", body: form })),
    /redirect:\/settings/,
  );

  assert.equal(cookieSets[0][0], "relay_selected_account");
  assert.equal(cookieSets[0][1], "acct-b");
});

test("account selection route rejects stale selected accounts and clears the cookie", async () => {
  const cleared = [];
  const route = await loadTsModule("app/api/auth/select-account/route.ts", {
    "next/headers": {
      cookies: async () => ({
        set: (...args) => cleared.push(args),
      }),
    },
    "next/navigation": {
      redirect: (target) => {
        throw new Error(`redirect:${target}`);
      },
    },
    "@/lib/auth": {
      createSupabaseAuthServerClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.com" } }, error: null }),
        },
      }),
      resolveAccountUserSessionForUser: async () => ({
        status: "invalid_selection",
      }),
      setSelectedAccountCookie: () => {},
      clearSelectedAccountCookie: (cookieStore) => {
        cookieStore.set("relay_selected_account", "", { maxAge: 0 });
      },
    },
  });
  const form = new FormData();
  form.set("accountId", "acct-missing");
  form.set("next", "/reports");

  await assert.rejects(
    () => route.POST(new Request("http://relay.test/api/auth/select-account", { method: "POST", body: form })),
    /redirect:\/account\/select\?error=invalid&next=%2Freports/,
  );

  assert.equal(cleared[0][0], "relay_selected_account");
  assert.equal(cleared[0][2].maxAge, 0);
});

test("logout clears the selected account cookie before returning to login", async () => {
  const cookieSets = [];
  let signedOut = false;
  const route = await loadTsModule("app/api/auth/logout/route.ts", {
    "next/headers": {
      cookies: async () => ({
        set: (...args) => cookieSets.push(args),
      }),
    },
    "next/navigation": {
      redirect: (target) => {
        throw new Error(`redirect:${target}`);
      },
    },
    "@/lib/auth": {
      createSupabaseAuthServerClient: async () => ({
        auth: {
          signOut: async () => {
            signedOut = true;
          },
        },
      }),
      clearSelectedAccountCookie: (cookieStore) => {
        cookieStore.set("relay_selected_account", "", { maxAge: 0 });
      },
    },
  });

  await assert.rejects(() => route.POST(), /redirect:\/login/);

  assert.equal(signedOut, true);
  assert.equal(cookieSets[0][0], "relay_selected_account");
  assert.equal(cookieSets[0][2].maxAge, 0);
});
