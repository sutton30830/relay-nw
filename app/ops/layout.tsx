import type { ReactNode } from "react";
import { requirePlatformOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  await requirePlatformOperator();
  return children;
}
