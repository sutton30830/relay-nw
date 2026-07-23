import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/onboarding-profile.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new vm.Script(`(function(module,exports){${compiled}\n})`).runInThisContext()(module, module.exports);
const { isCustomerProfileComplete, missingCustomerProfileFields } = module.exports;

const complete = {
  businessName: "Cascade Plumbing",
  ownerName: "Sutton Lowry",
  ownerEmail: "owner@example.com",
  ownerPhoneNumber: "+12065550123",
  publicBusinessNumber: "+12065550124",
  businessType: "llc",
  callMode: "forwarding",
};

test("customer profile completion never depends on a Relay-assigned number", () => {
  assert.equal(isCustomerProfileComplete(complete), true);
});

test("forwarding requires the public number but not cosmetic profile fields", () => {
  const profile = { ...complete, ownerName: null, publicBusinessNumber: "" };
  assert.deepEqual(missingCustomerProfileFields(profile), ["Existing public business number"]);
});

test("direct mode does not require an existing public number", () => {
  const profile = {
    ...complete,
    callMode: "direct",
    ownerName: null,
    businessType: null,
    publicBusinessNumber: null,
  };

  assert.equal(isCustomerProfileComplete(profile), true);
});
