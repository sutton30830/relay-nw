import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const ACCOUNT = {
  accountId: "acct-1",
  accountSlug: "relay-nw",
  businessName: "Relay NW",
  ownerEmail: "owner@example.com",
};

function validForm(overrides = {}) {
  return new URLSearchParams({
    businessName: "Demo Plumbing",
    ownerName: "Alex Owner",
    phone: "(206) 555-0123",
    businessType: "Plumbing",
    currentBusinessNumber: "(206) 555-0100",
    preferredCallbackNumber: "",
    notes: "Interested in setup.",
    company: "",
    ...overrides,
  });
}

function makeMocks({
  perIpCount = 0,
  globalCount = 0,
  countThrows = false,
} = {}) {
  const calls = {
    recentCounts: [],
    globalCounts: [],
    setupRequests: [],
    adminNotifications: [],
    redirects: [],
  };

  const mocks = {
    "node:crypto": { createHash },
    "next/navigation": {
      redirect: (url) => {
        calls.redirects.push(url);
        throw Object.assign(new Error(`REDIRECT:${url}`), { url });
      },
    },
    "@/lib/email": {
      notifyAdminNewSetupRequest: async (input) => calls.adminNotifications.push(input),
    },
    "@/lib/supabase": {
      countRecentSetupRequests: async (input) => {
        calls.recentCounts.push(input);
        if (countThrows) throw new Error("supabase count failed");
        return perIpCount;
      },
      countSetupRequestsSince: async (since) => {
        calls.globalCounts.push(since);
        if (countThrows) throw new Error("supabase count failed");
        return globalCount;
      },
      createSetupRequest: async (input) => calls.setupRequests.push(input),
      getDefaultAccountConfig: async () => ACCOUNT,
    },
  };

  return { mocks, calls };
}

async function postIntake(mocks, { ip = "203.0.113.42", form = validForm() } = {}) {
  const { POST } = await loadTsModule("app/api/intake/route.ts", mocks);

  try {
    await POST(new Request("https://example.com/api/intake", {
      method: "POST",
      body: form,
      headers: {
        "x-forwarded-for": `${ip}, 10.0.0.1`,
        "content-type": "application/x-www-form-urlencoded",
      },
    }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) {
      throw error;
    }
  }
}

test("sixth submission from one hashed IP within the window is redirected to rate_limited", async () => {
  const { mocks, calls } = makeMocks({ perIpCount: 5, globalCount: 0 });

  await postIntake(mocks);

  assert.deepEqual(calls.redirects, ["/intake?rate_limited=1"]);
  assert.equal(calls.setupRequests.length, 0);
  assert.equal(calls.adminNotifications.length, 0);
});

test("global cap rejects even a fresh IP", async () => {
  const { mocks, calls } = makeMocks({ perIpCount: 0, globalCount: 30 });

  await postIntake(mocks, { ip: "198.51.100.10" });

  assert.deepEqual(calls.redirects, ["/intake?rate_limited=1"]);
  assert.equal(calls.setupRequests.length, 0);
});

test("submission stores the sha256 submitter hash, never the raw IP", async () => {
  const rawIp = "198.51.100.77";
  const { mocks, calls } = makeMocks();

  await postIntake(mocks, { ip: rawIp });

  assert.deepEqual(calls.redirects, ["/intake?saved=1"]);
  assert.equal(calls.setupRequests.length, 1);
  assert.match(calls.setupRequests[0].submitterHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(calls.setupRequests[0]), new RegExp(rawIp.replaceAll(".", "\\.")));
  assert.equal(calls.recentCounts[0].submitterHash, calls.setupRequests[0].submitterHash);
});

test("rate-limit lookup failure lets a valid submission through", async () => {
  const { mocks, calls } = makeMocks({ countThrows: true });

  await postIntake(mocks);

  assert.deepEqual(calls.redirects, ["/intake?saved=1"]);
  assert.equal(calls.setupRequests.length, 1);
  assert.equal(calls.adminNotifications.length, 1);
});
