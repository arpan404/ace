import { withAndroidManifest, withDangerousMod, type ConfigPlugin } from "expo/config-plugins";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Native cleartext is denied everywhere except the debug fixture's literal loopback hosts. */
const withAceNetwork: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (!app) throw new Error("Android application manifest is missing");
    app.$["android:networkSecurityConfig"] = "@xml/ace_network_security";
    app.$["android:usesCleartextTraffic"] = "false";
    return mod;
  });
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const root = mod.modRequest.platformProjectRoot;
      for (const [variant, xml] of [
        [
          "main",
          '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>',
        ],
        [
          "debug",
          '<network-security-config><base-config cleartextTrafficPermitted="false" /><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">::1</domain></domain-config></network-security-config>',
        ],
      ] as const) {
        const directory = join(root, "app", "src", variant, "res", "xml");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "ace_network_security.xml"),
          `<?xml version="1.0" encoding="utf-8"?>\n${xml}\n`,
        );
      }
      return mod;
    },
  ]);
};
export default withAceNetwork;
