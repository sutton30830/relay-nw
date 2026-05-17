import {
  createPendingForwardingHealthCheck,
  expirePendingForwardingHealthChecks,
  getForwardingHealthSummary,
  getLatestForwardingHealthCheck,
} from "@/lib/supabase";
import { env } from "@/lib/env";
import { FORWARDING_HEALTH_CHECK_COOLDOWN_MS, forwardingHealthRetryAt } from "@/lib/forwarding-health";
import { phoneLast4 } from "@/lib/twilio";
import { isAuthorizedHealthCheckRequest } from "../_auth";

export const dynamic = "force-dynamic";

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
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }

    const healthCheck = await createPendingForwardingHealthCheck(env.ownerPhoneNumber);

    if (!healthCheck) {
      return Response.json(
        { error: "Health check storage is not configured." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    console.info("health_check_started", {
      healthCheckId: healthCheck.id,
      phoneLast4: phoneLast4(env.ownerPhoneNumber),
      mode: "manual_listening_window",
    });

    const summary = await getForwardingHealthSummary();
    return Response.json(
      { ...summary, healthCheckId: healthCheck.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to start forwarding health check", { error });
    return Response.json(
      { error: "Unable to start health check" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
