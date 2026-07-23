import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BACKFILL_TABLES = [
  "leads",
  "opt_outs",
  "inbound_messages",
];

const NULL_ALLOWED_TABLES = [
  {
    table: "webhook_events",
    reason: "Unresolved Twilio webhooks are intentionally logged with account_id NULL.",
  },
];

function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [match[1], value];
}

async function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;

    const contents = await readFile(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line);
      if (!parsed) continue;

      const [key, value] = parsed;
      process.env[key] ??= value;
    }
  }
}

function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name] || null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const slugArg = args.find((arg) => arg.startsWith("--slug="));
  const slug = slugArg?.slice("--slug=".length) || optionalEnv("RELAY_DEFAULT_ACCOUNT_SLUG") || "relay-nw";

  return { apply, slug };
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return JSON.stringify(error, null, 2);
}

async function getHouseAccount(supabase, slug) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(`House account "${slug}" was not found.`);
  }

  return data;
}

async function getNullAccountRows(supabase, table) {
  const { error: countError, count } = await supabase
    .from(table)
    .select("account_id", { count: "exact", head: true })
    .is("account_id", null);

  if (countError) throw countError;

  const sampleQueries = [
    () => supabase
      .from(table)
      .select("id, created_at")
      .is("account_id", null)
      .order("created_at", { ascending: false })
      .limit(5),
    () => supabase
      .from(table)
      .select("created_at")
      .is("account_id", null)
      .order("created_at", { ascending: false })
      .limit(5),
    () => supabase
      .from(table)
      .select("account_id")
      .is("account_id", null)
      .limit(5),
  ];

  for (const query of sampleQueries) {
    const { data, error } = await query();
    if (!error) {
      return {
        count: count ?? 0,
        samples: data ?? [],
      };
    }

    if (error.code !== "42703") {
      throw error;
    }
  }

  return {
    count: count ?? 0,
    samples: [],
  };
}

async function backfillTable(supabase, table, accountId) {
  const { error, count } = await supabase
    .from(table)
    .update({ account_id: accountId }, { count: "exact" })
    .is("account_id", null);

  if (error) throw error;
  return count ?? 0;
}

async function main() {
  await loadLocalEnv();

  const { apply, slug } = parseArgs();
  const supabaseUrl = optionalEnv("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const supabase = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const houseAccount = await getHouseAccount(supabase, slug);
  const mode = apply ? "APPLY" : "DRY RUN";

  console.log(`Relay NW account_id backfill (${mode})`);
  console.log(`House account: ${houseAccount.slug} (${houseAccount.id})`);
  console.log("");

  let totalNullRows = 0;
  for (const table of BACKFILL_TABLES) {
    const result = await getNullAccountRows(supabase, table);
    totalNullRows += result.count;

    console.log(`${table}: ${result.count} row${result.count === 1 ? "" : "s"} with NULL account_id`);
    for (const [index, sample] of result.samples.entries()) {
      const id = sample.id ? `id=${sample.id}` : `sample=${index + 1}`;
      const createdAt = sample.created_at ? ` created_at=${sample.created_at}` : "";
      console.log(`  ${id}${createdAt}`);
    }

    if (apply && result.count > 0) {
      const updated = await backfillTable(supabase, table, houseAccount.id);
      console.log(`  updated ${updated} row${updated === 1 ? "" : "s"} to ${houseAccount.slug}`);
    }
  }

  console.log("");
  console.log("Intentional NULL account_id exceptions:");
  for (const exception of NULL_ALLOWED_TABLES) {
    const result = await getNullAccountRows(supabase, exception.table);
    console.log(`${exception.table}: ${result.count} NULL row${result.count === 1 ? "" : "s"} allowed`);
    console.log(`  ${exception.reason}`);
  }

  console.log("");
  if (apply) {
    console.log("Backfill apply complete. Re-run without --apply to confirm zero blocking NULL rows.");
  } else if (totalNullRows > 0) {
    console.log(`Dry run found ${totalNullRows} blocking NULL account_id row${totalNullRows === 1 ? "" : "s"}.`);
    console.log(`Run npm run backfill:account-ids -- --slug=${slug} --apply after the WS1 code deploy.`);
  } else {
    console.log("Dry run found no blocking NULL account_id rows.");
  }
}

main().catch((error) => {
  console.error(`Backfill failed: ${formatError(error)}`);
  process.exit(1);
});
