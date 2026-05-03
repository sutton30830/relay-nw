export default function TermsPage() {
  return (
    <main className="legal-view">
      <article className="legal-card">
        <p className="t-eyebrow">Relay NW</p>
        <h1>Terms and Conditions</h1>

        <section>
          <h2>Service Description</h2>
          <p>
            Relay NW provides missed-call response and SMS follow-up tools for callers who contact
            Relay NW.
          </p>
        </section>

        <section>
          <h2>SMS Terms</h2>
          <p>
            When you call or submit your phone number via a form to Relay NW, we may send you a
            one-time text message acknowledging your missed call or inquiry. These messages are
            solely about the request you initiated; we do not send marketing or promotional texts.
            Message frequency varies. Message and data rates may apply. You can opt out at any time
            by replying STOP. Reply HELP for help. Relay NW does not use your phone number for
            marketing or share it with third parties for promotional purposes.
          </p>
        </section>

        <section>
          <h2>No Guarantee</h2>
          <p>
            Relay NW helps respond to missed calls but does not guarantee that every message will
            be delivered, received, or responded to.
          </p>
          <p>Relay NW is not responsible for:</p>
          <ul>
            <li>missed messages</li>
            <li>carrier delays</li>
            <li>service interruptions</li>
            <li>lost business</li>
          </ul>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            <a href="mailto:relaynw@gmail.com">relaynw@gmail.com</a>
          </p>
        </section>
      </article>
    </main>
  );
}
