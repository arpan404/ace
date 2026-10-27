import { describe, expect, it } from "vitest";
import {
  PhoneNotificationPrefs,
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
});

describe("phone notification delivery", () => {
  it("shows every category as a banner while open and a notification while away, by default", () => {
    for (const status of ["needs_you", "failed", "done", "agent_says"]) {
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

  it("files an alert quietly in the list while open when only its system notification is on", () => {
    const quietBanners = prefs({ inApp: { ...all(true), finished: false } });
    expect(phoneDelivery("done", quietBanners, open)).toEqual({
      post: true,
      interrupt: false,
      banner: false,
    });
    expect(phoneDelivery("needs_you", quietBanners, open).banner).toBe(true);
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
