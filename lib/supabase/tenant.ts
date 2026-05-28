import type { AccountRuntimeConfig } from "./accounts";

export type TenantAccountRuntimeConfig = AccountRuntimeConfig & { accountId: string };

export function assertAccountId(accountId: string | null | undefined, context: string) {
  const normalizedAccountId = accountId?.trim();

  if (!normalizedAccountId) {
    const message = `Missing account_id for tenant-scoped Supabase operation: ${context}`;
    console.error(message);
    throw new Error(message);
  }

  return normalizedAccountId;
}

export function assertTenantAccount(account: AccountRuntimeConfig, context: string): TenantAccountRuntimeConfig {
  return {
    ...account,
    accountId: assertAccountId(account.accountId, context),
  };
}
