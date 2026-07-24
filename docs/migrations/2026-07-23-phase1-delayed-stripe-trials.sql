-- Phase 1: Stripe-owned delayed trials and explicit commercial offers.
-- Idempotent and safe to run more than once.

alter table public.accounts
  add column if not exists commercial_offer text not null default 'standard';
alter table public.accounts
  add column if not exists billing_setup_checkout_session_id text;
alter table public.accounts
  add column if not exists stripe_setup_intent_id text;
alter table public.accounts
  add column if not exists stripe_setup_intent_status text;
alter table public.accounts
  add column if not exists stripe_default_payment_method_id text;
alter table public.accounts
  add column if not exists payment_method_updated_at timestamptz;

alter table public.accounts drop constraint if exists accounts_commercial_offer_check;
alter table public.accounts
  add constraint accounts_commercial_offer_check
  check (commercial_offer in ('standard', 'founding_pilot'));

alter table public.accounts drop constraint if exists accounts_stripe_setup_intent_status_check;
alter table public.accounts
  add constraint accounts_stripe_setup_intent_status_check
  check (
    stripe_setup_intent_status is null or
    stripe_setup_intent_status in (
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
      'processing',
      'canceled',
      'succeeded'
    )
  );

create unique index if not exists accounts_billing_setup_checkout_session_unique_idx
  on public.accounts (billing_setup_checkout_session_id)
  where billing_setup_checkout_session_id is not null;
create unique index if not exists accounts_stripe_setup_intent_unique_idx
  on public.accounts (stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;

-- Existing explicit setup-fee waivers are founding-pilot offers unless an
-- operator later returns them to the standard offer through the audited RPC.
update public.accounts
set commercial_offer = 'founding_pilot'
where billing_policy = 'setup_fee_waived'
  and setup_fee_status = 'waived'
  and commercial_offer = 'standard';

create or replace function public.set_account_commercial_offer(
  p_account_id uuid,
  p_offer text,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_offer text,
  current_offer text
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_offer text;
  v_billing_policy text;
  v_subscription_status text;
  v_setup_fee_status text;
begin
  if p_offer not in ('standard', 'founding_pilot') then
    raise exception 'Unsupported commercial offer';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A meaningful commercial-offer reason is required';
  end if;

  select
    commercial_offer,
    billing_policy,
    stripe_subscription_status,
    setup_fee_status
  into
    v_previous_offer,
    v_billing_policy,
    v_subscription_status,
    v_setup_fee_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  if v_subscription_status in (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused'
  ) then
    raise exception 'Cannot change the commercial offer while Stripe has a nonterminal subscription';
  end if;

  if p_offer = 'founding_pilot'
    and v_setup_fee_status not in ('due', 'waived')
  then
    raise exception 'Cannot turn a Stripe payment, refund, or dispute into a pilot waiver';
  end if;

  update public.accounts
  set
    commercial_offer = p_offer,
    billing_policy = case
      when v_billing_policy = 'comped' then 'comped'
      when p_offer = 'founding_pilot' then 'setup_fee_waived'
      else 'standard'
    end,
    billing_policy_updated_at = now(),
    setup_fee_status = case
      when p_offer = 'founding_pilot' then 'waived'
      when setup_fee_status = 'waived' then 'due'
      else setup_fee_status
    end,
    setup_fee_waived_at = case
      when p_offer = 'founding_pilot' then coalesce(setup_fee_waived_at, now())
      when setup_fee_status = 'waived' then null
      else setup_fee_waived_at
    end,
    setup_fee_waiver_reason = case
      when p_offer = 'founding_pilot' then trim(p_reason)
      when setup_fee_status = 'waived' then null
      else setup_fee_waiver_reason
    end
  where id = p_account_id;

  insert into public.account_audit_events (
    account_id,
    actor_user_id,
    actor_email,
    action,
    summary
  )
  values (
    p_account_id,
    p_actor_user_id,
    p_actor_email,
    case
      when p_offer = 'founding_pilot' then 'billing.offer.founding_pilot'
      else 'billing.offer.standard'
    end,
    case
      when p_offer = 'founding_pilot'
        then 'Applied founding-pilot terms: audited $150 waiver and 30-day delayed Stripe trial — ' || trim(p_reason)
      else 'Applied standard terms: $150 setup fee and 14-day delayed Stripe trial — ' || trim(p_reason)
    end
  );

  return query select v_previous_offer, p_offer;
end;
$function$;

revoke all on function public.set_account_commercial_offer(
  uuid,
  text,
  text,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.set_account_commercial_offer(
  uuid,
  text,
  text,
  uuid,
  text
) to service_role;

-- Explicit test-account repair. This preserves Stripe event history and only
-- clears the known test-mode contamination when no live-mode event was ever
-- associated with the account. It does not claim that a payment was refunded
-- or paid; it resets the sample as an audited founding pilot.
do $repair$
declare
  v_account_id uuid;
begin
  select a.id
  into v_account_id
  from public.accounts a
  where a.slug = 'cascade-plumbing-sample'
    and (
      a.stripe_subscription_id = 'sub_1TwFR5JvfzsHNkkMWA7KT6FM' or
      a.setup_fee_payment_intent_id = 'pi_3TujX0JvfzsHNkkM1ukFdPew'
    )
    and not exists (
      select 1
      from public.stripe_events e
      where e.account_id = a.id
        and e.livemode = true
    )
  for update;

  if v_account_id is not null then
    update public.accounts
    set
      commercial_offer = 'founding_pilot',
      billing_policy = 'setup_fee_waived',
      billing_policy_updated_at = now(),
      billing_status = 'not_started',
      stripe_customer_id = null,
      stripe_subscription_id = null,
      stripe_price_id = null,
      stripe_subscription_status = null,
      billing_setup_checkout_session_id = null,
      stripe_setup_intent_id = null,
      stripe_setup_intent_status = null,
      stripe_default_payment_method_id = null,
      payment_method_updated_at = null,
      trial_ends_at = null,
      current_period_end = null,
      cancel_at_period_end = false,
      activated_at = null,
      first_paid_at = null,
      guarantee_ends_at = null,
      billing_attention_since = null,
      canceled_at = null,
      setup_fee_status = 'waived',
      setup_fee_checkout_session_id = null,
      setup_fee_payment_intent_id = null,
      setup_fee_paid_at = null,
      setup_fee_waived_at = now(),
      setup_fee_waiver_reason = 'Founding-pilot reset after documented Stripe test-mode contamination.',
      setup_fee_refunded_at = null,
      setup_fee_refunded_cents = 0,
      setup_fee_dispute_status = null,
      billing_updated_at = now()
    where id = v_account_id;

    insert into public.account_audit_events (
      account_id,
      actor_user_id,
      actor_email,
      action,
      summary
    )
    values (
      v_account_id,
      null,
      'system:phase1-migration',
      'billing.test_state.reset',
      'Cleared the known test-mode Stripe links and applied founding-pilot terms. Historical Stripe events were preserved.'
    );
  end if;
end
$repair$;

-- Verification: the sample should now be a clean founding pilot, and the RPC
-- plus all delayed-trial columns should be present.
select
  slug,
  commercial_offer,
  billing_policy,
  billing_status,
  setup_fee_status,
  stripe_customer_id,
  stripe_subscription_id,
  stripe_default_payment_method_id
from public.accounts
where slug = 'cascade-plumbing-sample';

select
  to_regprocedure(
    'public.set_account_commercial_offer(uuid,text,text,uuid,text)'
  ) as commercial_offer_rpc;
