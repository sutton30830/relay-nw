# Relay NW — 80%+ Gross Margin Playbook

## The math first

For a SaaS, gross margin = (Revenue − COGS) / Revenue, where COGS is everything that costs you money to deliver the service to one customer. For Relay NW, that's Twilio, OpenAI, hosting (your share), and payment processing.

**Per-customer monthly COGS at a typical 1-truck-operator usage profile (50 missed calls/month, ~3 SMS replies per lead):**

| Cost line | Per customer / month |
|---|---|
| Twilio phone number rental | $1.15 |
| Twilio inbound call routing (50 calls × ~30s) | $0.70 |
| Voicemail recording + transcription | $0.20 |
| Outbound text-back SMS (50 × $0.008) | $0.40 |
| Two-way SMS conversation (~300 msgs × $0.008) | $2.40 |
| OpenAI summary (gpt-4o-mini) | $0.10 |
| **Variable Twilio + OpenAI subtotal** | **~$5.00** |
| Shared infra (Supabase Pro, Vercel Pro, Resend, Sentry) at 50 customers | $2.00 |
| Stripe fees (2.9% + $0.30 on $99) | $3.17 |
| **Total COGS per customer (~50 customers scale)** | **~$10.17** |

**Margin at each price point:**

| Price | COGS | Gross margin |
|---|---|---|
| $49/mo | $10 | 79% (just under target) |
| $79/mo | $10 | 87% ✓ |
| $99/mo | $10 | 90% ✓ |
| $129/mo | $10 | 92% ✓ |
| $149/mo | $10 | 93% ✓ |

**Conclusion: 80%+ is easy on paper at $79+/mo.** What kills it in practice is (a) the 10% of customers who use 5x the volume, (b) free trials that don't convert, (c) onboarding labor disguised as "support," and (d) bundling that promises unlimited usage. Positioning is how you avoid those four traps.

## The five forces that destroy margins (and how to neutralize each)

**1. Usage outliers.** The customer who gets 250 missed calls in a month from a Google Ads spend you didn't know about. Their COGS is $30, not $5. At $99/mo that's 70% margin, not 90%. Three of them in a month average drag your blended margin from 90% to 84%.

→ *Neutralize with usage tiers, not "unlimited."* Base plan includes up to ~75 missed calls / 500 SMS per month. Overage at $0.20 per missed call beyond that. Most customers stay under; the ones who don't either pay more or upgrade tiers. You don't need fancy metering — Twilio gives you usage logs you can bill against monthly.

**2. Free trials with no skin in the game.** A 14-day free trial that lets a customer pour 30 missed calls through your system costs you $5 in COGS for zero revenue. Convert at 40% and your CAC just went up by $7.50 per acquired customer.

→ *Neutralize by charging for trials.* "First 30 days for $1, then $99/mo if you keep it." Same conversion, no margin leak. Or skip the trial entirely and use a money-back guarantee ("if your first 30 days don't recover at least your subscription cost, we refund you") — costs you nothing upfront and is psychologically stronger.

**3. Onboarding labor.** If you spend 2 hours hand-onboarding a customer at a fully-loaded value of $75/hr of your time, that's $150 of cost the customer never repays you for. Over the first 6 months at $99/mo you "earn" $594 in revenue but $150 went to setup, dragging effective margin from 90% to 65% over that window.

→ *Neutralize with a setup fee + a self-serve onboarding path.* Charge $149 one-time setup for the white-glove option (where you do the Twilio config, forwarding test, and SMS template). That converts the labor from cost to revenue. Build self-serve onboarding by month 3 so new customers can skip the fee and do it themselves — most will.

**4. Support that scales with the customer count.** Five hours/month of support across 20 customers is 15 minutes/customer — fine. Five hours/month across 5 customers is an hour/customer = $75 in labor cost, erasing your margin.

→ *Neutralize by making the smallest customers most self-serve and reserving high-touch for high-ticket tiers.* Free customers get docs. $99 customers get email support with 24h SLA. $199 "Pro" customers get a monthly call with you, priority response, and custom SMS template review. The price difference covers the labor difference, and Pro customers self-select on willingness-to-pay.

**5. Feature creep into expensive APIs.** Real-time AI voice answering (Twilio + GPT-4o real-time) costs $0.20–$0.50/min. Add this casually and you've just rebuilt yourself as an AI receptionist with 50% margins, not 90%.

→ *Neutralize by being deliberate about which AI features you add and pricing them separately if their COGS scales with usage.* Voicemail transcription summary is fine — pennies per lead. Real-time AI conversation, custom voice cloning, on-call AI agent, lead scoring with GPT-4o per message — these all need separate pricing tiers or per-usage charges if you add them.

## Positioning shifts that protect margin

**1. Anchor against the expensive alternative, not the cheap one.**

Don't say "$99/mo vs. free voicemail." Say "$99/mo vs. $250/mo live answering service that emails you 30 minutes later." Your relevant comparison is AnswerNet ($250), MAP Communications ($300), Ruby Receptionists ($319+), or any of the live-human services your target customer is already paying for. By anchoring on those, you make $99 feel cheap and you justify $129 as still-cheap-and-better.

This single positioning move probably moves your sustainable price 30–50% upward, which is pure margin.

**2. Charge for outcomes you can't deliver for free.**

The two-way SMS inbox, AI summary, voicemail transcription, mobile-first design — these are all "free" to add to a customer's plan and they have near-zero marginal cost. Bundle them into the headline price. The customer perceives 5 features for $99; you spend $0.50 more in COGS to deliver them.

What you DON'T bundle: anything that scales with usage. "Unlimited calls" is a margin trap. "Up to 100 calls/month, $0.20 each after" is a margin protector.

**3. Tiered pricing with deliberate jumps.**

| Tier | Price | What's in it | Margin role |
|---|---|---|---|
| **Starter** | $79/mo | Up to 50 missed calls, basic inbox, 1 SMS template | Anchor low, attracts cheapskates, ~87% margin |
| **Pro** | $129/mo | Up to 150 missed calls, AI summary, sequences, 3 templates, calendar booking | The default — 92% margin, sweet spot |
| **Operator** | $249/mo | Up to 500 calls, multi-user, monthly call with you, priority support, custom branding | Captures higher-touch customers; the support is built into the price |

The pricing gap between Starter and Pro should be **larger than the feature gap suggests** because the goal is to push most customers to Pro. Industry rule of thumb: 70% should pick the middle tier. If too many are picking Starter, raise Starter or lower Pro until the middle becomes the obvious value.

**4. Annual prepay discount.**

Offer 2 months free for annual prepay: $129 × 10 = $1,290 paid upfront. Reduces churn (people who paid annual rarely cancel mid-year), improves cash flow, and the "2 months free" framing reads as generous without actually being expensive (you're giving 17% off in exchange for ~30% reduction in churn). Annual customers are higher-margin even at the discount because they don't churn out at month 4.

**5. Make your COGS scale slower than your revenue.**

The right COGS curve is: a fixed-ish per-customer cost (Twilio number, Stripe fees) plus a small variable component (SMS/calls). The wrong COGS curve is a big variable component that scales with usage. Your current architecture is mostly in the right shape — keep it that way. Specifically:

- Cap voicemail length at 60 seconds (limits recording + transcription cost)
- Cap two-way SMS conversation length per lead at 20 messages before flagging "this needs a phone call" (limits SMS conversation cost)
- Delete recordings older than 30 days unless the customer is on a tier with extended retention
- Use Supabase storage for archived recordings instead of Twilio (10x cheaper)
- Switch from Twilio to Telnyx or Bandwidth at scale (~30% cheaper messaging at $500+/mo spend)

**6. Avoid the high-volume customer trap.**

A customer who tells you "we get 500 calls a month" is not a great customer at a flat $99 — they're a margin killer. Either price them on the Operator tier, or kindly point them to a competitor. Your ICP — 1-truck operators getting 50–80 missed calls/month — is also your high-margin ICP. Don't drift upmarket without raising prices to match.

**7. Productize support so it doesn't drag margin.**

The biggest hidden cost in SaaS is support time. Three moves:

- Build a 5-page docs site (or use a service like GitBook/Mintlify) so 80% of common questions are answered before they reach you
- Add an in-app "what's this?" tooltip system for the inbox so confused customers self-rescue
- Record 10 short Loom videos covering the top 10 support topics, embed them in the docs

Doing this once buys back ~80% of your support time for the lifetime of the business. The remaining 20% becomes a feature of the Pro and Operator tiers.

## The pricing structure I'd actually launch with

For your first 10 customers (the friendly beta), one price: **$99/mo, 30-day money-back guarantee, no contract.** Don't tier yet — you don't have the customers to know where the right tiers are. Keep it simple, prove the value, get the testimonials.

After 10 customers and at least 3 months of usage data: introduce the **three-tier structure** ($79 / $129 / $249) with the existing customers grandfathered at $99 for life (this is a retention lever, not a giveaway — the customers who stay become advocates and are statistically rare to upgrade anyway).

After 25 customers: introduce **usage caps and overages** at each tier. By this point you have enough data to set the caps at the 80th percentile of usage (so 80% of customers never hit them, 20% pay overage).

After 50 customers: consider an **annual prepay tier** (2 months free) and start hitting up the Operator tier (which is where the 90%+ margins really live).

## The 80%+ playbook in priority order

1. **Raise your default price to $99 today.** Below $79 you can't reliably hit 80% margin at the volume profile your customers will have. The price you advertise on the landing page should be the price you charge — no discounts, no negotiations.
2. **Stop using "unlimited" anywhere in your marketing.** Replace with explicit volume caps. This is the single most important margin protection in messaging-based SaaS.
3. **Add a $149 setup fee for white-glove onboarding** until self-serve onboarding ships. Converts labor cost into revenue.
4. **Anchor your pricing against $250 live answering services** in every piece of marketing copy. Not against voicemail.
5. **Build the docs and Loom library** for the top 10 support questions. Do this in week one of having paid customers.
6. **Cap voicemail at 60 sec, cap conversation at 20 SMS per lead**, and add automatic retention policies. These are 30-minute code changes that protect margin for years.
7. **Introduce the three-tier structure** at customer #10. Make Pro the obvious value.
8. **Switch to Telnyx or Bandwidth** when monthly Twilio spend crosses $500. Real cost saving at scale.
9. **Add an Operator tier ($249)** by customer #25. This is where the highest-margin customers live and where you absorb the high-touch ones who would otherwise drag margin on lower tiers.

## What 80%+ margin doesn't fix

This playbook gets you to a healthy gross margin business. It doesn't make you profitable on its own — that requires CAC discipline, low churn, and ARPU growth. For Relay NW, the math becomes attractive at roughly:

- 50 customers × $99 avg = $4,950 MRR ≈ $59K ARR
- 85% gross margin = $50K of gross profit annually
- Subtract your own time (you're the only operator) = effectively all of it is profit since you have no salary cost

That's a small lifestyle business at 50 customers. At 200 customers and $129 avg, you're at $310K ARR, $260K gross profit. That's a real business. The path from 50 to 200 is mostly about marketing efficiency, not margin — but you only get to play that game if your unit economics are healthy from customer #1. This playbook protects that.
