import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";

// Kept for existing bookmarks while Operations moves from separate pipelines to
// one Work queue plus a non-priority account directory.
export default async function RetiredCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePlatformOperator();
  const { q } = await searchParams;
  redirect(`/ops/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}
