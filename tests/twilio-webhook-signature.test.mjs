import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import twilio from "twilio";
import ts from "typescript";

async function loadTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(() => {
      throw new Error(`Unexpected import while loading ${path}`);
    }, module, module.exports);
  return module.exports;
}

const { twilioWebhookUrlCandidates } = await loadTsModule("lib/twilio-webhook-urls.ts");

const encodedProductionUrl =
  "https://www.relay-nw.com/api/twilio/sms-status?messageType=manual_reply&accountId=acct-1&leadId=lead-1&actionKey=manual_reply%3Alead-1%3Areply-1";
const literalColonProductionUrl = encodedProductionUrl.replaceAll("%3A", ":");
const payload = {
  MessageSid: "SM00000000000000000000000000000000",
  MessageStatus: "delivered",
};
const authToken = "production-signature-regression-token";

test("Twilio callbacks accept the literal-colon URL that produced the production signature", () => {
  const candidates = twilioWebhookUrlCandidates({
    requestUrl: encodedProductionUrl,
    appBaseUrl: "https://www.relay-nw.com",
    forwardedOrigin: "https://www.relay-nw.com",
  });
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    literalColonProductionUrl,
    payload,
  );

  assert.deepEqual(candidates, [encodedProductionUrl, literalColonProductionUrl]);
  assert.equal(
    candidates.some((url) => twilio.validateRequest(authToken, signature, url, payload)),
    true,
  );
});

test("Twilio callback compatibility does not decode other query data or accept a bad signature", () => {
  const url = `${encodedProductionUrl}&note=hello%20world%2Btest`;
  const candidates = twilioWebhookUrlCandidates({
    requestUrl: url,
    appBaseUrl: "https://www.relay-nw.com",
  });

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.includes("hello%20world%2Btest")));
  assert.equal(
    candidates.some((candidate) => twilio.validateRequest(authToken, "invalid", candidate, payload)),
    false,
  );
});
