# iOS App Store submission

A checklist for sending ace for iPhone and iPad to App Review. Items marked **Owner** need a
decision or a dashboard login that only the owner has. The desktop release is in
[releasing.md](releasing.md).

## Build and upload

`apps/ios/scripts/archive.ts --upload` (`bun run release:upload` in `apps/ios`) archives a signed
Release build and uploads it to App Store Connect, where it shows in TestFlight once Apple has
processed it. The `iOS release` workflow (`.github/workflows/ios-release.yml`) runs the same
script after the simulator tests pass. Submitting a build for review stays a step in App Store
Connect.

One-time setup (**Owner**):

- [ ] Create the app in App Store Connect with bundle id `app.ace.ios`.
- [ ] In the Apple Developer account, register the four App IDs (`app.ace.ios`,
      `app.ace.ios.activity`, `app.ace.ios.share`, `app.ace.ios.notifications`). Add the
      `group.app.ace.ios` app group to all four, and turn on Push Notifications for
      `app.ace.ios`. Register at least one iPhone as a device: the archive signs for
      development first, which needs a device on the team.
- [ ] Create an App Store Connect **Team Key** (Users and Access › Integrations › Team Keys)
      with the **Admin** role. Automatic signing uses it to create the distribution
      certificate and the profiles. The key can act for the whole team, so keep it only in the
      protected environment below.
- [ ] In GitHub, create an environment named `app-store` (Settings › Environments). Add
      yourself as a required reviewer, so every upload waits for your approval, and limit its
      deployment branches and tags to `ios-v*` tags and `main`. Add a tag ruleset so only you
      can create `ios-v*` tags. Then add these secrets to the environment:
  - `ACE_IOS_TEAM_ID`: the Apple Developer team id.
  - `APPLE_API_KEY_P8`: the whole `AuthKey_<id>.p8` file's text.
  - `APPLE_API_KEY_ID`: the key id.
  - `APPLE_API_ISSUER`: the issuer id shown above the keys list.

Each release:

1. Deploy ace cloud first when the build needs a new endpoint: it deploys from a `v*` tag
   (`release.yml`), not from `ios-v*`.
2. Push a tag such as `ios-v1.0.0`, which sets the version to 1.0.0, or run the `iOS release`
   workflow by hand with an optional version and build number.
3. The build number defaults to the UTC time as `YYYYMMDD.HHmmss`, so each build is higher
   than the last, from CI or a Mac. Two builds clash only if they start in the same second.
4. Approve the upload job when GitHub asks.
5. In App Store Connect, answer export compliance for the build if asked, add it to TestFlight
   groups or to a version, and submit.

From a Mac, without CI: set `ACE_IOS_TEAM_ID`, `APPLE_API_KEY` (the `.p8` file's path),
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, then run `bun run release:upload` in `apps/ios`.
`ACE_IOS_VERSION`, `ACE_IOS_BUILD_NUMBER` and `ACE_PUSH` (on by default for uploads) override
the defaults.

## URLs

- Privacy Policy: https://acehq.dev/privacy-policy/
- Support: https://acehq.dev/support/
- Marketing: https://acehq.dev/

The site deploys from `main` on Cloudflare Pages, so these pages must be live before you submit.

## App Privacy answers

Answer App Store Connect's questions to match the privacy policy and the account service:

- [ ] Collected, linked to the user, not used for tracking, purpose App Functionality: **Email
      Address**, **Name**, **User ID** and **Device ID** (the app's random install id, which the
      account service signs into each relay pass and doesn't store).
- [ ] Every other data type: **Not Collected**.
- [ ] Tracking: No.
- [ ] These match `NSPrivacyCollectedDataTypes` in `apps/ios/Resources/PrivacyInfo.xcprivacy`.
      Change both together.

## Sign in with Apple (guideline 4.8)

Sign-in offers Google and GitHub, so App Review expects an equivalent option.

- [ ] **Owner:** in the WorkOS dashboard (AuthKit), enable Apple as a social provider. This needs
      an Apple Services ID and a Sign in with Apple key from the Apple Developer account.
- [ ] Check that the Apple button appears in the app's sign-in and that the privacy policy names
      Apple as a sign-in provider (it lists Google and GitHub only).
- [ ] Deleting an account that signed in with Apple must revoke its Apple tokens (Apple TN3194).
      WorkOS's Delete User may not do this: check with a test Apple account before submitting,
      and add the revocation call if WorkOS doesn't make it.

## Account deletion (guideline 5.1.1(v))

- [ ] The app offers deletion in-app: Profile, then Delete account. Confirm the build you submit
      has it and that it deletes the account, sessions and machine list, and the WorkOS user.
- [ ] The privacy policy and the support page describe the same steps.
- [ ] The cloud Worker with `DELETE /v1/account` is deployed to production (it deploys from a
      `v*` tag, not from `main`). Delete a throwaway account from a Release build against
      production before you submit.

## Export compliance

The app uses TLS for its own traffic and end-to-end encryption (Noise, ADR 0155) between your
devices and your machines.

- [ ] **Owner:** answer Apple's encryption questions in App Store Connect. This is your decision;
      this checklist doesn't give a legal conclusion.
- [ ] Then set `ITSAppUsesNonExemptEncryption` in `apps/ios/project.yml` to match your answer. It
      isn't set today, so App Store Connect asks on every build.

## Age rating

- [ ] **Owner:** complete the questionnaire. The app can show web pages from a paired machine's
      browser, so answer the unrestricted web access question for that. Agents can also produce
      arbitrary text.

## App Review notes

Reviewers can't use ace without a machine to pair with.

- What exists: the fixture (`ACE_FIXTURE`, the `--spike` launch arguments) is compiled into Debug
  and Perf builds only. A Release build has no demo mode, and it requires a pinned WSS connection,
  so it can't talk to a loopback fixture.
- [ ] **Owner:** provide a reachable demo machine (a running ace daemon with a stable relay or
      public address) and put the pairing steps and any account credentials in the review notes.
      Keep it running through review. Or ask for a Release-safe demo mode to be built.
- [ ] State in the notes that sign-in is optional and pairing works without an account.
