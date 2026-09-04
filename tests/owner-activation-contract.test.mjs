import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Owner Activation release: one truthful service status, texting-gated lead
// actions, transcript-only summary recovery, and honest empty-voicemail copy.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const leadsPage = await read("app/leads/page.tsx");
const leadsList = await read("app/leads/leads-list.tsx");
const leadCard = await read("app/leads/_components/lead-card.tsx");
const serviceStrip = await read("app/leads/_components/service-status.tsx");
const conversationPage = await read("app/leads/[id]/page.tsx");
const conversationView = await read("app/leads/[id]/conversation-view.tsx");
const setupPage = await read("app/setup/page.tsx");
const readinessLoader = await read("lib/onboarding-readiness.ts");
const replyRoute = await read("app/api/leads/[id]/reply/route.ts");
const transcribeRoute = await read("app/api/leads/[id]/transcribe/route.ts");
const voicemailAi = await read("lib/voicemail-ai.ts");
const voicemailStore = await read("lib/supabase/voicemails.ts");
const globalsCss = await read("app/globals.css");

async function loadLeadUtils() {
  const source = await read("app/leads/_utils.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mocks = {
    "./_constants": {
      AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS: 10 * 60 * 1000,
      FAST_REPLY_PATTERNS: [],
      TODAY_REPLY_PATTERNS: [],
      LEGACY_FORWARDING_MESSAGE: "__legacy__",
    },
    "@/lib/voicemail-quality": {
      hasUsableVoicemail: (recordingSid, duration) =>
        Boolean(recordingSid) && !(typeof duration === "number" && duration < 3),
    },
  };
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Unexpected import ${specifier}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: "_utils.ts" })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { voicemailRecoveryAction, voicemailTranscriptionWasSuppressed } = await loadLeadUtils();

// --- One truthful status view -------------------------------------------------

test("inbox and conversation load the owner service status scoped to the session account", () => {
  assert.match(leadsPage, /loadOwnerServiceStatus\(accountId, account\)/);
  assert.match(conversationPage, /loadOwnerServiceStatus\(accountId, account\)/);
  assert.match(leadsList, /<ServiceStatusStrip status=\{serviceStatus\}/);
  assert.match(leadsList, /textingFromRelay=\{serviceStatus\?\.canTextFromRelay \?\? true\}/);
});

test("owner service status loader only reads account-scoped facts (cross-tenant)", () => {
  const loader = readinessLoader.slice(
    readinessLoader.indexOf("export async function loadOwnerServiceStatus"),
    readinessLoader.indexOf("function effectiveTechnicalStatus"),
  );
  assert.match(loader, /getAccountTechnicalSetupStatus\(accountId\)/);
  assert.match(loader, /getA2pRegistrationStatus\(accountId\)/);
  assert.match(loader, /getSignedCallVerificationAt\(accountId\)/);
  assert.doesNotMatch(loader, /listActiveAccountIds|\.from\(/);
  // Transcription readiness is a platform fact combined with the account switch.
  assert.match(loader, /voicemailTranscriptionEnabled: account\.voicemailTranscriptionEnabled/);
  assert.match(loader, /transcriptionProviderConfigured: Boolean\(env\.openaiApiKey\)/);
});

test("setup page derives calls, voicemail, and texting from the same contract as the inbox", () => {
  assert.match(setupPage, /deriveOwnerServiceStatus\(\{/);
  assert.match(setupPage, /serviceStatus\.transcription\.label/);
  assert.match(setupPage, /serviceStatus\.texting\.label/);
  assert.match(setupPage, /serviceStatus\.texting\.owner === "relay" \? serviceStatus\.texting\.nextStep : null/);
  assert.match(setupPage, /Calls and your inbox continue to work normally\. \{textingNextStep\}/);
  assert.match(setupPage, /<dt><Icon name="sparkle" size=\{16\} \/> Voicemail<\/dt>/);
  assert.match(globalsCss, /\.customer-setup-overview__states \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test("status strip shows every capability and the next step for anything blocked", () => {
  assert.match(serviceStrip, /\[status\.calls, status\.transcription, status\.texting\]/);
  assert.match(serviceStrip, /capabilities\.filter\(\(capability\) => capability\.nextStep\)/);
  assert.match(serviceStrip, /href="\/setup"/);
  assert.match(serviceStrip, /aria-label="Relay service status"/);
  assert.match(globalsCss, /\.service-status__item--ready/);
  assert.match(globalsCss, /\.service-status__item \{[^}]*min-height: 28px/);
});

// --- A2P / SMS gating in the owner UI -----------------------------------------

test("conversation composer appears only when the server-side reply gate would pass", () => {
  assert.match(replyRoute, /if \(!account\.smsEnabled\) \{/);
  assert.match(conversationView, /\{!readOnly && serviceStatus\.canTextFromRelay \? \(\s*<footer className="convo__composer">/);
  assert.match(conversationView, /\{!readOnly && !serviceStatus\.canTextFromRelay \? \(\s*<footer className="convo__composer convo__no-text"/);
  assert.match(conversationView, /Texting from your Relay number is not on yet\./);
});

test("while texting is blocked the owner still gets working non-SMS actions", () => {
  const panel = conversationView.slice(
    conversationView.indexOf('convo__no-text"'),
    conversationView.indexOf("{!readOnly && serviceStatus.canTextFromRelay", conversationView.indexOf('convo__no-text"')),
  );
  assert.match(panel, /href=\{`tel:\$\{lead\.phone\}`\}/);
  assert.match(panel, /href=\{`sms:\$\{lead\.phone\}`\}/);
  assert.match(panel, /Text from my phone/);
  assert.match(panel, /<CopyButton value=\{formatPhone\(lead\.phone\)\} label="Copy number" \/>/);
  assert.match(panel, /onClick=\{\(\) => setDetailsOpen\(true\)\}/);
  assert.match(panel, /Add note or mark contacted/);
  assert.match(globalsCss, /\.convo__no-text-actions \.btn \{\s*min-height: 40px;/);
});

test("lead cards stop flagging texting-off as a per-lead failure", () => {
  assert.match(leadCard, /if \(lead\.sms_status === "skipped_disabled"\) \{\s*return textingFromRelay \? `Not auto-texted\$\{updated\}` : null;/);
  assert.doesNotMatch(leadCard, /SMS off\$\{updated\}/);
  assert.doesNotMatch(leadCard, /smsMeta\.startsWith\("SMS off"\)/);
  // Real delivery failures remain loud.
  assert.match(leadCard, /smsMeta\.startsWith\("SMS failed"\)/);
  assert.match(leadCard, /item\.text\.startsWith\("SMS failed"\)\s*\? "lead-card__fact--warn"/);
});

// --- Transcript and summary recovery --------------------------------------------

test("voicemailRecoveryAction offers summary-only recovery for transcript-only voicemails", () => {
  const base = {
    recording_sid: "REtest",
    recording_duration: 20,
    voicemail_transcript: "I need a quote for a faucet.",
    voicemail_summary: null,
    voicemail_transcription_status: "completed",
    voicemail_transcription_error: null,
  };
  assert.equal(voicemailRecoveryAction(base), "summary");
  assert.equal(voicemailRecoveryAction({ ...base, voicemail_summary: "Faucet quote." }), null);
  assert.equal(voicemailRecoveryAction({ ...base, voicemail_transcription_status: "processing" }), null, "no duplicate while claimed");
  assert.equal(voicemailRecoveryAction({ ...base, voicemail_transcript: null, voicemail_transcription_status: null }), "transcription");
  assert.equal(voicemailRecoveryAction({ ...base, voicemail_transcript: null, voicemail_transcription_status: "failed", voicemail_transcription_error: "OpenAI insufficient_quota" }), "transcription");
  assert.equal(voicemailRecoveryAction({ ...base, recording_duration: 1 }), null, "empty recording is not recoverable");
});

test("suppressed transcriptions are final: no paid retry is offered", () => {
  for (const error of [
    "No usable voicemail was recorded. The caller hung up before leaving a message.",
    "No clear spoken message was detected in this voicemail.",
    "Relay could not confidently transcribe this voicemail.",
  ]) {
    assert.equal(voicemailTranscriptionWasSuppressed(error), true, error);
    assert.equal(voicemailRecoveryAction({
      recording_sid: "REtest",
      recording_duration: 12,
      voicemail_transcript: null,
      voicemail_summary: null,
      voicemail_transcription_status: "failed",
      voicemail_transcription_error: error,
    }), null);
  }
  assert.equal(voicemailTranscriptionWasSuppressed("Twilio recording download failed with 404"), false);
  assert.equal(voicemailTranscriptionWasSuppressed(null), false);
});

test("conversation page offers Generate summary from transcript without retranscribing", () => {
  assert.match(conversationView, /voicemailRecoveryAction\(item\.lead\)/);
  assert.match(conversationView, /"Generate summary from transcript"/);
  assert.match(conversationView, /summaryUnavailableIds\.has\(item\.lead\.id\)/);
  assert.match(conversationView, /could not write a reliable summary from this transcript/);
  // The server path for a transcript-only lead is summary-only and claim-guarded.
  assert.match(voicemailAi, /if \(lead\.voicemail_transcript\) \{\s*return regenerateVoicemailSummary\(/);
  assert.match(voicemailAi, /const claimed = await claimVoicemailSummary\(\{/);
  assert.match(voicemailStore, /\.eq\("voicemail_transcription_status", "completed"\)\s*\.not\("voicemail_transcript", "is", null\)\s*\.is\("voicemail_summary", null\)/);
  assert.match(transcribeRoute, /transcribeLeadVoicemail\(id, auth\.session\.accountId\)/);
});

test("lead drawer and conversation share one suppression rule", async () => {
  const drawer = await read("app/leads/_components/lead-drawer.tsx");
  assert.match(drawer, /voicemailTranscriptionWasSuppressed\(lead\.voicemail_transcription_error\)/);
  assert.doesNotMatch(drawer, /voicemail_transcription_error\?\.includes\("could not confidently transcribe"\)/);
});

// --- Empty voicemail handling ---------------------------------------------------

test("an empty recording is explained, not shown as a waiting voicemail or a failure", () => {
  assert.match(leadCard, /const emptyRecording = Boolean\(lead\.recording_sid\) && !hasVoicemail;/);
  assert.match(leadCard, /Caller hung up without leaving a message\. Call back while the request is still fresh\./);
  assert.match(leadCard, /hasVoicemail \? \{ text: "Voicemail", mobileEssential: false \} : null/);
  assert.doesNotMatch(leadCard, /lead\.recording_sid \? \{ text: "Voicemail"/);
  assert.match(conversationView, /\) : item\.lead\.recording_sid \? \(\s*<p className="convo__event-line convo__event-line--quiet">\s*Caller hung up without leaving a message\./);
  assert.match(conversationView, /humanVoicemailError\(item\.lead\.voicemail_transcription_error\)/);
});
