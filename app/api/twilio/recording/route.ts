export { postTwilioRecordingWebhook as POST } from "@/lib/telephony/providers/twilio-webhooks";

// Automatic transcription runs in after() within this function lifetime, so
// keep enough time for the complete voicemail pipeline.
export const runtime = "nodejs";
export const maxDuration = 120;
