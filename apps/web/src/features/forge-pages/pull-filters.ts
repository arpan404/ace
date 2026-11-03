import { sortLabels, type PullsSearch, type PullsSort } from "@ace/ui-core";
import type { ForgePrRow } from "@ace/protocol";
import type { FilterSection } from "./filters-menu.tsx";

const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
const sorts = Object.keys(sortLabels) as PullsSort[];

/**
 * The pull request box's filter menus, in GitHub's order: Author, Label, Reviews, then the
 * checks (ace's own) and Sort. Choices come from the rows read, plus whatever is set.
 */
export function pullSections(
  search: PullsSearch,
  rows: readonly ForgePrRow[],
  onSearch: (patch: Partial<PullsSearch>) => void,
): FilterSection[] {
  return [
    {
      kind: "one",
      id: "author",
      label: "Author",
      value: search.author ?? "",
      choices: [
        { value: "", label: "Anyone" },
        ...unique([
          ...rows.map((row) => row.author),
          ...(search.author ? [search.author] : []),
        ]).map((login) => ({ value: login, label: login })),
      ],
      onChange: (value) => onSearch({ author: value || undefined, who: undefined }),
    },
    {
      kind: "many",
      id: "labels",
      label: "Label",
      values: search.labels ?? [],
      choices: unique([...rows.flatMap((row) => row.labels), ...(search.labels ?? [])]).map(
        (label) => ({ value: label, label }),
      ),
      onChange: (labels) => onSearch({ labels: labels.length ? labels : undefined }),
    },
    {
      kind: "one",
      id: "review",
      label: "Reviews",
      value: search.review ?? "",
      choices: [
        { value: "", label: "Any review" },
        { value: "none", label: "No reviews" },
        { value: "required", label: "Review required" },
        { value: "approved", label: "Approved review" },
        { value: "changes", label: "Changes requested" },
      ],
      onChange: (value) =>
        onSearch({
          review:
            value === "approved" || value === "changes" || value === "required" || value === "none"
              ? value
              : undefined,
        }),
    },
    {
      kind: "one",
      id: "checks",
      label: "Checks",
      value: search.checks ?? "",
      choices: [
        { value: "", label: "Any checks" },
        { value: "passing", label: "Passing" },
        { value: "failing", label: "Failing" },
      ],
      onChange: (value) =>
        onSearch({ checks: value === "passing" || value === "failing" ? value : undefined }),
    },
    {
      kind: "one",
      id: "sort",
      label: "Sort",
      setting: true,
      value: search.sort && search.sort !== "ready" ? search.sort : "",
      choices: sorts.map((value) => ({
        value: value === "ready" ? "" : value,
        label: sortLabels[value],
      })),
      onChange: (value) => onSearch({ sort: sorts.find((key) => key === value) }),
    },
  ];
}
