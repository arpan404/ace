import { entryPage as entryData, featuredEntries, searchEntries, searchInput } from "../catalog.ts";
import type { Context } from "../context.ts";
import { html } from "../http.ts";
import { summary } from "../rules.ts";
import type { Route } from "../routes.ts";
import { categories } from "../store/read.ts";
import { entryPage, homePage, missingPage, searchPage } from "./views.ts";

/* The public web page's routes. Like the API's reads, they set no cookie and keep nothing. */

export async function pageRoute(
  url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  const dbs = context.dbs;
  switch (route.kind) {
    case "page-home": {
      const [featured, list] = await Promise.all([featuredEntries(dbs), categories(dbs.lists)]);
      return html(homePage({ featured: featured.map(summary), categories: list }));
    }
    case "page-search": {
      const input = searchInput(url.searchParams);
      const [found, list] = await Promise.all([searchEntries(dbs, input), categories(dbs.lists)]);
      return html(
        searchPage({
          ...input,
          category: list.find((category) => category.id === input.category),
          ...found,
        }),
      );
    }
    case "page-entry": {
      const data = await entryData(dbs, route.type, route.name);
      return data ? html(entryPage(data)) : missingPage404();
    }
    default:
      return undefined;
  }
}

export const missingPage404 = () => html(missingPage(), 404);
