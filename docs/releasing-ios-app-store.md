# iOS App Store submission

A checklist for sending ace for iPhone and iPad to App Review. Items marked **Owner** need a
decision or a dashboard login that only the owner has. The desktop release is in
[releasing.md](releasing.md).

## URLs

- Privacy Policy: https://acehq.dev/privacy-policy/
- Support: https://acehq.dev/support/
- Marketing: https://acehq.dev/

The site deploys from `main` on Cloudflare Pages, so these pages must be live before you submit.

## App Privacy answers

Answer App Store Connect's questions to match the privacy policy and the account service:

- [ ] Collected, linked to the user, not used for tracking, purpose App Functionality: **Email
      Address**, **Name** and **User ID**.
- [ ] Every other data type: **Not Collected**.
- [ ] Tracking: No.
- [ ] `apps/ios/Resources/PrivacyInfo.xcprivacy` lists no collected data types today
      (`NSPrivacyCollectedDataTypes` is empty). Add the three above so the manifest says what the
      App Store page says.

## Sign in with Apple (guideline 4.8)

Sign-in offers Google and GitHub, so App Review expects an equivalent option.

- [ ] **Owner:** in the WorkOS dashboard (AuthKit), enable Apple as a social provider. This needs
      an Apple Services ID and a Sign in with Apple key from the Apple Developer account.
- [ ] Check that the Apple button appears in the app's sign-in and that the privacy policy names
      Apple as a sign-in provider (it lists Google and GitHub only).

## Account deletion (guideline 5.1.1(v))

- [ ] The app offers deletion in-app: Profile, then Delete account. Confirm the build you submit
      has it and that it deletes the account, sessions and machine list, and the WorkOS user.
- [ ] The privacy policy and the support page describe the same steps.

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
