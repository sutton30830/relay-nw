import {
  billingUpdateFromSubscription,
  retrieveStripePaymentIntent,
  retrieveStripeSetupCheckoutSession,
  retrieveStripeSubscription,
  setupFeeStateFromPayment,
} from "@/lib/stripe-billing";
import { updateAccountBillingRecord, type OpsBillingAccount } from "@/lib/supabase";

export async function reconcileStripeBillingAccount(account: OpsBillingAccount) {
  let setupFeeChecked = false;
  let subscriptionChecked = false;

  let setupPaymentIntentId = account.setupFeePaymentIntentId;
  if (!setupPaymentIntentId && account.setupFeeCheckoutSessionId) {
    const checkout = await retrieveStripeSetupCheckoutSession(account.setupFeeCheckoutSessionId);
    const payment = checkout.paymentIntent;
    if (payment) {
      const state = setupFeeStateFromPayment(payment);
      await updateAccountBillingRecord(account.accountId, {
        ...state,
        stripeCustomerId: checkout.customerId ?? payment.customerId ?? account.stripeCustomerId,
        stripePaymentMethodId: payment.paymentMethodId ?? account.stripePaymentMethodId,
        setupFeePaymentIntentId: payment.id,
        setupFeeRefundedAt: state.setupFeeRefundedCents > 0
          ? account.setupFeeRefundedAt ?? new Date().toISOString()
          : null,
      });
      setupPaymentIntentId = payment.id;
      setupFeeChecked = true;
    }
  }

  if (setupPaymentIntentId && !setupFeeChecked) {
    const payment = await retrieveStripePaymentIntent(setupPaymentIntentId);
    const state = setupFeeStateFromPayment(payment);
    await updateAccountBillingRecord(account.accountId, {
      ...state,
      stripeCustomerId: payment.customerId ?? account.stripeCustomerId,
      stripePaymentMethodId: payment.paymentMethodId ?? account.stripePaymentMethodId,
      setupFeeRefundedAt: state.setupFeeRefundedCents > 0
        ? account.setupFeeRefundedAt ?? new Date().toISOString()
        : null,
    });
    setupFeeChecked = true;
  }

  if (account.stripeSubscriptionId) {
    try {
      const subscription = await retrieveStripeSubscription(account.stripeSubscriptionId);
      await updateAccountBillingRecord(account.accountId, billingUpdateFromSubscription(account.accountId, subscription));
    } catch (error) {
      if (/no such subscription|resource_missing/i.test(error instanceof Error ? error.message : String(error))) {
        await updateAccountBillingRecord(account.accountId, {
          billingStatus: "canceled",
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          cancelAtPeriodEnd: false,
          canceledAt: new Date().toISOString(),
        });
      } else {
        throw error;
      }
    }
    subscriptionChecked = true;
  }

  return { setupFeeChecked, subscriptionChecked };
}
