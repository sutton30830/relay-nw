import { env } from "@/lib/env";
import { missedCallSmsBody, phoneLast4, twilioClient } from "@/lib/twilio";
import { isAuthorizedSmsTestRequest } from "../_auth";

export const dynamic = "force-dynamic";

function testSmsBody() {
  return `[Relay NW test] ${missedCallSmsBody()}`;
}

export async function POST() {
  if (!(await isAuthorizedSmsTestRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!env.smsEnabled) {
    return Response.json(
      { error: "SMS is disabled. Set SMS_ENABLED=true before sending test texts." },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const message = await twilioClient.messages.create({
      to: env.ownerPhoneNumber,
      from: env.twilioPhoneNumber,
      body: testSmsBody(),
      statusCallback: `${env.appBaseUrl}/api/twilio/sms-status`,
    });

    console.info("sms_test_started", {
      messageSid: message.sid,
      ownerLast4: phoneLast4(env.ownerPhoneNumber),
      status: message.status,
    });

    return Response.json(
      {
        messageSid: message.sid,
        status: message.status,
        toLast4: phoneLast4(env.ownerPhoneNumber),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS test error";

    console.error("Failed to send SMS test", {
      ownerLast4: phoneLast4(env.ownerPhoneNumber),
      error: message,
    });

    return Response.json(
      { error: "Twilio could not send the SMS test.", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
