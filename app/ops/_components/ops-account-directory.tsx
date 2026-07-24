import Link from "next/link";
import type { ReactNode } from "react";
import type { SetupRequest } from "@/lib/supabase";
import type { OpsAccountSummary } from "@/lib/supabase";
import {
  deriveOpsState,
  type OpsDerivedState,
  type OpsQueueGroup,
} from "@/lib/ops-state";

const QUEUE_GROUPS: Array<{ key: OpsQueueGroup; label: string; description: string }> = [
  { key: "needs_attention", label: "Needs attention", description: "Resolve an owner, carrier, Stripe, or technical issue." },
  { key: "onboarding", label: "Onboarding", description: "Finish the next concrete setup step." },
  { key: "running", label: "Running", description: "Service is working; keep an eye on the normal operating signal." },
  { key: "paused", label: "Paused or closed", description: "Secondary accounts with an explicit call hold or closed setup." },
];

type DerivedAccount = {
  account: OpsAccountSummary;
  state: OpsDerivedState;
};

function deriveAccountState(account: OpsAccountSummary) {
  return deriveOpsState({
    technicalStatus: account.technicalStatus,
    a2pStatus: account.a2pStatus,
    smsEnabled: account.smsEnabled,
    billingStatus: account.billingStatus,
    billingPolicy: account.billingPolicy,
    stripeSubscriptionStatus: account.stripeSubscriptionStatus,
    setupFeeStatus: account.setupFeeStatus,
    stripeDefaultPaymentMethodId: account.stripeDefaultPaymentMethodId,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    blockedBy: account.opsBlockedBy,
    blockerNote: account.opsBlockerNote,
    blockedSince: account.opsBlockedSince,
  });
}

function matchesAccount(account: OpsAccountSummary, query: string) {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return [
    account.businessName,
    account.ownerName,
    account.ownerEmail,
    account.accountSlug,
    account.relayNumber,
    account.publicBusinessNumber,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

function matchesRequest(request: SetupRequest, query: string) {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return [
    request.business_name,
    request.name,
    request.owner_name,
    request.owner_email,
    request.phone,
    request.public_business_number,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

function blockedAge(state: OpsDerivedState) {
  if (state.blockedBy === "none") return "None";
  if (state.blockedAgeDays === null) return state.labels.blocker;
  return `${state.labels.blocker} · ${state.blockedAgeDays}d`;
}

function ownerLabel(account: OpsAccountSummary) {
  if (account.ownerName && account.ownerEmail) return `${account.ownerName} · ${account.ownerEmail}`;
  return account.ownerName ?? account.ownerEmail ?? "Owner not set";
}

function CustomerQueueCard({ account, state }: DerivedAccount) {
  return (
    <article className={`panel ops-queue-card ops-queue-card--${state.queueGroup}`}>
      <div className="ops-queue-card__head">
        <div>
          <h3>{account.businessName}</h3>
          <p>{ownerLabel(account)}</p>
        </div>
      </div>

      <dl className="ops-queue-card__facts" aria-label={`${account.businessName} status`}>
        <div><dt>Calls</dt><dd>{state.labels.calls}</dd></div>
        <div><dt>Texting</dt><dd>{state.labels.texting}</dd></div>
        <div><dt>Billing</dt><dd>{state.labels.billing}</dd></div>
        <div><dt>Blocked by</dt><dd>{blockedAge(state)}</dd></div>
      </dl>

      <div className="ops-queue-card__action">
        <span className="t-eyebrow">Next action</span>
        <strong>{state.nextAction.label}</strong>
        <p>{state.nextAction.detail}</p>
      </div>

      <Link className="btn btn-secondary btn-sm" href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}>
        Open account
      </Link>
    </article>
  );
}

function NewSetupRequestCard({ request, canAccept }: { request: SetupRequest; canAccept: boolean }) {
  const businessName = request.business_name ?? request.name ?? "New business";
  const owner = request.owner_name || request.owner_email
    ? [request.owner_name, request.owner_email].filter(Boolean).join(" · ")
    : "Owner details need completion";

  return (
    <article className="panel ops-new-request" id={`request-${request.id}`}>
      <div>
        <p className="t-eyebrow">New setup request</p>
        <h3>{businessName}</h3>
        <p>{owner}</p>
      </div>
      <div className="ops-new-request__action">
        <p>Confirm the request and create the customer workspace. No number or monthly billing begins here.</p>
        <form action="/api/ops/setup-requests" method="post">
          <input type="hidden" name="id" value={request.id} />
          <input type="hidden" name="action" value="accept" />
          <input type="hidden" name="owner_email" value={request.owner_email ?? ""} />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!canAccept || !request.owner_email}>
            Accept and invite
          </button>
        </form>
      </div>
    </article>
  );
}

function SearchForm({ query, action, placeholder }: { query: string; action: string; placeholder: string }) {
  return (
    <form className="lead-controls ops-account-search" action={action}>
      <input
        className="field"
        name="q"
        defaultValue={query}
        placeholder={placeholder}
        aria-label="Search accounts"
      />
      <button className="btn btn-primary" type="submit">Search</button>
    </form>
  );
}

function QueueSection({ group, rows, children, extraCount = 0 }: {
  group: (typeof QUEUE_GROUPS)[number];
  rows: DerivedAccount[];
  children?: ReactNode;
  extraCount?: number;
}) {
  const content = (
    <div className="ops-queue-section__body">
      {children}
      {rows.length > 0 ? (
        <div className="ops-queue-grid">
          {rows.map(({ account, state }) => <CustomerQueueCard key={account.accountId} account={account} state={state} />)}
        </div>
      ) : children ? null : <p className="ops-queue-empty">Nothing is in this group.</p>}
    </div>
  );

  if (group.key === "paused") {
    return (
      <details className="ops-queue-section ops-queue-section--secondary">
        <summary>
          <span><strong>{group.label}</strong><small>{group.description}</small></span>
          <span className="filter-pill__count">{rows.length}</span>
        </summary>
        {content}
      </details>
    );
  }

  return (
    <section id={group.key === "onboarding" ? "new-requests" : undefined} className={`ops-queue-section ops-queue-section--${group.key}`}>
      <header>
        <div><h2>{group.label}</h2><p>{group.description}</p></div>
        <span className="filter-pill__count">{rows.length + extraCount}</span>
      </header>
      {content}
    </section>
  );
}

function requestResultMessage(result: string | undefined) {
  if (!result) return null;
  if (result === "invite_sent") return "Customer invitation sent.";
  if (result === "created_invite_failed") return "Account created, but the invitation email failed. Open the account to resend it.";
  if (result === "email_required") return "A valid owner email is needed before accepting this request.";
  if (result === "already_onboarded") return "That request already has a customer workspace.";
  return "The setup request was not completed. Please try again.";
}

export function OpsWorkQueue({
  accounts,
  requests,
  query,
  canAcceptRequests,
  requestResult,
}: {
  accounts: OpsAccountSummary[];
  requests: SetupRequest[];
  query: string;
  canAcceptRequests: boolean;
  requestResult?: string;
}) {
  const normalizedQuery = query.trim();
  const rows = accounts
    .filter((account) => matchesAccount(account, normalizedQuery))
    .map((account) => ({ account, state: deriveAccountState(account) }));
  const visibleRequests = requests.filter((request) => matchesRequest(request, normalizedQuery));
  const resultMessage = requestResultMessage(requestResult);

  return (
    <>
      <SearchForm query={query} action="/ops" placeholder="Search business, owner, email, account slug, or phone" />
      {resultMessage ? <div className="settings-notice" role="status">{resultMessage}</div> : null}
      <div className="ops-work-queue">
        {QUEUE_GROUPS.map((group) => {
          const groupRows = rows.filter(({ state }) => state.queueGroup === group.key);
          const requestCards = group.key === "onboarding" && visibleRequests.length > 0 ? (
            <div className="ops-new-request-list">
              {visibleRequests.map((request) => <NewSetupRequestCard key={request.id} request={request} canAccept={canAcceptRequests} />)}
            </div>
          ) : undefined;
          return <QueueSection key={group.key} group={group} rows={groupRows} extraCount={group.key === "onboarding" ? visibleRequests.length : 0}>{requestCards}</QueueSection>;
        })}
      </div>
    </>
  );
}

export function OpsAccountDirectory({ accounts, query }: { accounts: OpsAccountSummary[]; query: string }) {
  const rows = accounts.filter((account) => matchesAccount(account, query.trim()));

  return (
    <>
      <SearchForm query={query} action="/ops/accounts" placeholder="Search business, owner, email, account slug, or phone" />
      <p className="ops-directory-hint">A searchable account directory. Queue priority and next actions live in Work queue.</p>
      <div className="ops-directory-list">
        {rows.length === 0 ? <p className="ops-queue-empty">No accounts match that search.</p> : rows.map((account) => (
          <article className="panel ops-directory-row" key={account.accountId}>
            <div><strong>{account.businessName}</strong><small>{ownerLabel(account)}</small></div>
            <span>{account.accountSlug}</span>
            <Link className="btn btn-secondary btn-sm" href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}>Open account</Link>
          </article>
        ))}
      </div>
    </>
  );
}
