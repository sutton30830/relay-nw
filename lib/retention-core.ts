export type ProviderResourceKind = "recording" | "message";

export type TenantProviderResource = {
  accountId: string;
  sid: string;
  kind: ProviderResourceKind;
};

export type AccountDeletionTarget = {
  accountId: string;
  accountStatus: string;
  technicalStatus: string;
};

export type AccountDeletionPreview = {
  recordings: number;
  messages: number;
  greetingFiles: number;
  databaseRows: Record<string, number>;
};

export type AccountDeletionResult = {
  status: "dry_run" | "deleted" | "already_deleted" | "partial_failure";
  accountId: string;
  preview: AccountDeletionPreview;
  providerFailures: Array<{ kind: ProviderResourceKind | "greeting" | "database"; identifier: string }>;
};

export type AccountDeletionDependencies = {
  loadTarget(accountId: string): Promise<AccountDeletionTarget | null>;
  wasDeletionCompleted(accountId: string): Promise<boolean>;
  preview(accountId: string): Promise<AccountDeletionPreview>;
  listProviderResources(accountId: string): Promise<TenantProviderResource[]>;
  deleteProviderResource(resource: TenantProviderResource): Promise<"deleted" | "not_found">;
  deleteGreetingFiles(accountId: string): Promise<{ deleted: number; failed: string[] }>;
  deleteDatabaseAccount(input: {
    accountId: string;
    actorUserId: string;
    actorEmail: string | null;
  }): Promise<Record<string, number>>;
  recordAction(input: {
    accountId: string;
    actorUserId: string;
    actorEmail: string | null;
    action: string;
    status: "failed" | "completed";
    counts: Record<string, number>;
    failureKinds?: string[];
  }): Promise<void>;
};

function requireAccountId(accountId: string) {
  const value = accountId.trim();
  if (!value) throw new Error("Account deletion requires an account id.");
  return value;
}

function emptyPreview(): AccountDeletionPreview {
  return { recordings: 0, messages: 0, greetingFiles: 0, databaseRows: {} };
}

export async function runAccountDeletion(input: {
  accountId: string;
  actorUserId: string;
  actorEmail: string | null;
  dryRun: boolean;
  dependencies: AccountDeletionDependencies;
}): Promise<AccountDeletionResult> {
  const accountId = requireAccountId(input.accountId);
  const target = await input.dependencies.loadTarget(accountId);

  if (!target) {
    if (await input.dependencies.wasDeletionCompleted(accountId)) {
      return {
        status: "already_deleted",
        accountId,
        preview: emptyPreview(),
        providerFailures: [],
      };
    }
    throw new Error("Account not found.");
  }

  if (target.accountId !== accountId) {
    throw new Error("Account deletion target crossed a tenant boundary.");
  }

  const preview = await input.dependencies.preview(accountId);
  if (input.dryRun) {
    return { status: "dry_run", accountId, preview, providerFailures: [] };
  }

  if (target.accountStatus !== "archived" || target.technicalStatus !== "closed") {
    throw new Error("Account must be archived and technically closed before deletion.");
  }

  const resources = await input.dependencies.listProviderResources(accountId);
  if (resources.some((resource) => resource.accountId !== accountId)) {
    throw new Error("Provider deletion candidates crossed a tenant boundary.");
  }

  const providerFailures: AccountDeletionResult["providerFailures"] = [];
  for (const resource of resources) {
    try {
      await input.dependencies.deleteProviderResource(resource);
    } catch {
      providerFailures.push({ kind: resource.kind, identifier: resource.sid });
    }
  }

  try {
    const greetingResult = await input.dependencies.deleteGreetingFiles(accountId);
    providerFailures.push(
      ...greetingResult.failed.map((identifier) => ({ kind: "greeting" as const, identifier })),
    );
  } catch {
    providerFailures.push({ kind: "greeting", identifier: `${accountId}/` });
  }

  if (providerFailures.length > 0) {
    await input.dependencies.recordAction({
      accountId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: "account.delete",
      status: "failed",
      counts: {
        recordings: preview.recordings,
        messages: preview.messages,
        greetingFiles: preview.greetingFiles,
      },
      failureKinds: [...new Set(providerFailures.map((failure) => failure.kind))],
    });
    return { status: "partial_failure", accountId, preview, providerFailures };
  }

  let counts: Record<string, number>;
  try {
    counts = await input.dependencies.deleteDatabaseAccount({
      accountId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
    });
  } catch {
    await input.dependencies.recordAction({
      accountId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: "account.delete",
      status: "failed",
      counts: {
        recordings: preview.recordings,
        messages: preview.messages,
        greetingFiles: preview.greetingFiles,
      },
      failureKinds: ["database"],
    });
    return {
      status: "partial_failure",
      accountId,
      preview,
      providerFailures: [{ kind: "database", identifier: accountId }],
    };
  }

  return {
    status: "deleted",
    accountId,
    preview: { ...preview, databaseRows: counts },
    providerFailures: [],
  };
}
