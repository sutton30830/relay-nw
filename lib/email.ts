import * as Sentry from "@sentry/nextjs";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { getOwnerNotificationEmail, type AccountRuntimeConfig } from "@/lib/supabase";

let resendClient: Resend | null = null;

function getResendClient() {
  if (!env.resendApiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(env.resendApiKey);
  }

  return resendClient;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function paragraph(value: string) {
  return `<p style="margin:0 0 12px;color:#263532;line-height:1.5">${escapeHtml(value)}</p>`;
}

function phoneLast4(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function emailHtml(input: {
  title: string;
  preview: string;
  lines: string[];
  actionLabel?: string;
  actionUrl?: string;
}) {
  const action = input.actionLabel && input.actionUrl
    ? `<p style="margin:20px 0"><a href="${escapeHtml(input.actionUrl)}" style="background:#0f4b44;color:#fff;text-decoration:none;padding:10px 14px;border-radius:6px;display:inline-block">${escapeHtml(input.actionLabel)}</a></p>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;background:#f5f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <span style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.preview)}</span>
    <main style="max-width:560px;margin:0 auto;padding:28px 18px">
      <section style="background:#fffcf6;border:1px solid #ddd5c7;border-radius:8px;padding:22px">
        <p style="margin:0 0 8px;color:#5f6b67;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Relay NW</p>
        <h1 style="margin:0 0 16px;color:#14211f;font-size:24px;line-height:1.2">${escapeHtml(input.title)}</h1>
        ${input.lines.map(paragraph).join("")}
        ${action}
      </section>
    </main>
  </body>
</html>`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown email error";
  }
}

function captureEmailBackstopFailure(input: { subject: string; tag: string }, error: unknown) {
  try {
    Sentry.captureMessage("Email alert delivery failed", {
      level: "error",
      tags: { tag: input.tag },
      extra: { subject: input.subject, error: errorMessage(error) },
    });
  } catch (sentryError) {
    console.error("Sentry email backstop capture failed", {
      tag: input.tag,
      error: errorMessage(sentryError),
    });
  }
}

function captureSkippedAdminBackstop(input: { to: string | null | undefined; tag: string }) {
  try {
    Sentry.captureMessage("Admin alert skipped: email backstop not configured", {
      level: "warning",
      tags: { tag: input.tag },
      extra: { hasResendApiKey: Boolean(env.resendApiKey), hasRecipient: Boolean(input.to) },
    });
  } catch (sentryError) {
    console.error("Sentry skipped-admin-alert capture failed", {
      tag: input.tag,
      error: errorMessage(sentryError),
    });
  }
}

async function sendEmail(input: {
  to: string | null | undefined;
  subject: string;
  html: string;
  text: string;
  tag: string;
}) {
  const client = getResendClient();

  if (!client || !input.to) {
    console.info("Email notification skipped", {
      tag: input.tag,
      hasResendApiKey: Boolean(env.resendApiKey),
      hasRecipient: Boolean(input.to),
    });

    if (input.tag === "admin_operational_issue") {
      captureSkippedAdminBackstop(input);
    }

    return { sent: false, skipped: true };
  }

  try {
    const { data, error } = await client.emails.send({
      from: env.alertFromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (error) {
      console.error("Email notification failed", { tag: input.tag, error });
      captureEmailBackstopFailure(input, error);
      return { sent: false, skipped: false, error };
    }

    console.info("Email notification sent", { tag: input.tag, id: data?.id });
    return { sent: true, skipped: false, id: data?.id };
  } catch (error) {
    const message = errorMessage(error);
    console.error("Email notification threw", {
      tag: input.tag,
      error: message,
    });
    captureEmailBackstopFailure(input, message);
    return { sent: false, skipped: false, error };
  }
}

async function ownerEmail(account: AccountRuntimeConfig) {
  return account.ownerEmail ?? await getOwnerNotificationEmail(account.accountId);
}

export async function notifyOwnerTestEmail(input: {
  account: AccountRuntimeConfig;
  requestedBy?: string | null;
}) {
  const recipient = await ownerEmail(input.account);
  const lines = [
    `This is a Relay NW owner notification test for ${input.account.businessName}.`,
    input.requestedBy ? `Requested by ${input.requestedBy}.` : "Requested from the ops page.",
    "If you received this, owner email alerts are configured correctly.",
  ];

  console.info("Owner email test requested", {
    accountId: input.account.accountId,
    accountSlug: input.account.accountSlug,
    hasResendApiKey: Boolean(env.resendApiKey),
    hasRecipient: Boolean(recipient),
  });

  return sendEmail({
    to: recipient,
    subject: `Relay NW email test for ${input.account.businessName}`,
    html: emailHtml({
      title: "Owner email test",
      preview: "Relay NW owner email notifications are working.",
      lines,
      actionLabel: "Open ops",
      actionUrl: `${env.appBaseUrl}/ops`,
    }),
    text: `${lines.join("\n")}\n\nOpen ops: ${env.appBaseUrl}/ops`,
    tag: "owner_email_test",
  });
}

export async function notifyOwnerPasswordSetup(input: {
  to: string;
  setupUrl: string;
}) {
  const lines = [
    "Use this secure link to set your Relay NW password.",
    "The link is single-use. If it expires, request a fresh setup link from the sign-in page.",
  ];

  return sendEmail({
    to: input.to,
    subject: "Set your Relay NW password",
    html: emailHtml({
      title: "Set your password",
      preview: "Use this secure link to set your Relay NW password.",
      lines,
      actionLabel: "Set password",
      actionUrl: input.setupUrl,
    }),
    text: `${lines.join("\n")}\n\nSet password: ${input.setupUrl}`,
    tag: "owner_password_setup",
  });
}

export async function notifyOwnerKickoffPayment(input: {
  to: string;
  businessName: string;
  checkoutUrl: string;
  feeWaived: boolean;
}) {
  const lines = input.feeWaived
    ? [
        `Relay NW waived the setup fee for ${input.businessName}.`,
        "Use the secure Stripe link to save a payment method. Monthly billing does not start from this step.",
      ]
    : [
        `Relay NW setup for ${input.businessName} starts with a one-time $150 kickoff payment.`,
        "Use the secure Stripe link to pay and save your card. Monthly billing starts only after setup is approved and Relay activates the account.",
      ];

  return sendEmail({
    to: input.to,
    subject: input.feeWaived ? "Save your Relay NW payment method" : "Complete your Relay NW kickoff payment",
    html: emailHtml({
      title: input.feeWaived ? "Save payment method" : "Complete kickoff",
      preview: lines[0],
      lines,
      actionLabel: input.feeWaived ? "Save card securely" : "Pay $150 securely",
      actionUrl: input.checkoutUrl,
    }),
    text: `${lines.join("\n")}\n\nSecure Stripe link: ${input.checkoutUrl}`,
    tag: input.feeWaived ? "owner_kickoff_card_save" : "owner_kickoff_payment",
  });
}

export async function notifyOwnerNewMissedCallLead(input: {
  account: AccountRuntimeConfig;
  leadId: string;
  callerPhone: string;
  smsStatus: string;
}) {
  const recipient = await ownerEmail(input.account);
  const last4 = phoneLast4(input.callerPhone) ?? "unknown";
  const smsLine = input.account.smsEnabled
    ? `SMS status: ${input.smsStatus}.`
    : "SMS is disabled until A2P/10DLC is approved.";
  const lines = [
    `New missed-call lead for ${input.account.businessName}.`,
    `Caller ending in ${last4}.`,
    smsLine,
  ];

  console.info("Owner missed-call email requested", {
    accountId: input.account.accountId,
    accountSlug: input.account.accountSlug,
    leadId: input.leadId,
    callerLast4: last4,
    smsStatus: input.smsStatus,
    hasResendApiKey: Boolean(env.resendApiKey),
    hasRecipient: Boolean(recipient),
  });

  return sendEmail({
    to: recipient,
    subject: `New missed call for ${input.account.businessName}`,
    html: emailHtml({
      title: "New missed call",
      preview: `Caller ending in ${last4}`,
      lines,
      actionLabel: "Open leads",
      actionUrl: `${env.appBaseUrl}/leads`,
    }),
    text: `${lines.join("\n")}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    tag: "owner_new_missed_call",
  });
}

export async function notifyOwnerVoicemailReady(input: {
  account: AccountRuntimeConfig;
  leadId: string;
  callerPhone?: string | null;
  summary: string;
}) {
  const recipient = await ownerEmail(input.account);
  const last4 = phoneLast4(input.callerPhone) ?? "unknown";
  const lines = [
    `Voicemail summary for ${input.account.businessName}.`,
    `Caller ending in ${last4}.`,
    input.summary,
  ];

  return sendEmail({
    to: recipient,
    subject: `Voicemail ready for ${input.account.businessName}`,
    html: emailHtml({
      title: "Voicemail ready",
      preview: input.summary,
      lines,
      actionLabel: "Open lead inbox",
      actionUrl: `${env.appBaseUrl}/leads`,
    }),
    text: `${lines.join("\n")}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    tag: "owner_voicemail_ready",
  });
}

export async function notifyOwnerInboundReply(input: {
  account: AccountRuntimeConfig;
  callerPhone: string;
  body: string;
}) {
  const recipient = await ownerEmail(input.account);
  const last4 = phoneLast4(input.callerPhone) ?? "unknown";
  const preview = input.body.slice(0, 220);
  const lines = [
    `New reply for ${input.account.businessName}.`,
    `Caller ending in ${last4}.`,
    preview,
  ];

  return sendEmail({
    to: recipient,
    subject: `Reply from missed-call lead for ${input.account.businessName}`,
    html: emailHtml({
      title: "New caller reply",
      preview,
      lines,
      actionLabel: "Open leads",
      actionUrl: `${env.appBaseUrl}/leads`,
    }),
    text: `${lines.join("\n")}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    tag: "owner_inbound_reply",
  });
}

export async function notifyOwnerOptOut(input: {
  account: AccountRuntimeConfig;
  callerPhone: string;
}) {
  const recipient = await ownerEmail(input.account);
  const last4 = phoneLast4(input.callerPhone) ?? "unknown";
  const lines = [
    `A caller opted out of texts from ${input.account.businessName}.`,
    `Caller ending in ${last4}.`,
    "Relay NW will suppress future automatic missed-call texts to this number for this account.",
  ];

  return sendEmail({
    to: recipient,
    subject: `Caller opted out of texts for ${input.account.businessName}`,
    html: emailHtml({
      title: "Caller opted out",
      preview: `Caller ending in ${last4} opted out of texts.`,
      lines,
      actionLabel: "Open leads",
      actionUrl: `${env.appBaseUrl}/leads`,
    }),
    text: `${lines.join("\n")}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    tag: "owner_opt_out",
  });
}

export async function notifyOwnerBillingPaymentFailed(input: {
  account: AccountRuntimeConfig;
  eventType: "invoice.payment_failed" | "invoice.payment_action_required";
}) {
  const recipient = await ownerEmail(input.account);
  const needsAction = input.eventType === "invoice.payment_action_required";
  const title = needsAction ? "Payment needs approval" : "Payment did not go through";
  const lines = [
    needsAction
      ? "Stripe needs you to approve or update the payment method for Relay NW."
      : "Your payment didn’t go through.",
    "Relay is still catching missed calls while you update your payment method.",
    "Open Settings and use Update payment to fix billing securely in Stripe.",
  ];

  return sendEmail({
    to: recipient,
    subject: `${title} for ${input.account.businessName}`,
    html: emailHtml({
      title,
      preview: "Relay is still catching missed calls while payment is fixed.",
      lines,
      actionLabel: "Update payment",
      actionUrl: `${env.appBaseUrl}/settings#billing`,
    }),
    text: `${lines.join("\n")}\n\nUpdate payment: ${env.appBaseUrl}/settings#billing`,
    tag: needsAction ? "owner_billing_payment_action_required" : "owner_billing_payment_failed",
  });
}

export async function notifyOwnerSubscriptionScheduledToEnd(input: {
  account: AccountRuntimeConfig;
  currentPeriodEnd: string | null;
}) {
  const recipient = await ownerEmail(input.account);
  const endDate = input.currentPeriodEnd
    ? new Date(input.currentPeriodEnd).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const lines = [
    endDate
      ? `Your Relay NW subscription is scheduled to end on ${endDate}.`
      : "Your Relay NW subscription is scheduled to end.",
    "Relay is still catching missed calls during the current billing period.",
    "Open Settings to manage or reactivate the subscription in Stripe.",
  ];

  return sendEmail({
    to: recipient,
    subject: `Relay NW subscription scheduled to end for ${input.account.businessName}`,
    html: emailHtml({
      title: "Subscription scheduled to end",
      preview: "Relay is still catching missed calls during the current billing period.",
      lines,
      actionLabel: "Manage billing",
      actionUrl: `${env.appBaseUrl}/settings#billing`,
    }),
    text: `${lines.join("\n")}\n\nManage billing: ${env.appBaseUrl}/settings#billing`,
    tag: "owner_subscription_scheduled_to_end",
  });
}

export async function notifyOwnerBillingRecovered(input: {
  account: AccountRuntimeConfig;
}) {
  const recipient = await ownerEmail(input.account);
  const lines = [
    "Your Relay NW billing is back in good standing.",
    "Relay kept catching missed calls while payment was being resolved.",
  ];

  return sendEmail({
    to: recipient,
    subject: `Relay NW billing recovered for ${input.account.businessName}`,
    html: emailHtml({
      title: "Billing recovered",
      preview: "Relay NW billing is back in good standing.",
      lines,
      actionLabel: "Open Settings",
      actionUrl: `${env.appBaseUrl}/settings#billing`,
    }),
    text: `${lines.join("\n")}\n\nOpen Settings: ${env.appBaseUrl}/settings#billing`,
    tag: "owner_billing_recovered",
  });
}

export async function notifyOwnerBillingTrialExpired(input: {
  account: AccountRuntimeConfig;
  trialEndsAt: string | null;
}) {
  const recipient = await ownerEmail(input.account);
  const trialEnd = input.trialEndsAt
    ? new Date(input.trialEndsAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const lines = [
    trialEnd
      ? `Your Relay NW trial for ${input.account.businessName} ended on ${trialEnd}.`
      : `Your Relay NW trial for ${input.account.businessName} has ended.`,
    "Start billing to continue on a paid subscription.",
    "Relay is still catching missed calls while billing is resolved.",
  ];

  return sendEmail({
    to: recipient,
    subject: `Relay NW trial ended for ${input.account.businessName}`,
    html: emailHtml({
      title: "Trial ended",
      preview: "Start billing to continue on a paid subscription.",
      lines,
      actionLabel: "Start billing",
      actionUrl: `${env.appBaseUrl}/settings#billing`,
    }),
    text: `${lines.join("\n")}\n\nStart billing: ${env.appBaseUrl}/settings#billing`,
    tag: "owner_billing_trial_expired",
  });
}

export async function notifyAdminNewSetupRequest(input: {
  account: AccountRuntimeConfig;
  leadName: string;
  ownerPhone: string;
  message: string;
}) {
  const last4 = phoneLast4(input.ownerPhone) ?? "unknown";
  const lines = [
    `New Relay NW setup request for ${input.leadName}.`,
    `Caller ending in ${last4}.`,
    input.message,
  ];

  return sendEmail({
    to: env.adminAlertEmail,
    subject: `New Relay NW setup request: ${input.leadName}`,
    html: emailHtml({
      title: "New setup request",
      preview: `Setup request from ${input.leadName}`,
      lines,
      actionLabel: "Open lead inbox",
      actionUrl: `${env.appBaseUrl}/leads`,
    }),
    text: `${lines.join("\n\n")}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    tag: "admin_new_setup_request",
  });
}

export async function notifyAdminOperationalIssue(input: {
  account?: AccountRuntimeConfig | null;
  issue: string;
  detail?: string | null;
  correlationId?: string | null;
}) {
  const lines = [
    `Issue: ${input.issue}`,
    input.account ? `Account: ${input.account.accountSlug} (${input.account.businessName})` : "Account: unknown",
    input.correlationId ? `Correlation: ${input.correlationId}` : null,
    input.detail ? `Detail: ${input.detail.slice(0, 1000)}` : null,
  ].filter((line): line is string => Boolean(line));

  return sendEmail({
    to: env.adminAlertEmail,
    subject: `Relay NW alert: ${input.issue}`,
    html: emailHtml({
      title: "Operational alert",
      preview: input.issue,
      lines,
      actionLabel: "Open ops",
      actionUrl: `${env.appBaseUrl}/ops`,
    }),
    text: `${lines.join("\n")}\n\nOpen ops: ${env.appBaseUrl}/ops`,
    tag: "admin_operational_issue",
  });
}

function formatDollars(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export async function notifyOwnerWeeklyDigest(input: {
  account: AccountRuntimeConfig;
  stats: {
    missedCalls: number;
    textedBack: number;
    urgent: number;
    replies: number;
    booked: number;
    recoveredCents: number;
  };
  periodLabel: string;
}) {
  const recipient = await ownerEmail(input.account);
  const { stats } = input;

  const headline = stats.recoveredCents > 0
    ? `Relay recovered ${formatDollars(stats.recoveredCents)} for ${input.account.businessName} ${input.periodLabel}.`
    : `Relay caught ${stats.missedCalls} missed ${stats.missedCalls === 1 ? "call" : "calls"} for ${input.account.businessName} ${input.periodLabel}.`;

  const lines = [
    headline,
    `Missed calls caught: ${stats.missedCalls}`,
    `Callers texted back automatically: ${stats.textedBack}`,
    `ASAP callbacks flagged: ${stats.urgent}`,
    `Customer replies: ${stats.replies}`,
    stats.booked > 0 && stats.recoveredCents > 0
      ? `Jobs booked: ${stats.booked} (${formatDollars(stats.recoveredCents)})`
      : stats.booked > 0
        ? `Jobs booked: ${stats.booked} — add job values so this report can show recovered revenue.`
        : "Jobs booked: none yet — mark leads as booked with a value so this report can show recovered revenue.",
  ];

  return sendEmail({
    to: recipient,
    subject: `Your week with Relay NW: ${stats.missedCalls} missed ${stats.missedCalls === 1 ? "call" : "calls"} caught${stats.recoveredCents > 0 ? `, ${formatDollars(stats.recoveredCents)} recovered` : ""}`,
    html: emailHtml({
      title: "Your weekly recovery report",
      preview: headline,
      lines,
      actionLabel: "See the full report",
      actionUrl: `${env.appBaseUrl}/reports`,
    }),
    text: `${lines.join("\n")}\n\nFull report: ${env.appBaseUrl}/reports`,
    tag: "owner_weekly_digest",
  });
}
