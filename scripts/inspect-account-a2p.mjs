import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

function parseLine(line) {
  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const parsed = parseLine(line);
      if (parsed) process.env[parsed[0]] ??= parsed[1];
    }
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  await loadEnv();
  const slug = process.argv[2]?.trim();
  if (!slug) throw new Error("Usage: node scripts/inspect-account-a2p.mjs <account-slug>");

  const supabase = createClient(
    process.env.SUPABASE_URL || required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) throw new Error(`Account not found: ${slug}`);

  const { data: numberRow, error: numberError } = await supabase
    .from("account_phone_numbers")
    .select("phone_number")
    .eq("account_id", account.id)
    .eq("is_primary", true)
    .maybeSingle();
  if (numberError) throw numberError;
  if (!numberRow?.phone_number) throw new Error(`No primary Relay number for ${slug}`);

  const client = twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
  const services = await client.messaging.v1.services.list({ limit: 100 });
  const matches = [];
  for (const service of services) {
    const context = client.messaging.v1.services(service.sid);
    const senders = await context.phoneNumbers.list({ limit: 1000 });
    if (!senders.some((sender) => sender.phoneNumber === numberRow.phone_number)) continue;
    const campaigns = await context.usAppToPerson.list({ limit: 100 });
    matches.push({
      messagingServiceSid: service.sid,
      friendlyName: service.friendlyName,
      serviceA2pRegistered: service.usAppToPersonRegistered,
      campaigns: campaigns.map((campaign) => ({
        campaignSid: campaign.sid,
        campaignStatus: campaign.campaignStatus,
        brandRegistrationSid: campaign.brandRegistrationSid,
        updatedAt: campaign.dateUpdated?.toISOString?.() ?? null,
      })),
    });
  }

  console.log(JSON.stringify({ accountSlug: slug, matchingMessagingServices: matches }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
