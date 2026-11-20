import { readSchema } from "./schema.ts";

const schemaProblems = (value: unknown, at: string) => readSchema(value, at).problems;

/*
 * A package's `surfaces` (ADR 0200 §5): the cards and panels it ships, read the way Spade reads
 * them (`spade_core::package::surfaces`), with the same sentences, held to it by
 * `package/rules.json`. A panel is `panels/<id>/index.html` with a title, its state's schema and
 * the actions it may send, each with its value's schema and whether only the person's confirm in
 * ace sends it. Pure.
 */

const mostSurfaces = 16;
const mostPanels = 8;
const mostActions = 16;
const titleChars = 60;
const labelChars = 40;

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const surfaceId = (id: unknown): id is string =>
  typeof id === "string" && id.length <= 40 && /^[a-z0-9][a-z0-9-]*$/.test(id);
const actionName = (name: unknown): name is string =>
  typeof name === "string" && name.length <= 40 && /^[a-z][a-z0-9_]*$/.test(name);
const words = (value: unknown, most: number): boolean =>
  typeof value === "string" && value.trim() !== "" && [...value.trim()].length <= most;

/** A panel's page, by id: the one file of its folder a package's panel runs. */
export const panelFile = (id: string) => `panels/${id}/index.html`;

/** The panels' page files `surfaces` names, by id, read leniently from a `bot.json`. */
export function panelFiles(surfaces: unknown): Map<string, string> {
  const files = new Map<string, string>();
  if (!Array.isArray(surfaces)) return files;
  for (const surface of surfaces)
    if (isFields(surface) && surface["kind"] === "panel" && surfaceId(surface["id"]))
      files.set(surface["id"], panelFile(surface["id"]));
  return files;
}

/** Every problem with `surfaces`; none when it reads. */
export function surfaceProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > mostSurfaces)
    return [`surfaces is a list of at most ${mostSurfaces}`];
  const problems: string[] = [];
  const ids = new Set<string>();
  let panels = 0;
  value.forEach((item: unknown, i) => {
    const at = `surfaces[${i}]`;
    if (!isFields(item)) {
      problems.push(`${at} is an object`);
      return;
    }
    const id = item["id"];
    if (!surfaceId(id)) {
      problems.push(`${at}.id is a short name: lower-case letters, digits and dashes`);
      return;
    }
    if (ids.has(id)) problems.push(`${at}: each surface has an id of its own`);
    ids.add(id);
    const file = typeof item["file"] === "string" ? item["file"] : "";
    const kind = item["kind"];
    if (kind === "card") {
      if (!/^cards\/[A-Za-z0-9._-]+\.json$/.test(file))
        problems.push(`${at}.file is cards/<name>.json`);
    } else if (kind === "panel") {
      const before = problems.length;
      panelProblems(item, at, id, file, problems);
      if (problems.length === before) panels++;
    } else if (typeof kind === "string")
      problems.push(`${at}: Needs a newer Spade: this one has no ${JSON.stringify(kind)} surface`);
    else problems.push(`${at}.kind is card or panel`);
  });
  if (panels > mostPanels) problems.push(`a package has at most ${mostPanels} panels`);
  return problems;
}

function panelProblems(item: Fields, at: string, id: string, file: string, problems: string[]) {
  if (file !== panelFile(id)) problems.push(`${at}.file is ${panelFile(id)}`);
  if (!words(item["title"], titleChars))
    problems.push(`${at}.title names the panel in a few words (at most ${titleChars} characters)`);
  if (item["state"] !== undefined) problems.push(...schemaProblems(item["state"], `${at}.state`));
  const actions = item["actions"];
  if (actions === undefined) return;
  if (!Array.isArray(actions) || actions.length > mostActions) {
    problems.push(`${at}.actions is a list of at most ${mostActions}`);
    return;
  }
  const names = new Set<string>();
  actions.forEach((action: unknown, j) => {
    const where = `${at}.actions[${j}]`;
    const fields = isFields(action) ? action : {};
    const name = fields["name"];
    if (!actionName(name)) {
      problems.push(`${where}.name is a short name: lower-case letters, digits and underscores`);
      return;
    }
    if (names.has(name)) problems.push(`${where}: each action of a panel has a name of its own`);
    names.add(name);
    if (fields["label"] !== undefined && !words(fields["label"], labelChars))
      problems.push(`${where}.label is a few words (at most ${labelChars} characters)`);
    if (fields["value"] !== undefined)
      problems.push(...schemaProblems(fields["value"], `${where}.value`));
    if (fields["confirm"] !== undefined && typeof fields["confirm"] !== "boolean")
      problems.push(`${where}.confirm is true or false`);
  });
}
