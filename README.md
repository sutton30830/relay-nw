# Relay NW

Relay NW is a very small MVP for one local home services business. It forwards calls from a Twilio number to the owner, sends one automatic SMS when the call is missed, saves the lead in Supabase, and provides a simple password-protected leads page.

This version intentionally does not include user accounts, billing, CRM features, business hours, deduplication, or multi-tenant logic.

## What It Does

1. A customer calls the Twilio business number.
2. Twilio asks this app what to do with the call.
3. The app returns TwiML that forwards the call to the owner's real phone number.
4. If the owner answers, the call connects normally.
5. If the owner does not answer, is busy, fails, or the call is canceled, the app sends this SMS:

```text
Hi, this is {BUSINESS_NAME}. Sorry we missed your call. You can fill out our intake form here: {INTAKE_URL} or book here: {SCHEDULING_URL}. Reply STOP to opt out.
```

6. The app saves the missed call as a lead.
7. The public intake form also saves leads to the same table.

## Pages

- `/` public home page
- `/intake` public intake form
- `/leads` internal password-protected leads page
- `/api/twilio/voice` Twilio incoming call webhook
- `/api/twilio/dial-status` Twilio dial status webhook
- `/api/intake` intake form submission route

## Database Setup

Create a Supabase project, open the SQL editor, and run the SQL in `supabase.sql`.

The table is:

```sql
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null,
  message text,
  source text not null check (source in ('missed_call', 'intake_form')),
  status text not null default 'new' check (status in ('new')),
  created_at timestamptz not null default now()
);
```

## Environment Variables

Create a file named `.env.local` and copy the values from `.env.example`.

```bash
cp .env.example .env.local
```

Then fill in:

- `BUSINESS_NAME`: the business name shown in the missed-call text
- `INTAKE_URL`: the public URL for `/intake`
- `SCHEDULING_URL`: the business scheduling link
- `LEADS_PASSWORD`: the simple password for `/leads`
- `TWILIO_ACCOUNT_SID`: from Twilio Console
- `TWILIO_AUTH_TOKEN`: from Twilio Console
- `TWILIO_PHONE_NUMBER`: the Twilio number customers call
- `OWNER_PHONE_NUMBER`: the owner's real phone number
- `NEXT_PUBLIC_SUPABASE_URL`: from Supabase project settings
- `SUPABASE_SERVICE_ROLE_KEY`: from Supabase API settings

Use phone numbers in E.164 format, like `+12065551234`.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## What You Can Test Locally

You can test these pieces locally:

- Home page at `http://localhost:3000`
- Intake form at `http://localhost:3000/intake`
- Leads page at `http://localhost:3000/leads`
- Supabase lead saving from the intake form
- Password gate for `/leads`

## What Needs A Public Webhook URL

Twilio cannot call `localhost` directly. These need a public URL:

- Incoming call webhook: `/api/twilio/voice`
- Dial status action webhook: `/api/twilio/dial-status`

## Simplest Twilio Webhook Test During Development

The simplest local testing path is ngrok:

```bash
ngrok http 3000
```

Ngrok will give you a public HTTPS URL, like:

```text
https://abc123.ngrok-free.app
```

In Twilio Console, set your Twilio phone number's voice webhook to:

```text
https://abc123.ngrok-free.app/api/twilio/voice
```

Use `HTTP POST`.

Also update `.env.local` while testing:

```text
INTAKE_URL="https://abc123.ngrok-free.app/intake"
```

Restart `npm run dev` after changing `.env.local`.

## Twilio Setup

1. Buy or choose a Twilio phone number.
2. Go to the phone number's configuration page.
3. Under voice incoming calls, choose webhook.
4. Set the webhook URL to your public app URL plus `/api/twilio/voice`.
5. Set the method to `POST`.
6. Save.
7. Call the Twilio number from another phone.
8. Let the owner's phone ring without answering.
9. Confirm the caller receives the SMS and a new lead appears in `/leads`.

## Deployment

The simplest deployment path is Vercel:

1. Push this project to GitHub.
2. Import the GitHub repo into Vercel.
3. Add all environment variables from `.env.example` in Vercel Project Settings.
4. Deploy.
5. Set `INTAKE_URL` to your deployed intake page, like `https://your-app.vercel.app/intake`.
6. In Twilio, set the voice webhook to `https://your-app.vercel.app/api/twilio/voice`.

## Security Notes

- This app uses one password for `/leads`.
- There are no user accounts.
- The Supabase service role key is used only on the server.
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` in browser code.
- This MVP is intended for non-healthcare businesses only.
- The intake form includes consent language.
- The SMS includes opt-out language.

## Next 3 Upgrades To Consider Later

1. Add a real login system for the leads page.
2. Add business-hours rules so after-hours calls get different handling.
3. Add duplicate lead detection so repeat callers do not create too many rows.
