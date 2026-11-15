/**
 * Push when the app is closed (`notifications.remotePush`, ADR 0106), in the same words on the
 * web's Notifications page and the phone's: a machine sends its phones' alerts through ace's push
 * gateway, which relays sealed payloads it can't read.
 */
export const remotePushSwitch = {
  title: "Push when the app is closed",
  description: "Goes through ace's push service, which sees only encrypted data.",
} as const;
