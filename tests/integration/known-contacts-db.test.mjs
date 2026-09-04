// Explicit opt-in suite: never loads .env, connects only to the owned Unix socket,
// and creates/drops only random databases created by this invocation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { loadContactModule, phoneFixtures } from "../helpers/contacts.mjs";
const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const state = join(root, ".local/postgres");
const marker = JSON.parse(await readFile(join(state, "relay-test-cluster.json"), "utf8"));
assert.deepEqual(marker, { version: 1, root, database: "relay_nw_test", admin: "relay_test_admin" });
for (const part of [state, join(state,"data"), join(state,"socket")]) assert.equal(await realpath(part), part);
const config = { host: join(state,"socket"), port: 55432, user: "relay_test_admin", password: "", ssl: false, connectionTimeoutMillis: 3000, query_timeout: 15000 };
async function connect(database) {
  const client = new pg.Client({ ...config, database });
  await client.connect();
  const { rows: [actual] } = await client.query("select current_database() db, current_user usr, current_setting('data_directory') data, inet_server_addr() tcp, current_setting('listen_addresses') listen");
  assert.deepEqual(actual, { db: database, usr: config.user, data: join(state,"data"), tcp: null, listen: "" });
  return client;
}
const migration = await readFile(join(root,"docs/migrations/2026-09-03-known-contacts.sql"),"utf8");
const smsMigration = await readFile(join(root,"docs/migrations/2026-09-04-known-contact-sms.sql"),"utf8");
const schema = await readFile(join(root,"supabase.sql"),"utf8");
const baseline = execFileSync("git",["show","0799c38a915d44e41014528bcf4d5b2ac2e0dd41:supabase.sql"],{cwd:root,encoding:"utf8",maxBuffer:4*1024*1024});
const bootstrap = await readFile(join(root,"scripts/local-db/bootstrap.sql"),"utf8");
const pure = await loadContactModule("lib/contacts.ts");
const A = "a1111111-1111-4111-8111-111111111111";
const B = "b2222222-2222-4222-8222-222222222222";
const actor = "d4444444-4444-4444-8444-444444444444";
async function rpc(client,name,args) {
  assert.match(name,/^[a-z_]+$/);
  return (await client.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) result`,args)).rows[0].result;
}
const merge = (c,account,entries) => rpc(c,"merge_known_contacts",[account,JSON.stringify(entries)]);
const patch = (c,account,row,changes,version=row.version) => rpc(c,"update_known_contact",[account,row.id,version,JSON.stringify(changes)]);
const remove = (c,account,row,version=row.version) => rpc(c,"delete_known_contact",[account,row.id,version]);
const list = (c,account,q="",classification=null,limit=50,offset=0) => rpc(c,"list_known_contacts",[account,q,classification,limit,offset]);

for (const mode of ["upgrade", "fresh"]) test(`real PostgreSQL: ${mode} schema, RLS, transactions and retained data`, async (t) => {
  const admin = await connect("relay_nw_test");
  const database = `relay_contacts_test_${randomUUID().replaceAll("-","")}`;
  let created = false; let client; let second;
  try {
    await admin.query(`create database "${database}" template template0`); created = true;
    client = await connect(database);
    // Adapt the local-only bootstrap's exact database guard to this freshly
    // created test database; connection/ownership checks above remain mandatory.
    await client.query(bootstrap.replace("'relay_nw_test'",`'${database}'`));
    if (mode === "upgrade") {
      await client.query(baseline);
      await client.query("insert into accounts(id,slug,name) values($1,'contacts-a','A'),($2,'contacts-b','B')",[A,B]);
      await client.query("insert into leads(account_id,phone,source,name,status,job_value_cents) values($1,'(206) 555-0101','missed_call','Original','booked',50000)",[A]);
      await client.query(migration);
      await client.query(migration);
      await client.query(smsMigration);
      await client.query(smsMigration);
      assert.equal((await client.query("select name from leads where account_id=$1",[A])).rows[0].name,"Original");
    } else {
      await client.query(schema);
      await client.query("insert into accounts(id,slug,name) values($1,'contacts-a','A'),($2,'contacts-b','B')",[A,B]);
      await client.query("insert into leads(account_id,phone,source,name,status,job_value_cents) values($1,'(206) 555-0101','missed_call','Original','booked',50000)",[A]);
    }
    second = await connect(database);
    await client.query("set role service_role");
    await second.query("set role service_role");
    const lead = (await client.query("select * from leads where account_id=$1",[A])).rows[0];
    await client.query("insert into messages(account_id,lead_id,direction,body) values($1,$2,'inbound','Retained reply')",[A,lead.id]);
    await client.query("insert into opt_outs(account_id,phone) values($1,'+12065550101')",[A]);
    await client.query("update leads set sms_status='delivered',booked_at=now(),recording_sid='LOCAL_RECORDING',recording_url='https://example.invalid/audio',voicemail_summary='Retained voicemail' where id=$1",[lead.id]);
    await client.query("insert into calls(account_id,lead_id,call_sid,from_phone,recording_sid) values($1,$2,'LOCAL_CONTACT_CALL','+12065550101','LOCAL_RECORDING')",[A,lead.id]);
    const callsBefore = (await client.query("select to_jsonb(c) row from calls c where account_id=$1",[A])).rows;
    const history = (await client.query("select to_jsonb(l) row from leads l where account_id=$1",[A])).rows;
    await t.test("SQL/TypeScript historical phone normalization parity",async()=>{
      for (const [raw,expected] of phoneFixtures) {
        assert.equal(await rpc(client,"known_contact_phone_key",[raw]),expected,String(raw));
        assert.equal(pure.knownContactPhoneKey(raw),expected);
      }
    });
    let contact;
    await t.test("default suppression, unique tenant numbers and conservative reimport",async()=>{
      [contact] = (await merge(client,A,[{phone:"+12065550101",display_name:"Imported"}])).map(x=>x.contact);
      assert.equal(contact.classification,"unclassified"); assert.equal(contact.auto_sms_policy,"suppress"); assert.equal(contact.version,1);
      const own = await patch(client,A,contact,{display_name:null,classification:"customer",auto_sms_policy:"standard"});
      const replay = await merge(client,A,[{phone:contact.phone,display_name:"Overwrite?",classification:"personal",source:"vcard"}]);
      assert.equal(replay[0].created,false); assert.deepEqual(replay[0].contact,own);
      contact = own;
      const foreign = await merge(client,B,[{phone:contact.phone,display_name:"Other owner"}]);
      assert.equal(foreign[0].created,true); assert.notEqual(foreign[0].contact.id,contact.id);
      assert.equal((await list(client,A)).total,1); assert.equal((await list(client,B)).contacts[0].display_name,"Other owner");
      assert.equal((await list(client,A,"%" )).total,0); // literal search, no wildcard expansion
      assert.equal((await list(client,A,"", "customer")).total,1);
    });
    await t.test("stale/foreign mutations, Personal invariant and immutable contact identity",async()=>{
      await assert.rejects(patch(client,B,contact,{display_name:"Foreign"}),{code:"P0002"});
      await assert.rejects(remove(client,B,contact),{code:"P0002"});
      await assert.rejects(patch(client,A,contact,{display_name:"Stale"},1),{code:"40001"});
      contact = await patch(client,A,contact,{classification:"personal"});
      assert.equal(contact.auto_sms_policy,"suppress");
      await assert.rejects(patch(client,A,contact,{auto_sms_policy:"standard"}),{code:"23514"});
      contact = await patch(client,A,contact,{classification:"customer"});
      assert.equal(contact.auto_sms_policy,"suppress");
      contact = await patch(client,A,contact,{auto_sms_policy:"standard"});
      contact = await patch(client,A,contact,{classification:"unclassified"});
      assert.equal(contact.auto_sms_policy,"suppress");
      await assert.rejects(client.query("update account_known_contacts set phone='+12065550102' where id=$1",[contact.id]),{code:"22023"});
      await assert.rejects(client.query("update account_known_contacts set account_id=$1 where id=$2",[B,contact.id]),{code:"22023"});
      await assert.rejects(client.query("insert into account_known_contacts(account_id,phone) values($1,'garbage')",[A]),{code:"23514"});
      await assert.rejects(client.query("insert into account_known_contacts(account_id,phone) values($1,$2)",[A,contact.phone]),{code:"23505"});
      await assert.rejects(client.query("insert into account_known_contacts(account_id,phone) values($1,'+12065550109')",[actor]),{code:"23503"});
    });
    await t.test("one bad batch row rolls back every insert; concurrent imports create once",async()=>{
      await assert.rejects(merge(client,A,[{phone:"+12065550102"},{phone:"bad"}]),{code:"23514"});
      assert.equal((await list(client,A)).total,1);
      const results = await Promise.all([merge(client,A,[{phone:"+12065550102",display_name:"First"}]),merge(second,A,[{phone:"+12065550102",display_name:"Second"}])]);
      assert.equal(results.flat().filter(x=>x.created).length,1);
      assert.deepEqual(results[0][0].contact,results[1][0].contact);
      await assert.rejects(merge(client,A,Array(251).fill({phone:"+12065550103"})),{code:"22023"});
    });
    await t.test("concurrent edits have one winner; quick action preserves names and checks expected existence",async()=>{
      const results = await Promise.allSettled([patch(client,A,contact,{display_name:"Winner A"}),patch(second,A,contact,{display_name:"Winner B"})]);
      assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
      assert.equal(results.find(x=>x.status==="rejected").reason.code,"40001");
      contact = results.find(x=>x.status==="fulfilled").value;
      const name = contact.display_name;
      await assert.rejects(rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"mark_personal",null,null]),{code:"40001"});
      await assert.rejects(rpc(client,"set_lead_contact_preference",[B,lead.id,contact.phone,"mark_personal",null,null]),{code:"P0002"});
      await assert.rejects(rpc(client,"set_lead_contact_preference",[A,lead.id,"+12065550109","mark_personal",contact.version,contact.id]),{code:"22023"});
      contact = await rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"mark_personal",contact.version,contact.id]);
      assert.equal(contact.display_name,name); assert.equal(contact.classification,"personal"); assert.equal(contact.auto_sms_policy,"suppress");
      contact = await rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"suppress_auto_sms",contact.version,contact.id]);
      assert.equal(contact.classification,"personal"); assert.equal(contact.display_name,name);
    });
    await t.test("remove/recreate never changes calls, messages, bookings or recipient opt-outs",async()=>{
      await assert.rejects(remove(client,A,contact,contact.version-1),{code:"40001"});
      await remove(client,A,contact);
      await assert.rejects(remove(client,A,contact),{code:"P0002"});
      await assert.rejects(rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"mark_personal",contact.version,contact.id]),{code:"40001"});
      const newContact = await rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"suppress_auto_sms",null,null]);
      assert.notEqual(newContact.id,contact.id); assert.equal(newContact.classification,"unclassified"); assert.equal(newContact.source,"lead");
      await assert.rejects(rpc(client,"set_lead_contact_preference",[A,lead.id,contact.phone,"mark_personal",newContact.version,contact.id]),{code:"40001"});
      assert.deepEqual((await client.query("select to_jsonb(c) row from calls c where account_id=$1",[A])).rows,callsBefore);
      assert.deepEqual((await client.query("select to_jsonb(l) row from leads l where account_id=$1",[A])).rows,history);
      assert.equal((await client.query("select count(*) from messages where account_id=$1",[A])).rows[0].count,"1");
      assert.equal((await client.query("select count(*) from opt_outs where account_id=$1",[A])).rows[0].count,"1");
    });
    await t.test("actual anon/authenticated ACL and restrictive RLS defeat permissive policies",async()=>{
      await client.query("reset role");
      const roleFlags = (await client.query("select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role')")).rows;
      for (const role of roleFlags) { assert.equal(role.rolsuper,false); assert.equal(role.rolbypassrls,role.rolname==="service_role"); }
      for (const role of ["anon","authenticated"]) {
        await client.query(`set role ${role}`);
        await assert.rejects(client.query("select * from account_known_contacts"),{code:"42501"});
        await assert.rejects(list(client,A),{code:"42501"});
        await assert.rejects(merge(client,A,[{phone:"+12065550109"}]),{code:"42501"});
        await client.query("reset role");
      }
      await client.query("begin");
      try {
        await client.query("grant select,insert,update,delete on account_known_contacts to anon,authenticated");
        await client.query("create policy test_allow on account_known_contacts as permissive for all to anon,authenticated using(true) with check(true)");
        for (const role of ["anon","authenticated"]) {
          await client.query(`set local role ${role}`);
          assert.equal((await client.query("select count(*) from account_known_contacts")).rows[0].count,"0");
          assert.equal((await client.query("update account_known_contacts set display_name='Denied'")).rowCount,0);
          assert.equal((await client.query("delete from account_known_contacts")).rowCount,0);
          await client.query("savepoint insert_denied");
          await assert.rejects(client.query("insert into account_known_contacts(account_id,phone) values($1,'+12065550109')",[A]),{code:"42501"});
          await client.query("rollback to savepoint insert_denied");
          await client.query("reset role");
        }
      } finally { await client.query("rollback"); }
      await client.query("set role service_role");
    });
    await t.test("SMS statuses and attempt evidence preserve suppression and faster callbacks",async()=>{
      for (const status of ["skipped_known_contact","blocked_pre_send"]) {
        await client.query("update leads set sms_status=$1 where id=$2",[status,lead.id]);
        assert.equal((await client.query("select sms_status from leads where id=$1",[lead.id])).rows[0].sms_status,status);
      }
      await assert.rejects(client.query("update leads set sms_status='invented_status' where id=$1",[lead.id]),{code:"23514"});
      const key = `automatic_missed_call_sms:${lead.id}`;
      await client.query("insert into provider_action_events(account_id,action,provider,idempotency_key,internal_status,retry_eligibility,recommended_next_action,customer_explanation) values($1,'automatic_missed_call_sms','twilio',$2,'processing','never','Wait','Checking eligibility')",[A,key]);
      assert.equal((await client.query("select attempt_count from provider_action_events where account_id=$1 and idempotency_key=$2",[A,key])).rows[0].attempt_count,0);
      await client.query("update provider_action_events set internal_status='suppressed',suppressed=true,provider_status='known_contact' where account_id=$1 and idempotency_key=$2",[A,key]);
      assert.equal(await rpc(client,"record_automatic_sms_attempt",[A,key]),false);
      assert.equal(await rpc(client,"claim_provider_action_retry",[A,key,new Date().toISOString()]),false);
      // A final gate permitted the next simulated submission. Its callback
      // arrived before the provider's original request promise resolved.
      await client.query("update provider_action_events set internal_status='succeeded',suppressed=false,provider_status='delivered',provider_identifier='LOCAL_SMS' where account_id=$1 and idempotency_key=$2",[A,key]);
      assert.equal(await rpc(client,"record_automatic_sms_attempt",[B,key]),false);
      assert.equal(await rpc(client,"record_automatic_sms_attempt",[A,key]),true);
      assert.equal(await rpc(second,"record_automatic_sms_attempt",[A,key]),true);
      const row=(await client.query("select attempt_count,internal_status,provider_status from provider_action_events where account_id=$1 and idempotency_key=$2",[A,key])).rows[0];
      assert.deepEqual(row,{attempt_count:1,internal_status:"succeeded",provider_status:"delivered"});
      for (const role of ["anon","authenticated"]) {
        await client.query("reset role");await client.query(`set role ${role}`);
        await assert.rejects(rpc(client,"record_automatic_sms_attempt",[A,key]),{code:"42501"});
      }
      await client.query("reset role");await client.query("set role service_role");
    });
    await t.test("account deletion records exact contact count and leaves the other tenant intact",async()=>{
      await assert.rejects(rpc(client,"delete_account_data",[A,actor,null]),/archived/);
      await client.query("update accounts set status='archived',onboarding_status='closed' where id=$1",[A]);
      const before = (await list(client,A)).total;
      const counts = await rpc(client,"delete_account_data",[A,actor,null]);
      assert.equal(counts.account_known_contacts,before); assert.equal(counts.leads,1); assert.equal(counts.messages,1);
      assert.equal((await list(client,A)).total,0); assert.equal((await list(client,B)).total,1);
      assert.equal((await client.query("select counts from data_retention_events where target_account_id=$1",[A])).rows[0].counts.account_known_contacts,before);
    });
  } finally {
    if (second) await second.end();
    if (client) await client.end();
    if (created) await admin.query(`drop database "${database}"`);
    await admin.end();
  }
});
