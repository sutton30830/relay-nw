import {
  assertStripeObjectMode,
  assertStripeSubscriptionPrice,
  billingUpdateFromSubscription,
  reconcileSetupFeeStateFromPayment,
  retrieveStripeCustomerBillingProfile,
  retrieveStripePaymentIntent,
  retrieveStripeSetupCheckoutSession,
  retrieveStripeSetupIntent,
  retrieveStripeSubscription,
  setStripeCustomerDefaultPaymentMethod,
} from "@/lib/stripe-billing";
import { updateAccountBillingRecord, type OpsBillingAccount } from "@/lib/supabase";

function assertAccountScopedObject(
  account: OpsBillingAccount,
  object: {
    customerId: string | null;
    metadataAccountId?: string | null;
  },
  label: string,
) {
  if (
    object.metadataAccountId &&
    object.metadataAccountId !== account.accountId
  ) {
    throw new Error(`${label} belongs to a different Relay account.`);
  }
  if (
    account.stripeCustomerId &&
    object.customerId &&
    object.customerId !== account.stripeCustomerId
  ) {
    throw new Error(`${label} belongs to a different Stripe customer.`);
  }
}

export async function reconcileStripeBillingAccount(account: OpsBillingAccount) {
  let setupFeeChecked = false;
  let paymentMethodChecked = false;
  let subscriptionChecked = false;

  let setupPaymentIntentId = account.setupFeePaymentIntentId;
  if (!setupPaymentIntentId && account.setupFeeCheckoutSessionId) {
    const checkout = await retrieveStripeSetupCheckoutSession(account.setupFeeCheckoutSessionId);
    const payment = checkout.paymentIntent;
    if (payment) {
      assertStripeObjectMode(payment.livemode, "Stripe PaymentIntent");
      assertAccountScopedObject(account, payment, "Stripe PaymentIntent");
      const state = reconcileSetupFeeStateFromPayment(payment, account);
      await updateAccountBillingRecord(account.accountId, {
        ...state,
        stripeCustomerId: checkout.customerId ?? payment.customerId ?? account.stripeCustomerId,
        setupFeePaymentIntentId: payment.id,
        setupFeeRefundedAt: state.setupFeeRefundedCents > 0 || state.setupFeeStatus === "charged_back"
          ? account.setupFeeRefundedAt ?? new Date().toISOString()
          : account.setupFeeRefundedAt,
      });
      setupPaymentIntentId = payment.id;
      setupFeeChecked = true;
    }
  }

  let setupIntentId = account.stripeSetupIntentId;
  if (!setupIntentId && account.billingSetupCheckoutSessionId) {
    const checkout = await retrieveStripeSetupCheckoutSession(account.billingSetupCheckoutSessionId);
    if (checkout.setupIntent) {
      assertAccountScopedObject(account, checkout.setupIntent, "Stripe SetupIntent");
      setupIntentId = checkout.setupIntent.id;
      await updateAccountBillingRecord(account.accountId, {
        stripeCustomerId: checkout.customerId ?? checkout.setupIntent.customerId ?? account.stripeCustomerId,
        stripeSetupIntentId: checkout.setupIntent.id,
        stripeSetupIntentStatus: checkout.setupIntent.status,
      });
    }
  }

  if (setupIntentId) {
    const setupIntent = await retrieveStripeSetupIntent(setupIntentId);
    assertStripeObjectMode(setupIntent.livemode, "Stripe SetupIntent");
    assertAccountScopedObject(account, setupIntent, "Stripe SetupIntent");
    let defaultPaymentMethodId = account.stripeDefaultPaymentMethodId;
    if (
      setupIntent.status === "succeeded" &&
      setupIntent.customerId &&
      setupIntent.paymentMethodId
    ) {
      const customer = await setStripeCustomerDefaultPaymentMethod({
        customerId: setupIntent.customerId,
        paymentMethodId: setupIntent.paymentMethodId,
        idempotencyKey: `relay-default-payment-method:${account.accountId}:${setupIntent.id}`,
      });
      assertStripeObjectMode(customer.livemode, "Stripe customer");
      defaultPaymentMethodId = customer.defaultPaymentMethodId;
    }
    await updateAccountBillingRecord(account.accountId, {
      stripeCustomerId: setupIntent.customerId ?? account.stripeCustomerId,
      stripeSetupIntentId: setupIntent.id,
      stripeSetupIntentStatus: setupIntent.status,
      stripeDefaultPaymentMethodId: defaultPaymentMethodId,
      paymentMethodUpdatedAt: new Date().toISOString(),
    });
    paymentMethodChecked = true;
  }

  if (account.stripeCustomerId) {
    const customer = await retrieveStripeCustomerBillingProfile(account.stripeCustomerId);
    assertStripeObjectMode(customer.livemode, "Stripe customer");
    if (customer.id !== account.stripeCustomerId) {
      throw new Error("Stripe customer lookup returned a different customer.");
    }
    await updateAccountBillingRecord(account.accountId, {
      stripeDefaultPaymentMethodId: customer.defaultPaymentMethodId,
      paymentMethodUpdatedAt: new Date().toISOString(),
    });
    paymentMethodChecked = true;
  }

  if (setupPaymentIntentId && !setupFeeChecked) {
    const payment = await retrieveStripePaymentIntent(setupPaymentIntentId);
    assertStripeObjectMode(payment.livemode, "Stripe PaymentIntent");
    assertAccountScopedObject(account, payment, "Stripe PaymentIntent");
    const state = reconcileSetupFeeStateFromPayment(payment, account);
    await updateAccountBillingRecord(account.accountId, {
      ...state,
      stripeCustomerId: payment.customerId ?? account.stripeCustomerId,
      setupFeeRefundedAt: state.setupFeeRefundedCents > 0 || state.setupFeeStatus === "charged_back"
        ? account.setupFeeRefundedAt ?? new Date().toISOString()
        : account.setupFeeRefundedAt,
    });
    setupFeeChecked = true;
  }

  if (account.stripeSubscriptionId) {
    try {
      const subscription = await retrieveStripeSubscription(account.stripeSubscriptionId);
      assertStripeObjectMode(subscription.livemode, "Stripe subscription");
      assertStripeSubscriptionPrice(subscription.priceId, "Stripe subscription");
      if (
        subscription.metadataAccountId !== account.accountId ||
        (account.stripeCustomerId &&
          subscription.customerId !== account.stripeCustomerId)
      ) {
        throw new Error("Stripe subscription belongs to a different Relay account or customer.");
      }
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

  return { setupFeeChecked, paymentMethodChecked, subscriptionChecked };
}
