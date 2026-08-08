-- Keep accounts.name aligned with the editable account_settings.business_name.
-- The slug is deliberately not changed: it is a stable operator/provider key.

begin;

create or replace function public.sync_account_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if btrim(new.business_name) = '' then
    raise exception 'Business name cannot be blank';
  end if;

  update public.accounts
  set name = btrim(new.business_name),
      updated_at = now()
  where id = new.account_id
    and name is distinct from btrim(new.business_name);

  return new;
end;
$$;

drop trigger if exists account_settings_sync_account_display_name on public.account_settings;
create trigger account_settings_sync_account_display_name
after insert or update of business_name on public.account_settings
for each row execute function public.sync_account_display_name();

revoke all on function public.sync_account_display_name() from public, anon, authenticated;

update public.accounts as account
set name = btrim(settings.business_name),
    updated_at = now()
from public.account_settings as settings
where settings.account_id = account.id
  and btrim(settings.business_name) <> ''
  and account.name is distinct from btrim(settings.business_name);

commit;
