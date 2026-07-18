import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { updateSetupRequestStatus, type SetupRequestStatus } from "@/lib/supabase";

const VALID_STATUSES = new Set<SetupRequestStatus>(["new", "contacted", "onboarded", "closed"]);

function readString(formData: FormData, key: string, maxLength = 120) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

export async function POST(request: Request) {
  await requirePlatformOperator();

  const formData = await request.formData();
  const id = readString(formData, "id", 80);
  const status = readString(formData, "status", 30) as SetupRequestStatus;

  if (!id || !VALID_STATUSES.has(status)) {
    redirect("/ops/setup-requests?error=invalid");
  }

  try {
    await updateSetupRequestStatus(id, status);
  } catch (error) {
    console.error("Setup request status update failed", {
      id,
      status,
      error: error instanceof Error ? error.message : error,
    });
    redirect("/ops/setup-requests?error=save_failed");
  }

  redirect(`/ops/setup-requests?status=${status}`);
}
