import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OpsAccountDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformOperator();
  const { id } = await params;
  redirect(`/ops?account=${encodeURIComponent(id)}`);
}
