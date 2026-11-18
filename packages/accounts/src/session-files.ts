/**
 * Which files make up one provider session, and how to write a copy of them into another home
 * without following links or replacing a file. Shared by account copies (ADR 0018) and by moving
 * a working thread to another machine (ADR 0191), so the lineage rules live in one place.
 */
export { claudePlan, codexPlan, type MigrationPlan } from "./migration-plan.ts";
export {
  MigrationFailure,
  safeParents,
  stageFile,
  publishFile,
  rollback,
  type CopyFile,
} from "./migration-files.ts";
