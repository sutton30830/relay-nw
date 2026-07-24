import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";

// Setup requests are prospects at the top of Onboarding in Work queue. Keep
// this path alive for links sent before the queue consolidation.
export default async function RetiredSetupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  await requirePlatformOperator();
  const { result } = await searchParams;
  const query = result ? `?request_result=${encodeURIComponent(result)}` : "";
  redirect(`/ops${query}#new-requests`);
}
