import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    throw new Error(`Unexpected import ${specifier} in pure module ${path}`);
  };
  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { diffSettingsForAudit } = await loadTsModule("lib/audit.ts");

test("no changes => no events", () => {
  const s = { smsEnabled: true, businessName: "Ace" };
  assert.deepEqual(diffSettingsForAudit(s, s), []);
});

test("turning texting on gets its own explicit event", () => {
  const events = diffSettingsForAudit({ smsEnabled: false }, { smsEnabled: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "texting.enabled");
  assert.match(events[0].summary, /ON/);
});

test("turning texting off is recorded as OFF", () => {
  const events = diffSettingsForAudit({ smsEnabled: true }, { smsEnabled: false });
  assert.equal(events[0].action, "texting.disabled");
  assert.match(events[0].summary, /OFF/);
});

test("field changes roll into one summary, texting stays separate", () => {
  const before = { smsEnabled: false, businessName: "Ace", missedCallSmsCooldownHours: 24 };
  const after = { smsEnabled: true, businessName: "Ace Plumbing", missedCallSmsCooldownHours: 12 };
  const events = diffSettingsForAudit(before, after);
  assert.equal(events.length, 2);
  assert.equal(events[0].action, "texting.enabled");
  assert.equal(events[1].action, "settings.updated");
  assert.match(events[1].summary, /business name and text cooldown/);
});

test("untouched fields (undefined in after) are ignored", () => {
  // A non-owner submit never includes smsEnabled; only business name changed.
  const events = diffSettingsForAudit({ businessName: "Ace" }, { businessName: "Ace Co" });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "settings.updated");
  assert.match(events[0].summary, /^Updated business name$/);
});

test("null and empty are treated the same (no phantom change)", () => {
  const events = diffSettingsForAudit({ schedulingUrl: null }, { schedulingUrl: null });
  assert.deepEqual(events, []);
});

test("quick reply arrays compared by content", () => {
  const same = diffSettingsForAudit({ quickReplyTemplates: ["a", "b"] }, { quickReplyTemplates: ["a", "b"] });
  assert.deepEqual(same, []);
  const changed = diffSettingsForAudit({ quickReplyTemplates: ["a"] }, { quickReplyTemplates: ["a", "b"] });
  assert.equal(changed.length, 1);
  assert.match(changed[0].summary, /quick replies/);
});

test("typical job value changes are included in the settings summary", () => {
  const events = diffSettingsForAudit(
    { typicalJobValueCents: null },
    { typicalJobValueCents: 25000 },
  );
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /typical job value/);
});

test("notification preference changes are audited by content", () => {
  const before = {
    notificationPreferences: {
      missed_call: { email: true, sms: true },
      voicemail_ready: { email: true, sms: false },
    },
  };
  assert.deepEqual(diffSettingsForAudit(before, structuredClone(before)), []);

  const events = diffSettingsForAudit(before, {
    notificationPreferences: {
      missed_call: { email: true, sms: false },
      voicemail_ready: { email: true, sms: false },
    },
  });
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /notification preferences/);
});
