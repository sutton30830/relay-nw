type TwilioWebhookUrlInput = {
  requestUrl: string;
  appBaseUrl: string;
  forwardedOrigin?: string | null;
};

function pathAndSearch(value: string) {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function addSignatureCandidates(candidates: Set<string>, value: string) {
  candidates.add(value);

  // Twilio signs the exact callback URL it uses. The first production callbacks
  // containing Relay's colon-delimited action key arrived at Vercel with `%3A`
  // in request.url but did not validate against that representation. Keep the
  // compatibility candidate deliberately narrow: the HMAC must still validate,
  // and no other query characters are decoded or reordered.
  const literalColonUrl = value.replace(/%3A/gi, ":");
  if (literalColonUrl !== value) {
    candidates.add(literalColonUrl);
  }
}

export function twilioWebhookUrlCandidates(input: TwilioWebhookUrlInput) {
  const suffix = pathAndSearch(input.requestUrl);
  const candidates = new Set<string>();

  addSignatureCandidates(candidates, input.requestUrl);
  addSignatureCandidates(candidates, `${input.appBaseUrl}${suffix}`);

  if (input.forwardedOrigin) {
    addSignatureCandidates(candidates, `${input.forwardedOrigin}${suffix}`);
  }

  return Array.from(candidates);
}
