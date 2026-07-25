-- Relay NW: flexible, no-card pilot access.
--
-- Free access is a Relay-owned commercial policy. It creates no Stripe
-- customer, card, setup payment, trial, or subscription. The optional review
-- date is operational only: reaching it creates no charge and does not stop
-- service.

begin;

alter table public.accounts
  add column if not exists free_access_review_at timestamptz;

update public.accounts
set free_access_review_at = null
where billing_policy <> 'comped'
  and free_access_review_at is not null;

do $$
begin
  alter table public.accounts
    add constraint accounts_free_access_review_requires_comp_check
    check (free_access_review_at is null or billing_policy = 'comped');
exception
  when duplicate_object then null;
end $$;

-- Leaving free access always clears its operational review date. This RPC
-- remains the explicit path for ending free access or applying other existing
-- commercial policies.
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
    billing_policy_updated_at = now(),
    free_access_review_at = case
      when p_policy = 'comped' then free_access_review_at
      else null
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
    nullif(trim(coalesce(p_actor_email, '')), ''),
    'billing.policy.' || p_policy,
    v_reason
  );

  return query select v_previous_policy, p_policy;
end;
$function$;

-- Starts or updates free access atomically with its audit event. A null review
-- date means "no review scheduled"; it never means "bill immediately."
create or replace function public.set_account_free_access(
  p_account_id uuid,
  p_review_at timestamptz,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_policy text,
  current_policy text,
  previous_review_at timestamptz,
  current_review_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_policy text;
  v_previous_review_at timestamptz;
  v_stripe_status text;
  v_reason text := trim(coalesce(p_reason, ''));
  v_action text;
  v_review_summary text;
begin
  if length(v_reason) < 5 then
    raise exception 'A meaningful free-access reason is required';
  end if;

  if p_review_at is not null and p_review_at <= now() then
    raise exception 'The free-access review date must be in the future';
  end if;

  select
    billing_policy,
    free_access_review_at,
    stripe_subscription_status
  into
    v_previous_policy,
    v_previous_review_at,
    v_stripe_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  if v_stripe_status in (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused'
  ) then
    raise exception 'Cancel or finish the Stripe subscription before granting free access';
  end if;

  v_action := case
    when v_previous_policy = 'comped' then 'billing.free_access.updated'
    else 'billing.free_access.started'
  end;
  v_review_summary := case
    when p_review_at is null then 'No review date scheduled'
    else 'Review on ' || to_char(p_review_at at time zone 'UTC', 'YYYY-MM-DD')
  end;

  update public.accounts
  set
    billing_policy = 'comped',
    billing_policy_updated_at = case
      when billing_policy = 'comped' then billing_policy_updated_at
      else now()
    end,
    free_access_review_at = p_review_at
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
    v_action,
    v_review_summary || ' — ' || v_reason
  );

  return query
  select
    v_previous_policy,
    'comped'::text,
    v_previous_review_at,
    p_review_at;
end;
$function$;

revoke all
on function public.set_account_free_access(
  uuid,
  timestamptz,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_free_access(
  uuid,
  timestamptz,
  text,
  uuid,
  text
)
to service_role;

commit;

select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'free_access_review_at'
  ) as free_access_review_column,
  to_regprocedure(
    'public.set_account_free_access(uuid,timestamp with time zone,text,uuid,text)'
  ) is not null as free_access_rpc;
