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

test("customer profile reports the exact missing owner-supplied fields", () => {
  const profile = { ...complete, ownerName: null, publicBusinessNumber: "" };
  assert.deepEqual(missingCustomerProfileFields(profile), ["Owner or admin name", "Existing public business number"]);
});
