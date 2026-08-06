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

function twilioModuleMock() {
  const client = { messages: { create: async () => ({ sid: "SM_test" }) } };
  const factory = Object.assign(() => client, {
    validateRequest: () => true,
  });

  return { __esModule: true, default: factory };
}

test("Twilio media URL allowlist only accepts https api.twilio.com URLs", async () => {
  const { isTrustedTwilioMediaUrl } = await loadTsModule("lib/twilio.ts", {
    "twilio": twilioModuleMock(),
    "@/lib/env": {
      env: {
        twilioAccountSid: "AC_test",
        twilioAuthToken: "token",
        businessName: "Relay NW",
        intakeUrl: "https://example.com/intake",
        schedulingUrl: "https://example.com/book",
        smsTemplate: null,
        callMode: "direct",
        appBaseUrl: "https://example.com",
        allowUnsignedTwilioWebhooks: false,
      },
    },
    "@/lib/email": { notifyAdminOperationalIssue: async () => ({ sent: true }) },
    "@/lib/supabase": { logWebhookEvent: async () => {} },
    "@/lib/twilio-webhook-urls": {
      twilioWebhookUrlCandidates: ({ requestUrl }) => [requestUrl],
    },
  });

  assert.equal(isTrustedTwilioMediaUrl("https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE.mp3"), true);
  assert.equal(isTrustedTwilioMediaUrl("http://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE.mp3"), false);
  assert.equal(isTrustedTwilioMediaUrl("https://example.com/recording.mp3"), false);
  assert.equal(isTrustedTwilioMediaUrl("https://api.twilio.com.evil.com/recording.mp3"), false);
  assert.equal(isTrustedTwilioMediaUrl("not a url"), false);
  assert.equal(isTrustedTwilioMediaUrl(null), false);
});

test("recording playback falls back to api.twilio.com for untrusted stored URLs", async () => {
  const fetchedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return new Response("audio", {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };

  try {
    const { GET } = await loadTsModule("app/api/recordings/[recordingSid]/route.ts", {
      "@/lib/env": {
        env: {
          twilioAccountSid: "AC_test",
          twilioAuthToken: "token",
        },
      },
      "@/lib/auth": {
        requireAccountUserJson: async () => ({
          session: { accountId: "acct-1" },
          response: null,
        }),
      },
      "@/lib/supabase": {
        getLeadRecordingForPlayback: async () => ({
          id: "lead-1",
          recording_url: "https://evil.example/x.mp3",
        }),
      },
      "@/lib/twilio": {
        isTrustedTwilioMediaUrl: (value) => {
          if (!value) return false;
          const url = new URL(value);
          return url.protocol === "https:" && url.hostname === "api.twilio.com";
        },
      },
    });

    const recordingSid = "RE1234567890abcdef1234567890abcdef";
    const response = await GET(
      new Request(`https://example.com/api/recordings/${recordingSid}`),
      { params: Promise.resolve({ recordingSid }) },
    );

    assert.equal(response.status, 200);
    assert.equal(fetchedUrls.length, 1);
    assert.equal(new URL(fetchedUrls[0]).hostname, "api.twilio.com");
    assert.doesNotMatch(fetchedUrls[0], /evil\.example/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
