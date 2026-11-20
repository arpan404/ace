# Releasing the web app (app.acehq.dev)

app.acehq.dev is the Cloudflare Pages project `ace-web`, built from `apps/web`. It serves the
latest **stable release's** web app, not `main`: the release pipeline
([ADR 0188](../adr/0188-tag-driven-release-pipeline.md), `.github/workflows/release.yml`)
deploys it, and the build carries the release's version, so the app names itself
`web/<version>` to ace cloud and the market ([ADR 0189](../adr/0189-cloud-features-gated-by-client-version.md)).
beta.app.acehq.dev serves the newest release of either line, as the Beta line's apps update
([ADR 0177](../adr/0177-beta-release-line.md)).

| Tag                | Pages branches    | Sites                                               |
| ------------------ | ----------------- | --------------------------------------------------- |
| `vX.Y.Z`           | `main` and `beta` | app.acehq.dev (production) and beta.app.acehq.dev   |
| `ace-X.Y.Z-beta-N` | `beta`            | beta.app.acehq.dev only; app.acehq.dev is untouched |

## The deploy-web job

On omarchy, in the `production` environment, after `deploy:workers production` succeeds and
before publish (publish waits for it):

1. `apps/desktop/scripts/pipeline/web-plan.ts <tag>` decides (`webDeployPlan` in
   `apps/desktop/src/packaging/web-deploy.ts`): the version (`0.0.24`, or a beta's
   `0.0.24-beta.2`), the message `ace <tag>`, and the branches. A branch is skipped when it
   already serves a later published release: `main` counts stable releases, `beta` both lines.
   So rerunning an older tag never takes a site back, and a stable release after a newer beta
   updates app.acehq.dev but leaves the beta site on the beta. Skipping is a success.
2. `apps/web/scripts/cloudflare-pages-build.sh` builds once with `ACE_VERSION=<version>`: the
   same build Pages ran from Git.
3. `wrangler pages deploy apps/web/dist --project-name ace-web --branch <branch> --commit-hash <sha>
--commit-message "ace <tag>"`, once per branch. Only this step gets the Cloudflare token.

**Reruns deploy again** rather than checking what Pages serves. Pages uploads only the files it
doesn't already have, so a second deploy of the same build is quick and serves the same files;
`wrangler pages deployment list` shows only a short sha and one page, which is no reliable
check. "Re-run failed jobs" doesn't repeat a deploy that succeeded, and a published release
never redeploys (the job is skipped with the rest of the deploys).

**Rolling back** is the Pages dashboard: **Workers & Pages › ace-web › Deployments**, pick the
previous deployment of that branch (its message names the release), **Rollback to this
deployment**. The next release deploys forward again.

**Sign-in and pairing.** ace cloud (`ACE_ACCOUNT_ALLOWED_ORIGINS` in `apps/cloud/wrangler.jsonc`)
and the daemon (`apps/daemon/src/web-origins.ts`) allow exactly `https://app.acehq.dev` and
`https://beta.app.acehq.dev`. The `*.ace-web.pages.dev` addresses are not allowed: they load,
but can't sign in or reach a machine. A daemon allows beta.app.acehq.dev from the release that
added it; older daemons need it in `ACE_WEB_ORIGINS`.

## acehq.dev after a stable release

The marketing site (Pages project `ace-marketing`) builds its download links and version from
the latest release, and Pages rebuilds it only on a push to `main`. So after a stable release
is published, the `refresh-marketing` job POSTs the deploy hook in the `production`
environment's `MARKETING_DEPLOY_HOOK` secret, and Pages rebuilds the site. It runs no repository
code and never fails the release: without the secret, or when the request fails, it leaves a
notice or a warning on the run, and the site catches up on the next push to `main`. Betas don't
trigger it; the site links the latest stable release only.

## Setup (owner, once)

1. **Stop Pages deploying `main` on its own**, or every merge would replace the release on
   app.acehq.dev with an unversioned build. **Workers & Pages › ace-web › Settings › Builds ›
   Branch control**: turn off **Enable automatic production branch deployments**. Keep the
   production branch as `main` (the job deploys to it by name). Preview deployments can stay
   on for pull requests if you want them; set **Preview branch** to **Custom branches** and
   exclude `beta`, so a Git branch named `beta` never lands on the beta site.
2. **The token.** The `production` environment's `CLOUDFLARE_API_TOKEN` needs **Account ›
   Cloudflare Pages › Edit** besides its Workers permissions ([workers.md](workers.md#the-cloudflare-api-token)).
3. **beta.app.acehq.dev** (required: the beta web app can sign in only there). **ace-web ›
   Custom domains › Set up a custom domain**, `beta.app.acehq.dev`; then, in the `acehq.dev`
   DNS, change the CNAME it creates for `beta.app` to `beta.ace-web.pages.dev`. A Pages custom
   domain serves production until its CNAME names a branch alias, so check after the first
   beta that beta.app.acehq.dev and app.acehq.dev can differ.
4. **The marketing deploy hook.** **Workers & Pages › ace-marketing › Settings › Builds › Deploy
   hooks › Add deploy hook**: name `release`, branch `main`. Copy the URL (anyone holding it can
   start a build) into **GitHub › Settings › Environments › production › Add environment
   secret** as `MARKETING_DEPLOY_HOOK`.
