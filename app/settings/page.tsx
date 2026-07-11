import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
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
    <label className="form-field">
      <span className="t-eyebrow form-field__label">{label}</span>
      {children}
      {hint ? <span className="form-field__hint">{hint}</span> : null}
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
      <section className="leads-shell settings-shell">
        <AppHeader businessName={account.businessName} currentPage="settings" />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Settings</p>
            <h1 className="t-display">{account.businessName}</h1>
            <p className="leads-subtitle">
              {readOnly ? "View-only access" : "Changes apply to the next call that comes in."}
            </p>
          </div>
        </div>

        {params.saved ? (
          <div className="panel settings-notice settings-notice--ok" role="status">
            <Icon name="check" size={14} /> Settings saved.
          </div>
        ) : null}
        {params.error ? (
          <div className="intake-error settings-notice" role="alert">
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

        <section className="panel settings-section">
          <p className="t-eyebrow settings-section__title">Your Relay line</p>
          <p className="settings-section__lead">
            Relay number: <strong>{account.twilioPhoneNumber}</strong> · Mode: {account.callMode}
          </p>
          <p className="settings-section__meta">
            Carrier registration: {A2P_LABELS[a2pStatus ?? ""] ?? "Unknown"}
          </p>
        </section>

        <form className="panel settings-form" action="/api/settings" method="POST">
          <fieldset disabled={readOnly} className="settings-fieldset">
            <p className="t-eyebrow settings-group-title settings-group-title--first">Business</p>
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

            <p className="t-eyebrow settings-group-title">Messaging</p>
            {role === "owner" ? (
              <Field
                label="Automatic texting"
                hint="Master switch. Off = no texts to customers or to you. Only enable after carrier registration is approved."
              >
                <span className="settings-toggle">
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

            <p className="t-eyebrow settings-group-title">Voice</p>
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
              <button className="btn btn-primary settings-submit" type="submit">
                Save settings
              </button>
            ) : null}
          </fieldset>
        </form>
      </section>
    </main>
  );
}
