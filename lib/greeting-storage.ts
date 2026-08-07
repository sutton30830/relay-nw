import "server-only";

import { supabaseAdmin } from "@/lib/supabase/client";
import { assertAccountId } from "@/lib/supabase/tenant";

export const GREETING_BUCKET = "account-greetings";

export async function listGreetingFiles(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "listGreetingFiles");
  const { data, error } = await supabaseAdmin.storage.from(GREETING_BUCKET).list(accountId, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    if (/not found|does not exist/i.test(error.message)) return [];
    throw error;
  }
  return (data ?? []).filter((item) => item.name && item.name !== ".emptyFolderPlaceholder")
    .map((item) => `${accountId}/${item.name}`);
}
export async function removeGreetingFiles(inputAccountId: string, keepPath?: string | null) {
  const accountId = assertAccountId(inputAccountId, "removeGreetingFiles");
  const paths = (await listGreetingFiles(accountId)).filter((path) => path !== keepPath);
  if (paths.length === 0) return { deleted: 0, failed: [] as string[] };

  const { data, error } = await supabaseAdmin.storage.from(GREETING_BUCKET).remove(paths);
  if (error) return { deleted: 0, failed: paths };
  const deleted = new Set((data ?? []).map((item) => item.name));
  return {
    deleted: deleted.size,
    failed: paths.filter((path) => !deleted.has(path) && !deleted.has(path.slice(accountId.length + 1))),
  };
}
