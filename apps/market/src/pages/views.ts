import type { FeedEntry } from "@ace/marketplace";
import type { MarketCategory, MarketEntryVersion } from "@ace/protocol/marketplace";
import {
  entryList,
  escape,
  page,
  reviewWords,
  searchForm,
  typeChoices,
  typeName,
} from "./layout.ts";

/* The page's three views. Pure: data in, HTML out. */

export function homePage(input: {
  featured: readonly FeedEntry[];
  categories: readonly MarketCategory[];
}): string {
  const categories =
    input.categories.length === 0
      ? ""
      : `<h2>Categories</h2><ul>${input.categories
          .map(
            (category) =>
              `<li><a class="row" href="/search?category=${encodeURIComponent(category.id)}">${escape(category.title)}</a></li>`,
          )
          .join("")}</ul>`;
  return page(
    "ace marketplace",
    `<h1>Marketplace</h1>
<p class="lead">Suits, skills, plugins and bots for ace. Open one in ace to review and install it.</p>
${searchForm()}
<h2>Featured</h2>
${entryList(input.featured, "Nothing is featured yet.")}
${categories}`,
  );
}

export function searchPage(input: {
  query: string;
  type?: string | undefined;
  category: MarketCategory | undefined;
  entries: readonly FeedEntry[];
  total: number;
}): string {
  const typeLabel = typeChoices.find(([value]) => value === (input.type ?? ""))?.[1];
  const heading = input.category ? input.category.title : "Search";
  const count =
    input.total === 0
      ? ""
      : `<p class="meta">${input.total === 1 ? "1 entry" : `${input.total} entries`}${
          input.total > input.entries.length ? `, the first ${input.entries.length} shown` : ""
        }</p>`;
  const empty = input.query
    ? `Nothing matches “${input.query}”${input.type ? ` in ${typeLabel ?? input.type}` : ""}.`
    : "Nothing here yet.";
  return page(
    `${input.query ? `${input.query} · ` : ""}${heading} · ace marketplace`,
    `<h1>${escape(heading)}</h1>
${searchForm(input.query, input.type ?? "")}
${count}
${entryList(input.entries, empty)}`,
  );
}

const sizeWords = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const dateWords = (at: number) => new Date(at).toISOString().slice(0, 10);

const downloadsWords = (count: number) => (count === 1 ? "1 download" : `${count} downloads`);

export function entryPage(input: {
  entry: FeedEntry;
  description: string;
  versions: readonly MarketEntryVersion[];
}): string {
  const { entry } = input;
  const meta = [
    typeName(entry.type),
    entry.publisher ? `by ${entry.publisher.name}` : undefined,
    reviewWords(entry),
    downloadsWords(entry.downloads),
  ]
    .filter(Boolean)
    .join(" · ");
  const open = `ace://marketplace/${encodeURIComponent(entry.type)}/${encodeURIComponent(entry.name)}`;
  const versions = input.versions
    .map(
      (version) =>
        `<li><span class="number">${escape(version.version)}</span><span class="meta">${escape(
          [
            dateWords(version.published),
            sizeWords(version.size),
            downloadsWords(version.downloads),
            version.withdrawn === undefined ? undefined : `Withdrawn: ${version.withdrawn}`,
          ]
            .filter(Boolean)
            .join(" · "),
        )}</span></li>`,
    )
    .join("");
  const status = entry.version
    ? `<p><a class="action" href="${escape(open)}">Open in ace</a></p>`
    : `<p class="lead">Every version was withdrawn, so this can't be installed.</p>`;
  return page(
    `${entry.title} · ace marketplace`,
    `<h1>${escape(entry.title)}</h1>
<p class="meta">${escape(meta)}</p>
${entry.line ? `<p class="lead">${escape(entry.line)}</p>` : ""}
${status}
${input.description && input.description !== entry.line ? `<div class="description">${escape(input.description)}</div>` : ""}
<h2>Versions</h2>
<ul class="versions">${versions}</ul>`,
  );
}

export function missingPage(): string {
  return page(
    "Not found · ace marketplace",
    `<h1>Not here</h1>
<p class="lead">Nothing in the marketplace has that address.</p>
${searchForm()}`,
  );
}
