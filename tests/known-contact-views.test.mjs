import assert from "node:assert/strict";
import test from "node:test";
import { loadContactModule } from "./helpers/contacts.mjs";
const constants = await loadContactModule("app/leads/_constants.ts", { "@/lib/priority": await loadContactModule("lib/priority.ts") });
const utils = await loadContactModule("app/leads/_utils.ts", {
  "./_constants": constants, "@/lib/voicemail-quality": { hasUsableVoicemail: () => false },
});
const state = await loadContactModule("app/leads/_inbox-state.ts", { "./_utils": utils });
const lead = (id,fields={}) => ({id,phone:`+1206555010${id}`,status:"new",name:null,deleted_at:null,booked_at:null,job_value_cents:null,is_personal:false,created_at:"2026-09-01T00:00:00Z",...fields});

test("sample and optimistic counts keep Personal/Trash independent and distinguish skipped, blocked and failed texts",()=>{
  const rows=[lead(1,{contact_classification:"personal",booked_at:"date",job_value_cents:10000,sms_status:"failed"}),lead(2,{contact_classification:"customer",sms_status:"skipped_known_contact"}),lead(3,{contact_classification:"unclassified",sms_status:"blocked_pre_send"}),lead(4,{sms_status:"failed"}),lead(5,{sms_status:"skipped_opt_out"}),lead(6,{is_personal:true,deleted_at:"date"})];
  const totals=utils.countLeads(rows);
  assert.deepEqual(totals,{all:4,new:4,contacted:0,actionable:4,booked:0,dead:0,trash:1,personal:1,smsIssues:1,smsBlocked:1,knownContactSkipped:1,bookedValueCents:0,bookedWithValue:0});
  for(const filter of ["all","new","contacted","booked","dead","personal","trash"]) assert.equal(utils.filterLeads(rows,filter,"").length,totals[filter]);
  const reclassified={...rows[0],contact_classification:"customer"};
  assert.deepEqual(state.applyCountDeltas(totals,[{before:rows[0],after:reclassified}]),utils.countLeads([reclassified,...rows.slice(1)]));
  const restored={...rows[5],deleted_at:null};
  assert.deepEqual(state.applyCountDeltas(totals,[{before:rows[5],after:restored}]),utils.countLeads([...rows.slice(0,5),restored]));
});

test("names fall back to contacts, stay searchable, and never populate the editable raw name",()=>{
  const row=lead(1,{contact_name:"Dave Nguyen",name:"  "});
  assert.equal(utils.leadDisplayName(row),"Dave Nguyen");assert.equal(utils.initials(row),"DN");assert.equal(utils.leadMatchesSearch(row,"dave"),true);
  assert.equal(utils.leadDisplayName({...row,name:"Owner label"}),"Owner label");
  assert.equal(utils.leadDisplayName({...row,contact_name:null}),null);assert.equal(row.name,"  ");
});

test("a refresh applies pending lead fields to fresh contact metadata and never resurrects a server-absent row",()=>{
  const writes=new Map([[1,{notes:"unsaved note"}]]),phones=new Map();
  const updated=lead(1,{contact_name:"Mom",contact_classification:"personal",is_personal:true});
  const [merged]=state.applyPendingWrites([updated],writes,phones);
  assert.equal(merged.notes,"unsaved note");assert.equal(merged.contact_name,"Mom");assert.equal(utils.filterLeads([merged],"all","").length,0);
  assert.deepEqual(state.applyPendingWrites([],writes,phones),[]);
  const confirmed=state.applyPendingWrites([{...updated,notes:"unsaved note"}],writes,phones);
  assert.equal(writes.size,0);assert.equal(confirmed[0].is_personal,true);
  writes.set(1,{deleted_at:"date"});
  assert.deepEqual(state.applyPendingWrites([],writes,phones),[]);
  writes.set(1,{deleted_at:null}); // Undo by id replaces the pending deletion
  assert.equal(state.applyPendingWrites([updated],writes,phones)[0].deleted_at,null);
  assert.equal(writes.size,0);
});

test("pending count refresh and failed-edit rollback use current grouping and account-wide totals",()=>{
  const business=lead(1),personal={...business,is_personal:true};
  const totals=utils.countLeads([personal,lead(2),lead(3)]);
  const writes=new Map([[1,{status:"contacted"}]]);
  assert.deepEqual(state.applyPendingCounts(totals,[personal],writes,new Map()),totals);
  assert.deepEqual(state.applyPendingCounts(totals,[],writes,new Map()),totals);
  writes.clear(); // request failed after the contact was reclassified
  assert.deepEqual(state.applyPendingCounts(totals,[personal],writes,new Map()),totals);
});

async function stores(result,placeholder=false) {
  const calls=[];
  const mocks={
    "./client":{isPlaceholderSupabaseConfig:()=>placeholder,throwIfSupabaseError:error=>{if(error)throw new Error(error.message);},supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return result;},from:()=>{throw new Error("Unfiltered fallback used");}}},
    "./tenant":{assertAccountId:id=>{if(!id?.trim())throw new Error("Account required");return id;}},
  };
  return {calls,leads:await loadContactModule("lib/supabase/leads.ts",mocks),reports:await loadContactModule("lib/supabase/reports.ts",mocks)};
}
test("contact-aware read adapters fail visibly on missing RPC, missing projection or placeholder configuration",async()=>{
  for(const [result,placeholder] of [[{error:{message:"RPC unavailable"}},false],[{data:null},false],[{data:{}},false],[{data:null},true]]) {
    const {leads,reports}=await stores(result,placeholder);
    for(const read of [()=>leads.getLeadInboxCountsForAccount("a"),()=>leads.getLeadInboxPageForAccount("a"),()=>reports.getAccountRecoveryStats("a",{since:null}),()=>reports.getAccountResponseStats("a",{since:null})]) await assert.rejects(read,/unavailable/i);
  }
  const {leads}=await stores({data:{leads:[lead(1,{is_personal:undefined})],total:1}});
  await assert.rejects(leads.getLeadInboxPageForAccount("a"),/unavailable/i);
});
test("aggregate adapters pass the tenant and exact time boundaries and reject missing tenant identity",async()=>{
  const h=await stores({data:{medianSeconds:25,sampleSize:4}});
  assert.deepEqual(await h.reports.getAccountResponseStats("account-a",{since:"start",until:"end"}),{medianSeconds:25,sampleSize:4});
  assert.deepEqual(h.calls,[{name:"account_business_response_stats",args:{p_account:"account-a",p_since:"start",p_until:"end"}}]);
  await assert.rejects(h.reports.getAccountResponseStats("",{since:null}),/Account required/);
  await assert.rejects(h.leads.getLeadInboxPageForAccount(""),/Account required/);
});

test("weekly digest skips Personal-only activity, sends business skips, and reports unavailable data as failure",async()=>{
  const sent=[],checks=[],periods=[];
  const zero={missedCalls:0,replies:0,booked:0,textedBack:0,knownContactSkipped:0,preSendBlocked:0};
  const route=await loadContactModule("app/api/digest/weekly/route.ts",{
    "@/lib/env":{env:{cronSecret:"local-test"}},
    "@/lib/cron-checkins":{recordCronCheckIn:async input=>{checks.push(input);return true;}},
    "@/lib/cron-monitor":{withCronMonitor:({run})=>run()},
    "@/lib/email":{notifyOwnerWeeklyDigest:async input=>{sent.push(input);return {sent:true};}},
    "@/lib/supabase":{
      listActiveAccountIds:async()=>["personal-only","business","unavailable"],
      getAccountConfigByAccountId:async accountId=>({accountId}),
      getAccountRecoveryStats:async(id,period)=>{periods.push(period);if(id==="unavailable")throw new Error("Contact data unavailable");return id==="personal-only"?zero:{...zero,missedCalls:1,knownContactSkipped:1};},
    },
  });
  const res=await route.GET(new Request("https://example.invalid/digest",{headers:{authorization:"Bearer local-test"}}));
  assert.equal(res.status,502);assert.equal(sent.length,1);assert.equal(sent[0].account.accountId,"business");assert.equal(sent[0].stats.knownContactSkipped,1);
  assert.equal(checks.find(x=>x.accountId==="personal-only").ok,true);assert.equal(checks.find(x=>x.accountId==="unavailable").ok,false);
  assert.ok(periods.every(p=>JSON.stringify(p)===JSON.stringify(periods[0])));assert.equal(Date.parse(periods[0].until)-Date.parse(periods[0].since),7*24*60*60*1000);
});

test("digest email labels intentional skips separately from checks held before sending (mock provider)",async()=>{
  const emails=[];
  const email=await loadContactModule("lib/email.ts",{
    "@sentry/nextjs":{},resend:{Resend:class {emails={send:async input=>{emails.push(input);return {data:{id:"LOCAL_EMAIL"}};}};}},
    "@/lib/env":{env:{resendApiKey:"local-fake",alertFromEmail:"local@example.invalid",appBaseUrl:"https://example.invalid"}},
    "@/lib/supabase":{recordProviderAction:async()=>{}},
  });
  await email.notifyOwnerWeeklyDigest({account:{accountId:"a",businessName:"Local fixture",ownerEmail:"owner@example.invalid"},stats:{missedCalls:3,textedBack:0,knownContactSkipped:2,preSendBlocked:1,urgent:0,replies:0,booked:0,recoveredCents:0},periodLabel:"this week"});
  assert.equal(emails.length,1);assert.match(emails[0].text,/Not auto-texted: known contact \(2\)/);assert.match(emails[0].text,/Held before sending: texting checks unavailable \(1\)/);
  assert.doesNotMatch(emails[0].text,/SMS failed|undefined|NaN/);
});
