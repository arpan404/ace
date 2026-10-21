import type { DoctorFeature } from "./feature.ts";
import { accounts } from "./accounts.ts";
import { computerUse } from "./computer-use.ts";
import { daemonHealth } from "./daemon-health.ts";
import { install } from "./install.ts";
import { recentErrors } from "./recent-errors.ts";
import { remoteAccess } from "./remote-access.ts";
import { storage } from "./storage.ts";

/** Every `ace doctor` feature beyond the base checks, in report order. */
export const doctorFeatures: readonly DoctorFeature[] = [
  install,
  daemonHealth,
  recentErrors,
  storage,
  accounts,
  computerUse,
  remoteAccess,
];
