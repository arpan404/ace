import { waitFor, within, type ByRoleOptions } from "@testing-library/react";
import { rowText } from "./row-text.ts";

/*
 * A long list (Skills, Automations, Pull requests, History) is one flat list whose groups are
 * heading rows, so it can mount only the rows near the viewport. These read it the way a person
 * does: the rows under a heading, until the next one.
 */

/** A heading's own words: its text without a count or other element beside them. */
function ownText(heading: Element): string {
  return [...heading.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

/** Each heading row of `list`, as mounted now, with its name and the rows under it. */
export function listGroups(
  list: HTMLElement,
): { name: string; heading: HTMLElement; rows: HTMLElement[] }[] {
  const box = list.matches('[role="list"]')
    ? list
    : list.querySelector<HTMLElement>('[role="list"]');
  const groups: { name: string; heading: HTMLElement; rows: HTMLElement[] }[] = [];
  for (const item of box?.querySelectorAll<HTMLElement>(":scope > [data-index]") ?? []) {
    const heading = item.querySelector<HTMLElement>("h1, h2, h3, h4, [role='heading']");
    if (heading)
      groups.push({ name: ownText(heading) || rowText(heading).trim(), heading, rows: [] });
    else groups.at(-1)?.rows.push(item);
  }
  return groups;
}

/** A heading is named by its own words ("Waiting") or by all of them ("Personal · 3"). */
const named = (group: { name: string; heading: HTMLElement }, name: string | RegExp) => {
  const full = rowText(group.heading).trim();
  return typeof name === "string"
    ? group.name === name || full === name
    : name.test(group.name) || name.test(full);
};

/** The rows of `list` under the heading row named `heading`, as mounted now. */
export function rowsUnder(list: HTMLElement, heading: string | RegExp): HTMLElement[] {
  return listGroups(list).find((group) => named(group, heading))?.rows ?? [];
}

/** Queries over the rows under one heading, as `within` gives over an element. */
export function listGroup(list: HTMLElement, heading: string | RegExp) {
  const all = (role: string, options?: ByRoleOptions) =>
    rowsUnder(list, heading).flatMap((row) => within(row).queryAllByRole(role, options));
  const getByRole = (role: string, options?: ByRoleOptions): HTMLElement => {
    const found = all(role, options);
    const [only] = found;
    if (!only || found.length > 1)
      throw new Error(`${found.length} ${role} rows under "${String(heading)}" match`);
    return only;
  };
  return {
    rows: () => rowsUnder(list, heading),
    getByRole,
    getAllByRole: (role: string, options?: ByRoleOptions) => {
      const found = all(role, options);
      if (!found.length) throw new Error(`No ${role} rows under "${String(heading)}"`);
      return found;
    },
    queryAllByRole: all,
    queryByRole: (role: string, options?: ByRoleOptions): HTMLElement | null => {
      const found = all(role, options);
      if (found.length > 1)
        throw new Error(`${found.length} ${role} rows under "${String(heading)}" match`);
      return found[0] ?? null;
    },
    findByRole: (role: string, options?: ByRoleOptions) => waitFor(() => getByRole(role, options)),
    findByText: (text: string | RegExp) =>
      waitFor(() => {
        const found = rowsUnder(list, heading).flatMap((row) => within(row).queryAllByText(text));
        if (!found[0]) throw new Error(`No "${String(text)}" under "${String(heading)}"`);
        return found[0];
      }),
  };
}
