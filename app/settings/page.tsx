import Link from "next/link";
import { Icon } from "@/components/icon";
import { requireAccountUser } from "@/lib/auth";
import { getA2pRegistrationStatus } from "@/lib/supabase";
import { QUICK_REPLIES } from "@/app/leads/_constants";

export const dynamic = "force-dynamic";

const A2P_LABELS: Record<string, string> = {
  not_started: "Not started — texting cannot be enabled yet",
  in_progress: "In carrier review — usually takes a few days",
  approved: "Approved — texting is carrier-registered",
  rejected: "Rejected — contact Relay support",
  paused: "Paused",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span className="t-eyebrow" style={{ display: "block", marginBottom: 6 }}>{label}</span>
      {children}
      {hint ? (
        <span style={{ color: "var(--ink-4)", display: "block", fontSize: 12.5, marginTop: 4 }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, role } = session;
  const params = await searchParams;
  const a2pStatus = await getA2pRegistrationStatus(session.accountId);
  const readOnly = role === "viewer";

  return (
    <main className="leads-view">
      <section className="leads-shell" style={{ maxWidth: 720 }}>
        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Settings</p>
            <h1 className="t-display">{account.businessName}</h1>
            <p className="leads-subtitle">
              {readOnly ? "View-only access" : "Changes apply to the next call that comes in."}
            </p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary" href="/setup">Setup</Link>
            <Link className="btn btn-secondary" href="/leads">Back to leads</Link>
          </div>
        </div>

        {params.saved ? (
          <div className="panel" style={{ borderColor: "var(--good, #2e7d32)", marginBottom: 20, padding: "12px 16px" }} role="status">
            <Icon name="check" size={14} /> Settings saved.
          </div>
        ) : null}
        {params.error ? (
          <div className="intake-error" style={{ marginBottom: 20 }} role="alert">
            <Icon name="alertTriangle" size={14} />
            {params.error === "forbidden"
              ? "Your role does not allow editing settings."
              : params.error === "save_failed"
                ? "Could not save settings. Try again."
                : params.error === "a2p_not_approved"
                  ? "Texting can't be enabled until this account's A2P registration is approved. Update the status with the provisioning script first."
                  : "Please check the highlighted values and try again."}
          </div>
        ) : null}

        <section className="panel" style={{ marginBottom: 20, padding: "16px 18px" }}>
          <p className="t-eyebrow" style={{ margin: "0 0 10px" }}>Your Relay line</p>
          <p style={{ margin: "0 0 4px" }}>
            Relay number: <strong>{account.twilioPhoneNumber}</strong> · Mode: {account.callMode}
          </p>
          <p style={{ color: "var(--ink-4)", fontSize: 13, margin: 0 }}>
            Carrier registration: {A2P_LABELS[a2pStatus ?? ""] ?? "Unknown"}
          </p>
        </section>

        <form className="panel" style={{ padding: "20px 18px" }} action="/api/settings" method="POST">
          <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0 }}>
            <p className="t-eyebrow" style={{ margin: "0 0 14px" }}>Business</p>
            <Field label="Business name" hint="Used in texts and voicemail greetings.">
              <input className="field" name="business_name" required maxLength={120} defaultValue={account.businessName} />
            </Field>
            <Field label="Owner phone" hint="Where calls forward and Relay alerts are texted.">
              <input className="field" name="owner_phone_number" required defaultValue={account.ownerPhoneNumber} />
            </Field>
            <Field label="Owner email" hint="Lead notifications and the weekly report.">
              <input className="field" type="email" name="owner_email" defaultValue={account.ownerEmail ?? ""} />
            </Field>
            <Field label="Scheduling link" hint="Optional. Included in texts when set (https://...).">
              <input className="field" name="scheduling_url" defaultValue={account.schedulingUrl ?? ""} />
            </Field>

            <p className="t-eyebrow" style={{ margin: "22px 0 14px" }}>Messaging</p>
            {role === "owner" ? (
              <Field
                label="Automatic texting"
                hint="Master switch. Off = no texts to customers or to you. Only enable after carrier registration is approved."
              >
                <span style={{ alignItems: "center", display: "inline-flex", gap: 8 }}>
                  <input type="checkbox" name="sms_enabled" defaultChecked={account.smsEnabled} />
                  Send automatic texts
                </span>
              </Field>
            ) : null}
            <Field
              label="Missed-call text"
              hint="Sent to callers you miss. Variables: {BUSINESS_NAME}, {INTAKE_URL}, {SCHEDULING_URL}. Leave blank for the default."
            >
              <textarea className="field" name="sms_template" rows={3} maxLength={600} defaultValue={account.smsTemplate ?? ""} placeholder="Hi, this is {BUSINESS_NAME} - sorry we missed your call..." />
            </Field>
            <Field label="Text cooldown (hours)" hint="Never auto-text the same caller twice within this window.">
              <input className="field" type="number" name="missed_call_sms_cooldown_hours" min={1} max={168} required defaultValue={account.missedCallSmsCooldownHours} />
            </Field>
            <Field
              label="Quick replies"
              hint="One per line (up to 6). These are the one-tap replies in the message composer. Leave blank for the defaults. When a scheduling link is set, a 'Send booking link' chip is added automatically."
            >
              <textarea
                className="field"
                name="quick_replies"
                rows={5}
                defaultValue={(account.quickReplyTemplates ?? QUICK_REPLIES).join("\n")}
                placeholder={QUICK_REPLIES.join("\n")}
              />
            </Field>

            <p className="t-eyebrow" style={{ margin: "22px 0 14px" }}>Voice</p>
            <Field
              label="Greeting recording URL"
              hint="Optional audio file (https://... .mp3/.wav). When set, this recording plays to callers and the text greeting below is ignored."
            >
              <input className="field" name="missed_call_greeting_audio_url" defaultValue={account.missedCallGreetingAudioUrl ?? ""} placeholder="https://www.relay-nw.com/audio/greeting.mp3" />
            </Field>
            <Field
              label="Voicemail greeting (text-to-speech)"
              hint={account.missedCallGreetingAudioUrl
                ? "Currently unused — your greeting recording above takes precedence."
                : "Spoken to callers before the beep. Leave blank for the default."}
            >
              <textarea className="field" name="missed_call_voice_message" rows={2} maxLength={600} defaultValue={account.missedCallVoiceMessage ?? ""} placeholder="Thanks for calling. Sorry we missed you..." />
            </Field>
            <Field label="Ring time before voicemail (seconds)" hint="How long your phone rings before Relay answers. 5-60.">
              <input className="field" type="number" name="dial_timeout_seconds" min={5} max={60} required defaultValue={account.dialTimeoutSeconds} />
            </Field>
            <Field label="Max voicemail length (seconds)" hint="10-300.">
              <input className="field" type="number" name="voicemail_max_seconds" min={10} max={300} required defaultValue={account.voicemailMaxSeconds} />
            </Field>

            {!readOnly ? (
              <button className="btn btn-primary" type="submit" style={{ marginTop: 8 }}>
                Save settings
              </button>
            ) : null}
          </fieldset>
        </form>
      </section>
    </main>
  );
}
