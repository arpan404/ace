# Releasing the web app (app.acehq.dev)

app.acehq.dev is the Cloudflare Pages project `ace-web`, built from `apps/web`. It serves the
latest **stable release's** web app, not `main`: the release pipeline
([ADR 0188](../adr/0188-tag-driven-release-pipeline.md), `.github/workflows/release.yml`)
deploys it, and the build carries the release's version, so the app names itself
`web/<version>` to ace cloud and the market ([ADR 0189](../adr/0189-cloud-features-gated-by-client-version.md)).

| Tag                | Pages branch | Where                                                             |
| ------------------ | ------------ | ----------------------------------------------------------------- |
| `vX.Y.Z`           | `main`       | production: app.acehq.dev                                         |
| `ace-X.Y.Z-beta-N` | `beta`       | a preview alias: beta.ace-web.pages.dev (app.acehq.dev untouched) |

## The deploy-web job

On omarchy, in the `production` environment, after `deploy:workers production` succeeds and
before publish (publish waits for it):

1. `apps/desktop/scripts/pipeline/web-plan.ts <tag>` decides (`webDeployPlan` in
   `apps/desktop/src/packaging/web-deploy.ts`): the branch, the version (`0.0.24`, or a beta's
   `0.0.24-beta.2`), and the message `ace <tag>`. It skips the deploy, as a success, when a later
   release of the same line is already published, so rerunning an older tag never takes the site
   back.
2. `apps/web/scripts/cloudflare-pages-build.sh` builds with `ACE_VERSION=<version>`: the same
   build Pages ran from Git.
3. `wrangler pages deploy apps/web/dist --project-name ace-web --branch <branch> --commit-hash <sha>
--commit-message "ace <tag>"`. Only this step gets the Cloudflare token.

**Reruns deploy again** rather than checking what Pages serves. Pages uploads only the files it
doesn't already have, so a second deploy of the same build is quick and serves the same files;
`wrangler pages deployment list` shows only a short sha and one page, which is no reliable
check. "Re-run failed jobs" doesn't repeat a deploy that succeeded, and a published release
never redeploys (the job is skipped with the rest of the deploys).

**Rolling back** is the Pages dashboard: **Workers & Pages › ace-web › Deployments**, pick the
previous production deployment (its message names the release), **Rollback to this deployment**.
The next stable tag deploys forward again.

## Setup (owner, once)

1. **Stop Pages deploying `main` on its own**, or every merge would replace the release on
   app.acehq.dev with an unversioned build. **Workers & Pages › ace-web › Settings › Builds ›
   Branch control**: turn off **Enable automatic production branch deployments**. Keep the
   production branch as `main` (the job deploys to it by name). Preview deployments can stay
   on for pull requests if you want them; set **Preview branch** to **Custom branches** and
   exclude `beta`, so a Git branch named `beta` never lands on the beta alias.
2. **The token.** The `production` environment's `CLOUDFLARE_API_TOKEN` needs **Account ›
   Cloudflare Pages › Edit** besides its Workers permissions ([workers.md](workers.md#the-cloudflare-api-token)).
3. **Optional: beta.app.acehq.dev.** **ace-web › Custom domains › Set up a custom domain**,
   `beta.app.acehq.dev`; then, in the `acehq.dev` DNS, change the CNAME it creates for `beta.app`
   to `beta.ace-web.pages.dev` (a Pages custom domain serves production until its CNAME names a
   branch alias).

**The beta web app can't sign in or pair yet.** Only `https://app.acehq.dev` and `app://ace` are
allowed origins: ace cloud's `ACE_ACCOUNT_ALLOWED_ORIGINS` (`apps/cloud/wrangler.jsonc`) and the
daemon's `hostedWebOrigin` (`apps/daemon/src/web-origins.ts`, or a person's own
`ACE_WEB_ORIGINS`). A beta origin has to be added to both before beta.ace-web.pages.dev or
beta.app.acehq.dev is more than a preview of the interface, and a daemon only learns it in the
release that adds it.
