// Carrier-aware call-forwarding guidance. Generic GSM codes (*61*/*67*/*62*)
// work on AT&T, T-Mobile, and MVNOs on their networks, but Verizon uses a
// different single conditional-forwarding code — so an owner who copies the
// generic codes on Verizon fails and blames Relay. Pick the carrier, get the
// right steps. The Full test below is always the source of truth, so imperfect
// codes are caught empirically rather than silently trusted.
//
// Pure and dependency-free so it's unit-testable.

export type CarrierOption = { id: string; name: string };

export const CARRIERS: CarrierOption[] = [
  { id: "att", name: "AT&T" },
  { id: "tmobile", name: "T-Mobile" },
  { id: "verizon", name: "Verizon" },
  { id: "other", name: "Other / MVNO / VoIP / not sure" },
];

export type ForwardingCode = { label: string; code: string };

export type CarrierForwarding = {
  carrierId: string;
  carrierName: string;
  // "known" = codes are reliable for this carrier; "generic" = best-effort
  // standard codes, confirm with the test.
  confidence: "known" | "generic";
  intro: string;
  codes: ForwardingCode[];
  cancelCode: string | null;
  note: string;
};

function digitsOnly(phone: string): string {
  return (phone ?? "").replace(/\D/g, "");
}

// US carriers want the 10-digit national number in these codes — the leading
// country-code "1" can get the code rejected.
function nationalDigits(phone: string): string {
  const digits = digitsOnly(phone);
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function gsmConditionalCodes(digits: string): ForwardingCode[] {
  return [
    { label: "No answer", code: `*61*${digits}#` },
    { label: "Busy", code: `*67*${digits}#` },
    { label: "Unreachable", code: `*62*${digits}#` },
  ];
}

export function getCarrierForwarding(carrierId: string, relayNumber: string): CarrierForwarding {
  const digits = nationalDigits(relayNumber);

  // AT&T: verified one-dial code that sets no-answer, busy, and unreachable at
  // once (confirmed on an AT&T iPhone).
  if (carrierId === "att") {
    return {
      carrierId,
      carrierName: "AT&T",
      confidence: "known",
      intro:
        "On AT&T, one code forwards every missed call to Relay. Dial it from your business phone and press call — you'll hear a confirmation tone.",
      codes: digits ? [{ label: "All missed calls", code: `**004*${digits}#` }] : [],
      cancelCode: "##004#",
      note: "This one code forwards a call when you don't answer, are busy, or are unreachable — you still get every call normally. If it doesn't take, set them separately with *61*, *67*, and *62*.",
    };
  }

  // T-Mobile: standard GSM conditional codes (well documented; not separately
  // verified, so shown per-condition).
  if (carrierId === "tmobile") {
    return {
      carrierId,
      carrierName: "T-Mobile",
      confidence: "known",
      intro: "On T-Mobile, dial each code from your business phone and press call — you'll hear a confirmation tone.",
      codes: digits ? gsmConditionalCodes(digits) : [],
      cancelCode: "##004#",
      note: "These forward a call only when you don't answer, are busy, or are unreachable. Many GSM phones also accept the one-dial **004*<number># to set all three at once.",
    };
  }

  if (carrierId === "verizon") {
    return {
      carrierId,
      carrierName: "Verizon",
      confidence: "known",
      intro: "On Verizon, one code forwards busy and unanswered calls. Dial it from your business phone and press call.",
      codes: digits ? [{ label: "No answer or busy", code: `*71${digits}` }] : [],
      cancelCode: "*73",
      note: "Verizon uses a single conditional-forwarding code for busy and no-answer; there is no separate “unreachable” setting.",
    };
  }

  return {
    carrierId: "other",
    carrierName: "Other / MVNO / VoIP / not sure",
    confidence: "generic",
    intro:
      "These are the standard GSM codes — they work on most US carriers. If a code doesn't take, look up your carrier's “conditional call forwarding” steps.",
    codes: digits ? gsmConditionalCodes(digits) : [],
    cancelCode: "##004#",
    note: "MVNOs usually follow their host network — Cricket → AT&T, Mint/Metro → T-Mobile, Visible → Verizon (*71). Whatever you dial, run the Full test below to confirm it worked.",
  };
}
