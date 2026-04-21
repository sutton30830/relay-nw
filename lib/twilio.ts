import twilio from "twilio";
import { env } from "@/lib/env";

export const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

export function missedCallSmsBody() {
  return `Hi, this is ${env.businessName}. Sorry we missed your call. You can fill out our intake form here: ${env.intakeUrl} or book here: ${env.schedulingUrl}. Reply STOP to opt out.`;
}
