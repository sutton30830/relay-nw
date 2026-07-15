import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";
import { getAccountConfigByAccountId, supabaseAdmin, type AccountRuntimeConfig } from "@/lib/supabase";

export type AccountRole = "owner" | "admin" | "viewer";
export const SELECTED_ACCOUNT_COOKIE = "relay_selected_account";

export type AccountUserSession = {
  userId: string;
  email: string | null;
  accountId: string;
  role: AccountRole;
  account: AccountRuntimeConfig;
};

export type AccountMembership = AccountUserSession & {
  membershipId: string;
};

export type AccountUserResolution =
  | { status: "unauthenticated" }
  | { status: "no_membership"; userId: string; email: string | null }
  | { status: "single_account"; session: AccountUserSession; memberships: AccountMembership[] }
  | { status: "selected_account"; session: AccountUserSession; memberships: AccountMembership[] }
  | { status: "ambiguous"; userId: string; email: string | null; memberships: AccountMembership[] }
  | { status: "invalid_selection"; userId: string; email: string | null; selectedAccount: string; memberships: AccountMembership[] };

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

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function normalizeSelectedAccount(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function readSelectedAccountCookie(cookieStore: { get?: (name: string) => { value?: string } | undefined }) {
  return normalizeSelectedAccount(cookieStore.get?.(SELECTED_ACCOUNT_COOKIE)?.value);
}

export function setSelectedAccountCookie(cookieStore: Pick<CookieStore, "set">, accountId: string) {
  cookieStore.set(SELECTED_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSelectedAccountCookie(cookieStore: Pick<CookieStore, "set">) {
  cookieStore.set(SELECTED_ACCOUNT_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

function escapeIlike(value: string) {
  // ilike treats % and _ as wildcards, and _ is legal in email addresses. Escape both so
  // a login email like j_doe@x.com can only match itself, never another tenant's
  // jadoe@x.com row. The lookup stays case-insensitive.
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function bindEmailInvitesToUser(rows: AccountUserRow[], userId: string) {
  const unclaimedRows = rows.filter((row) => !row.user_id);

  await Promise.all(
    unclaimedRows.map(async (row) => {
      const { error } = await supabaseAdmin
        .from("account_users")
        .update({ user_id: userId })
        .eq("id", row.id)
        .is("user_id", null);

      if (error) {
        throw error;
      }
    }),
  );

  return rows
    .filter((row) => !row.user_id || row.user_id === userId)
    .map((row) => ({ ...row, user_id: userId }));
}

async function findAccountUserRows(userId: string, email: string | null) {
  const byUserId = await supabaseAdmin
    .from("account_users")
    .select("id, account_id, user_id, email, role")
    .eq("user_id", userId);

  if (byUserId.error) {
    if (byUserId.error.message.includes("user_id")) {
      console.warn("account_users.user_id is missing. Run supabase.sql before enabling Supabase Auth.");
    } else {
      throw byUserId.error;
    }
  }

  const userRows = (byUserId.data ?? []) as AccountUserRow[];
  if (userRows.length > 0) {
    return userRows;
  }

  if (!email) {
    return [];
  }

  const byEmail = await supabaseAdmin
    .from("account_users")
    .select("id, account_id, user_id, email, role")
    .ilike("email", escapeIlike(email));

  if (byEmail.error) {
    throw byEmail.error;
  }

  const emailRows = (byEmail.data ?? []) as AccountUserRow[];
  return bindEmailInvitesToUser(emailRows, userId);
}

export async function getAccountMembershipsForUser(user: { id: string; email?: string | null }) {
  const email = user.email ?? null;
  const rows = await findAccountUserRows(user.id, email);
  const memberships: AccountMembership[] = [];

  for (const row of rows) {
    const account = await getAccountConfigByAccountId(row.account_id);
    if (!account?.accountId) {
      continue;
    }

    memberships.push({
      userId: user.id,
      email,
      accountId: account.accountId,
      role: row.role,
      account,
      membershipId: row.id,
    });
  }

  return memberships;
}

export async function resolveAccountUserSessionForUser(
  user: { id: string; email?: string | null } | null | undefined,
  selectedAccount?: string | null,
): Promise<AccountUserResolution> {
  if (!user) {
    return { status: "unauthenticated" };
  }

  const email = user.email ?? null;
  const memberships = await getAccountMembershipsForUser(user);

  if (memberships.length === 0) {
    return { status: "no_membership", userId: user.id, email };
  }

  const normalizedSelection = normalizeSelectedAccount(selectedAccount);

  if (normalizedSelection) {
    const selected = memberships.find(
      (membership) =>
        membership.accountId === normalizedSelection ||
        membership.account.accountSlug === normalizedSelection,
    );

    if (!selected) {
      return {
        status: "invalid_selection",
        userId: user.id,
        email,
        selectedAccount: normalizedSelection,
        memberships,
      };
    }

    return { status: "selected_account", session: selected, memberships };
  }

  if (memberships.length === 1) {
    return { status: "single_account", session: memberships[0], memberships };
  }

  return { status: "ambiguous", userId: user.id, email, memberships };
}

export async function getAccountUserResolution() {
  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return { status: "unauthenticated" } satisfies AccountUserResolution;
  }

  const cookieStore = await cookies();
  return resolveAccountUserSessionForUser(data.user, readSelectedAccountCookie(cookieStore));
}

export async function getAccountUserSessionForUser(
  user: { id: string; email?: string | null },
  selectedAccount?: string | null,
) {
  const resolution = await resolveAccountUserSessionForUser(user, selectedAccount);

  return resolution.status === "single_account" || resolution.status === "selected_account"
    ? resolution.session
    : null;
}

export async function getAccountUserSession() {
  const resolution = await getAccountUserResolution();

  return resolution.status === "single_account" || resolution.status === "selected_account"
    ? resolution.session
    : null;
}

export async function requireAccountUser() {
  const resolution = await getAccountUserResolution();

  if (resolution.status === "single_account" || resolution.status === "selected_account") {
    return resolution.session;
  }

  if (resolution.status === "unauthenticated") {
    redirect("/login");
  }

  if (resolution.status === "no_membership") {
    redirect("/login?error=not_invited");
  }

  redirect("/account/select");
}

export async function requireAccountUserJson() {
  const resolution = await getAccountUserResolution();

  if (resolution.status === "single_account" || resolution.status === "selected_account") {
    return { session: resolution.session, response: null };
  }

  if (resolution.status === "ambiguous") {
    return {
      session: null,
      response: Response.json({ error: "Choose an account before continuing" }, { status: 409 }),
    };
  }

  if (resolution.status === "invalid_selection") {
    const cookieStore = await cookies();
    clearSelectedAccountCookie(cookieStore);

    return {
      session: null,
      response: Response.json({ error: "Selected account is no longer available" }, { status: 403 }),
    };
  }

  if (resolution.status === "no_membership") {
    return {
      session: null,
      response: Response.json({ error: "No account access" }, { status: 403 }),
    };
  }

  if (resolution.status === "unauthenticated") {
    return {
      session: null,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return {
    session: null,
    response: Response.json({ error: "Unauthorized" }, { status: 401 }),
  };
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

export function isRelayOperator(session: AccountUserSession) {
  return (
    session.account.accountSlug === env.defaultAccountSlug &&
    (session.role === "owner" || session.role === "admin")
  );
}

export async function requireRelayOperator() {
  const session = await requireAccountUser();

  if (!isRelayOperator(session)) {
    redirect("/ops");
  }

  return session;
}

export async function requireRelayOperatorJson() {
  const auth = await requireAccountUserJson();

  if (auth.response) {
    return auth;
  }

  if (!isRelayOperator(auth.session)) {
    return {
      session: null,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return auth;
}
