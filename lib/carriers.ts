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

function gsmCodes(digits: string): ForwardingCode[] {
  return [
    { label: "No answer", code: `*61*${digits}#` },
    { label: "Busy", code: `*67*${digits}#` },
    { label: "Unreachable", code: `*62*${digits}#` },
  ];
}

export function getCarrierForwarding(carrierId: string, relayNumber: string): CarrierForwarding {
  const digits = digitsOnly(relayNumber);

  if (carrierId === "att" || carrierId === "tmobile") {
    const carrierName = carrierId === "att" ? "AT&T" : "T-Mobile";
    return {
      carrierId,
      carrierName,
      confidence: "known",
      intro: `On ${carrierName}, dial each code from your business phone and press call — you'll hear a confirmation tone.`,
      codes: digits ? gsmCodes(digits) : [],
      cancelCode: "##002#",
      note: "These forward a call only when you don't answer, are busy, or are unreachable — you still get every call normally.",
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
    codes: digits ? gsmCodes(digits) : [],
    cancelCode: "##002#",
    note: "MVNOs usually follow their host network — Cricket → AT&T, Mint/Metro → T-Mobile, Visible → Verizon (*71). Whatever you dial, run the Full test below to confirm it worked.",
  };
}
