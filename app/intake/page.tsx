import Link from "next/link";
import { env } from "@/lib/env";

type SearchParams = Promise<{
  saved?: string;
  error?: string;
}>;

export default async function IntakePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const saved = params.saved === "1";
  const error = params.error === "1";

  return (
    <main className="shell">
      <section className="mx-auto max-w-5xl">
        <nav className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-5">
          <div>
            <Link href="/" className="eyebrow">
              Relay NW
            </Link>
            <p className="mt-1 text-sm text-[var(--muted)]">{env.businessName}</p>
          </div>
          <a href={env.schedulingUrl} className="button-secondary text-sm">
            Book online instead
          </a>
        </nav>

        <div className="grid gap-6 py-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <aside className="space-y-5">
            <div className="panel overflow-hidden">
              <div className="bg-[var(--brand)] p-6 text-white">
                <p className="text-sm font-semibold uppercase tracking-[0.12em] opacity-85">
                  Request help
                </p>
                <h1 className="mt-3 text-3xl font-semibold leading-tight">
                  Tell us what you need and we&apos;ll follow up.
                </h1>
              </div>
              <div className="space-y-4 p-6 text-[var(--muted)]">
                <p className="leading-7">
                  Use this form if we missed your call or if you prefer to send a quick note first.
                </p>
                <div className="rounded-md border border-[var(--line)] bg-white p-4">
                  <p className="font-semibold text-[var(--foreground)]">What happens next</p>
                  <ol className="mt-3 space-y-2 text-sm leading-6">
                    <li>1. Your request is saved securely.</li>
                    <li>2. The owner reviews the details.</li>
                    <li>3. You get a call or text back with next steps.</li>
                  </ol>
                </div>
              </div>
            </div>

            <div className="panel p-5">
              <p className="text-sm font-semibold text-[var(--muted)]">Prefer a time slot?</p>
              <a href={env.schedulingUrl} className="button-secondary mt-3 w-full">
                Open scheduling link
              </a>
            </div>
          </aside>

          <div className="panel overflow-hidden">
            <div className="border-b border-[var(--line)] bg-[#f1eee7] p-6 sm:p-8">
              <p className="eyebrow">{env.businessName}</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight">Service request</h2>
              <p className="mt-3 max-w-2xl leading-7 text-[var(--muted)]">
                A few details are enough. Keep it brief, and include anything that will help us
                understand the job.
              </p>
            </div>

            <div className="p-6 sm:p-8">
              {saved ? (
                <div className="mb-6 rounded-md border border-green-700 bg-green-50 p-4 text-green-900">
                  Thanks. Your request was received.
                </div>
              ) : null}

              {error ? (
                <div className="mb-6 rounded-md border border-red-700 bg-red-50 p-4 text-red-900">
                  Something went wrong. Please check the form and try again.
                </div>
              ) : null}

              <form action="/api/intake" method="POST" className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block font-semibold">Your name</span>
                    <input
                      className="field"
                      name="name"
                      autoComplete="name"
                      placeholder="Jane Smith"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block font-semibold">Best phone number</span>
                    <input
                      className="field"
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      placeholder="(206) 555-0123"
                      required
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="mb-2 block font-semibold">What can we help with?</span>
                  <textarea
                    className="field min-h-44"
                    name="message"
                    placeholder="Example: leaking outdoor faucet, no hot water, broken outlet..."
                  />
                </label>

                <label className="flex gap-3 rounded-md border border-[var(--line)] bg-white p-4 text-sm leading-6 text-[var(--muted)]">
                  <input className="mt-1 h-4 w-4 shrink-0" name="consent" type="checkbox" required />
                  <span>
                    I agree to be contacted by phone or text about this request. Message and data
                    rates may apply. Reply STOP to opt out.
                  </span>
                </label>

                <button type="submit" className="button-primary w-full">
                  Send request
                </button>
              </form>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
