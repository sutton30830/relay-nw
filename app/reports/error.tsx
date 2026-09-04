"use client";

export default function DataError({ reset }: { reset: () => void }) {
  return (
    <main className="leads-view">
      <section className="leads-shell">
        <div className="empty-state" role="alert">
          <h1>Reports is temporarily unavailable</h1>
          <p>Relay could not load this view. Please try again.</p>
          <button type="button" className="btn btn-primary" onClick={reset}>Try again</button>
        </div>
      </section>
    </main>
  );
}
