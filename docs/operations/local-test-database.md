# Local PostgreSQL verification

Relay now has a private PostgreSQL 17 test cluster for executing SQL, migrations, constraints, and role-access checks. This is a real PostgreSQL engine with a small local Supabase compatibility bootstrap, not mocked SQL and not a complete Supabase development stack.

## Commands

Run from the repository root:

```sh
# Initialize if needed, start, load bootstrap + checked-in supabase.sql, and verify.
npm run db:local -- setup

# Inspect or restart the existing cluster without reapplying the schema.
npm run db:local -- status
npm run db:local -- start

# Run existing synthetic SQL/RLS checks; fixtures roll back.
npm run db:local -- verify

# Apply a repository SQL migration/test file to this local database only.
npm run db:local -- sql docs/migrations/your-migration.sql

# Run contact-specific fresh-install/upgrade/concurrency/RLS checks.
# Creates and cleans up only its own temporary databases in this local cluster.
npm run test:contacts:db

# Stop the server; retain the local data for later work.
npm run db:local -- stop
```

PostgreSQL binaries are provided by `brew install postgresql@17`; installed version at setup was **17.11**. The runner checks the standard Apple Silicon and Intel Homebrew locations. No Homebrew service or login startup was enabled. Homebrew also initializes its own default cluster during installation; Relay uses its separate repository-owned cluster instead.

Starting/initializing PostgreSQL may require permission to run outside the Codex sandbox because macOS shared memory is blocked there. Do not work around a denied approval. Ordinary file editing and command syntax checks do not require server access.

`setup` reapplies the current complete schema in a transaction and does not drop/reset the test database. For an upgrade test, run `setup` at the baseline revision and then `sql` with the dedicated migration; do not replace the baseline with the final schema before testing the upgrade. It is appropriate to retain synthetic development records here, but never copy customer data into the cluster.

## Connection and isolation

- Database: `relay_nw_test`.
- Administrative local role: `relay_test_admin`.
- Data: `.local/postgres/data` within this repository; ignored by Git.
- Unix socket: `.local/postgres/socket`; port suffix `55432`.
- TCP: disabled (`listen_addresses = ''`); no network database URL is used.
- Cluster/socket directories: private to the current macOS user. Local socket authentication trusts only processes that can access that directory; it is a disposable development service, not an application login mechanism.
- Ownership marker: `.local/postgres/relay-test-cluster.json`. Commands refuse an unmarked/mismatched cluster or redirected data/socket directory. Before SQL they validate the actual database, administrative role, data directory, local socket connection, and disabled TCP listener.
- The runner never loads `.env`/`.env.local`, accepts no host/URL override, supplies all connection arguments explicitly, disables `psqlrc`, and removes inherited `PG*` connection settings from its subprocesses.
- Existing application/production configuration is unchanged. Do not put this socket/database in the Supabase URL environment variable: the application Supabase SDK requires HTTP services that this setup does not provide.

## Supabase compatibility and limits

`scripts/local-db/bootstrap.sql` creates non-login `anon`, `authenticated`, and `service_role` roles. The client roles are neither superusers nor `BYPASSRLS`. The service role has `BYPASSRLS` but is not a superuser, matching the application's server-side trust boundary. The bootstrap supplies table privileges so RLS is actually exercised, and a minimal `auth.users(id)` table for the existing push-subscription foreign key.

The checked-in `supabase.sql` itself supplies the application tables, extensions, constraints, policies, and RPC restrictions. It is executed unchanged. The bootstrap is local infrastructure, not a production migration.

This verifies PostgreSQL behavior. It does not provide Supabase Auth/JWT issuance, PostgREST HTTP/schema-cache behavior, Storage APIs, or provider integration. Those require separate tests when relevant. In particular, service-role access bypasses RLS; tenant isolation for application server calls still depends on explicit account scope and tenant-safe RPCs/FKs. See PostgreSQL's [row-security documentation](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

## Verification evidence

On 2026-09-03 (America/Los_Angeles), the full checked-in schema loaded on PostgreSQL 17.11 and the real database checks in `scripts/local-db/verify.sql` passed:

- Service-role missed-call RPC inserts a lead and activates signed first-call evidence.
- Replaying the same call does not insert or activate again.
- Two accounts sharing a synthetic caller number retain separate inbox counts and search results.
- Invalid SMS status violates the actual check constraint.
- A message cannot reference a lead from another account: the composite tenant FK rejects it.
- Both `anon` and `authenticated` cannot read, insert, update, or delete lead rows, even with an extra permissive policy temporarily present.
- Both client roles are denied execution of the service-only inbox RPC.
- All synthetic accounts/leads and the temporary permissive policy are rolled back.

Reapplying `setup` passed against the existing schema. Stop/start was exercised, and `status` plus the SQL/RLS checks passed again after restart. The server was left running for Prompt 2. The runner also passed Node syntax checking and focused ESLint validation.

Latest detailed logs are in `.local/postgres/schema-load.log`, `.local/postgres/verification.log`, and `.local/postgres/server.log`. These local files are ignored by Git. The SQL script and commands above are the repeatable evidence.

Prompt 2 is now implemented and verified: the dedicated known-contact migration is applied to `relay_nw_test`, and `npm run test:contacts:db` passed 18 checks across a fresh schema and an upgrade from baseline `0799c38a915d44e41014528bcf4d5b2ac2e0dd41`. The integration suite checks the same cluster ownership/connection invariants, creates randomly named `relay_contacts_test_*` databases, and removes only databases created by that invocation. Its `pg` client uses an explicit socket/user/database configuration and never loads environment files. See [the implementation specification](../impl-specs/known-contacts.md#14-step-2-implementation-and-verification) for the exact coverage and limits.


Step 3 adds `docs/migrations/2026-09-04-known-contact-sms.sql` after the contact foundation. It is applied locally. The same `npm run test:contacts:db` suite now runs **20** checks through both migrations and a fresh full schema, including the new SMS status constraints, no-attempt suppression, and idempotent actual-attempt evidence. Application/provider behavior is checked separately by `tests/known-contact-sms.test.mjs`; no real messaging services are used.
