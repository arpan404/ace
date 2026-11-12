import { describe, expect, it } from "vitest";
import {
  PhoneNotificationPrefs,
  alertDelivery,
  defaultPhonePrefs,
  phoneCategory,
  phoneDelivery,
} from "./notification-delivery.ts";

const open = { foreground: true, minuteOfDay: 12 * 60 };
const away = { foreground: false, minuteOfDay: 12 * 60 };
const prefs = (patch: Partial<PhoneNotificationPrefs>) => ({ ...defaultPhonePrefs, ...patch });
const all = (value: boolean) => ({
  needsYou: value,
  failures: value,
  finished: value,
  agentSays: value,
  limits: value,
});

describe("phone notification delivery", () => {
  it("shows requests, failures and finishes as a banner while open and a notification while away, by default", () => {
    for (const status of ["needs_you", "failed", "done"]) {
      expect(phoneDelivery(status, defaultPhonePrefs, open)).toEqual({
        post: true,
        interrupt: true,
        banner: true,
      });
      expect(phoneDelivery(status, defaultPhonePrefs, away)).toEqual({
        post: true,
        interrupt: true,
        banner: false,
      });
    }
  });

  it("leaves agent messages out unless the person turned them on", () => {
    expect(phoneDelivery("agent_says", defaultPhonePrefs, away).post).toBe(false);
    expect(phoneDelivery("agent_says", defaultPhonePrefs, open).post).toBe(false);
    const optedIn = prefs({ system: all(true) });
    expect(phoneDelivery("agent_says", optedIn, away).post).toBe(true);
  });

  it("files an alert quietly in the list while open when only its system notification is on", () => {
    const quietBanners = prefs({ inApp: { ...all(true), finished: false } });
    expect(phoneDelivery("done", quietBanners, open)).toEqual({
      post: true,
      interrupt: false,
      banner: false,
    });
    expect(phoneDelivery("needs_you", quietBanners, open).banner).toBe(true);
  });

  it("an older phone's preferences without usage limits read them as on", () => {
    const older = PhoneNotificationPrefs.parse({
      inApp: { needsYou: true, failures: true, finished: true, agentSays: false },
      system: { needsYou: true, failures: true, finished: true, agentSays: false },
      quietHours: null,
    });
    expect(phoneDelivery("limits", older, open)).toMatchObject({ post: true, banner: true });
    expect(phoneDelivery("limits", older, away).post).toBe(true);
  });

  it("posts nothing for a category that is off everywhere", () => {
    const off = prefs({
      inApp: { ...all(true), agentSays: false },
      system: { ...all(true), agentSays: false },
    });
    expect(phoneDelivery("agent_says", off, open).post).toBe(false);
    expect(phoneDelivery("agent_says", off, away).post).toBe(false);
  });

  it("still shows a banner while open for a category whose system notification is off", () => {
    const bannerOnly = prefs({ system: all(false) });
    expect(phoneDelivery("failed", bannerOnly, open)).toMatchObject({ post: true, banner: true });
    expect(phoneDelivery("failed", bannerOnly, away).post).toBe(false);
  });

  it("delivers quietly inside quiet hours that cross midnight, and normally outside them", () => {
    const night = prefs({ quietHours: { start: 22 * 60, end: 7 * 60 } });
    expect(phoneDelivery("needs_you", night, { foreground: false, minuteOfDay: 23 * 60 })).toEqual({
      post: true,
      interrupt: false,
      banner: false,
    });
    expect(
      phoneDelivery("needs_you", night, { foreground: false, minuteOfDay: 6 * 60 }).interrupt,
    ).toBe(false);
    expect(
      phoneDelivery("needs_you", night, { foreground: false, minuteOfDay: 7 * 60 }).interrupt,
    ).toBe(true);
    // Quiet hours are for the locked phone; banners in the open app still show.
    expect(
      phoneDelivery("needs_you", night, { foreground: true, minuteOfDay: 23 * 60 }).banner,
    ).toBe(true);
  });

  it("sorts daemon statuses as the desktop does, unknown ones as finished", () => {
    expect(phoneCategory("catch_up")).toBe("needsYou");
    expect(phoneCategory("unresponsive")).toBe("failures");
    expect(phoneCategory("background_done")).toBe("finished");
    expect(phoneCategory("something_new")).toBe("finished");
  });

  it("reads missing or malformed stored preferences as the defaults", () => {
    expect(PhoneNotificationPrefs.parse({})).toEqual(defaultPhonePrefs);
    expect(
      PhoneNotificationPrefs.parse({
        inApp: { needsYou: "yes" },
        quietHours: { start: 9999, end: 1 },
      }),
    ).toMatchObject({ inApp: { needsYou: true, failures: true }, quietHours: null });
  });
});

const own = (status: string) => ({ status, delegated: false });
const delegated = (status: string) => ({ status, delegated: true });

describe("which alerts the phone posts at all", () => {
  it("a background task finishing never alerts, whatever the settings", () => {
    const everything = prefs({ inApp: all(true), system: all(true) });
    expect(alertDelivery(own("background_done"), everything, away).post).toBe(false);
    expect(alertDelivery(own("background_done"), everything, open).post).toBe(false);
  });

  it("a delegated thread alerts only for a request of its own, never for finishing or failing", () => {
    expect(alertDelivery(delegated("done"), defaultPhonePrefs, away).post).toBe(false);
    expect(alertDelivery(delegated("failed"), defaultPhonePrefs, away).post).toBe(false);
    expect(alertDelivery(delegated("needs_you"), defaultPhonePrefs, away).post).toBe(true);
  });

  it("the person's own thread finishing, failing or asking alerts", () => {
    for (const status of ["done", "failed", "needs_you"])
      expect(alertDelivery(own(status), defaultPhonePrefs, away)).toEqual({
        post: true,
        interrupt: true,
        banner: false,
      });
  });
});
