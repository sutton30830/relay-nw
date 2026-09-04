\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'relay_nw_test' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Verification requires the local Relay test database';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('anon', 'authenticated') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Client roles must actually enforce RLS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls AND NOT rolsuper) THEN
    RAISE EXCEPTION 'Service role must model the server-side BYPASSRLS boundary';
  END IF;
END $$;

INSERT INTO public.accounts (id, slug, name) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'local-sql-test-a', 'Local SQL Test A'),
  ('b0000000-0000-4000-8000-000000000002', 'local-sql-test-b', 'Local SQL Test B');

SET LOCAL ROLE service_role;
DO $$
DECLARE
  result record;
  a uuid := 'b0000000-0000-4000-8000-000000000001';
  b uuid := 'b0000000-0000-4000-8000-000000000002';
  lead_a uuid;
BEGIN
  SELECT * INTO result FROM public.create_missed_call_lead_and_mark_live(a, 'LOCAL_TEST_CALL_A', '+12065550101', NULL, true);
  IF NOT result.inserted OR NOT result.became_live THEN RAISE EXCEPTION 'Signed call did not create/activate account A'; END IF;
  lead_a := result.lead_id;
  SELECT * INTO result FROM public.create_missed_call_lead_and_mark_live(a, 'LOCAL_TEST_CALL_A', '+12065550101', NULL, true);
  IF result.inserted OR result.became_live THEN RAISE EXCEPTION 'Duplicate call was not idempotent'; END IF;
  PERFORM public.create_missed_call_lead_and_mark_live(b, 'LOCAL_TEST_CALL_B', '+12065550101', NULL, false);
  IF (SELECT all_count FROM public.lead_inbox_counts(a)) <> 1 OR
     (SELECT all_count FROM public.lead_inbox_counts(b)) <> 1 THEN
    RAISE EXCEPTION 'Account-scoped inbox counts are incorrect';
  END IF;
  IF EXISTS (SELECT FROM public.search_lead_inbox(a, 'all', '', 50, 0) WHERE account_id <> a) THEN
    RAISE EXCEPTION 'Inbox RPC leaked another account';
  END IF;
  BEGIN
    INSERT INTO public.leads (account_id, phone, source, sms_status) VALUES (a, '+12065550102', 'missed_call', 'invalid_status');
    RAISE EXCEPTION 'Invalid SMS status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.messages (account_id, lead_id, direction) VALUES (b, lead_a, 'outbound');
    RAISE EXCEPTION 'Cross-account message-to-lead relation was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS: real service-role RPC, duplicate call, tenant counts/search, check constraint, and tenant FK';
END $$;
RESET ROLE;

-- Prove restrictive RLS still wins even when a permissive policy is present.
CREATE POLICY local_verification_allow ON public.leads AS PERMISSIVE FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
SET LOCAL ROLE anon;
DO $$
DECLARE changed integer;
BEGIN
  IF (SELECT count(*) FROM public.leads) <> 0 THEN RAISE EXCEPTION 'anon read bypassed RLS'; END IF;
  UPDATE public.leads SET name = 'Unexpected';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'anon update bypassed RLS'; END IF;
  DELETE FROM public.leads;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'anon delete bypassed RLS'; END IF;
  BEGIN
    INSERT INTO public.leads (account_id, phone, source) VALUES ('b0000000-0000-4000-8000-000000000001', '+12065550103', 'missed_call');
    RAISE EXCEPTION 'anon insert bypassed RLS';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.lead_inbox_counts('b0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'anon executed service-only RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS: anon SELECT/INSERT/UPDATE/DELETE denied by actual RLS; RPC execute denied';
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE changed integer;
BEGIN
  IF (SELECT count(*) FROM public.leads) <> 0 THEN RAISE EXCEPTION 'authenticated read bypassed RLS'; END IF;
  UPDATE public.leads SET name = 'Unexpected';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'authenticated update bypassed RLS'; END IF;
  DELETE FROM public.leads;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'authenticated delete bypassed RLS'; END IF;
  BEGIN
    INSERT INTO public.leads (account_id, phone, source) VALUES ('b0000000-0000-4000-8000-000000000001', '+12065550103', 'missed_call');
    RAISE EXCEPTION 'authenticated insert bypassed RLS';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.lead_inbox_counts('b0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'authenticated executed service-only RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS: authenticated SELECT/INSERT/UPDATE/DELETE denied by actual RLS; RPC execute denied';
END $$;
RESET ROLE;
ROLLBACK;
\echo PASS: PostgreSQL verification complete; synthetic fixtures and temporary policy rolled back.
