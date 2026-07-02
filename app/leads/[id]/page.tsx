import { notFound } from "next/navigation";
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
