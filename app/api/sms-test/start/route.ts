import { env } from "@/lib/env";
import { missedCallSmsBodyForAccount, phoneLast4, twilioClient } from "@/lib/twilio";
import { authorizeSmsTestRequest } from "../_auth";

export const dynamic = "force-dynamic";

function testSmsBody(account: Parameters<typeof missedCallSmsBodyForAccount>[0]) {
  return `[Relay NW test] ${missedCallSmsBodyForAccount(account)}`;
}

export async function POST() {
  const auth = await authorizeSmsTestRequest();
  if (auth.response) return auth.response;

  if (!auth.session.account.smsEnabled) {
    return Response.json(
      { error: "SMS is disabled. Set SMS_ENABLED=true before sending test texts." },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const message = await twilioClient.messages.create({
      to: auth.session.account.ownerPhoneNumber,
      from: auth.session.account.twilioPhoneNumber,
      body: testSmsBody(auth.session.account),
      statusCallback: `${env.appBaseUrl}/api/twilio/sms-status`,
    });

    console.info("sms_test_started", {
      messageSid: message.sid,
      ownerLast4: phoneLast4(auth.session.account.ownerPhoneNumber),
      status: message.status,
    });

    return Response.json(
      {
        messageSid: message.sid,
        status: message.status,
        toLast4: phoneLast4(auth.session.account.ownerPhoneNumber),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS test error";

    console.error("Failed to send SMS test", {
      ownerLast4: phoneLast4(auth.session.account.ownerPhoneNumber),
      error: message,
    });

    return Response.json(
      { error: "Twilio could not send the SMS test.", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
