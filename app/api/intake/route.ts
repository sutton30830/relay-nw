import { redirect } from "next/navigation";
import { createLead } from "@/lib/supabase";

/**
 * Lightweight US phone normalization to E.164 so leads page tel:/sms: links
 * always dial correctly. Accepts any punctuation the user typed.
 * Returns null if the value can't be parsed as a plausible US number.
 */
function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return null;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const name = String(formData.get("name") || "").trim();
  const phoneRaw = String(formData.get("phone") || "").trim();
  const message = String(formData.get("message") || "").trim();
  const consent = formData.get("consent");
  const honeypot = String(formData.get("company") || "").trim();

  // Spam trap: bots tend to fill every field. Silently "succeed".
  if (honeypot) {
    redirect("/intake?saved=1");
  }

  const phone = normalizeUsPhone(phoneRaw);

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
