// Backward-compatible alias for Twilio numbers configured before /voice-status
// became the canonical Relay callback URL. This is not a Dial provider route.
export {
  getTwilioCallResultWebhook as GET,
  postTwilioCallResultWebhook as POST,
} from "@/lib/telephony/providers/twilio-webhooks";
