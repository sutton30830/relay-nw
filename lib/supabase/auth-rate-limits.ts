import { supabaseAdmin, throwIfSupabaseError } from "./client";

export async function consumePasswordResetRateLimit(input: {
  emailHash: string;
  ipHash: string;
  windowSeconds: number;
  maxPerEmail: number;
  maxPerIp: number;
}) {
  const { data, error } = await supabaseAdmin.rpc("consume_auth_rate_limit", {
    p_action: "password_reset",
    p_email_hash: input.emailHash,
    p_ip_hash: input.ipHash,
    p_window_seconds: input.windowSeconds,
    p_max_per_email: input.maxPerEmail,
    p_max_per_ip: input.maxPerIp,
  });

  throwIfSupabaseError(error);
  return data === true;
}
