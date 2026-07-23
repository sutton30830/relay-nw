-- Phase 4/5: Relay-owned billing exceptions must be explicit and audited in
-- the same transaction. Stripe subscription/payment snapshots are untouched.

create or replace function public.set_account_billing_policy(
  p_account_id uuid,
  p_policy text,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_policy text,
  current_policy text
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_policy text;
  v_stripe_status text;
  v_setup_fee_status text;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if p_policy not in ('standard', 'setup_fee_waived', 'comped') then
    raise exception 'Unsupported billing policy';
  end if;

  if length(v_reason) < 5 then
    raise exception 'A meaningful billing-policy reason is required';
  end if;

  select
    billing_policy,
    stripe_subscription_status,
    setup_fee_status
  into
    v_previous_policy,
    v_stripe_status,
    v_setup_fee_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  if p_policy = 'comped'
    and v_stripe_status in (
      'incomplete',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused'
    )
  then
    raise exception 'Cancel or finish the Stripe subscription before comping';
  end if;

  if p_policy = 'setup_fee_waived'
    and v_setup_fee_status in ('paid', 'partially_refunded')
  then
    raise exception 'A paid setup fee cannot be reclassified as waived';
  end if;

  update public.accounts
  set
    billing_policy = p_policy,
    billing_policy_updated_at = now()
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
    nullif(trim(coalesce(p_actor_email, '')), ''),
    'billing.policy.' || p_policy,
    v_reason
  );

  return query select v_previous_policy, p_policy;
end;
$function$;

revoke all
on function public.set_account_billing_policy(
  uuid,
  text,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_billing_policy(
  uuid,
  text,
  text,
  uuid,
  text
)
to service_role;

