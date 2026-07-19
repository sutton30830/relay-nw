import { randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { notifyOwnerPasswordSetup } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase";

export async function sendCustomerPasswordInvite(emailInput: string) {
  const email = emailInput.trim().toLowerCase();
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password: randomBytes(32).toString("base64url"),
    email_confirm: true,
  });

  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    throw created.error;
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
  });
  if (error) throw error;

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error("Supabase returned no password setup token.");

  const setupUrl = new URL("/auth/recovery", env.appBaseUrl);
  setupUrl.searchParams.set("type", "recovery");
  setupUrl.searchParams.set("token_hash", tokenHash);
  setupUrl.searchParams.set("next", "/account/password");

  const delivery = await notifyOwnerPasswordSetup({ to: email, setupUrl: setupUrl.toString() });
  if (!delivery.sent) throw new Error("Customer password email was not delivered.");

  return { email, setupUrl: setupUrl.toString() };
}
