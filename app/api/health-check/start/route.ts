import {
  createPendingForwardingHealthCheck,
  expirePendingForwardingHealthChecks,
  getForwardingHealthSummary,
  getLatestForwardingHealthCheck,
} from "@/lib/supabase";
import { FORWARDING_HEALTH_CHECK_COOLDOWN_MS, forwardingHealthRetryAt } from "@/lib/forwarding-health";
import { phoneLast4 } from "@/lib/twilio";
import { authorizeHealthCheckRequest } from "../_auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await authorizeHealthCheckRequest();
  if (auth.response) return auth.response;

  if (auth.session.account.callMode !== "forwarding") {
    return Response.json({ error: "Forwarding health checks only run when CALL_MODE is forwarding." }, { status: 409 });
  }

  try {
    await expirePendingForwardingHealthChecks(auth.session.accountId);

    const latest = await getLatestForwardingHealthCheck(auth.session.accountId);
    const canRunAt = forwardingHealthRetryAt(latest);

    if (canRunAt) {
      console.info("health_check_rate_limited", {
        phoneLast4: phoneLast4(auth.session.account.ownerPhoneNumber),
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

    const healthCheck = await createPendingForwardingHealthCheck(
      auth.session.account.ownerPhoneNumber,
      auth.session.accountId,
    );

    if (!healthCheck) {
      return Response.json(
        { error: "Health check storage is not configured." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    console.info("health_check_started", {
      healthCheckId: healthCheck.id,
      phoneLast4: phoneLast4(auth.session.account.ownerPhoneNumber),
      mode: "manual_listening_window",
    });

    const summary = await getForwardingHealthSummary(auth.session.accountId);
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
