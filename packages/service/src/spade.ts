/** Spade's service, binary and updater swap (ADR 0123): `@ace/service/spade`. */
export {
  spadeServicePlan,
  spadeEnvironment,
  spadeBinaryName,
  renderSpadeCmdLauncher,
  spadeLabel,
  spadeUnit,
  spadeTaskName,
  SPADE_CMD_LAUNCHER,
  type SpadeAccount,
  type SpadePlatform,
  type SpadeServicePlan,
} from "./spade-plan.ts";
export {
  installSpadeService,
  removeSpadeService,
  restartSpadeService,
  spadeServiceState,
  rotateSpadeLog,
  type SpadeServicePorts,
  type SpadeServiceState,
} from "./spade-service.ts";
export {
  installSpadeBinary,
  installedSpadeVersion,
  stageSpadeBinary,
  flipSpadeCurrent,
  pruneSpadeReleases,
  spadeReleases,
} from "./spade-release.ts";
export { localSpadePlan } from "./spade-local.ts";
export {
  swapSpade,
  swapPrograms,
  spadeQuiet,
  describeSpadeSwap,
  spadeDeadlines,
  SpadeMaintenance,
  type SpadeSwapMode,
  type SpadeSwapPorts,
  type SpadeSwapResult,
} from "./spade-swap.ts";
export { localSpadeSwapPorts, type SpadeSwapIo } from "./spade-swap-ports.ts";
export {
  updateSpade,
  reopenSpadeAdmission,
  rememberSpadeUpdateMode,
  takeSpadeUpdateMode,
  spadeUpdateModeFile,
} from "./spade-update.ts";
