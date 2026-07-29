import { randomUUID } from "node:crypto";

export const BUSINESS_A = {
  key: "a",
  accountId: "11111111-1111-4111-8111-111111111111",
  slug: "alpha-plumbing",
  name: "Alpha Plumbing",
  owner: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "owner@alpha.example",
    phone: "+12065550111",
  },
  users: {
    owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    admin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
  },
  relayNumber: "+12065551001",
  publicNumber: "+12065552001",
  phoneSid: `PN${"a".repeat(32)}`,
  customerPhone: "+12065553001",
  optOutPhone: "+12065554001",
  callSid: `CA${"a".repeat(32)}`,
  pendingCallSid: `CA${"c".repeat(32)}`,
  messageSid: `SM${"a".repeat(32)}`,
  inboundMessageSid: `SM${"c".repeat(32)}`,
  recordingSid: `RE${"a".repeat(32)}`,
  pendingRecordingSid: `RE${"c".repeat(32)}`,
  leadId: "aaaaaaaa-1111-4111-8111-111111111111",
  pendingLeadId: "aaaaaaaa-2222-4222-8222-222222222222",
  callId: "aaaaaaaa-3333-4333-8333-333333333333",
  messageId: "aaaaaaaa-4444-4444-8444-444444444444",
};

export const BUSINESS_B = {
  key: "b",
  accountId: "22222222-2222-4222-8222-222222222222",
  slug: "bravo-electric",
  name: "Bravo Electric",
  owner: {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "owner@bravo.example",
    phone: "+12065550112",
  },
  users: {
    owner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    admin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
    viewer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd",
  },
  relayNumber: "+12065551002",
  publicNumber: "+12065552002",
  phoneSid: `PN${"b".repeat(32)}`,
  customerPhone: "+12065553002",
  optOutPhone: "+12065554002",
  callSid: `CA${"b".repeat(32)}`,
  pendingCallSid: `CA${"d".repeat(32)}`,
  messageSid: `SM${"b".repeat(32)}`,
  inboundMessageSid: `SM${"d".repeat(32)}`,
  recordingSid: `RE${"b".repeat(32)}`,
  pendingRecordingSid: `RE${"d".repeat(32)}`,
  leadId: "bbbbbbbb-1111-4111-8111-111111111111",
  pendingLeadId: "bbbbbbbb-2222-4222-8222-222222222222",
  callId: "bbbbbbbb-3333-4333-8333-333333333333",
  messageId: "bbbbbbbb-4444-4444-8444-444444444444",
};

export const BUSINESSES = [BUSINESS_A, BUSINESS_B];

function runtimeAccount(business) {
  return {
    accountId: business.accountId,
    accountSlug: business.slug,
    businessName: business.name,
    ownerEmail: business.owner.email,
    ownerName: `${business.name} Owner`,
    legalBusinessName: `${business.name} LLC`,
    publicBusinessNumber: business.publicNumber,
    businessType: business.key === "a" ? "Plumbing" : "Electrical",
    businessIndustry: "Local trades",
    websiteUrl: `https://${business.slug}.example`,
    addressLine1: business.key === "a" ? "101 Alpha Ave" : "202 Bravo Blvd",
    addressLine2: null,
    addressCity: "Seattle",
    addressRegion: "WA",
    addressPostalCode: business.key === "a" ? "98101" : "98102",
    addressCountry: "US",
    businessHours: { summary: business.key === "a" ? "Weekdays" : "Every day" },
    implementationNotes: `${business.name} notes`,
    greetingPreference: "generated",
    callMode: "forwarding",
    smsEnabled: true,
    intakeUrl: `https://${business.slug}.example/intake`,
    schedulingUrl: `https://${business.slug}.example/book`,
    smsTemplate: `Thanks for calling ${business.name}.`,
    quickReplyTemplates: null,
    missedCallVoiceMessage: `You reached ${business.name}.`,
    missedCallVoiceName: "Polly.Joanna-Neural",
    missedCallGreetingAudioUrl: null,
    voicemailMaxSeconds: 60,
    dialTimeoutSeconds: 18,
    missedCallSmsCooldownHours: 24,
    typicalJobValueCents: business.key === "a" ? 45000 : 65000,
    voicemailTranscriptionEnabled: true,
    twilioPhoneNumber: business.relayNumber,
    ownerPhoneNumber: business.owner.phone,
  };
}

function accountRow(business) {
  return {
    id: business.accountId,
    slug: business.slug,
    name: business.name,
    status: "active",
    onboarding_status: business.key === "a" ? "live" : "waiting_for_forwarding",
    ops_blocked_by: business.key === "a" ? "none" : "customer",
    ops_blocker_note: business.key === "a" ? null : "Waiting for forwarding",
    ops_blocked_since: business.key === "a" ? null : "2026-07-01T00:00:00.000Z",
    billing_status: business.key === "a" ? "active" : "not_started",
    billing_policy: business.key === "a" ? "standard" : "setup_fee_waived",
    setup_fee_status: business.key === "a" ? "paid" : "waived",
    stripe_customer_id: business.key === "a" ? "cus_alpha" : "cus_bravo",
    stripe_subscription_id: business.key === "a" ? "sub_alpha" : null,
  };
}

function settingsRow(business) {
  const runtime = runtimeAccount(business);
  return {
    account_id: business.accountId,
    business_name: runtime.businessName,
    owner_email: runtime.ownerEmail,
    owner_name: runtime.ownerName,
    legal_business_name: runtime.legalBusinessName,
    public_business_number: runtime.publicBusinessNumber,
    business_type: runtime.businessType,
    business_industry: runtime.businessIndustry,
    website_url: runtime.websiteUrl,
    owner_phone_number: runtime.ownerPhoneNumber,
    intake_url: runtime.intakeUrl,
    scheduling_url: runtime.schedulingUrl,
    call_mode: runtime.callMode,
    sms_enabled: runtime.smsEnabled,
    sms_template: runtime.smsTemplate,
    a2p_registration_status: business.key === "a" ? "approved" : "in_progress",
  };
}

function completedLead(business) {
  return {
    id: business.leadId,
    account_id: business.accountId,
    call_sid: business.callSid,
    phone: business.customerPhone,
    name: `${business.name} Caller`,
    message: `${business.name} missed call`,
    source: "missed_call",
    status: "new",
    sms_status: "delivered",
    twilio_message_sid: business.messageSid,
    recording_sid: business.recordingSid,
    recording_url:
      `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${business.recordingSid}.mp3`,
    recording_duration: business.key === "a" ? 12 : 18,
    recording_status: "completed",
    voicemail_raw_transcript: `${business.name} raw transcript`,
    voicemail_transcript: `${business.name} verified transcript`,
    voicemail_summary: `${business.name} verified summary`,
    voicemail_transcription_status: "completed",
    voicemail_transcribed_at: "2026-07-20T00:00:00.000Z",
    deleted_at: null,
    created_at: "2026-07-20T00:00:00.000Z",
  };
}

function pendingLead(business) {
  return {
    ...completedLead(business),
    id: business.pendingLeadId,
    call_sid: business.pendingCallSid,
    message: `${business.name} pending voicemail`,
    twilio_message_sid: null,
    recording_sid: business.pendingRecordingSid,
    recording_url:
      `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${business.pendingRecordingSid}.mp3`,
    voicemail_raw_transcript: null,
    voicemail_transcript: null,
    voicemail_summary: null,
    voicemail_transcription_status: "pending",
    voicemail_transcribed_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

function clone(value) {
  return structuredClone(value);
}

export function createTwoBusinessFixture() {
  const state = {
    accounts: BUSINESSES.map(accountRow),
    runtimeAccounts: Object.fromEntries(
      BUSINESSES.map((business) => [business.accountId, runtimeAccount(business)]),
    ),
    account_settings: BUSINESSES.map(settingsRow),
    account_carrier_profiles: BUSINESSES.map((business) => ({
      account_id: business.accountId,
      status: business.key === "a" ? "approved" : "in_progress",
      twilio_brand_sid: `BN${business.key.repeat(32)}`,
      twilio_campaign_sid: `QE${business.key.repeat(32)}`,
      messaging_service_sid: `MG${business.key.repeat(32)}`,
    })),
    account_phone_numbers: BUSINESSES.map((business) => ({
      id: randomUUID(),
      account_id: business.accountId,
      phone_number: business.relayNumber,
      twilio_sid: business.phoneSid,
      is_primary: true,
    })),
    account_users: BUSINESSES.flatMap((business) => [
      {
        id: randomUUID(),
        account_id: business.accountId,
        user_id: business.users.owner,
        email: business.owner.email,
        role: "owner",
      },
      {
        id: randomUUID(),
        account_id: business.accountId,
        user_id: business.users.admin,
        email: `admin@${business.slug}.example`,
        role: "admin",
      },
      {
        id: randomUUID(),
        account_id: business.accountId,
        user_id: business.users.viewer,
        email: `viewer@${business.slug}.example`,
        role: "viewer",
      },
    ]),
    account_audit_events: BUSINESSES.map((business) => ({
      id: randomUUID(),
      account_id: business.accountId,
      action: `fixture.${business.key}`,
      summary: `${business.name} audit`,
    })),
    leads: BUSINESSES.flatMap((business) => [
      completedLead(business),
      pendingLead(business),
    ]),
    inbound_messages: BUSINESSES.map((business) => ({
      id: randomUUID(),
      account_id: business.accountId,
      message_sid: business.inboundMessageSid,
      from_phone: business.customerPhone,
      to_phone: business.relayNumber,
      body: `${business.name} inbound reply`,
    })),
    calls: BUSINESSES.flatMap((business) => [
      {
        id: business.callId,
        account_id: business.accountId,
        call_sid: business.callSid,
        lead_id: business.leadId,
        from_phone: business.customerPhone,
        to_phone: business.relayNumber,
        recording_sid: business.recordingSid,
      },
      {
        id: randomUUID(),
        account_id: business.accountId,
        call_sid: business.pendingCallSid,
        lead_id: business.pendingLeadId,
        from_phone: business.customerPhone,
        to_phone: business.relayNumber,
        recording_sid: business.pendingRecordingSid,
      },
    ]),
    messages: BUSINESSES.map((business) => ({
      id: business.messageId,
      account_id: business.accountId,
      lead_id: business.leadId,
      call_id: business.callId,
      twilio_message_sid: business.messageSid,
      direction: "outbound",
      from_phone: business.relayNumber,
      to_phone: business.customerPhone,
      body: `${business.name} outbound text`,
      status: "delivered",
    })),
    opt_outs: BUSINESSES.map((business) => ({
      id: randomUUID(),
      account_id: business.accountId,
      phone: business.optOutPhone,
      created_at: "2026-07-19T00:00:00.000Z",
    })),
    webhook_events: BUSINESSES.map((business) => ({
      id: randomUUID(),
      account_id: business.accountId,
      source: "twilio_voice",
      correlation_id: business.callSid,
    })),
    stripe_events: BUSINESSES.map((business) => ({
      event_id: `evt_${business.key}`,
      account_id: business.accountId,
      stripe_customer_id: business.key === "a" ? "cus_alpha" : "cus_bravo",
      processing_status: "processed",
    })),
    providerActions: [],
    ownerNotifications: [],
    adminNotifications: [],
    transcriptionClaims: new Set(),
  };

  function accountById(accountId) {
    return state.runtimeAccounts[accountId] ?? null;
  }

  function accountByRelayNumber(phoneNumber) {
    const mapping = state.account_phone_numbers.find(
      (row) => row.phone_number === phoneNumber,
    );
    return mapping ? accountById(mapping.account_id) : null;
  }

  function accountByCallSid(callSid) {
    const matches = state.calls.filter((row) => row.call_sid === callSid);
    const accountIds = [...new Set(matches.map((row) => row.account_id))];
    return accountIds.length === 1 ? accountById(accountIds[0]) : null;
  }

  function accountByMessageSid(messageSid) {
    const matches = state.messages.filter(
      (row) => row.twilio_message_sid === messageSid,
    );
    const accountIds = [...new Set(matches.map((row) => row.account_id))];
    return accountIds.length === 1 ? accountById(accountIds[0]) : null;
  }

  function sessionFor(business, role = "owner") {
    return {
      userId: business.users[role],
      email:
        role === "owner"
          ? business.owner.email
          : `${role}@${business.slug}.example`,
      role,
      accountId: business.accountId,
      account: clone(state.runtimeAccounts[business.accountId]),
      membershipCount: 1,
      platformOperatorRole: null,
    };
  }

  return {
    state,
    accountById,
    accountByRelayNumber,
    accountByCallSid,
    accountByMessageSid,
    sessionFor,
    snapshot() {
      return clone({
        ...state,
        transcriptionClaims: [...state.transcriptionClaims],
      });
    },
  };
}
