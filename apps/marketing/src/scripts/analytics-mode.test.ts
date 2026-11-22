import { expect, test } from "vitest";
import { analyticsMode, countryFromTrace, needsCountry } from "./analytics-mode.ts";

const trace = (loc: string) => `fl=12f\nh=acehq.dev\nip=203.0.113.9\nloc=${loc}\ntls=TLSv1.3\n`;

test("a visitor from the US with no choice and no opt-out signal is recorded", () => {
  expect(analyticsMode({ choice: undefined, optOutSignal: false, country: "US" })).toBe("full");
});

test("visitors from the EEA, the UK and Switzerland stay anonymous until they turn recording on", () => {
  for (const country of ["DE", "FR", "NO", "GB", "CH"]) {
    expect(analyticsMode({ choice: undefined, optOutSignal: false, country })).toBe("anonymous");
    expect(analyticsMode({ choice: "on", optOutSignal: false, country })).toBe("full");
  }
});

test("Global Privacy Control keeps a visit anonymous unless the visitor turned recording on", () => {
  expect(analyticsMode({ choice: undefined, optOutSignal: true, country: "US" })).toBe("anonymous");
  expect(analyticsMode({ choice: "on", optOutSignal: true, country: "US" })).toBe("full");
});

test("turning recording off is kept everywhere", () => {
  expect(analyticsMode({ choice: "off", optOutSignal: false, country: "US" })).toBe("anonymous");
});

test("an unknown country is treated as one that needs consent", () => {
  expect(analyticsMode({ choice: undefined, optOutSignal: false, country: undefined })).toBe(
    "anonymous",
  );
  expect(countryFromTrace(trace("XX"))).toBeUndefined();
  expect(countryFromTrace(trace("T1"))).toBeUndefined();
  expect(countryFromTrace("<html>404</html>")).toBeUndefined();
});

test("the country is read from Cloudflare's trace", () => {
  expect(countryFromTrace(trace("US"))).toBe("US");
  expect(countryFromTrace(trace("GB"))).toBe("GB");
});

test("the country is looked up only when neither a choice nor an opt-out signal decides", () => {
  expect(needsCountry(undefined, false)).toBe(true);
  expect(needsCountry("off", false)).toBe(false);
  expect(needsCountry(undefined, true)).toBe(false);
});
