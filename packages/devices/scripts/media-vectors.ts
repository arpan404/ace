import { commonDeviceStream } from "../src/stream-control.ts";
import { deviceStreamProfile, screenStreamProfile } from "../src/stream-profile.ts";
import { writeVectors } from "../../browser/scripts/media-vector-harness.ts";
export function mediaVectors() {
  const scenarios = (["local", "remote", "relay"] as const).flatMap((connection) =>
    [-1, 0, 1, 2, 3, 4].map((pressure) => {
      const panel = { width: 2001, height: 3001 };
      return {
        input: { connection, pressure, panel },
        device: deviceStreamProfile(panel, connection, pressure),
        screen: screenStreamProfile(panel, connection, pressure),
      };
    }),
  );
  const profiles = scenarios.slice(0, 3).map((s) => s.device);
  return {
    "device-control": {
      scenarios,
      common: [[], profiles, profiles.slice(0, 1)].map((input) => ({
        input,
        output: commonDeviceStream(input),
      })),
    },
  };
}
if (import.meta.main) writeVectors(mediaVectors());
