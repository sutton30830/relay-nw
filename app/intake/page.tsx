import Link from "next/link";
import { env } from "@/lib/env";
import { IntakeForm } from "@/app/intake/intake-form";

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

        {saved ? (
          <div className="py-10">
            <div className="panel mx-auto max-w-xl p-8 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#e4f0e8] text-2xl font-bold text-[var(--good)]">
                ✓
              </div>
              <h1 className="mt-5 text-3xl font-semibold">Thanks, we&apos;ve got it.</h1>
              <p className="mt-3 leading-7 text-[var(--muted)]">
                The owner will call or text you back shortly. If it&apos;s urgent, you can also
                book a time directly.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <a href={env.schedulingUrl} className="button-primary">
                  Book a time
                </a>
                <Link href="/intake" className="button-secondary">
                  Submit another request
                </Link>
              </div>
            </div>
          </div>
        ) : (
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
                    Use this form if we missed your call or if you prefer to send a quick note
                    first.
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
                {error ? (
                  <div className="alert alert--error mb-6" role="alert">
                    Something went wrong. Please check the form and try again. If this keeps
                    happening, call us directly.
                  </div>
                ) : null}

                <IntakeForm />
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
