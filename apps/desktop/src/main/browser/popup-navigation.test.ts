import { expect, it } from "vitest";
import { popupNavigation, UserActivation } from "./popup-navigation.ts";

const current = "https://docs.example/tags/page.html";

it("a popup to the current address does not reload the page", () => {
  expect(popupNavigation({ url: current, current, activated: true })).toBeUndefined();
});

it("a script-opened blank or non-web popup does not replace the page", () => {
  for (const url of ["", "about:blank", "javascript:void(0)", "data:text/html,ad"])
    expect(popupNavigation({ url, current, activated: true })).toBeUndefined();
});

it("a popup opened without recent input does not replace the page", () => {
  expect(
    popupNavigation({ url: "https://ads.example/landing", current, activated: false }),
  ).toBeUndefined();
});

it("a new-tab link clicked by the person opens in the page", () => {
  expect(popupNavigation({ url: "https://other.example/a?b=1", current, activated: true })).toBe(
    "https://other.example/a?b=1",
  );
});

it("input keeps a page activated for five seconds, then lapses", () => {
  let now = 1_000;
  const activation = new UserActivation(() => now);
  expect(activation.active()).toBe(false);
  activation.note();
  now += 5_000;
  expect(activation.active()).toBe(true);
  now += 1;
  expect(activation.active()).toBe(false);
});
