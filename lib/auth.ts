import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";
import { getAccountConfigByAccountId, supabaseAdmin, type AccountRuntimeConfig } from "@/lib/supabase";

export type AccountRole = "owner" | "admin" | "viewer";

export type AccountUserSession = {
  userId: string;
  email: string | null;
  accountId: string;
  role: AccountRole;
  account: AccountRuntimeConfig;
};

type AccountUserRow = {
  id: string;
  account_id: string;
  user_id: string | null;
  email: string | null;
  role: AccountRole;
};

export async function createSupabaseAuthServerClient() {
  const cookieStore = await cookies();

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components can read but not mutate cookies. Route handlers can mutate them.
        }
      },
    },
  });
}

async function findAccountUser(userId: string, email: string | null) {
  const byUserId = await supabaseAdmin
    .from("account_users")
    .select("id, account_id, user_id, email, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (byUserId.error) {
    if (byUserId.error.message.includes("user_id")) {
      console.warn("account_users.user_id is missing. Run supabase.sql before enabling Supabase Auth.");
    } else {
      throw byUserId.error;
    }
  }

  if (byUserId.data) {
    return byUserId.data as AccountUserRow;
  }

  if (!email) {
    return null;
  }

  // ilike treats % and _ as wildcards, and _ is legal in email addresses. Escape both so
  // a login email like j_doe@x.com can only match itself, never another tenant's
  // jadoe@x.com row. The lookup stays case-insensitive.
  const escapedEmail = email.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

  const byEmail = await supabaseAdmin
    .from("account_users")
    .select("id, account_id, user_id, email, role")
    .ilike("email", escapedEmail)
    .maybeSingle();

  if (byEmail.error) {
    throw byEmail.error;
  }

  const row = byEmail.data as AccountUserRow | null;

  if (row && !row.user_id) {
    const { error } = await supabaseAdmin
      .from("account_users")
      .update({ user_id: userId })
      .eq("id", row.id);

    if (error) {
      throw error;
    }
  }

  return row;
}

export async function getAccountUserSessionForUser(user: { id: string; email?: string | null }) {
  const email = user.email ?? null;
  const accountUser = await findAccountUser(user.id, email);

  if (!accountUser) {
    return null;
  }

  const account = await getAccountConfigByAccountId(accountUser.account_id);

  if (!account?.accountId) {
    return null;
  }

  return {
    userId: user.id,
    email,
    accountId: account.accountId,
    role: accountUser.role,
    account,
  } satisfies AccountUserSession;
}

export async function getAccountUserSession() {
  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return null;
  }

  return getAccountUserSessionForUser(data.user);
}

export async function requireAccountUser() {
  const session = await getAccountUserSession();

  if (!session) {
    redirect("/login");
  }

  return session;
}

export async function requireAccountUserJson() {
  const session = await getAccountUserSession();

  if (!session) {
    return {
      session: null,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { session, response: null };
}

/**
 * Auth guard for JSON API routes that mutate account data or trigger real
 * side effects (SMS sends, calls, AI transcription). Viewers are read-only:
 * they pass requireAccountUserJson but are rejected here with a 403.
 */
export async function requireWriteAccessJson(viewerMessage = "Viewers have read-only access") {
  const auth = await requireAccountUserJson();

  if (auth.response) {
    return auth;
  }

  if (auth.session.role === "viewer") {
    return {
      session: null,
      response: Response.json({ error: viewerMessage }, { status: 403 }),
    };
  }

  return auth;
}
