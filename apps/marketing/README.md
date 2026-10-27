# ace marketing site

A static Astro site: one page plus `llms.txt`, `robots.txt`, `sitemap.xml`, a web manifest and a
404 page.

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

Copy lives in `src/content/`: `product.ts` (headline, statuses, features, computer use, Fleet, MCP
tools, FAQ) and `agents.ts` (read from `@ace/ui-core`, so the agent list matches the app). The page,
its JSON-LD structured data (`src/seo/`) and `llms.txt` are all built from these files, so they never
disagree.

## Screenshots

`src/assets/shots/` holds dark captures of the web app running against the fake daemon
(`bun run dev:fake`), at 1440×900 and 2× scale: `home` (the hero) and `review`. The site is
dark only, so there are no light captures. `public/og.png` is the 1200×630 social card.
