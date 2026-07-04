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

function makeSession(overrides = {}) {
  return {
    accountId: "acct-1",
    role: "owner",
    account: {
      smsEnabled: false,
    },
    ...overrides,
  };
}

function settingsForm(overrides = {}) {
  return new URLSearchParams({
    business_name: "Demo Plumbing",
    owner_phone_number: "+12065550123",
    owner_email: "owner@example.com",
    scheduling_url: "https://example.com/book",
    sms_template: "Hi",
    missed_call_voice_message: "Leave a message",
    missed_call_greeting_audio_url: "",
    dial_timeout_seconds: "18",
    voicemail_max_seconds: "60",
    missed_call_sms_cooldown_hours: "24",
    ...overrides,
  });
}

async function runSettingsPost({
  session = makeSession(),
  a2pStatus = "approved",
  form = settingsForm({ sms_enabled: "on" }),
} = {}) {
  const calls = {
    a2pLookups: [],
    updates: [],
    redirects: [],
  };

  const { POST } = await loadTsModule("app/api/settings/route.ts", {
    "next/navigation": {
      redirect: (url) => {
        calls.redirects.push(url);
        throw Object.assign(new Error(`REDIRECT:${url}`), { url });
      },
    },
    "@/lib/auth": {
      requireAccountUser: async () => session,
    },
    "@/lib/phone": {
      normalizePhoneNumber: (value) => value,
    },
    "@/lib/supabase": {
      getA2pRegistrationStatus: async (accountId) => {
        calls.a2pLookups.push(accountId);
        return a2pStatus;
      },
      updateAccountSettings: async (accountId, update) => {
        calls.updates.push({ accountId, update });
      },
    },
  });

  try {
    await POST(new Request("http://localhost:3000/api/settings", {
      method: "POST",
      body: form,
    }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) {
      throw error;
    }
  }

  return calls;
}

test("owner enabling SMS with approved A2P persists sms_enabled true", async () => {
  const calls = await runSettingsPost({ a2pStatus: "approved" });

  assert.deepEqual(calls.a2pLookups, ["acct-1"]);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].update.sms_enabled, true);
  assert.deepEqual(calls.redirects, ["/settings?saved=1"]);
});

test("owner enabling SMS with in-progress A2P is refused", async () => {
  const calls = await runSettingsPost({ a2pStatus: "in_progress" });

  assert.deepEqual(calls.a2pLookups, ["acct-1"]);
  assert.equal(calls.updates.length, 0);
  assert.deepEqual(calls.redirects, ["/settings?error=a2p_not_approved"]);
});

test("A2P lookup failure/null fails closed when enabling SMS", async () => {
  const calls = await runSettingsPost({ a2pStatus: null });

  assert.deepEqual(calls.a2pLookups, ["acct-1"]);
  assert.equal(calls.updates.length, 0);
  assert.deepEqual(calls.redirects, ["/settings?error=a2p_not_approved"]);
});

test("owner disabling SMS never consults A2P status", async () => {
  const calls = await runSettingsPost({
    session: makeSession({ account: { smsEnabled: true } }),
    a2pStatus: "in_progress",
    form: settingsForm(),
  });

  assert.deepEqual(calls.a2pLookups, []);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].update.sms_enabled, false);
  assert.deepEqual(calls.redirects, ["/settings?saved=1"]);
});

test("admin cannot mutate sms_enabled through settings", async () => {
  const calls = await runSettingsPost({
    session: makeSession({ role: "admin", account: { smsEnabled: false } }),
    a2pStatus: "approved",
  });

  assert.deepEqual(calls.a2pLookups, []);
  assert.equal(calls.updates.length, 1);
  assert.equal(Object.hasOwn(calls.updates[0].update, "sms_enabled"), false);
  assert.deepEqual(calls.redirects, ["/settings?saved=1"]);
});
