import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/** `app.json` relative to this test file: `src/pairing/` -> `apps/android/`. */
const APP_JSON_URL = new URL("../../app.json", import.meta.url);

/**
 * The `configureAndroidBackup` flag makes the `expo-secure-store` config
 * plugin emit manifest rules plus backup-rules XML excluding the
 * `SecureStore` preferences from Auto Backup. This test pins the checked-in
 * config that generates that exclusion: without the flag (or without the
 * plugin entry) a backup would restore another phone's token.
 *
 * What this cannot prove: that the generated manifest actually carries the
 * rules. That needs a prebuild inspection (`expo prebuild --platform
 * android`, then read the manifest and the generated
 * `secure_store_backup_rules` / `secure_store_data_extraction_rules` XML),
 * which no hermetic unit test can do. See the README limitation.
 */
it("keeps the SecureStore plugin excluding tokens from Auto Backup", () => {
  const appJson = JSON.parse(readFileSync(APP_JSON_URL, "utf8")) as {
    expo?: { plugins?: unknown[] };
  };
  const plugins = appJson.expo?.plugins;
  expect(Array.isArray(plugins)).toBe(true);
  const entry = (plugins ?? []).find(
    (plugin) =>
      plugin === "expo-secure-store" ||
      (Array.isArray(plugin) && plugin[0] === "expo-secure-store"),
  );
  expect(entry).toBeDefined();
  expect(Array.isArray(entry)).toBe(true);
  const props = (entry as unknown[])[1] as { configureAndroidBackup?: unknown } | undefined;
  expect(props?.configureAndroidBackup).toBe(true);
});
