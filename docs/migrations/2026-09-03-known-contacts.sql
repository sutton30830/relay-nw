-- Step 2: preferences only. Caller automation and historical grouping follow later.
create table if not exists public.account_known_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text check (display_name is null or (display_name = btrim(display_name) and length(display_name) between 1 and 120 and display_name !~ '[[:cntrl:]]')),
  classification text not null default 'unclassified' check (classification in ('unclassified','customer','personal')),
  auto_sms_policy text not null default 'suppress' check (auto_sms_policy in ('suppress','standard')),
  source text not null default 'manual' check (source in ('manual','lead','csv','vcard','phone_picker')),
  version bigint not null default 1 check (version > 0 and version <= 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, phone),
  check (auto_sms_policy = 'suppress' or classification = 'customer')
);
create index if not exists account_known_contacts_classification_idx on public.account_known_contacts(account_id, classification, id);
alter table public.account_known_contacts enable row level security;
drop policy if exists deny_client_access on public.account_known_contacts;
create policy deny_client_access on public.account_known_contacts as restrictive for all to anon, authenticated using (false) with check (false);
revoke all on public.account_known_contacts from public, anon, authenticated;
grant select, insert, update, delete on public.account_known_contacts to service_role;

create or replace function public.known_contact_phone_key(p_phone text) returns text
language plpgsql immutable strict parallel safe set search_path = public as $$
declare v_input text := btrim(p_phone, E' \t\r\n'); v_digits text; v_national text;
begin
  if v_input = '' or v_input !~ E'^[+0-9 ().\\-\t\r\n]+$' or v_input !~ '^\+?[^+]+$' then return null; end if;
  v_digits := regexp_replace(v_input, '[^0-9]', '', 'g');
  if left(v_input,1) = '+' then
    if v_digits ~ '^[1-9][0-9]{7,14}$' then return '+' || v_digits; end if;
    return null;
  end if;
  v_national := case when length(v_digits) = 11 and left(v_digits,1) = '1' then substr(v_digits,2) else v_digits end;
  if v_national ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then return '+1' || v_national; end if;
  return null;
end $$;

create or replace function public.guard_known_contact_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id is distinct from old.id or new.account_id is distinct from old.account_id or new.phone is distinct from old.phone
    or new.source is distinct from old.source or new.created_at is distinct from old.created_at then
    raise exception using errcode = '22023', message = 'Contact identity is immutable';
  end if;
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists guard_known_contact_update on public.account_known_contacts;
create trigger guard_known_contact_update before update on public.account_known_contacts for each row execute function public.guard_known_contact_update();

-- Serialize preference writes per account, including create-versus-edit races.
-- The account lock also orders these writes against account deletion.
create or replace function public.lock_known_contact_account(p_account_id uuid) returns void
language plpgsql set search_path = public as $$
begin
  perform 1 from public.accounts where id = p_account_id for key share;
  if not found then raise exception using errcode = 'P0002', message = 'Account not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('known-contacts:' || p_account_id::text, 0));
end $$;

create or replace function public.merge_known_contacts(p_account_id uuid, p_entries jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare v_entry jsonb; v_contact public.account_known_contacts; v_created boolean; v_results jsonb := '[]';
begin
  if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 250 then
    raise exception using errcode = '22023', message = 'Expected 1 to 250 contacts';
  end if;
  perform public.lock_known_contact_account(p_account_id);
  for v_entry in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_entry) <> 'object' or exists(select 1 from jsonb_object_keys(v_entry) k where k not in ('phone','display_name','classification','source')) then
      raise exception using errcode = '22023', message = 'Invalid contact fields';
    end if;
    insert into public.account_known_contacts(account_id,phone,display_name,classification,source)
      values(p_account_id, v_entry->>'phone', nullif(btrim(v_entry->>'display_name'),''), coalesce(v_entry->>'classification','unclassified'),coalesce(v_entry->>'source','manual'))
      on conflict(account_id,phone) do nothing returning * into v_contact;
    v_created := found;
    if not v_created then select * into strict v_contact from public.account_known_contacts where account_id = p_account_id and phone = v_entry->>'phone'; end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('contact',to_jsonb(v_contact),'created',v_created));
  end loop;
  return v_results;
end $$;

create or replace function public.update_known_contact(p_account_id uuid, p_id uuid, p_version bigint, p_patch jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare v_contact public.account_known_contacts; v_classification text; v_policy text;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb or
    exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('display_name','classification','auto_sms_policy')) then
    raise exception using errcode = '22023', message = 'Invalid contact fields';
  end if;
  perform public.lock_known_contact_account(p_account_id);
  select * into v_contact from public.account_known_contacts where account_id = p_account_id and id = p_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Contact not found'; end if;
  if p_version is distinct from v_contact.version then raise exception using errcode = '40001', message = 'Contact changed; reload and try again'; end if;
  v_classification := case when p_patch ? 'classification' then p_patch->>'classification' else v_contact.classification end;
  v_policy := case when p_patch ? 'auto_sms_policy' then p_patch->>'auto_sms_policy' when v_classification <> 'customer' then 'suppress' else v_contact.auto_sms_policy end;
  update public.account_known_contacts set
    display_name = case when p_patch ? 'display_name' then nullif(btrim(p_patch->>'display_name'),'') else display_name end,
    classification = v_classification, auto_sms_policy = v_policy
    where account_id = p_account_id and id = p_id returning * into v_contact;
  return to_jsonb(v_contact);
end $$;

create or replace function public.delete_known_contact(p_account_id uuid, p_id uuid, p_version bigint) returns boolean
language plpgsql set search_path = public as $$
declare v_version bigint;
begin
  perform public.lock_known_contact_account(p_account_id);
  select version into v_version from public.account_known_contacts where account_id = p_account_id and id = p_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Contact not found'; end if;
  if p_version is distinct from v_version then raise exception using errcode = '40001', message = 'Contact changed; reload and try again'; end if;
  delete from public.account_known_contacts where account_id = p_account_id and id = p_id;
  return true;
end $$;

-- Require identity and version to detect deletion/recreation of the same number.
create or replace function public.set_lead_contact_preference(p_account_id uuid, p_lead_id uuid, p_phone text, p_action text, p_version bigint, p_contact_id uuid) returns jsonb
language plpgsql set search_path = public as $$
declare v_lead public.leads; v_contact public.account_known_contacts; v_patch jsonb;
begin
  if p_action is null or p_action not in ('suppress_auto_sms','mark_personal') then raise exception using errcode = '22023', message = 'Invalid contact action'; end if;
  perform public.lock_known_contact_account(p_account_id);
  select * into v_lead from public.leads where account_id = p_account_id and id = p_lead_id for share;
  if not found then raise exception using errcode = 'P0002', message = 'Lead not found'; end if;
  if p_phone is null or public.known_contact_phone_key(v_lead.phone) is distinct from p_phone then
    raise exception using errcode = '22023', message = 'Invalid caller phone';
  end if;
  select * into v_contact from public.account_known_contacts where account_id = p_account_id and phone = p_phone;
  if not found then
    if p_version is not null or p_contact_id is not null then raise exception using errcode = '40001', message = 'Contact changed; reload and try again'; end if;
    insert into public.account_known_contacts(account_id,phone,display_name,classification,source)
      values(p_account_id,p_phone,nullif(left(btrim(v_lead.name),120),''),case when p_action = 'mark_personal' then 'personal' else 'unclassified' end,'lead') returning * into v_contact;
    return to_jsonb(v_contact);
  end if;
  if p_contact_id is distinct from v_contact.id then raise exception using errcode = '40001', message = 'Contact changed; reload and try again'; end if;
  v_patch := jsonb_build_object('auto_sms_policy','suppress');
  if p_action = 'mark_personal' then v_patch := v_patch || jsonb_build_object('classification','personal'); end if;
  return public.update_known_contact(p_account_id,v_contact.id,p_version,v_patch);
end $$;

create or replace function public.list_known_contacts(p_account_id uuid,p_query text default '',p_classification text default null,p_limit integer default 50,p_offset integer default 0) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_result jsonb;
begin
  if p_account_id is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 or
    p_query is null or length(p_query) > 120 or (p_classification is not null and p_classification not in ('unclassified','customer','personal')) then
    raise exception using errcode = '22023', message = 'Invalid contact filters';
  end if;
  with matching as (
    select * from public.account_known_contacts where account_id = p_account_id
      and (p_classification is null or classification = p_classification)
      and (p_query = '' or position(lower(p_query) in lower(coalesce(display_name,'') || ' ' || phone)) > 0)
  ), page as (select * from matching order by id limit p_limit offset p_offset)
  select jsonb_build_object('contacts',coalesce((select jsonb_agg(to_jsonb(page) order by id) from page),'[]'::jsonb),
    'total',(select count(*) from matching),'limit',p_limit,'offset',p_offset) into v_result;
  return v_result;
end $$;

revoke all on function public.known_contact_phone_key(text), public.guard_known_contact_update(), public.lock_known_contact_account(uuid),
  public.merge_known_contacts(uuid,jsonb),public.update_known_contact(uuid,uuid,bigint,jsonb),public.delete_known_contact(uuid,uuid,bigint),
  public.set_lead_contact_preference(uuid,uuid,text,text,bigint,uuid),public.list_known_contacts(uuid,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.known_contact_phone_key(text), public.guard_known_contact_update(), public.lock_known_contact_account(uuid),
  public.merge_known_contacts(uuid,jsonb),public.update_known_contact(uuid,uuid,bigint,jsonb),public.delete_known_contact(uuid,uuid,bigint),
  public.set_lead_contact_preference(uuid,uuid,text,text,bigint,uuid),public.list_known_contacts(uuid,text,text,integer,integer) to service_role;

create or replace function public.delete_account_data(
  p_account_id uuid,
  p_actor_user_id uuid,
  p_actor_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_technical_status text;
  v_counts jsonb;
begin
  if p_account_id is null or p_actor_user_id is null then
    raise exception 'Account id and actor are required';
  end if;
  select status, onboarding_status into v_status, v_technical_status
  from public.accounts where id = p_account_id for update;
  if not found then
    if exists (select 1 from public.data_retention_events where target_account_id = p_account_id and action = 'account.delete' and status = 'completed') then
      return '{}'::jsonb;
    end if;
    raise exception 'Account not found';
  end if;
  if v_status <> 'archived' or v_technical_status <> 'closed' then
    raise exception 'Account must be archived and technically closed before deletion';
  end if;
  select jsonb_build_object(
    'accounts', 1,
    'leads', (select count(*) from public.leads where account_id = p_account_id),
    'calls', (select count(*) from public.calls where account_id = p_account_id),
    'messages', (select count(*) from public.messages where account_id = p_account_id),
    'inbound_messages', (select count(*) from public.inbound_messages where account_id = p_account_id),
    'webhook_events', (select count(*) from public.webhook_events where account_id = p_account_id),
    'opt_outs', (select count(*) from public.opt_outs where account_id = p_account_id),
    'account_known_contacts', (select count(*) from public.account_known_contacts where account_id = p_account_id),
    'account_audit_events', (select count(*) from public.account_audit_events where account_id = p_account_id),
    'provider_action_events', (select count(*) from public.provider_action_events where account_id = p_account_id)
  ) into v_counts;
  delete from public.provider_action_events where account_id = p_account_id;
  delete from public.messages where account_id = p_account_id;
  delete from public.calls where account_id = p_account_id;
  delete from public.inbound_messages where account_id = p_account_id;
  delete from public.opt_outs where account_id = p_account_id;
  delete from public.account_known_contacts where account_id = p_account_id;
  delete from public.webhook_events where account_id = p_account_id;
  delete from public.leads where account_id = p_account_id;
  delete from public.accounts where id = p_account_id;
  insert into public.data_retention_events (target_account_id, actor_user_id, actor_email, action, status, counts)
    values (p_account_id, p_actor_user_id, p_actor_email, 'account.delete', 'completed', v_counts);
  return v_counts;
end;
$$;
revoke all on function public.delete_account_data(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid, uuid, text) to service_role;
