import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/app/leads/_components/app-header";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { getLeadConversation, listCustomerVisibleProviderActions } from "@/lib/supabase";
import { QUICK_REPLIES } from "../_constants";
import { ConversationView } from "./conversation-view";

export const dynamic = "force-dynamic";

export default async function LeadConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId, role, membershipCount } = session;
  const { id } = await params;

  const quickReplies = account.quickReplyTemplates?.length ? account.quickReplyTemplates : QUICK_REPLIES;

  const [conversation, providerIssues] = await Promise.all([
    getLeadConversation(accountId, id),
    listCustomerVisibleProviderActions(accountId, id),
  ]);

  if (!conversation) {
    notFound();
  }

  // One thread per customer: if a newer lead exists for this number, that lead
  // is the canonical conversation. Older ids land there too.
  const newest = conversation.previousLeads.find(
    (sibling) =>
      !sibling.deleted_at &&
      new Date(sibling.created_at).getTime() > new Date(conversation.lead.created_at).getTime(),
  );

  if (newest) {
    redirect(`/leads/${newest.id}`);
  }

  return (
    <main className="convo-page">
      <div className="convo-app-head">
        <AppHeader
          businessName={account.businessName}
          currentPage="conversation"
          showOperations={isRelayOperator(session)}
          switchAccountHref={membershipCount > 1 ? `/account/select?next=/leads/${id}` : undefined}
        />
      </div>
      <ConversationView
        lead={conversation.lead}
        previousLeads={conversation.previousLeads}
        inbound={conversation.inbound}
        outbound={conversation.outbound}
        readOnly={role === "viewer"}
        quickReplies={quickReplies}
        schedulingUrl={account.schedulingUrl}
        providerIssues={providerIssues.map((issue) => ({
          id: issue.id,
          explanation: issue.customerExplanation,
          nextAction: issue.recommendedNextAction,
        }))}
      />
    </main>
  );
}
