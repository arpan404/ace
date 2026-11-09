// A stand-in for the app's main entry (toolchains.process.test.ts): bundled the way the main
// process is, it detects toolchains the way the app does and prints what it found.
import { bundledToolchains } from "../toolchains.ts";

const found = await bundledToolchains(import.meta.url)(process.env);
// The idle probe worker would hold the process open until it retires.
process.stdout.write(`${JSON.stringify(found)}\n`, () => process.exit(0));
