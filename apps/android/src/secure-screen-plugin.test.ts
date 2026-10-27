import { expect, it } from "vitest";
import {
  applySecureScreenToMainActivity,
  SECURE_SCREEN_CALL,
  SECURE_SCREEN_IMPORT,
} from "../plugins/secure-screen-text.ts";

/** Minimal shape of the Expo MainActivity template the plugin anchors on. */
const TEMPLATE = `package dev.ace.android

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }
}
`;

it("inserts the import and the flag before super.onCreate", () => {
  const edited = applySecureScreenToMainActivity(TEMPLATE);
  expect(edited).toContain(SECURE_SCREEN_IMPORT);
  expect(edited).toContain(SECURE_SCREEN_CALL);
  expect(edited.indexOf(SECURE_SCREEN_CALL)).toBeLessThan(edited.indexOf("super.onCreate(null)"));
  expect(edited.indexOf(SECURE_SCREEN_IMPORT)).toBeLessThan(
    edited.indexOf("import android.os.Bundle"),
  );
});

it("never duplicates the wiring on plugin reruns", () => {
  const once = applySecureScreenToMainActivity(TEMPLATE);
  expect(applySecureScreenToMainActivity(once)).toBe(once);
});

it("repairs a half-applied edit without duplicating the other half", () => {
  const callOnly = applySecureScreenToMainActivity(TEMPLATE).replace(
    `${SECURE_SCREEN_IMPORT}\n`,
    "",
  );
  expect(callOnly).not.toContain(SECURE_SCREEN_IMPORT);
  const repaired = applySecureScreenToMainActivity(callOnly);
  expect(repaired).toContain(SECURE_SCREEN_IMPORT);
  expect(repaired.split(SECURE_SCREEN_CALL).length - 1).toBe(1);
});

it("refuses a generated MainActivity with an unexpected shape", () => {
  expect(() => applySecureScreenToMainActivity("class MainActivity {}")).toThrow(
    /MainActivity template changed/,
  );
  expect(() =>
    applySecureScreenToMainActivity(TEMPLATE.replace("super.onCreate(null)", "")),
  ).toThrow(/MainActivity template changed/);
  expect(() =>
    applySecureScreenToMainActivity(TEMPLATE.replace("import android.os.Bundle", "")),
  ).toThrow(/MainActivity template changed/);
});

it("refuses ambiguous anchors instead of editing the wrong call site", () => {
  const duplicatedSuper = TEMPLATE.replace(
    "super.onCreate(null)",
    "super.onCreate(null)\n    super.onCreate(null)",
  );
  expect(() => applySecureScreenToMainActivity(duplicatedSuper)).toThrow(
    /MainActivity template changed/,
  );
});
