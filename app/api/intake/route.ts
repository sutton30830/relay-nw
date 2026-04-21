import { redirect } from "next/navigation";
import { createLead } from "@/lib/supabase";

export async function POST(request: Request) {
  const formData = await request.formData();
  const name = String(formData.get("name") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const message = String(formData.get("message") || "").trim();
  const consent = formData.get("consent");

  if (!phone || consent !== "on") {
    redirect("/intake?error=1");
  }

  try {
    await createLead({
      name: name || null,
      phone,
      message: message || null,
      source: "intake_form",
    });
  } catch (error) {
    console.error("Failed to save intake form lead", error);
    redirect("/intake?error=1");
  }

  redirect("/intake?saved=1");
}
