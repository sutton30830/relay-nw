const DEFAULT_BASE_URL = "http://localhost:3000";

const scenario = process.argv[2];
const baseUrl = (process.env.SIMULATE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
const now = Date.now();

const scenarios = {
  "missed-call": {
    path: "/api/twilio/voice-status",
    payload: {
      CallSid: `CA_sim_missed_${now}`,
      DialCallSid: `CA_sim_dial_${now}`,
      From: "+12065550123",
      To: "+15551234567",
      DialCallStatus: "no-answer",
      CallStatus: "completed",
    },
  },
  "answered-call": {
    path: "/api/twilio/voice-status",
    payload: {
      CallSid: `CA_sim_answered_${now}`,
      DialCallSid: `CA_sim_dial_${now}`,
      From: "+12065550123",
      To: "+15551234567",
      DialCallStatus: "completed",
      CallStatus: "completed",
    },
  },
  recording: {
    path: "/api/twilio/recording",
    payload: {
      CallSid: process.env.SIMULATE_CALL_SID || `CA_sim_missed_${now}`,
      RecordingSid: `RE_sim_${now}`,
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/Recordings/RE_sim",
      RecordingDuration: "12",
      RecordingStatus: "completed",
    },
  },
  "inbound-sms": {
    path: "/api/twilio/sms",
    payload: {
      MessageSid: `SM_sim_inbound_${now}`,
      From: "+12065550123",
      To: "+15551234567",
      Body: "Hi, I still need help with this.",
    },
  },
  "sms-status": {
    path: "/api/twilio/sms-status",
    payload: {
      MessageSid: process.env.SIMULATE_MESSAGE_SID || `SM_sim_outbound_${now}`,
      MessageStatus: process.env.SIMULATE_MESSAGE_STATUS || "delivered",
      To: "+12065550123",
      From: "+15551234567",
    },
  },
  // Failure injection: carrier rejected the SMS. The lead should converge to
  // sms_status "failed" with the error visible, and a webhook event should be logged.
  "sms-status-failed": {
    path: "/api/twilio/sms-status",
    payload: {
      MessageSid: process.env.SIMULATE_MESSAGE_SID || `SM_sim_outbound_${now}`,
      MessageStatus: "failed",
      ErrorCode: "30003",
      To: "+12065550123",
      From: "+15551234567",
    },
  },
  // Failure injection: a status callback for a MessageSid no lead carries (this is what
  // happens after "Twilio accepted but the lead update failed"). With a matching row in
  // the messages table the lead should be reconciled; without one, the webhook event
  // should say "No lead matched this MessageSid."
  "sms-status-orphan": {
    path: "/api/twilio/sms-status",
    payload: {
      MessageSid: `SM_sim_orphan_${now}`,
      MessageStatus: "delivered",
      To: "+12065550123",
      From: "+15551234567",
    },
  },
  // Failure injection: a recording callback whose CallSid matches no lead. The webhook
  // event should note the unmatched CallSid and the admin should be notified.
  "recording-orphan": {
    path: "/api/twilio/recording",
    payload: {
      CallSid: `CA_sim_orphan_${now}`,
      From: "+12065559999",
      RecordingSid: `RE_sim_orphan_${now}`,
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/Recordings/RE_sim_orphan",
      RecordingDuration: "9",
      RecordingStatus: "completed",
    },
  },
};

function usage() {
  console.log(`Usage: npm run simulate -- <scenario>

Scenarios:
${Object.keys(scenarios).map((name) => `  - ${name}`).join("\n")}

Environment:
  SIMULATE_BASE_URL       Defaults to ${DEFAULT_BASE_URL}
  SIMULATE_CALL_SID       Optional CallSid for recording
  SIMULATE_MESSAGE_SID    Optional MessageSid for sms-status
  SIMULATE_MESSAGE_STATUS Optional SMS status for sms-status

For local simulation, run the app with ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true.
Do not enable that setting in production.
`);
}

async function postForm(path, payload) {
  const body = new URLSearchParams(payload);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    body,
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text,
  };
}

if (!scenario || !scenarios[scenario]) {
  usage();
  process.exit(scenario ? 1 : 0);
}

const selected = scenarios[scenario];

console.log(`Posting ${scenario} to ${baseUrl}${selected.path}`);
console.log(selected.payload);

const result = await postForm(selected.path, selected.payload);

console.log(`HTTP ${result.status}`);
console.log(result.body);

if (result.status >= 400) {
  process.exitCode = 1;
}
