import { withAppBuildGradle, type ConfigPlugin } from "expo/config-plugins";
import { addMeasurementBuildType, pinReleaseBundleEntry } from "./variant-text.ts";

/** Adds the release-like measurement build type and pins the production bundle entry. */
const withAceVariant: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = pinReleaseBundleEntry(
      addMeasurementBuildType(mod.modResults.contents),
    );
    return mod;
  });
export default withAceVariant;
