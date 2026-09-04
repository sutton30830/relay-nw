import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Outcome follow-through: Call back -> "Did you reach them?" -> Contacted ->
// "Did this become a job?" -> booked -> value presets. Session-only prompts
// whose answers are ordinary status/booked edits.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const hook = await read("app/leads/_hooks/use-leads-inbox.ts");
const card = await read("app/leads/_components/lead-card.tsx");
const list = await read("app/leads/leads-list.tsx");
const prompt = await read("app/leads/_components/outcome-prompt.tsx");
const convo = await read("app/leads/[id]/conversation-view.tsx");
const css = await read("app/globals.css");

test("prompts are session state, never persisted, and never shown for booked or trashed leads", () => {
  assert.match(hook, /const \[outcomePrompts, setOutcomePrompts\] = useState<Map<string, OutcomePromptStage>>/);
  assert.doesNotMatch(hook, /localStorage|outcome_prompt/);
  assert.match(hook, /function noteCallBack\(id: string\) \{\s*const lead = leadById\(id\);\s*if \(!lead \|\| lead\.deleted_at \|\| isBookedLead\(lead\)\) return;/);
  assert.match(card, /\{outcomePrompt && !trashed && !booked \? \(/);
});

test("Call back asks whether they were reached; Contacted asks whether it became a job", () => {
  assert.match(hook, /setOutcomePromptFor\(id, lead\.status === "contacted" \? "outcome" : "reached"\);/);
  assert.match(hook, /if \(saved && status === "contacted" && lead && !isBookedLead\(lead\)\) \{\s*setOutcomePromptFor\(id, "outcome"\);/);
  // A failed save never leaves a dangling prompt.
  assert.match(hook, /\} else \{\s*setOutcomePromptFor\(id, null\);\s*\}/);
  assert.match(prompt, /Did you reach them\?/);
  assert.match(prompt, /Did this become a job\?/);
  assert.match(prompt, /Yes, mark contacted/);
  assert.match(prompt, /Yes, booked/);
  assert.match(prompt, /Not yet/);
});

test("answers are the existing status and booked edits, so nothing new is persisted", () => {
  assert.match(hook, /if \(answer === "reached"\) \{\s*await updateStatus\(id, "contacted"\);\s*return;\s*\}/);
  assert.match(hook, /setOutcomePromptFor\(id, null\);\s*await updateBooked\(id, true\);/);
  assert.match(list, /outcomePrompt=\{inbox\.outcomePrompts\.get\(lead\.id\) \?\? null\}/);
  assert.match(list, /onCallBack=\{inbox\.noteCallBack\}/);
  assert.match(list, /onOutcomeAnswer=\{inbox\.answerOutcomePrompt\}/);
  assert.match(card, /href=\{`tel:\$\{lead\.phone\}`\} onClick=\{\(\) => onCallBack\?\.\(lead\.id\)\}/);
});

test("a freshly booked card shows value presets so the amount is one tap", () => {
  assert.match(card, /showPresets=\{!lead\.job_value_cents\}/);
});

test("conversation page runs the same loop from Call, opens details on booked, and hides it for viewers", () => {
  assert.match(convo, /setOutcomePrompt\(nextStatus === "contacted" && !booked \? "outcome" : null\);/);
  assert.match(convo, /if \(readOnly \|\| booked\) return;\s*setOutcomePrompt\(status === "contacted" \? "outcome" : "reached"\);/);
  assert.match(convo, /\{outcomePrompt && !readOnly && !booked \? \(\s*<div className="convo__outcome-prompt">/);
  assert.match(convo, /onReached=\{\(\) => void saveStatus\("contacted"\)\}/);
  assert.match(convo, /setDetailsOpen\(true\);\s*void saveLeadPatch\(\{ booked: true \}\)/);
});

test("prompt is tappable above the card's stretched link and has phone-sized targets", () => {
  assert.match(css, /\.lead-card \.outcome-prompt \{\s*position: relative;/);
  assert.match(css, /\.outcome-prompt__actions \.btn \{\s*min-height: 40px;/);
  assert.match(prompt, /role="group" aria-label=/);
});
