import { waitFor, within, type ByRoleOptions } from "@testing-library/react";
import { rowText } from "./row-text.ts";

/*
 * A long list (Skills, Automations, Pull requests, History) is one flat list whose groups are
 * heading rows, so it can mount only the rows near the viewport. These read it the way a person
 * does: the rows under a heading, until the next one.
 */

const named = (text: string, name: string | RegExp) =>
  typeof name === "string" ? text === name : name.test(text);

/** The rows of `list` under the heading row named `heading`, as mounted now. */
export function rowsUnder(list: HTMLElement, heading: string | RegExp): HTMLElement[] {
  const box = list.matches('[role="list"]')
    ? list
    : list.querySelector<HTMLElement>('[role="list"]');
  const rows: HTMLElement[] = [];
  let inside = false;
  for (const item of box?.querySelectorAll<HTMLElement>(":scope > [data-index]") ?? []) {
    const title = item.querySelector("h1, h2, h3, h4, [role='heading']");
    if (title) {
      inside = named(rowText(title).trim(), heading);
      continue;
    }
    if (inside) rows.push(item);
  }
  return rows;
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
    findByRole: (role: string, options?: ByRoleOptions) => waitFor(() => getByRole(role, options)),
    findByText: (text: string | RegExp) =>
      waitFor(() => {
        const found = rowsUnder(list, heading).flatMap((row) => within(row).queryAllByText(text));
        if (!found[0]) throw new Error(`No "${String(text)}" under "${String(heading)}"`);
        return found[0];
      }),
  };
}
