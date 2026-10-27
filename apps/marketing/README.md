# ace marketing site

A static Astro site: the home page, `/download/`, `/features/` with a page per feature,
`/agents/` with a page per built-in agent, `/mcp/`, `/security/` and `/faq/`, plus `llms.txt`,
`llms-full.txt`, `robots.txt`, `sitemap.xml`, a web manifest and a 404 page.

```sh
bun run --filter @ace/marketing dev     # local preview
SITE_URL=https://your.domain bun run --filter @ace/marketing build   # output in dist/
```

## Deploy

Cloudflare Pages builds and deploys both public sites from `main`; there is no deploy script.

| Pages project   | Domains                  | Build command (repo root)                                                                                   | Output                |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| `ace-marketing` | acehq.dev, www.acehq.dev | `bun install --frozen-lockfile && bun run --cwd apps/marketing build`                                       | `apps/marketing/dist` |
| `ace-web`       | app.acehq.dev            | `bun install --frozen-lockfile && bun run --cwd apps/web build && find apps/web/dist -name '*.map' -delete` | `apps/web/dist`       |

Both set `BUN_VERSION`, `NODE_VERSION=24` and `SKIP_DEPENDENCY_INSTALL=1`; `ace-marketing` also sets
`SITE_URL=https://acehq.dev`. Each builds only when its app, `packages/` or the lockfile changes.
The web app has no `404.html`, so Pages answers every unknown path with `index.html` and the app's
router handles it.

## Build settings

| Variable       | What it does                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`     | The public address. Turns on canonical links, absolute social-card URLs and the sitemap. Without it they are left out. |
| `GITHUB_TOKEN` | Optional. Raises GitHub's API rate limit for the release lookup on CI.                                                 |

## Download links

Each "Download for <platform>" button points at that platform's installer in the latest published
release, looked up from GitHub at build time (`src/content/release.ts`): the Apple-silicon `.dmg`
for Mac, the x64 `-setup.exe` for Windows and the x64 `.AppImage` for Linux. The page shows the
button for the visitor's system (Base.astro tags `<html data-os>` before paint; anything else sees
Mac). A platform the release has no installer for, or a build that can't reach GitHub, links the
release page instead. Rebuild after each release so the site links the new version.

## Content

Copy lives in `src/content/`, never in components:

| File              | What it holds                                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| `product.ts`      | Headline, statuses, capabilities, Fleet points, MCP families, FAQ, boundaries    |
| `features.ts`     | Every feature page: title, meta description, sections, tools, questions          |
| `agent-guides.ts` | A page per built-in agent (the agent list itself comes from `@ace/ui-core`)      |
| `mcp.ts`          | The full tool reference on `/mcp/`                                               |
| `routes.ts`       | Every indexable page; nav, footer, breadcrumbs, sitemap and llms.txt all read it |

A new page goes in `routes.ts` first; `trail()` refuses a path that isn't listed, so a page can't
ship unlinked or missing from the sitemap.

## SEO

Every page goes through `layouts/Page.astro`, which writes its title, description, canonical URL,
Open Graph and Twitter cards, and one JSON-LD graph: `WebSite`, the page, `BreadcrumbList` on inner
pages, plus what the page adds (`SoftwareApplication` on home and download, `FAQPage` wherever
questions are shown, `ItemList` on index pages). Node builders live in `src/seo/schema.ts`.
`llms.txt` indexes every page; `llms-full.txt` carries all of their content in one file.

## Themes

The site has a dark and a light theme. A script in Base.astro's head sets `<html data-theme>`
before paint: the visitor's saved choice (the nav toggle, stored as `ace-theme`), else their system
setting, followed live until they choose. Colours are tokens in `src/styles/global.css`; the light
theme overrides them under `html[data-theme="light"]`.

## Screenshots

`src/assets/shots/` holds light and dark captures of the web app running against the fake daemon's
small showcase world (`bun run web:dev:fake`, then `/t/thread-cold-start?fakeWorld=showcase`), at
1440×900 and 2× scale: `home` (the hero) and `review` (the same thread with the right panel on
Changes). Replace both modes
together; `Shot.astro` shows the one matching the theme. `public/og.png` is the 1200×630 social card.
