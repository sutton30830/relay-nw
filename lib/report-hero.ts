export type ReportHeroInput = {
  booked: number;
  bookedMissingValue: number;
  recoveredCents: number;
  missedCalls: number;
  typicalJobValueCents: number | null;
};

export type ReportHero = {
  kind:
    | "entered_value"
    | "partial_value"
    | "estimated_value"
    | "booked_without_value"
    | "calls_caught"
    | "empty";
  figure: string;
  unitLine: string;
  subLine: string;
  footnote: string | null;
  scale: "strong" | "count" | "quiet";
  estimateLabel?: "Estimate";
};

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function typicalValue(input: ReportHeroInput) {
  const value = input.typicalJobValueCents;
  return value != null && value > 0 ? value : null;
}

export function computeReportHero(input: ReportHeroInput): ReportHero {
  const booked = Math.max(0, input.booked);
  const bookedMissingValue = Math.max(0, Math.min(input.bookedMissingValue, booked));
  const recoveredCents = Math.max(0, input.recoveredCents);
  const missedCalls = Math.max(0, input.missedCalls);
  const typical = typicalValue(input);

  if (booked > 0 && bookedMissingValue === 0 && recoveredCents > 0) {
    return {
      kind: "entered_value",
      figure: dollars(recoveredCents),
      unitLine: "booked from Relay leads",
      subLine: `${pluralize(booked, "job")} currently marked booked.`,
      footnote: "Based on job values you entered.",
      scale: "strong",
    };
  }

  if (recoveredCents > 0 && bookedMissingValue > 0) {
    if (typical) {
      const estimatedCents = recoveredCents + typical * bookedMissingValue;
      return {
        kind: "estimated_value",
        figure: `≈ ${dollars(estimatedCents)}`,
        unitLine: "booked from Relay leads",
        subLine: `${dollars(recoveredCents)} entered · ${pluralize(
          bookedMissingValue,
          "job",
        )} estimated at your typical value`,
        footnote: `Based on job values you entered. Estimated using your typical job value of ${dollars(
          typical,
        )} — set in Settings.`,
        scale: "strong",
        estimateLabel: "Estimate",
      };
    }

    const enteredJobs = Math.max(0, booked - bookedMissingValue);
    return {
      kind: "partial_value",
      figure: `at least ${dollars(recoveredCents)}`,
      unitLine: "booked from Relay leads",
      subLine: `${enteredJobs} of ${booked} booked jobs have values — add the rest.`,
      footnote: "Based on job values you entered.",
      scale: "strong",
    };
  }

  if (booked > 0 && recoveredCents === 0) {
    const valueLessJobs = bookedMissingValue > 0 ? bookedMissingValue : booked;
    if (typical) {
      return {
        kind: "estimated_value",
        figure: `≈ ${dollars(typical * valueLessJobs)}`,
        unitLine: "estimated from your typical job value",
        subLine: `${pluralize(booked, "job")} booked from Relay leads.`,
        footnote: `Estimated using your typical job value of ${dollars(typical)} — set in Settings.`,
        scale: "strong",
        estimateLabel: "Estimate",
      };
    }

    return {
      kind: "booked_without_value",
      figure: String(booked),
      unitLine: "jobs booked from Relay leads",
      subLine: "Add job values to see dollars recovered.",
      footnote: null,
      scale: "count",
    };
  }

  if (missedCalls > 0) {
    return {
      kind: "calls_caught",
      figure: String(missedCalls),
      unitLine: "leads in your inbox",
      subLine: "Mark booked jobs to track recovery.",
      footnote: null,
      scale: "count",
    };
  }

  return {
    kind: "empty",
    figure: "No recovered jobs yet",
    unitLine: "Reports will fill in as Relay catches missed calls.",
    subLine: "Once Relay catches leads and you mark booked jobs, the value will show here.",
    footnote: null,
    scale: "quiet",
  };
}
