// Owner-facing weekly recap. Pure, so the copy is contract-tested. The value
// headline reuses the Reports hero so email and app never disagree about what
// counts as recovered: entered values are facts, typical-value estimates are
// labelled estimates, and a booked job without a value is never priced at zero.

import { computeReportHero } from "@/lib/report-hero";
import type { RecoveryStats } from "@/lib/supabase/reports";

export type WeeklyDigestInput = {
  businessName: string;
  stats: RecoveryStats;
  periodLabel: string;
  // Whether this account could text callers from its Relay number during the
  // period. When it could not, texting lines are replaced by one honest line
  // instead of a column of zeros that reads like failure.
  textingOn: boolean;
  typicalJobValueCents: number | null;
  appBaseUrl: string;
};

export type WeeklyDigest = {
  subject: string;
  headline: string;
  lines: string[];
  actionLabel: string;
  actionUrl: string;
};

// Plain-text email: keep the app's hero copy but drop typographic separators.
function plain(text: string) {
  return text
    .replace(/\s+—\s+([^.]*)\./g, " ($1).")
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+·\s+/g, ", ");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function buildWeeklyDigest(input: WeeklyDigestInput): WeeklyDigest {
  const { stats } = input;
  const hero = computeReportHero({
    booked: stats.booked,
    bookedMissingValue: stats.bookedMissingValue,
    recoveredCents: stats.recoveredCents,
    missedCalls: stats.missedCalls,
    typicalJobValueCents: input.typicalJobValueCents,
  });

  const valueLine =
    hero.kind === "entered_value" || hero.kind === "partial_value" || hero.kind === "estimated_value"
      ? `${hero.figure} ${hero.unitLine}. ${plain(hero.subLine)}`
      : hero.kind === "booked_without_value"
        ? `${plural(stats.booked, "job")} booked from Relay leads. Add job values and next week's recap will show dollars.`
        : `Jobs booked: none marked yet. Tap "Yes, booked" after a call-back so Relay can count it.`;

  const headline =
    hero.kind === "entered_value" || hero.kind === "partial_value" || hero.kind === "estimated_value"
      ? `Relay booked ${hero.figure} for ${input.businessName} ${input.periodLabel}.`
      : `Relay caught ${plural(stats.missedCalls, "missed call")} for ${input.businessName} ${input.periodLabel}.`;

  const voicemailLine =
    stats.voicemails === 0
      ? "Voicemails: none left."
      : `Voicemails: ${stats.voicemails}, ${stats.voicemailsWithRequest} with a clear request summarized for you.`;

  const unconfirmed = Math.max(0, stats.textedBack - stats.textedDelivered);
  const textingLines = input.textingOn
    ? [
        `Auto-texts delivered: ${stats.textedDelivered}${unconfirmed > 0 ? ` (${unconfirmed} more sent, delivery not confirmed)` : ""}${stats.smsFailed > 0 ? `, ${stats.smsFailed} failed` : ""}`,
        `Customer replies: ${stats.replies}`,
      ]
    : ["Auto-text: not on yet. Relay is completing carrier registration; callers were not texted this period."];

  const lines = [
    `Missed calls caught: ${stats.missedCalls}`,
    voicemailLine,
    `ASAP callbacks flagged: ${stats.urgent}`,
    ...textingLines,
    valueLine,
    ...(hero.footnote ? [plain(hero.footnote)] : []),
  ];

  const subject =
    hero.kind === "entered_value" || hero.kind === "partial_value" || hero.kind === "estimated_value"
      ? `Your week with Relay NW: ${plural(stats.missedCalls, "missed call")} caught, ${hero.figure} booked`
      : `Your week with Relay NW: ${plural(stats.missedCalls, "missed call")} caught`;

  return {
    subject,
    headline,
    lines,
    actionLabel: "See the full report",
    actionUrl: `${input.appBaseUrl}/reports`,
  };
}
