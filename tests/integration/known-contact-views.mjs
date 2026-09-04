import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Invoked in both fresh and upgraded disposable, socket-only databases.
export async function verifyContactViews(client, t) {
  const account = randomUUID(), other = randomUUID(), large = randomUUID(), personalOnly = randomUUID();
  for (const id of [account, other, large, personalOnly]) await client.query("insert into accounts(id,slug,name) values($1::uuid,$1::text,'View fixtures')",[id]);
  const since = "2026-09-01T00:00:00Z", until = "2026-09-08T00:00:00Z";
  const rpc = async (name,args) => (await client.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,args)).rows[0].result;
  const page = (filter="all",query="",limit=50,offset=0,id=account) => rpc("search_lead_inbox_v2",[id,filter,query,limit,offset]);
  const counts = (id=account) => rpc("lead_inbox_counts_v2",[id]);
  const stats = (id=account) => rpc("account_business_recovery_stats",[id,since,until]);
  const response = (id=account) => rpc("account_business_response_stats",[id,since,until]);
  const phones = {p:"+12065550101",c:"+12065550102",u:"+12065550103",n:"+12065550104",o:"+12065550105",t:"+12065550106",b:"+12065550107",p2:"+12065550108",foreign:"+442065550101"};
  async function lead(phone, changes={}) {
    const row={id:randomUUID(),account_id:account,phone,source:"missed_call",status:"new",sms_status:"delivered",created_at:"2026-09-02T12:00:00Z",...changes};
    const keys=Object.keys(row);
    await client.query(`insert into leads(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
    return row;
  }
  const p = await lead(phones.p,{sms_status:"skipped_known_contact",booked_at:since,job_value_cents:99999,recording_sid:"LOCAL_PERSONAL"});
  await lead(phones.p,{created_at:"2026-09-03T12:00:00Z",sms_status:"skipped_known_contact"});
  const pt = await lead(phones.p,{deleted_at:since});
  await lead("(206) 555-0101");
  const co = await lead(phones.c,{created_at:"2026-08-01T12:00:00Z",booked_at:since,job_value_cents:25000});
  const c = await lead(phones.c,{name:"Owner name",booked_at:"2026-08-02T00:00:00Z",job_value_cents:10000,sms_status:"skipped_known_contact"});
  await lead(phones.c,{deleted_at:since});
  const u = await lead(phones.u,{sms_status:"skipped_known_contact"});
  const n = await lead(phones.n,{sms_status:"failed",booked_at:since});
  await lead(phones.o,{sms_status:"skipped_opt_out"});
  const tr = await lead(phones.t,{deleted_at:since,booked_at:since,job_value_cents:88000});
  await lead(phones.b,{sms_status:"blocked_pre_send"});
  await lead(phones.foreign,{name:"Suffix neighbor"});
  const foreignLead = await lead(phones.p,{account_id:other});
  const only = await lead(phones.p,{account_id:personalOnly,booked_at:since,job_value_cents:70000});
  for(const [id,phone,name,classification] of [
    [account,phones.p,"Family % name","personal"],[account,phones.p2,"No calls","personal"],
    [account,phones.c,"Customer fallback","customer"],[account,phones.u,"Imported business","unclassified"],
    [other,phones.p,"Other tenant","customer"],[personalOnly,phones.p,"Only Personal","personal"],
  ]) await client.query("insert into account_known_contacts(account_id,phone,display_name,classification) values($1,$2,$3,$4)",[id,phone,name,classification]);
  await client.query("insert into opt_outs(account_id,phone) values($1,$2)",[account,phones.o]);
  async function inbound(sender,linked=null,id=account,sid=randomUUID()) {
    await client.query("insert into inbound_messages(account_id,message_sid,from_phone,to_phone,body,created_at) values($1,$2,$3,'+12065550000','Reply',$4)",[id,sid,sender,since]);
    if(linked) await client.query("insert into messages(account_id,twilio_message_sid,lead_id,direction,body,created_at) values($1,$2,$3,'inbound','Reply',$4)",[id,sid,linked.id,since]);
    return sid;
  }
  await inbound(phones.c,c);
  await inbound(phones.c,c);
  const unlinkedSid = await inbound(phones.n);
  await inbound(phones.p);
  await inbound(phones.p2);
  await inbound(phones.c,p); // business sender cannot make a verified Personal link eligible
  await inbound(phones.n,tr);
  await inbound(phones.t);
  await inbound("+12065550999");
  await inbound(phones.c); // live and trashed history: live business makes this eligible
  await inbound(phones.o);
  await inbound(phones.p,only,personalOnly);
  await inbound(phones.p,foreignLead,other);
  await client.query("insert into messages(account_id,twilio_message_sid,lead_id,direction,body) values($1,$2,$3,'inbound','Foreign mirror')",[other,unlinkedSid,foreignLead.id]);
  for(const [row,seconds] of [[co,30],[c,90],[u,10],[p,1],[only,1]]) {
    for (const delta of [seconds,seconds+60]) await client.query("insert into messages(account_id,lead_id,direction,body,created_at) values($1,$2,'outbound','Response',$3)",[row.account_id,row.id,new Date(Date.parse(row.created_at)+delta*1000).toISOString()]);
  }
  // A verified link across tenants must never be accepted. The FK normally
  // prevents this; same-provider-id tenant collisions above test the read join.
  const before = await client.query("select to_jsonb(l) row from leads l where account_id=$1 order by id",[account]);
  const messagesBefore = await client.query("select to_jsonb(m) row from messages m where account_id=$1 order by id",[account]);

  await t.test("Personal and Trash are independent; search, pagination and condensed counts agree",async()=>{
    const totals=await counts();
    assert.equal(totals.all_count,6);assert.equal(totals.personal_count,2);assert.equal(totals.trash_count,3);
    assert.equal(totals.sms_issues_count,1);assert.equal(totals.sms_blocked_count,1);assert.equal(totals.known_contact_skipped_count,2);
    assert.equal(totals.booked_count,2);assert.equal(totals.booked_value_cents,10000);
    for(const filter of ["all","new","contacted","booked","dead","personal","trash"]) {
      const result=await page(filter);assert.equal(result.total,totals[`${filter}_count`]);
      if(!["trash","personal"].includes(filter)) assert.ok(result.leads.every(l=>!l.is_personal&&!l.deleted_at));
    }
    assert.equal((await page("personal","Family %")).total,2);
    assert.equal((await page("all","Family")).total,0);
    assert.equal((await page("personal","%")).total,2);
    assert.equal((await page("all","%")).total,0);
    assert.equal((await page("all","Owner name")).leads[0].name,"Owner name");
    assert.equal((await page("all","Imported business")).leads[0].name,null);
    assert.equal((await page("all","Other tenant")).total,0);
    assert.equal((await page("all","Suffix neighbor")).total,1);
    const first=await page("all","",2,0),second=await page("all","",2,2),outside=await page("all","",2,999);
    assert.equal(first.total,6);assert.equal(second.total,6);assert.equal(outside.total,6);assert.equal(outside.leads.length,0);
    assert.equal(new Set([...first.leads,...second.leads].map(l=>l.id)).size,4);
    assert.equal((await page("personal")).leads.find(l=>l.phone===phones.p).call_count,3);
    assert.equal((await page("all","",50,0,other)).leads[0].display_name,"Other tenant");
    await client.query("update leads set name='  ' where id=$1",[c.id]);
    assert.equal((await page("all","Customer fallback")).leads[0].display_name,"Customer fallback");
    await client.query("update leads set name='Owner name' where id=$1",[c.id]);
  });
  await t.test("business aggregates share Personal/Trash reply rules and use event-specific dates",async()=>{
    const actual=await stats();
    assert.deepEqual(actual,{missedCalls:6,textedBack:1,smsFailed:1,knownContactSkipped:2,preSendBlocked:1,urgent:0,replies:6,uniqueReplyLeads:1,unlinkedReplyCount:4,booked:2,bookedMissingValue:1,recoveredCents:25000});
    assert.deepEqual(await response(),{medianSeconds:50,sampleSize:2}); // older lead's reply is outside the lead cohort
    assert.deepEqual(await stats(personalOnly),{missedCalls:0,textedBack:0,smsFailed:0,knownContactSkipped:0,preSendBlocked:0,urgent:0,replies:0,uniqueReplyLeads:0,unlinkedReplyCount:0,booked:0,bookedMissingValue:0,recoveredCents:0});
    assert.deepEqual(await response(personalOnly),{medianSeconds:null,sampleSize:0});
    const alltime=await rpc("account_business_response_stats",[account,null,null]);
    assert.deepEqual(alltime,{medianSeconds:30,sampleSize:3});
  });
  await t.test("reclassification and removal regroup retained history without changing outcomes or Trash",async()=>{
    await client.query("update account_known_contacts set classification='customer' where account_id=$1 and phone=$2",[account,phones.p]);
    assert.equal((await counts()).all_count,8);assert.equal((await counts()).personal_count,0);assert.equal((await counts()).trash_count,3);
    assert.equal((await stats()).recoveredCents,124999);
    assert.equal((await client.query("select auto_sms_policy from account_known_contacts where account_id=$1 and phone=$2",[account,phones.p])).rows[0].auto_sms_policy,"suppress");
    await client.query("update account_known_contacts set classification='personal' where account_id=$1 and phone=$2",[account,phones.p]);
    await client.query("update leads set deleted_at=null where id=$1",[pt.id]);
    assert.equal((await counts()).all_count,6);assert.equal((await counts()).personal_count,2);assert.equal((await counts()).trash_count,2);
    await client.query("update leads set deleted_at=$1 where id=$2",[since,pt.id]);
    await client.query("delete from account_known_contacts where account_id=$1 and phone=$2",[account,phones.p]);
    assert.equal((await counts()).all_count,8);assert.equal((await counts()).trash_count,3);
    assert.deepEqual((await client.query("select to_jsonb(l) row from leads l where account_id=$1 order by id",[account])).rows,before.rows);
    assert.deepEqual((await client.query("select to_jsonb(m) row from messages m where account_id=$1 order by id",[account])).rows,messagesBefore.rows);
  });
  await t.test("full SQL totals exceed old 2000-call/5000-reply caps and filter before paging",async()=>{
    await client.query(`insert into leads(account_id,phone,source,status,sms_status,created_at,booked_at,job_value_cents)
      select $1,'+1206'||(5550000+i)::text,'missed_call','new','delivered',$2,$2,100 from generate_series(1,2205) i`,[large,since]);
    await client.query(`insert into account_known_contacts(account_id,phone,classification)
      select $1,'+1206'||(5550000+i)::text,'personal' from generate_series(1,100) i`,[large]);
    await client.query(`insert into inbound_messages(account_id,message_sid,from_phone,to_phone,body,created_at)
      select $1,'large-'||i,'+12065559999','+12065550000','Unlinked',$2 from generate_series(1,5205) i`,[large,since]);
    assert.equal((await counts(large)).all_count,2105);
    const last=await page("all","",50,2100,large);assert.equal(last.total,2105);assert.equal(last.leads.length,5);
    const actual=await stats(large);assert.equal(actual.missedCalls,2105);assert.equal(actual.booked,2105);assert.equal(actual.recoveredCents,210500);
    assert.equal(actual.replies,5205);assert.equal(actual.uniqueReplyLeads,0);assert.equal(actual.unlinkedReplyCount,5205);
  });
  await t.test("new SQL surfaces reject client roles and invalid inbox arguments",async()=>{
    await assert.rejects(page("invalid"),{code:"22023"});
    await assert.rejects(page("all","x".repeat(201)),{code:"22023"});
    for(const role of ["anon","authenticated"]) {
      await client.query("reset role");await client.query(`set role ${role}`);
      await assert.rejects(client.query("select * from lead_contact_context"),{code:"42501"});
      for(const [fn,args] of [["lead_inbox_context",[account]],["lead_inbox_counts_v2",[account]],["search_lead_inbox_v2",[account,"all","",50,0]],...["account_business_replies","account_business_recovery_stats","account_business_response_stats"].map(fn=>[fn,[account,since,until]])]) {
        await assert.rejects(rpc(fn,args),{code:"42501"});
      }
    }
    await client.query("reset role");await client.query("set role service_role");
  });
}
