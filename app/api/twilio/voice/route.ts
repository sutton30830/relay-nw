export {
  getTwilioVoiceWebhook as GET,
  postTwilioVoiceWebhook as POST,
} from "@/lib/telephony/providers/twilio-webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;
