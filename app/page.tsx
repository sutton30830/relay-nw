import Link from "next/link";
import { env } from "@/lib/env";
import { missedCallSmsBody } from "@/lib/twilio";
import { CopyButton } from "@/app/copy-button";

export default function HomePage() {
  const voiceWebhookUrl = `${env.appBaseUrl}/api/twilio/voice`;
  const smsWebhookUrl = `${env.appBaseUrl}/api/twilio/sms`;
  const missedCallStatuses = ["no-answer", "busy", "failed", "canceled"];

  return (
    <main className="shell">
      <section className="page">
        <nav className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <p className="eyebrow">Relay NW</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal">{env.businessName}</h1>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href="/intake" className="button-secondary">
              Intake
            </Link>
            <Link href="/leads" className="button-primary">
              Leads
            </Link>
          </div>
        </nav>

        <div className="grid gap-6 py-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <div className="panel p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <span className="status-dot" />
                <p className="font-semibold">MVP ready for Twilio connection</p>
              </div>
              <h2 className="mt-5 max-w-2xl text-4xl font-semibold leading-tight">
                Missed calls get a fast, useful text back.
              </h2>
              <p className="mt-4 max-w-2xl text-lg leading-8 text-[var(--muted)]">
                Calls to the Twilio number forward to the owner. If the call is missed, Relay NW
                sends the customer the intake form and scheduling link, then saves the lead.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <Link href="/intake" className="button-primary">
                  View intake form
                </Link>
                <Link href="/leads" className="button-secondary">
                  Open leads
                </Link>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {[
                ["Twilio number", env.twilioPhoneNumber],
                ["Ring time", `${env.dialTimeoutSeconds} seconds`],
                ["Reply handling", "forwards to owner"],
              ].map(([label, value]) => (
                <div key={label} className="panel p-4">
                  <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
                  <p className="mt-2 break-words text-lg font-semibold">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <aside className="space-y-6">
            <div className="panel p-6">
              <p className="eyebrow">Connect Twilio</p>
              <h2 className="mt-2 text-2xl font-semibold">Webhooks</h2>
              <p className="mt-3 leading-7 text-[var(--muted)]">
                In your Twilio phone number settings, paste these URLs into the matching webhook
                fields. Use method <code>POST</code>.
              </p>

              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      Voice: A call comes in
                    </p>
                    <CopyButton value={voiceWebhookUrl} />
                  </div>
                  <p className="mt-2 break-all font-mono text-sm">{voiceWebhookUrl}</p>
                </div>

                <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      Messaging: A message comes in
                    </p>
                    <CopyButton value={smsWebhookUrl} />
                  </div>
                  <p className="mt-2 break-all font-mono text-sm">{smsWebhookUrl}</p>
                </div>
              </div>

              <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
                For local testing, run <code>ngrok http 3000</code> and set{" "}
                <code>APP_BASE_URL</code> to the ngrok URL.
              </p>
            </div>

            <div className="panel p-6">
              <p className="eyebrow">Missed call rules</p>
              <ul className="mt-4 space-y-3 text-[var(--muted)]">
                {missedCallStatuses.map((status) => (
                  <li key={status} className="flex items-center justify-between gap-3">
                    <span>{status}</span>
                    <span className="sms-badge sms-badge--sent">text sent</span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>

        <div className="grid gap-6 pb-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="panel p-6">
            <p className="eyebrow">SMS preview</p>
            <p className="mt-4 rounded-md border border-[var(--line)] bg-white p-4 leading-7">
              {missedCallSmsBody()}
            </p>
          </div>

          <div className="panel p-6">
            <p className="eyebrow">Test checklist</p>
            <ol className="mt-4 grid gap-3 text-[var(--muted)] sm:grid-cols-2">
              <li>1. Run the Supabase SQL.</li>
              <li>2. Fill in <code>.env.local</code>.</li>
              <li>3. Start <code>npm run dev</code>.</li>
              <li>4. Run <code>ngrok http 3000</code>.</li>
              <li>5. Paste the webhook URLs in Twilio.</li>
              <li>6. Call the Twilio number and let it ring.</li>
            </ol>
          </div>
        </div>

        <footer className="border-t border-[var(--line)] pt-5 text-sm text-[var(--muted)]">
          Built for one business. No accounts, billing, CRM, or extra automation in v1.
        </footer>
      </section>
    </main>
  );
}
