import { AppHeader } from "@/app/leads/_components/app-header";

export function OpsHeader({
  businessName,
  operatorEmail,
}: {
  businessName?: string;
  operatorEmail: string | null;
}) {
  return <AppHeader businessName={businessName ?? "Operations"} currentPage="operations" variant="operations" />;
}
