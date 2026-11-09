import { quietAt } from "@ace/notify/policy";
import { z } from "zod";

/*
 * What the phone does with one daemon alert, by this phone's own preferences (Settings ›
 * Notifications): the same four categories as the desktop, chosen separately for banners while
 * ace is open and for system notifications while it's in the background, plus the phone's own
 * quiet hours. The daemon still decides what is an alert; this only decides how it shows. Pure.
 */

export const phoneCategories = ["needsYou", "failures", "finished", "agentSays"] as const;
export type PhoneCategory = (typeof phoneCategories)[number];

const on = z.boolean().catch(true);
/** Agent messages are opt-in on the phone: by default it alerts only for requests, failures and finishes. */
const optIn = z.boolean().catch(false);
const Categories = z
  .object({ needsYou: on, failures: on, finished: on, agentSays: optIn })
  .catch({ needsYou: true, failures: true, finished: true, agentSays: false });
const minute = z.number().int().min(0).max(1439);

export const PhoneNotificationPrefs = z.object({
  /** Banners while ace is open. */
  inApp: Categories,
  /** System notifications while ace is in the background or closed. */
  system: Categories,
  /** Minutes after local midnight; the window may cross midnight. Null: no quiet hours. */
  quietHours: z.object({ start: minute, end: minute }).nullable().catch(null),
});
export type PhoneNotificationPrefs = z.infer<typeof PhoneNotificationPrefs>;

export const defaultPhonePrefs: PhoneNotificationPrefs = PhoneNotificationPrefs.parse({});

/** The category of a daemon alert status, as the desktop sorts them. */
export function phoneCategory(status: string): PhoneCategory {
  switch (status) {
    case "needs_you":
    case "catch_up":
      return "needsYou";
    case "failed":
    case "unresponsive":
      return "failures";
    case "agent_says":
      return "agentSays";
    default:
      return "finished";
  }
}

/**
 * `post`: add it to Notification Center at all. `interrupt`: sound and light the screen (off is
 * a quiet delivery straight to the list). `banner`: while ace is open, show it over the app.
 */
export interface PhoneDelivery {
  post: boolean;
  interrupt: boolean;
  banner: boolean;
}

export interface DeliveryContext {
  foreground: boolean;
  /** Minutes after local midnight now. */
  minuteOfDay: number;
}

/**
 * Open: a banner when the category's banner is on; otherwise, if its system notification is on,
 * a quiet entry in the list. Background: a system notification when its category is on, quiet
 * (no sound, no banner) during quiet hours. Off in both: nothing is posted.
 */
export function phoneDelivery(
  status: string,
  prefs: PhoneNotificationPrefs,
  context: DeliveryContext,
): PhoneDelivery {
  const category = phoneCategory(status);
  const system = prefs.system[category];
  if (context.foreground && prefs.inApp[category])
    return { post: true, interrupt: true, banner: true };
  if (!system) return { post: false, interrupt: false, banner: false };
  if (context.foreground) return { post: true, interrupt: false, banner: false };
  const quiet =
    prefs.quietHours !== null &&
    quietAt(
      { timeZone: "local", startMinute: prefs.quietHours.start, endMinute: prefs.quietHours.end },
      context.minuteOfDay,
    );
  return { post: true, interrupt: !quiet, banner: false };
}

/** What the phone knows about an alert's thread beyond the alert itself. */
export interface AlertFacts {
  status: string;
  /** An agent delegated the thread (here, or from a paired machine): it reports to its parent. */
  delegated: boolean;
}

const never: PhoneDelivery = { post: false, interrupt: false, banner: false };

/**
 * Whether the phone posts an alert at all, then how (`phoneDelivery`). It alerts only when the
 * person is needed, a failure stops a thread, or a thread of their own finishes: background
 * commands finishing never alert (the thread's own finish says it), and a delegated thread
 * alerts only for a request of its own, never for finishing or failing (its parent reports).
 */
export function alertDelivery(
  alert: AlertFacts,
  prefs: PhoneNotificationPrefs,
  context: DeliveryContext,
): PhoneDelivery {
  if (alert.status === "background_done") return never;
  if (alert.delegated && alert.status !== "needs_you") return never;
  return phoneDelivery(alert.status, prefs, context);
}
