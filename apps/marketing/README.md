# ace marketing site

A static Astro site: one page plus `llms.txt`, `robots.txt`, `sitemap.xml`, a web manifest and a
404 page.

```sh
bun run --filter @ace/marketing dev     # local preview
SITE_URL=https://your.domain bun run --filter @ace/marketing build   # output in dist/
```

## Build settings

| Variable       | What it does                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`     | The public address. Turns on canonical links, absolute social-card URLs and the sitemap. Without it they are left out. |
| `GITHUB_TOKEN` | Optional. Raises GitHub's API rate limit for the release lookup on CI.                                                 |

## Download links

Every "Download for Mac" button points at the Apple-silicon `.dmg` of the latest published
release, looked up from GitHub at build time (`src/content/release.ts`). Rebuild after each
release so the site links the new version. If GitHub can't be reached, the build still succeeds and
the buttons open the latest release page instead.

## Content

Copy lives in `src/content/`: `product.ts` (headline, statuses, features, computer use, Fleet, MCP
tools, FAQ) and `agents.ts` (read from `@ace/ui-core`, so the agent list matches the app). The page,
its JSON-LD structured data (`src/seo/`) and `llms.txt` are all built from these files, so they never
disagree.

## Screenshots

`src/assets/shots/` holds light and dark captures of the web app running against the fake daemon
(`bun run dev:fake`), at 1440×900 and 2× scale. Replace both modes together. `public/og.png` is the
1200×630 social card.
