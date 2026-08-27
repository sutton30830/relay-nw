import { Blob } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultManifest = path.join(repoRoot, "tests/fixtures/voicemail-evals/manifest.json");
const manifestPath = path.resolve(process.argv[2] ?? defaultManifest);
const confidenceConfig = JSON.parse(
  await readFile(path.join(repoRoot, "lib/voicemail-confidence-config.json"), "utf8"),
);
const transcriptionPrompt =
  "A caller is leaving a voicemail after a missed phone call. The message may be personal, a test, a vendor notice, or a service request. Preserve exactly what is audible, including names, stated problems, and callback requests. Do not add words that were not spoken.";
const logprobModels = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
]);

function words(value) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wordErrorRate(reference, candidate) {
  const expected = words(reference);
  const actual = words(candidate);

  if (expected.length === 0) return actual.length === 0 ? 0 : 1;

  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= actual.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[actual.length] / expected.length;
}

function confidenceAssessment(logprobs = []) {
  const values = logprobs
    .filter((item) => typeof item.logprob === "number" && Number.isFinite(item.logprob))
    .filter((item) => /[\p{L}\p{N}]/u.test(item.token ?? ""))
    .map((item) => item.logprob);

  if (values.length === 0) return { confidence: null, reliable: false };

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minimum = Math.min(...values);
  const lowFraction =
    values.filter((value) => value < confidenceConfig.lowLogprobThreshold).length / values.length;
  const confidence = Math.min(1, Math.max(0, Math.exp(average)));

  return {
    confidence,
    reliable:
      confidence >= confidenceConfig.minimumReliableConfidence &&
      lowFraction <= confidenceConfig.maximumReliableLowTokenFraction &&
      minimum >= confidenceConfig.veryLowLogprobThreshold,
  };
}

async function transcribe(audioPath, model) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio]), path.basename(audioPath));
  form.append("model", model);
  form.append("response_format", "json");
  form.append("prompt", transcriptionPrompt);
  form.append("chunking_strategy", "auto");
  if (model === "gpt-transcribe") {
    form.append("languages[]", "en");
  } else {
    form.append("language", "en");
  }
  form.append("temperature", "0");
  if (logprobModels.has(model)) {
    form.append("include[]", "logprobs");
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const result = await response.json();
  return {
    text: String(result.text ?? "").trim(),
    logprobs: result.logprobs ?? [],
  };
}

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required to run voicemail evaluation.");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  console.error(`Could not read ${manifestPath}. Copy manifest.example.json to manifest.json and add local audio files.`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
  console.error("The evaluation manifest must contain at least one case.");
  process.exit(2);
}

const primaryModel = manifest.primaryModel ?? "gpt-transcribe";
const verificationModel = manifest.verificationModel ?? "gpt-4o-transcribe";
const adjudicationModel = manifest.adjudicationModel ?? "gpt-4o-mini-transcribe";
const rows = [];

for (const item of manifest.cases) {
  const audioPath = path.resolve(path.dirname(manifestPath), item.audio);
  const [primary, verification] = await Promise.all([
    transcribe(audioPath, primaryModel),
    transcribe(audioPath, verificationModel),
  ]);
  const agreementWer = wordErrorRate(primary.text, verification.text);
  let adjudication = null;
  let selected = primary;
  let recovered = false;

  if (agreementWer > confidenceConfig.maximumReliableTranscriptDisagreement) {
    adjudication = await transcribe(audioPath, adjudicationModel);
    const primarySupported =
      wordErrorRate(primary.text, adjudication.text) <=
      confidenceConfig.maximumReliableTranscriptDisagreement;
    const verificationSupported =
      wordErrorRate(verification.text, adjudication.text) <=
      confidenceConfig.maximumReliableTranscriptDisagreement;

    selected = primarySupported && !verificationSupported
      ? primary
      : verificationSupported && !primarySupported
        ? verification
        : primarySupported && verificationSupported
          ? primary
          : null;
    recovered = Boolean(selected);
  }

  const confidenceCandidates = selected && adjudication
    ? [selected, adjudication]
    : [primary, verification];
  const confidence = confidenceCandidates
    .map((candidate) => confidenceAssessment(candidate.logprobs))
    .find((assessment) => assessment.reliable) ?? { confidence: null, reliable: false };
  const expectedWer = selected
    ? wordErrorRate(item.expectedTranscript, selected.text)
    : Number.POSITIVE_INFINITY;
  const maxWer = item.maxWordErrorRate ?? manifest.maxWordErrorRate ?? 0.15;
  const accepted =
    Boolean(selected) &&
    confidence.reliable &&
    expectedWer <= maxWer;

  rows.push({
    id: item.id,
    accepted,
    recovered,
    expected_wer: Number.isFinite(expectedWer) ? expectedWer.toFixed(3) : "n/a",
    model_agreement_wer: agreementWer.toFixed(3),
    confidence: confidence.confidence?.toFixed(3) ?? "n/a",
  });
}

console.table(rows);
const accepted = rows.filter((row) => row.accepted).length;
console.log(`${accepted}/${rows.length} recordings met the configured acceptance criteria.`);

if (accepted !== rows.length) process.exitCode = 1;
