import { describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  formatRelativeTimeLabel,
  getTimestampFormatOptions,
} from "./timeFormat";

describe("timeFormat", () => {
  it("maps explicit hour-cycle settings to Intl options", () => {
    expect(getTimestampFormatOptions("12-hour", false)).toMatchObject({
      hour: "numeric",
      hour12: true,
      minute: "2-digit",
    });
    expect(getTimestampFormatOptions("24-hour", true)).toMatchObject({
      hour: "numeric",
      hour12: false,
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("formats relative time labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));

    expect(formatRelativeTime("2026-05-02T11:58:00.000Z")).toEqual({
      value: "2m",
      suffix: "ago",
    });
    expect(formatRelativeTimeLabel("2026-05-02T12:00:00.000Z")).toBe("just now");

    vi.useRealTimers();
  });
});
