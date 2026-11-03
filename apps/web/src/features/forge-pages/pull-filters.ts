import { sortLabels, type PullsSearch, type PullsSort } from "@ace/ui-core";
import type { ForgePrRow } from "@ace/protocol";
import type { FilterSection } from "./filters-menu.tsx";

const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));

/**
 * Who the list concerns and its order, first in the Filters menu: who counts as a filter that
 * is on; sort is the view's setting.
 */
export function viewSections(
  search: PullsSearch,
  onSearch: (patch: Partial<PullsSearch>) => void,
): FilterSection[] {
  return [
    {
      kind: "one",
      id: "who",
      label: "Involvement",
      value: search.who ?? "",
      choices: [
        { value: "", label: "Everyone" },
        { value: "authored", label: "Authored" },
        { value: "reviewing", label: "Reviewing" },
      ],
      onChange: (value) =>
        onSearch({ who: value === "authored" || value === "reviewing" ? value : undefined }),
    },
    {
      kind: "one",
      id: "sort",
      label: "Sort",
      setting: true,
      value: search.sort && search.sort !== "ready" ? search.sort : "",
      choices: (Object.keys(sortLabels) as PullsSort[]).map((value) => ({
        value: value === "ready" ? "" : value,
        label: sortLabels[value],
      })),
      onChange: (value) =>
        onSearch({ sort: (Object.keys(sortLabels) as PullsSort[]).find((key) => key === value) }),
    },
  ];
}

export function filterSections(
  search: PullsSearch,
  rows: readonly ForgePrRow[],
  onSearch: (patch: Partial<PullsSearch>) => void,
): FilterSection[] {
  return [
    {
      kind: "one",
      id: "draft",
      label: "Drafts",
      value: search.draft ?? "",
      choices: [
        { value: "", label: "Include drafts" },
        { value: "only", label: "Drafts only" },
        { value: "hide", label: "Hide drafts" },
      ],
      onChange: (value) =>
        onSearch({ draft: value === "only" || value === "hide" ? value : undefined }),
    },
    {
      kind: "one",
      id: "review",
      label: "Review",
      value: search.review ?? "",
      choices: [
        { value: "", label: "Any review" },
        { value: "approved", label: "Approved" },
        { value: "changes", label: "Changes requested" },
        { value: "required", label: "Review required" },
        { value: "none", label: "No review" },
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
      onChange: (value) => onSearch({ author: value || undefined }),
    },
    {
      kind: "many",
      id: "labels",
      label: "Labels",
      values: search.labels ?? [],
      choices: unique([...rows.flatMap((row) => row.labels), ...(search.labels ?? [])]).map(
        (label) => ({ value: label, label }),
      ),
      onChange: (labels) => onSearch({ labels: labels.length ? labels : undefined }),
    },
  ];
}
