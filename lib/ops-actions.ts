import type { PlatformOperatorRole } from "@/lib/supabase";

export const OPS_ACTIONS = {
  accountRead: "account.read",
  diagnosticsRead: "diagnostics.read",
  voicemailRecovery: "voicemail.recovery.run",
  profileEdit: "account.profile.edit",
  assignExistingNumber: "twilio.number.assign_existing",
  releaseExistingNumber: "twilio.number.release_existing",
  a2pSync: "a2p.status.sync",
  blockerManage: "operations.blocker.manage",
  billingLinkSend: "billing.link.send",
  billingReconcile: "billing.reconcile",
  trialActivate: "billing.trial.activate",
  onboardingPause: "account.onboarding.pause",
  onboardingResume: "account.onboarding.resume",
  setupRequestAccept: "setup_request.accept",
  setupFeeWaive: "commercial.setup_fee.waive",
  setupFeeRequire: "commercial.setup_fee.require",
  serviceComp: "commercial.service.comp",
  serviceUncomp: "commercial.service.uncomp",
  accountClose: "account.close",
  accountReopen: "account.reopen",
  accountExport: "account.data.export",
  accountDelete: "account.data.delete",
  paidServicePause: "account.paid_service.pause",
  teamManage: "team.manage",
  stripePaymentMethods: "stripe.payment_methods",
  stripeInvoices: "stripe.invoices",
  stripeRefunds: "stripe.refunds",
  stripeRetries: "stripe.retries",
  stripeDisputes: "stripe.disputes",
  stripeCancellation: "stripe.cancellation",
} as const;

export type OpsAction = (typeof OPS_ACTIONS)[keyof typeof OPS_ACTIONS];

const SUPPORT_ACTIONS = new Set<OpsAction>([
  OPS_ACTIONS.accountRead,
  OPS_ACTIONS.diagnosticsRead,
]);

const OPERATOR_ACTIONS = new Set<OpsAction>([
  ...SUPPORT_ACTIONS,
  OPS_ACTIONS.voicemailRecovery,
  OPS_ACTIONS.profileEdit,
  OPS_ACTIONS.assignExistingNumber,
  OPS_ACTIONS.a2pSync,
  OPS_ACTIONS.blockerManage,
  OPS_ACTIONS.billingLinkSend,
  OPS_ACTIONS.billingReconcile,
  OPS_ACTIONS.trialActivate,
  OPS_ACTIONS.onboardingPause,
  OPS_ACTIONS.onboardingResume,
  OPS_ACTIONS.setupRequestAccept,
]);

const SUPER_ADMIN_ACTIONS = new Set<OpsAction>([
  ...OPERATOR_ACTIONS,
  OPS_ACTIONS.setupFeeWaive,
  OPS_ACTIONS.setupFeeRequire,
  OPS_ACTIONS.serviceComp,
  OPS_ACTIONS.serviceUncomp,
  OPS_ACTIONS.accountClose,
  OPS_ACTIONS.releaseExistingNumber,
  OPS_ACTIONS.accountReopen,
  OPS_ACTIONS.accountExport,
  OPS_ACTIONS.accountDelete,
  OPS_ACTIONS.paidServicePause,
  OPS_ACTIONS.teamManage,
]);

export const STRIPE_ONLY_ACTIONS = new Set<OpsAction>([
  OPS_ACTIONS.stripePaymentMethods,
  OPS_ACTIONS.stripeInvoices,
  OPS_ACTIONS.stripeRefunds,
  OPS_ACTIONS.stripeRetries,
  OPS_ACTIONS.stripeDisputes,
  OPS_ACTIONS.stripeCancellation,
]);

export const COMMERCIAL_EXCEPTION_ACTIONS = new Set<OpsAction>([
  OPS_ACTIONS.setupFeeWaive,
  OPS_ACTIONS.setupFeeRequire,
  OPS_ACTIONS.serviceComp,
  OPS_ACTIONS.serviceUncomp,
  OPS_ACTIONS.paidServicePause,
]);

export function canPerformOpsAction(
  role: PlatformOperatorRole,
  action: OpsAction,
) {
  if (STRIPE_ONLY_ACTIONS.has(action)) return false;
  if (role === "super_admin") return SUPER_ADMIN_ACTIONS.has(action);
  if (role === "operator") return OPERATOR_ACTIONS.has(action);
  return SUPPORT_ACTIONS.has(action);
}

export function hasExplicitOpsConfirmation(value: FormDataEntryValue | null) {
  return value === "confirmed";
}
