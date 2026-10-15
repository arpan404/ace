# Daemon desktop smoke regression coverage

All rows are **not executed (tests run at merge)**. This maps each review mutation
to a behavioural assertion; it is not a record of killed or surviving mutants.
Tests, probes, flakiness runs, benchmarks and native rebuilds need run at merge.
The five-second shutdown timeout is a hang budget, not performance evidence.

| #   | Mutation                                        | Public behaviour coverage                                                                                                                    |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Omit CLI preview option                         | `desktop-smoke.process.test.ts`: real `ace start` exposes a paired, forwarded preview                                                        |
| 2   | Allow host-token links                          | `desktop-smoke`: host token cannot create a preview session                                                                                  |
| 3   | Allow unforwarded links                         | `desktop-smoke`: unforwarded port refuses a session                                                                                          |
| 4   | Remove foreign-Origin refusal                   | `desktop-smoke`: foreign-Origin HTTP receives 403                                                                                            |
| 5   | Skip the fresh start                            | `home-fresh-start.process.test.ts` (service): an unversioned `~/.ace` is renamed to `~/.ace-v0` in one rename and a fresh v1 home is created |
| 6   | Overwrite an existing backup                    | `home-fresh-start` (service): `~/.ace-v0` and `~/.ace-v0.1` stay unchanged; the new backup is `~/.ace-v0.2`                                  |
| 7   | Ignore an older format                          | `home-fresh-start` (service): the bump from v1 to v2 backs up to `~/.ace-v1`                                                                 |
| 8   | Rename a home in use                            | `home-fresh-start.process.test.ts` (daemon): a home whose older daemon still runs is not renamed                                             |
| 9   | Accept installed 0.x metadata                   | `legacy-safety.process.test.ts`: release-shaped 0.x cannot start a service                                                                   |
| 10  | Ignore launcher validation                      | `legacy-safety`: legacy executable cannot borrow rewrite metadata                                                                            |
| 11  | Skip service command validation                 | `legacy-safety`: registered legacy executable refuses; `service-safety.process.test.ts`: extra registration hooks cannot contact manager     |
| 12  | Accept 0.x health                               | `home-fresh-start` (daemon): real CLI refuses a local server's 0.x status                                                                    |
| 13  | Abort opened worker RPCs                        | `notification-readiness-shutdown.process.test.ts`: admitted cursor and cleanup RPCs survive lifetime abort until explicit close              |
| 14  | Omit delivery cancellation                      | `orderly-quit.process.test.ts`: offline push observes abort and shutdown logs no failure                                                     |
| 15  | Suppress real worker errors                     | `orderly-quit`: a thrown worker failure remains in durable logs                                                                              |
| 16  | Suppress all experimental warnings              | `sqlite-warnings.process.test.ts`: unrelated experimental diagnostic remains in stderr                                                       |
| 17  | Suppress coded SQLite warning                   | `sqlite-warnings`: the coded SQLite diagnostic retains its code in stderr                                                                    |
| 18  | Stop awaiting ingestion                         | `notification-readiness-shutdown`: gated subscriber ingest persists its cursor across worker close/reopen                                    |
| 19  | Rename newer data                               | `home-fresh-start` (daemon): a newer-format home exits 65 and is neither renamed nor rewritten                                               |
| 20  | Skip loaded service identity                    | `service-safety`: loaded legacy program refuses every action, with missing or compatible registration; inactive loaded hooks also refuse     |
| 21  | Accept extra launcher commands                  | `legacy-safety`: early legacy exec before pointer resolution, overwritten artifact and extra commands all refuse                             |
| 22  | Skip readiness cancellation                     | `notification-readiness-shutdown`: shutdown during cursor and revocation RPCs with two revoked devices settles readiness as AbortError       |
| 23  | Write the shim before the fresh start           | `home-selection.process.test.ts` (desktop): the CLI shim lands in the new home and the old launcher stays in the backup                      |
| 24  | Use pathname writes after directory replacement | `pinned-directory.process.test.ts` keeps publication on its original inode                                                                   |
| 25  | Restore optional-only service safety            | `service-safety`: direct public `UserService` actions reject a legacy binary without optional preflight                                      |

A service command on a legacy home sets the home aside before any service manager
is contacted, so its launcher is never registered or run (`home-fresh-start`). Existing service lifecycle tests exercise mandatory safety
checks and a process manager fixture whose loaded program is separate from disk.
Existing shutdown regressions are preserved; the gated cases are in a separate file.

Only static checks are permitted this round. Historical packaged idle RSS is
200.36 MiB versus 292.58 MiB from source on Node 24.13.0 at 60 seconds, at head
`6f5b7c61`. Current-head performance needs run at merge. See the benchmark report;
no allocator, worker-count or SQLite cache tuning is claimed.
