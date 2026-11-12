import { outsideGrantTables } from "./external-mcp/tables.ts";
import { schemaVersionBefore } from "./migrations.ts";

/**
 * SQL that takes a current database back to an older schema, newest steps first, for upgrade
 * fixtures. A fixture that puts a database back to before some step must also take out every
 * step after it, so it is the older schema it says it is and the upgrade replays those steps on
 * a database without them. Add the undo of each new step here, at the front of the chain.
 */

/**
 * An older build never wrote in this build's stored event shape (ADR 0125, `stored-shape.ts`):
 * forgetting the recorded one makes the upgraded store decode the rows a fixture adds as an
 * older build's, as it would on a real upgrade. Every rewind starts with it.
 */
const olderBuild = "DROP TABLE IF EXISTS stored_event_shape; ";

/**
 * What the outside MCP client steps (ADR 0122), the newest in the schema, added: the grant,
 * token and thread tables, the DCR clients and the tokens' resource column.
 */
export const undoOutsideClients =
  olderBuild +
  "DROP TABLE outside_grant_threads; DROP TABLE outside_grant_tokens; DROP TABLE outside_grants; DROP TABLE outside_oauth_clients; ";

/** The schema just before the outside MCP client steps. */
export const beforeOutsideClients = schemaVersionBefore(outsideGrantTables);

/**
 * Back to before the ADR 0115 steps (the two before the outside client steps): no account link,
 * install or fold columns on devices.
 */
export const undoInstalls =
  undoOutsideClients +
  "DROP INDEX devices_install; ALTER TABLE devices DROP COLUMN account_link; ALTER TABLE devices DROP COLUMN merged_into; ALTER TABLE devices DROP COLUMN install_id; ";

/** The schema just before the ADR 0115 steps. */
export const beforeInstalls = beforeOutsideClients - 2;

/** Back to before the machine code tables (ADR 0111, the step before the install steps). */
export const undoMachineCode =
  undoInstalls + "DROP TABLE machine_code; DROP TABLE machine_code_passes; ";
