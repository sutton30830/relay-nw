import { AppHeader } from "@/app/leads/_components/app-header";

export function OpsHeader({
  businessName,
  operatorEmail,
  currentPage = "operations",
}: {
  businessName?: string;
  operatorEmail: string | null;
  currentPage?: "operations" | "customers" | "requests" | "team";
}) {
  return <AppHeader businessName={businessName ?? "Operations"} currentPage={currentPage} variant="operations" />;
}
