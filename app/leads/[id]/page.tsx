import { notFound, redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { getLeadConversation } from "@/lib/supabase";
import { ConversationView } from "./conversation-view";

export const dynamic = "force-dynamic";

export default async function LeadConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { accountId, role } = await requireAccountUser();
  const { id } = await params;

  const conversation = await getLeadConversation(accountId, id);

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
      <ConversationView
        lead={conversation.lead}
        previousLeads={conversation.previousLeads}
        inbound={conversation.inbound}
        outbound={conversation.outbound}
        readOnly={role === "viewer"}
      />
    </main>
  );
}
