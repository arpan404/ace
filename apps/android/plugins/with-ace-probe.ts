import { withAppBuildGradle, withDangerousMod, type ConfigPlugin } from "expo/config-plugins";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const withAceProbe: ConfigPlugin = (config) => {
  config = withAppBuildGradle(config, (mod) => {
    const runner = 'testInstrumentationRunner "dev.ace.android.benchmark.SpikeInstrumentation"';
    if (!mod.modResults.contents.includes(runner)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "defaultConfig {",
        `defaultConfig {\n        ${runner}`,
      );
    }
    return mod;
  });
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const directory = join(
        mod.modRequest.platformProjectRoot,
        "app/src/androidTest/java/dev/ace/android/benchmark",
      );
      await mkdir(directory, { recursive: true });
      for (const name of [
        "SpikeInstrumentation.kt",
        "FixtureSendScenario.kt",
        "FixtureDevServer.kt",
      ]) {
        await copyFile(
          join(mod.modRequest.projectRoot, `benchmark/${name}`),
          join(directory, name),
        );
      }
      return mod;
    },
  ]);
};
export default withAceProbe;
