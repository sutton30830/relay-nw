import {
  createPendingForwardingHealthCheck,
  expirePendingForwardingHealthChecks,
  getForwardingHealthSummary,
  getLatestForwardingHealthCheck,
  markForwardingHealthCheckFailed,
  markForwardingHealthCheckOutboundCreated,
} from "@/lib/supabase";
import { env } from "@/lib/env";
import { FORWARDING_HEALTH_CHECK_COOLDOWN_MS, forwardingHealthRetryAt } from "@/lib/forwarding-health";
import { phoneLast4, twilioClient } from "@/lib/twilio";
import { isAuthorizedHealthCheckRequest } from "../_auth";

const OUTBOUND_TEST_CALL_TIMEOUT_SECONDS = 55;

function healthCheckCallUrl() {
  return `${env.appBaseUrl}/api/health-check/outbound-call`;
}

export async function POST() {
  if (!(await isAuthorizedHealthCheckRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (env.callMode !== "forwarding") {
    return Response.json({ error: "Forwarding health checks only run when CALL_MODE is forwarding." }, { status: 409 });
  }

  try {
    await expirePendingForwardingHealthChecks();

    const latest = await getLatestForwardingHealthCheck();
    const canRunAt = forwardingHealthRetryAt(latest);

    if (canRunAt) {
      console.info("health_check_rate_limited", {
        phoneLast4: phoneLast4(env.ownerPhoneNumber),
        canRunAt,
      });

      return Response.json(
        {
          error: "Health check was requested too recently.",
          canRunAt,
          cooldownMs: FORWARDING_HEALTH_CHECK_COOLDOWN_MS,
        },
        { status: 429 },
      );
    }

    const healthCheck = await createPendingForwardingHealthCheck(env.ownerPhoneNumber);

    if (!healthCheck) {
      return Response.json({ error: "Health check storage is not configured." }, { status: 500 });
    }

    console.info("health_check_started", {
      healthCheckId: healthCheck.id,
      phoneLast4: phoneLast4(env.ownerPhoneNumber),
    });

    try {
      const call = await twilioClient.calls.create({
        to: env.ownerPhoneNumber,
        from: env.twilioPhoneNumber,
        url: healthCheckCallUrl(),
        method: "POST",
        timeout: OUTBOUND_TEST_CALL_TIMEOUT_SECONDS,
      });

      await markForwardingHealthCheckOutboundCreated(healthCheck.id, call.sid);

      console.info("outbound_test_call_created", {
        healthCheckId: healthCheck.id,
        outboundTwilioCallSid: call.sid,
        phoneLast4: phoneLast4(env.ownerPhoneNumber),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Twilio outbound error";

      await markForwardingHealthCheckFailed(healthCheck.id, "twilio_outbound_failed", {
        message,
      });

      return Response.json(
        { error: "Twilio could not place the health check call.", healthCheckId: healthCheck.id },
        { status: 502 },
      );
    }

    const summary = await getForwardingHealthSummary();
    return Response.json({ ...summary, healthCheckId: healthCheck.id });
  } catch (error) {
    console.error("Failed to start forwarding health check", { error });
    return Response.json({ error: "Unable to start health check" }, { status: 500 });
  }
}
