import { afterEach, expect, test, vi } from "vitest";
import {
  formatAge,
  formatAgo,
  formatClock,
  formatElapsed,
  formatShortClock,
  formatSpan,
} from "./time.ts";

const s = 1000;
const m = 60 * s;
const h = 60 * m;
const d = 24 * h;

test("list ages read now, minutes, hours, days, then weeks", () => {
  expect(formatAge(1000, 1000 + 30 * s)).toBe("now");
  expect(formatAge(0, 2 * m)).toBe("2m");
  expect(formatAge(0, 3 * h)).toBe("3h");
  expect(formatAge(0, 4 * d)).toBe("4d");
  expect(formatAge(0, 42 * d)).toBe("6w");
});

test("an age inside a sentence reads just now, then so long ago", () => {
  expect(formatAgo(0, 10 * s)).toBe("just now");
  expect(formatAgo(0, 12 * m)).toBe("12m ago");
});

test("an age in the future, from clock skew, reads now", () => {
  expect(formatAge(10 * m, 0)).toBe("now");
});

test("elapsed turn time keeps seconds until an hour", () => {
  expect(formatElapsed(38 * s)).toBe("38s");
  expect(formatElapsed(4 * m + 12 * s)).toBe("4m 12s");
  expect(formatElapsed(h + 2 * m)).toBe("1h 2m");
});

test("a run span rounds to minutes and drops a zero remainder", () => {
  expect(formatSpan(0, 42 * s)).toBe("42s");
  expect(formatSpan(0, 6 * m + 20 * s)).toBe("6m");
  expect(formatSpan(0, h + 12 * m)).toBe("1h 12m");
  expect(formatSpan(0, 2 * h)).toBe("2h");
});

test("reset clocks follow the locale's 12 or 24 hour setting without padding the hour", () => {
  const at = new Date(2026, 0, 2, 13, 33).getTime();
  expect(formatClock(at, "en-US")).toBe("1:33 PM");
  expect(formatClock(at, "en-GB")).toBe("13:33");
});

test("day periods have the same casing across locales and explicit schedule zones", () => {
  const at = Date.UTC(2026, 9, 8, 22, 32);
  expect(formatClock(at, "en-US", "America/Chicago")).toBe("5:32 PM");
  expect(formatClock(at, "en-AU", "America/Chicago")).toBe("5:32 PM");
  expect(formatClock(at, "en-GB", "America/Chicago")).toBe("17:32");
});

test("a clock in the host's zone follows the person changing zone mid-session", () => {
  const before = process.env.TZ;
  const at = Date.UTC(2026, 0, 15, 12, 0);
  try {
    process.env.TZ = "UTC";
    expect(formatClock(at, "en-GB")).toBe("12:00");
    process.env.TZ = "Asia/Kolkata";
    expect(formatClock(at, "en-GB")).toBe("17:30");
    expect(formatShortClock(at, "en-GB")).toBe("17:30");
    process.env.TZ = "America/New_York";
    expect(formatClock(at, "en-US")).toBe("7:00 AM");
    // Summer time in the same zone.
    expect(formatClock(Date.UTC(2026, 6, 15, 12, 0), "en-US")).toBe("8:00 AM");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

/** Runs `body` with the host in each zone in turn, restoring the host's own zone after. */
function inZones(body: (zone: (name: string) => void) => void) {
  const before = process.env.TZ;
  try {
    body((name) => {
      process.env.TZ = name;
    });
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("zones that agree in winter and summer but not on the day still read their own clocks", () => {
  // Casablanca drops to UTC during Ramadan (1 March 2026); Algiers stays an hour ahead.
  const winter = Date.UTC(2026, 0, 15, 12, 0);
  const ramadan = Date.UTC(2026, 2, 1, 12, 0);
  inZones((zone) => {
    zone("Africa/Casablanca");
    expect(formatClock(winter, "en-GB")).toBe("13:00");
    expect(formatShortClock(winter, "en-GB")).toBe("13:00");
    expect(formatClock(ramadan, "en-GB")).toBe("12:00");
    expect(formatShortClock(ramadan, "en-GB")).toBe("12:00");
    zone("Africa/Algiers");
    expect(formatClock(ramadan, "en-GB")).toBe("13:00");
    expect(formatShortClock(ramadan, "en-GB")).toBe("13:00");
    zone("Africa/Casablanca");
    expect(formatClock(ramadan, "en-GB")).toBe("12:00");
    expect(formatShortClock(ramadan, "en-GB")).toBe("12:00");
  });
});

test("clocks read the right side of each daylight saving change", () => {
  inZones((zone) => {
    zone("America/New_York");
    // Spring forward on 8 March 2026 at 07:00 UTC, fall back on 1 November at 06:00 UTC.
    const instants = [
      [Date.UTC(2026, 2, 8, 6, 59), "1:59 AM", "01:59"],
      [Date.UTC(2026, 2, 8, 7, 0), "3:00 AM", "03:00"],
      [Date.UTC(2026, 10, 1, 5, 59), "1:59 AM", "01:59"],
      [Date.UTC(2026, 10, 1, 6, 0), "1:00 AM", "01:00"],
    ] as const;
    for (const [at, clock, short] of instants) {
      expect(formatClock(at, "en-US")).toBe(clock);
      expect(formatShortClock(at, "en-GB")).toBe(short);
    }
  });
});

/**
 * A host whose default locale is whatever `current` returns, as an engine reads it from the
 * system: every Intl service and Date's locale methods resolve an omitted locale to it.
 */
function hostLocale(current: () => string) {
  const services = [
    "DateTimeFormat",
    "NumberFormat",
    "ListFormat",
    "PluralRules",
    "Collator",
    "RelativeTimeFormat",
    "Segmenter",
  ] as const;
  const replaced: PropertyDescriptorMap = {};
  for (const name of services) {
    const System: new (locales?: Intl.LocalesArgument, options?: object) => object = Intl[name];
    replaced[name] = {
      value: class extends System {
        constructor(locales?: Intl.LocalesArgument, options?: object) {
          super(locales ?? current(), options);
        }
      },
    };
  }
  vi.stubGlobal("Intl", Object.create(Intl, replaced));
  for (const method of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const) {
    const system = Date.prototype[method];
    vi.spyOn(Date.prototype, method).mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      return system.call(this, locales ?? current(), options);
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("clocks without a locale follow the host's default locale changing mid-session", () => {
  const at = Date.UTC(2026, 0, 15, 13, 5);
  let locale = "en-US";
  hostLocale(() => locale);
  inZones((zone) => {
    zone("UTC");
    expect(formatClock(at)).toBe("1:05 PM");
    expect(formatShortClock(at)).toBe("13:05");
    locale = "en-GB";
    expect(formatClock(at)).toBe("13:05");
    // The same language and region with another hour cycle or digits.
    locale = "en-GB-u-hc-h12";
    expect(formatClock(at)).toBe("1:05 PM");
    locale = "ar-EG";
    expect(formatShortClock(at)).toBe("١٣:٠٥");
    locale = "ar-EG-u-nu-latn";
    expect(formatShortClock(at)).toBe("13:05");
  });
});
