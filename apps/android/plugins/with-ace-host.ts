import { withMainApplication, type ConfigPlugin } from "expo/config-plugins";

/** The app's build variant owns dev support, rather than the precompiled RN library. */
const withAceHost: ConfigPlugin = (config) =>
  withMainApplication(config, (mod) => {
    const source = mod.modResults.contents;
    if (!source.includes("useDevSupport = BuildConfig.DEBUG")) {
      const marker = "context = applicationContext,";
      if (!source.includes(marker))
        throw new Error("Expo host template changed; check ace dev-support wiring.");
      mod.modResults.contents = source.replace(
        marker,
        `${marker}\n      useDevSupport = BuildConfig.DEBUG,`,
      );
    }
    return mod;
  });
export default withAceHost;
