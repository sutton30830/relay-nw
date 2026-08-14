export default function PrivacyPage() {
  return (
    <main className="legal-view">
      <article className="legal-card">
        <p className="t-eyebrow">Relay NW</p>
        <h1>Privacy Policy</h1>
        <p>
          Effective August 14, 2026. Relay NW is a service operated by Lowry Works LLC.
          In this policy, “Relay NW,” “we,” “us,” and “our” refer to Lowry Works LLC
          and the Relay NW service.
        </p>

        <section>
          <h2>Overview</h2>
          <p>
            Relay NW helps participating businesses recover missed calls. We use caller
            information only to route the request, notify the business, and keep a record of
            the conversation for that business.
          </p>
        </section>

        <section>
          <h2>Information We Collect</h2>
          <p>We may collect:</p>
          <ul>
            <li>phone number</li>
            <li>message content</li>
            <li>voicemail recordings, transcripts, and short summaries when a voicemail is left</li>
            <li>call or message metadata such as time of contact and delivery details</li>
          </ul>
        </section>

        <section>
          <h2>How We Use Information</h2>
          <p>We use information to:</p>
          <ul>
            <li>respond to customer inquiries</li>
            <li>send SMS follow-up messages related to customer inquiries</li>
            <li>route, organize, or prioritize customer requests</li>
            <li>record, transcribe, and summarize voicemails so the business can call back quickly</li>
            <li>maintain records of customer communications</li>
          </ul>
        </section>

        <section>
          <h2>Voicemail and AI Processing</h2>
          <p>
            If a caller leaves a voicemail, Relay NW may store the recording and use service
            providers such as Twilio and OpenAI to transcribe and summarize it for the business.
            These summaries are used to help the business understand and respond to the caller's
            request. Relay NW does not use voicemail recordings, transcripts, or summaries for
            advertising.
          </p>
        </section>

        <section>
          <h2>SMS Messaging</h2>
          <p>
            By calling or submitting a contact form to Relay NW, you consent to receive a one-time
            text message regarding your inquiry. Message frequency varies; additional messages will
            only be sent in response to your replies. Message and data rates may apply. To opt out,
            reply STOP at any time. To receive help, reply HELP. Relay NW does not sell or share
            mobile numbers or opt-in consent with third parties for marketing or promotional
            purposes.
          </p>
        </section>

        <section>
          <h2>Retention</h2>
          <p>
            Operational webhook logs and inbound SMS bodies are pruned on the configured daily
            schedule. Relay NW removes sanitized webhook diagnostics after 30 days by default and
            removes inbound SMS bodies from Relay's message stores after 90 days by default. The retention periods for leads, call
            metadata, voicemail recordings, transcripts, summaries, and audit events have not yet
            been set. Those records remain until an authorized account deletion or another
            documented policy applies.
          </p>
          <p>
            A business may ask Relay NW to delete or export account records. An authorized Relay
            operator can export an account and can delete a closed account.
            Account deletion removes the account's Relay database records, stored greeting files,
            and linked Twilio recordings and message resources. If a provider deletion fails,
            Relay keeps the account records so the deletion can be retried. Relay keeps a limited
            deletion record containing the account identifier, actor, time, result, failure
            category, and record counts; it does not include deleted message or transcript content.
          </p>
        </section>

        <section>
          <h2>Data Sharing</h2>
          <ul>
            <li>We do not sell personal information</li>
            <li>
              We do not share mobile opt-in data or consent with third parties for marketing or
              promotional purposes
            </li>
            <li>
              We do not share personal information with third parties for their marketing purposes
            </li>
          </ul>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Lowry Works LLC<br />
            <a href="mailto:relaynw@gmail.com">relaynw@gmail.com</a>
          </p>
        </section>
      </article>
    </main>
  );
}
