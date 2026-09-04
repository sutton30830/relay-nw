import assert from "node:assert/strict";
import test from "node:test";
import { loadContactModule } from "./helpers/contacts.mjs";
const ACCOUNT = { accountId: "account-a", businessName: "Local Test", smsEnabled: true, missedCallSmsCooldownHours: 24, twilioPhoneNumber: "+12065550100", ownerPhoneNumber: "+12065550199", ownerEmail: "test@example.invalid" };
const PHONE = "+12065550101";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const saved = (classification="unclassified", auto_sms_policy="suppress") => ({ id: "contact-1", account_id: ACCOUNT.accountId, phone: PHONE, display_name: "Dave", classification, auto_sms_policy, version: 1 });
async function harness(options={}) {
  const events = []; const actions = []; const emails = []; const ownerTexts = []; const messages = []; const attempts = []; const issues = [];
  const leads = new Map(); const contacts = new Map([[ACCOUNT.accountId, options.contact ?? null]]);
  let lookups = 0; let optReads = 0; let providerCalls = 0; let pushCalls = 0;
  const provider = { identity: { id: "twilio", displayName: "Test provider" }, sendSms: async (input) => {
    events.push("send"); providerCalls++; if (options.send) return options.send(input);
    return { messageId: { value: "SM_TEST" }, status: "queued" };
  } };
  const db = {
    assertTenantAccount: a => a,
    createMissedCallLeadIfNew: async (input) => {
      const key = `${input.accountId}:${input.providerCallId}`;
      if (leads.has(key)) return { inserted: false };
      const lead = { ...input, id: `lead-${leads.size}`, smsStatus: "pending", createdAt: new Date().toISOString() };
      leads.set(key,lead); events.push("capture");
      return { inserted: true, leadId: lead.id, becameLive: true, createdAt: lead.createdAt };
    },
    updateCallForMissedLead: async () => { events.push("link"); if (options.linkFails) throw new Error("write unavailable"); },
    getKnownContactByPhone: async (accountId,phone) => {
      assert.equal(phone,PHONE); events.push("contact"); lookups++;
      if (options.lookupFails === true || options.lookupFails === lookups) throw new Error("lookup unavailable");
      return structuredClone(contacts.get(accountId) ?? null);
    },
    isOptedOut: async () => { events.push("opt-out"); optReads++; if (options.optFails === optReads) throw new Error("unavailable"); return options.optedOut === true || options.optedOut === optReads; },
    hasRecentMissedCallSms: async (phone,since,accountId,id,createdAt) => {
      events.push("cooldown"); assert.equal(phone,PHONE); assert.ok(since instanceof Date); assert.ok(createdAt); assert.ok(id);
      if (options.cooldownFails) throw new Error("unavailable"); return options.recent ?? false;
    },
    recordProviderAction: async input => {
      events.push(`action:${input.internalStatus}`); actions.push(input);
      if (options.actionFails) throw new Error("unavailable");
      if (input.internalStatus === "processing") await options.reserve?.();
    },
    recordAutomaticSmsAttempt: async (...args) => { events.push("attempt"); attempts.push(args); },
    updateLeadSmsStatus: async input => {
      events.push(`status:${input.smsStatus}`);
      if (options.statusFails) throw new Error("unavailable");
      const lead = [...leads.values()].find(x=>x.id===input.id); Object.assign(lead,input);
    },
    createMessageIfNew: async input => { messages.push(input); if (options.messageFails) throw new Error("unavailable"); },
  };
  const mocks = {
    "@/lib/env": { env: { appBaseUrl: "https://relay.example.invalid" } },
    "@/lib/phone": { normalizePhoneNumber: p=>p },
    "@/lib/supabase": db,
    "@/lib/supabase/accounts": { envAccountConfig: ()=>ACCOUNT },
    "@/lib/telephony/registry": { getTelephonyProvider: ()=>provider },
    "@/lib/twilio": { missedCallSmsBodyForAccount: ()=>"We missed your call.", phoneLast4: p=>p.slice(-4), sendOwnerSms: async input=>{ ownerTexts.push(input); if(options.ownerFails) throw new Error("unavailable"); } },
    "@/lib/email": { notifyOwnerNewMissedCallLead: async input=>{ emails.push(input); if(options.emailFails) throw new Error("unavailable"); }, notifyAdminOperationalIssue: async input=>{issues.push(input); if(options.adminFails) throw new Error("unavailable");} },
    "@/lib/web-push": { notifyOwnerByWebPush: async ()=>{ pushCalls++; await options.push?.(); if(options.pushFails) throw new Error("unavailable"); } },
  };
  const { handleMissedCall } = await loadContactModule("lib/missed-call.ts",mocks);
  return { run: (account=ACCOUNT,call="CALL_1")=>handleMissedCall({ account,callerPhone:PHONE,providerCallId:call,message:null,providerSignatureValid:true }),
    contacts, actions, emails, ownerTexts, messages, attempts, issues, leads, events, db,
    get providerCalls(){return providerCalls;}, get lookups(){return lookups;}, get pushCalls(){return pushCalls;} };
}
for (const [label,contact,status] of [
  ["unknown caller",null,"sent"], ["unclassified",saved(),"skipped_known_contact"],
  ["customer default",saved("customer"),"skipped_known_contact"], ["enabled customer",saved("customer","standard"),"sent"],
  ["Personal",saved("personal"),"skipped_known_contact"], ["malformed Personal policy",saved("personal","standard"),"skipped_known_contact"],
]) test(`${label}: caller policy and independent owner alerts`,async()=>{
  const h=await harness({contact}); const result=await h.run();
  assert.equal(result.smsStatus,status); assert.equal(result.becameLive,true);
  assert.equal(h.providerCalls,status==="sent"?1:0); assert.equal(h.messages.length,h.providerCalls); assert.equal(h.attempts.length,h.providerCalls);
  assert.equal(h.emails.length,1); assert.equal(h.ownerTexts.length,1); assert.equal(h.pushCalls,1);
  assert.equal(h.emails[0].callerName,contact?.display_name);
  if(status==="skipped_known_contact") {
    const action=h.actions.find(a=>a.action==="automatic_missed_call_sms");
    assert.equal(action.provider,"relay"); assert.equal(action.providerStatus,"known_contact"); assert.equal(action.countAttempt,false);
    assert.equal(action.expectedSuppression,true); assert.equal(action.retryEligibility,"never");
    assert.match(h.ownerTexts[0].body,/known contact/); assert.match(h.ownerTexts[0].body,/\/leads\/lead-0/);
    assert.doesNotMatch(h.ownerTexts[0].body,/FAILED/); assert.ok(!h.events.includes("cooldown"));
  } else {
    assert.equal(h.lookups,2); assert.equal(h.events[h.events.indexOf("send")-1],"contact");
    assert.equal(h.actions.find(a=>a.internalStatus==="processing").countAttempt,false);
  }
});
for (const [label,options,account,status] of [
  ["disabled resolves names",{contact:saved("personal")},{...ACCOUNT,smsEnabled:false},"skipped_disabled"],
  ["disabled keeps reason on lookup failure",{lookupFails:true},{...ACCOUNT,smsEnabled:false},"skipped_disabled"],
  ["opt-out precedes contact/cooldown",{contact:saved(),optedOut:true,recent:true},ACCOUNT,"skipped_opt_out"],
  ["opt-out keeps reason on metadata failure",{lookupFails:true,optedOut:true},ACCOUNT,"skipped_opt_out"],
  ["contact precedes cooldown",{contact:saved(),recent:true},ACCOUNT,"skipped_known_contact"],
  ["ordinary cooldown",{recent:true},ACCOUNT,"skipped_recent"],
  ["initial contact lookup failure",{lookupFails:1},ACCOUNT,"blocked_pre_send"],
  ["final contact lookup failure",{lookupFails:2},ACCOUNT,"blocked_pre_send"],
  ["initial opt-out failure",{optFails:1},ACCOUNT,"blocked_pre_send"],
  ["final opt-out failure",{optFails:2},ACCOUNT,"blocked_pre_send"],
  ["cooldown failure",{cooldownFails:true},ACCOUNT,"blocked_pre_send"],
  ["opt-out added before final read",{optedOut:2},ACCOUNT,"skipped_opt_out"],
]) test(label,async()=>{
  const h=await harness(options); const result=await h.run(account);
  assert.equal(result.smsStatus,status); assert.equal(h.providerCalls,0); assert.equal(h.messages.length,0); assert.equal(h.attempts.length,0);
  assert.equal(h.lookups>=1,true); assert.equal(h.emails.length,1); assert.equal(h.pushCalls,1);
  assert.equal(h.ownerTexts.length,account.smsEnabled?1:0);
  const action=h.actions.findLast(a=>a.action==="automatic_missed_call_sms");
  assert.equal(action.countAttempt,false); assert.equal(action.retryEligibility,"never");
  if(status==="blocked_pre_send") { assert.equal(action.providerStatus,"pre_send_check_failed"); assert.equal(action.expectedSuppression,false); assert.equal(h.issues.length,1); }
});
test("contact saved before the final read suppresses a reserved send",async()=>{
  const reserved=deferred(), release=deferred();
  const h=await harness({reserve:async()=>{reserved.resolve();await release.promise;}});
  const pending=h.run(); await reserved.promise; h.contacts.set(ACCOUNT.accountId,saved()); release.resolve();
  assert.equal((await pending).smsStatus,"skipped_known_contact"); assert.equal(h.providerCalls,0); assert.equal(h.attempts.length,0);
  assert.deepEqual(h.actions.filter(a=>a.action==="automatic_missed_call_sms").map(a=>[a.internalStatus,a.countAttempt]),[["processing",false],["suppressed",false]]);
});
test("an edit after provider submission cannot recall it; webhook replay does not resend",async()=>{
  const submitted=deferred(), accepted=deferred();
  const h=await harness({send:async()=>{submitted.resolve();await accepted.promise;return{messageId:{value:"SM_TEST"},status:"queued"};}});
  const pending=h.run(); await submitted.promise; h.contacts.set(ACCOUNT.accountId,saved("personal")); accepted.resolve();
  assert.equal((await pending).smsStatus,"sent"); assert.equal((await h.run()).smsStatus,"duplicate");
  assert.equal(h.providerCalls,1); assert.equal(h.pushCalls,1); assert.equal(h.attempts.length,1);
});
test("same number in another account is ordinary; removing a contact never replays prior skips",async()=>{
  const h=await harness({contact:saved()}); assert.equal((await h.run()).smsStatus,"skipped_known_contact");
  assert.equal((await h.run({...ACCOUNT,accountId:"account-b"})).smsStatus,"sent");
  h.contacts.delete(ACCOUNT.accountId); assert.equal((await h.run()).smsStatus,"duplicate");
  assert.equal((await h.run(ACCOUNT,"CALL_2")).smsStatus,"sent");
  assert.equal(h.leads.get(`${ACCOUNT.accountId}:CALL_1`).smsStatus,"skipped_known_contact"); assert.equal(h.providerCalls,2);
});
test("parallel duplicate calls capture and submit once",async()=>{
  const h=await harness(); const results=await Promise.all([h.run(),h.run()]);
  assert.deepEqual(results.map(r=>r.smsStatus).sort(),["duplicate","sent"]); assert.equal(h.providerCalls,1);
});
test("persistence and alert failures never fall through to a caller send",async()=>{
  const h=await harness({lookupFails:true,statusFails:true,actionFails:true,emailFails:true,ownerFails:true,adminFails:true,pushFails:true,linkFails:true});
  assert.equal((await h.run()).smsStatus,"blocked_pre_send"); assert.equal(h.providerCalls,0);
  assert.equal(h.emails.length,1); assert.equal(h.ownerTexts.length,1); assert.equal(h.pushCalls,1);
});
test("reservation failure is blocked, not a provider attempt",async()=>{
  const h=await harness({actionFails:true}); assert.equal((await h.run()).smsStatus,"blocked_pre_send"); assert.equal(h.providerCalls,0); assert.equal(h.attempts.length,0);
});
test("acceptance survives bookkeeping and all notification failures",async()=>{
  const h=await harness({messageFails:true,statusFails:true,emailFails:true,ownerFails:true,adminFails:true,pushFails:true});
  assert.equal((await h.run()).smsStatus,"sent_update_failed"); assert.equal(h.providerCalls,1); assert.equal(h.attempts.length,1);
  assert.ok(!h.actions.some(a=>a.internalStatus==="failed")); assert.equal(h.emails[0].smsStatus,"sent");
});
test("provider rejection is an actual attempt, and configured owner channels remain independent",async()=>{
  const h=await harness({send:async()=>{throw new Error("Provider rejected request");},emailFails:true});
  assert.equal((await h.run()).smsStatus,"failed"); assert.equal(h.attempts.length,1); assert.equal(h.ownerTexts.length,1);
  const muted=await harness({contact:saved()}); await muted.run({...ACCOUNT,notificationPreferences:{missedCall:{sms:false}}}); assert.equal(muted.ownerTexts.length,0);
  const self=await harness({contact:saved()}); await self.run({...ACCOUNT,ownerPhoneNumber:PHONE}); assert.equal(self.ownerTexts.length,0);
});
test("suppressed terminal paths await the already-started push",async()=>{
  const started=deferred(),released=deferred();let done=false;
  const h=await harness({contact:saved(),push:async()=>{started.resolve();await released.promise;}});
  const pending=h.run().then(r=>{done=true;return r;}); await started.promise; await new Promise(r=>setImmediate(r));
  assert.equal(done,false); released.resolve(); assert.equal((await pending).smsStatus,"skipped_known_contact");
});

test("manual reply on a Personal contact preserves policy and auto-text outcome, while opt-outs and disabled accounts still block",async()=>{
  for(const mode of ["allowed","opted-out","disabled"]) {
    const contact=saved("personal"); const lead={id:"lead-1",phone:PHONE,status:"new",deleted_at:null,sms_status:"skipped_known_contact"}; let sends=0;
    const forbidden=()=>{throw new Error("Manual reply must not edit contact policy or auto-text outcome");};
    const {POST}=await loadContactModule("app/api/leads/[id]/reply/route.ts",{
      "@/lib/auth":{requireWriteAccessJson:async()=>({session:{accountId:ACCOUNT.accountId,account:{...ACCOUNT,smsEnabled:mode!=="disabled"}}})},
      "@/lib/env":{env:{appBaseUrl:"https://relay.example.invalid"}},
      "@/lib/twilio":{phoneLast4:p=>p.slice(-4)},
      "@/lib/telephony/registry":{getTelephonyProvider:()=>({identity:{id:"twilio",displayName:"Test"},sendSms:async()=>{sends++;return{messageId:{value:"SM_MANUAL"},status:"queued"};}})},
      "@/lib/supabase":{getLeadByIdForAccount:async(a)=>{assert.equal(a,ACCOUNT.accountId);return lead;},isOptedOut:async()=>mode==="opted-out",recordProviderAction:async()=>{},claimProviderActionRetry:async()=>true,createMessageIfNew:async()=>{},updateLead:async input=>{assert.deepEqual(input,{accountId:ACCOUNT.accountId,id:lead.id,status:"contacted"});},updateKnownContact:forbidden,updateLeadSmsStatus:forbidden},
    });
    const response=await POST(new Request("https://relay.example.invalid/api/leads/lead-1/reply",{method:"POST",headers:{"idempotency-key":"manual-contact-1"},body:JSON.stringify({body:"Here is the booking link."})}),{params:Promise.resolve({id:"lead-1"})});
    assert.equal(response.status,mode==="allowed"?200:mode==="opted-out"?403:400);assert.equal(sends,mode==="allowed"?1:0);
    assert.equal(contact.auto_sms_policy,"suppress");assert.equal(lead.sms_status,"skipped_known_contact");
  }
});
test("new status text is intentional/actionable and blocked checks stay out of delivery-failure counts",async()=>{
  const delivery=await loadContactModule("lib/twilio/sms-delivery.ts");
  const priority=await loadContactModule("lib/priority.ts");
  const constants=await loadContactModule("app/leads/_constants.ts", {"@/lib/priority":priority});
  const ui=await loadContactModule("app/leads/_utils.ts",{"./_constants":constants,"@/lib/voicemail-quality":{hasUsableVoicemail:()=>false}});
  const skipped={source:"missed_call",status:"new",sms_status:"skipped_known_contact"};const blocked={...skipped,sms_status:"blocked_pre_send"};
  assert.equal(delivery.smsDeliveryIssue("skipped_known_contact"),null);
  assert.match(delivery.smsDeliveryIssue("blocked_pre_send").title,/checks unavailable/);
  assert.match(ui.followUpStatusText(skipped),/known contact/);assert.match(ui.getFollowUpCue(blocked).label,/checks unavailable/);
  assert.equal(ui.needsAttention(blocked),true);assert.equal(ui.hasSmsDeliveryFailure(blocked),false);assert.equal(ui.needsAttention(skipped),false);
  const health=await loadContactModule("lib/monitoring-health.ts");
  const alerts=health.calculateAccountHealth({accountId:ACCOUNT.accountId,preSendCheckFailures:1,smsFailures:0,smsAttempts:0,phoneNumberCount:1,primaryPhoneNumberCount:1}).alerts;
  assert.ok(alerts.some(a=>a.code==="pre_send_check_failed"));assert.ok(!alerts.some(a=>a.code==="terminal_sms_failure"));
});
test("owner email escapes contact names, uses a direct conversation link, and honors email preference",async()=>{
  const sends=[];
  const email=await loadContactModule("lib/email.ts",{
    "@sentry/nextjs":{captureMessage:()=>{}},"resend":{Resend:class{emails={send:async input=>{sends.push(input);return{data:{id:"TEST"}};}}}},
    "@/lib/env":{env:{resendApiKey:"test",appBaseUrl:"https://relay.example.invalid",alertFromEmail:"test@example.invalid"}},
    "@/lib/supabase":{getOwnerNotificationEmail:async()=>ACCOUNT.ownerEmail,recordProviderAction:async()=>{}},
  });
  await email.notifyOwnerNewMissedCallLead({account:ACCOUNT,leadId:"lead-1",callerPhone:PHONE,callerName:"<Dave & Mom>",smsStatus:"skipped_known_contact"});
  assert.match(sends[0].html,/&lt;Dave &amp; Mom&gt;/);assert.match(sends[0].html,/\/leads\/lead-1/);assert.match(sends[0].text,/Not auto-texted: known contact/);
  await email.notifyOwnerNewMissedCallLead({account:{...ACCOUNT,notificationPreferences:{missedCall:{email:false}}},leadId:"lead-1",callerPhone:PHONE,smsStatus:"blocked_pre_send"});
  assert.equal(sends.length,1);
});

test("monitoring separates withheld checks and zero-attempt reservations from actual carrier failures",async()=>{
  const now=new Date().toISOString();const account={...ACCOUNT,accountStatus:"active"};
  const action=(id,provider,status,providerStatus,count,suppressed=false)=>({id,account_id:ACCOUNT.accountId,resource_id:id,action:"automatic_missed_call_sms",provider,internal_status:status,provider_status:providerStatus,attempt_count:count,suppressed,last_attempt_at:now});
  const tables={provider_action_events:[
    action("skip","relay","suppressed","known_contact",0,true),
    action("blocked","supabase","failed","pre_send_check_failed",0),
    action("reservation","twilio","processing","checking_eligibility",0),
    action("submitted","twilio","failed","send_failed",1),
  ],leads:[
    {id:"blocked",account_id:ACCOUNT.accountId,source:"missed_call",sms_status:"blocked_pre_send",created_at:now},
    ...["skip","reservation"].map(id=>({id,account_id:ACCOUNT.accountId,source:"missed_call",sms_status:"pending",created_at:new Date(Date.now()-10*60*1000).toISOString()})),
  ],account_phone_numbers:[{account_id:ACCOUNT.accountId,phone_number:ACCOUNT.twilioPhoneNumber,is_primary:true}]};
  let measured;
  const health=await loadContactModule("lib/monitoring-health.ts");
  const db={from(table){const filters=[];let columns="";const builder={
    select(value){columns=value;return builder;},in(key,values){filters.push(r=>values.includes(r[key]));return builder;},
    eq(key,value){filters.push(r=>r[key]===value);return builder;},is(key,value){filters.push(r=>(r[key]??null)===value);return builder;},
    gte(){return builder;},order(){return builder;},limit(){return builder;},then(resolve){
      if(table==="provider_action_events"){assert.match(columns,/attempt_count/);assert.match(columns,/provider_identifier/);}
      return Promise.resolve({data:(tables[table]??[]).filter(r=>filters.every(f=>f(r)))}).then(resolve);
    },
  };return builder;}};
  const monitor=await loadContactModule("lib/supabase/monitoring.ts",{
    "@/lib/env":{env:{monitoringActivityWindowHours:24,monitoringMissingLeadGraceMinutes:5,monitoringMissingSmsGraceMinutes:5,monitoringSmsFailureRatePercent:20,monitoringSmsFailureMinimumAttempts:3,monitoringEvaluatorStaleMinutes:15,monitoringDailyCronStaleHours:36,monitoringWeeklyCronStaleHours:192}},
    "@/lib/monitoring-health":{...health,calculateAccountHealth:(input,...rest)=>{measured=input;return health.calculateAccountHealth(input,...rest);}},
    "@/lib/ops-state":{deriveOpsState:()=>({labels:{billing:"Active"}})},
    "@/lib/voicemail-monitoring":{calculateVoicemailPipelineHealth:()=>({waiting:0,stalled:0,failed:0})},
    "./client":{supabaseAdmin:db,isPlaceholderSupabaseConfig:()=>false,throwIfSupabaseError:e=>{if(e)throw e;}},
    "./accounts":{listOpsAccounts:async()=>[account]},
  });
  await monitor.loadOperationsMonitoring();
  assert.equal(measured.smsAttempts,1);assert.equal(measured.smsFailures,1);assert.equal(measured.preSendCheckFailures,1);assert.equal(measured.missedCallsWithoutTextAttempt,1,"a stalled zero-attempt reservation remains actionable; intentional suppression does not");
});
