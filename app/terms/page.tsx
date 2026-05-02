export default function TermsPage() {
  return (
    <main className="legal-view">
      <article className="legal-card">
        <p className="t-eyebrow">Relay NW</p>
        <h1>Terms and Conditions</h1>

        <section>
          <h2>Service Description</h2>
          <p>
            Relay NW provides missed-call response and SMS follow-up tools for local service
            businesses.
          </p>
        </section>

        <section>
          <h2>SMS Terms</h2>
          <p>
            By contacting a business that uses Relay NW, users may receive SMS messages related
            to their inquiry.
          </p>
          <p>
            Relay NW messages are sent only in response to a customer-initiated call or inquiry.
          </p>
          <ul>
            <li>Message frequency varies</li>
            <li>Message and data rates may apply</li>
            <li>Reply STOP to opt out at any time</li>
            <li>Reply HELP for help</li>
          </ul>
        </section>

        <section>
          <h2>No Guarantee</h2>
          <p>
            Relay NW helps businesses respond to missed calls but does not guarantee that every
            message will be delivered, received, or responded to.
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
