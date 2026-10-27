import { withAndroidManifest, withDangerousMod, type ConfigPlugin } from "expo/config-plugins";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { networkXmlDocument, variantNetworkXml } from "./variant-text.ts";

/** Native cleartext is denied everywhere except the fixture variants' literal loopback hosts. */
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
      for (const variant of ["main", "debug", "measurement"] as const) {
        const directory = join(root, "app", "src", variant, "res", "xml");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "ace_network_security.xml"),
          networkXmlDocument(variantNetworkXml(variant)),
        );
      }
      return mod;
    },
  ]);
};
export default withAceNetwork;
