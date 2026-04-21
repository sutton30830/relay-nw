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
      <section className="mx-auto max-w-3xl">
        <nav className="flex items-center justify-between border-b border-[var(--line)] pb-5">
          <Link href="/" className="eyebrow">
            Relay NW
          </Link>
          <a href={env.schedulingUrl} className="button-secondary text-sm">
            Book online
          </a>
        </nav>

        <div className="panel mt-8 overflow-hidden">
          <div className="border-b border-[var(--line)] bg-[#f1eee7] p-6 sm:p-8">
            <p className="eyebrow">{env.businessName}</p>
            <h1 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              Request a follow-up
            </h1>
            <p className="mt-3 max-w-2xl leading-7 text-[var(--muted)]">
              Share a few details about the job. The owner will use this to call or text you back
              with the right next step.
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
                  <span className="mb-2 block font-semibold">Name</span>
                  <input className="field" name="name" autoComplete="name" />
                </label>

                <label className="block">
                  <span className="mb-2 block font-semibold">Phone</span>
                  <input className="field" name="phone" type="tel" autoComplete="tel" required />
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block font-semibold">How can we help?</span>
                <textarea
                  className="field min-h-36"
                  name="message"
                  placeholder="Example: leaking outdoor faucet, no hot water, broken outlet..."
                />
              </label>

              <label className="flex gap-3 rounded-md border border-[var(--line)] bg-white p-4 text-sm leading-6 text-[var(--muted)]">
                <input className="mt-1 h-4 w-4" name="consent" type="checkbox" required />
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
      </section>
    </main>
  );
}
