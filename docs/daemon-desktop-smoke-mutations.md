# Daemon desktop smoke regression coverage

All rows are **not executed (tests run at merge)**. This maps each review mutation
to a behavioural assertion; it is not a record of killed or surviving mutants.
Tests, probes, flakiness runs, benchmarks and native rebuilds need run at merge.
The five-second shutdown timeout is a hang budget, not performance evidence.

| #   | Mutation                                        | Public behaviour coverage                                                                                                                                                      |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Omit CLI preview option                         | `desktop-smoke.process.test.ts`: real `ace start` exposes a paired, forwarded preview                                                                                          |
| 2   | Allow host-token links                          | `desktop-smoke`: host token cannot create a preview session                                                                                                                    |
| 3   | Allow unforwarded links                         | `desktop-smoke`: unforwarded port refuses a session                                                                                                                            |
| 4   | Remove foreign-Origin refusal                   | `desktop-smoke`: foreign-Origin HTTP receives 403                                                                                                                              |
| 5   | Keep legacy default `.ace`                      | `legacy-home.process.test.ts`: default selects `.ace-next`, legacy bytes/permissions unchanged                                                                                 |
| 6   | Ignore explicit-home compatibility              | `legacy-home`: explicit legacy home refuses before data access                                                                                                                 |
| 7   | Forget sticky marker                            | `legacy-home`: selection persists after removing the old layout                                                                                                                |
| 8   | Accept unknown next directory                   | `legacy-home`: populated unrecognized next home stays untouched                                                                                                                |
| 9   | Accept installed 0.x metadata                   | `legacy-safety.process.test.ts`: release-shaped 0.x cannot start a service                                                                                                     |
| 10  | Ignore launcher validation                      | `legacy-safety`: legacy executable cannot borrow rewrite metadata                                                                                                              |
| 11  | Skip service command validation                 | `legacy-safety`: registered legacy executable refuses; `service-safety.process.test.ts`: extra registration hooks cannot contact manager                                       |
| 12  | Accept 0.x health                               | `legacy-home`: real CLI refuses a local server's 0.x status                                                                                                                    |
| 13  | Abort opened worker RPCs                        | `notification-readiness-shutdown.process.test.ts`: admitted cursor and cleanup RPCs survive lifetime abort until explicit close                                                |
| 14  | Omit delivery cancellation                      | `orderly-quit.process.test.ts`: offline push observes abort and shutdown logs no failure                                                                                       |
| 15  | Suppress real worker errors                     | `orderly-quit`: a thrown worker failure remains in durable logs                                                                                                                |
| 16  | Suppress all experimental warnings              | `sqlite-warnings.process.test.ts`: unrelated experimental diagnostic remains in stderr                                                                                         |
| 17  | Suppress coded SQLite warning                   | `sqlite-warnings`: the coded SQLite diagnostic retains its code in stderr                                                                                                      |
| 18  | Stop awaiting ingestion                         | `notification-readiness-shutdown`: gated subscriber ingest persists its cursor across worker close/reopen                                                                      |
| 19  | Skip marker schema                              | `home-selection.process.test.ts`: empty, corrupt, directory, interrupted, wrong-home, wrong-owner, oversized and symlink markers refuse unknown data                           |
| 20  | Skip loaded service identity                    | `service-safety`: loaded legacy program refuses every action, with missing or compatible registration; inactive loaded hooks also refuse                                       |
| 21  | Accept extra launcher commands                  | `legacy-safety`: early legacy exec before pointer resolution, overwritten artifact and extra commands all refuse                                                               |
| 22  | Skip readiness cancellation                     | `notification-readiness-shutdown`: shutdown during cursor and revocation RPCs with two revoked devices settles readiness as AbortError                                         |
| 23  | Remove selection serialization                  | `home-selection`: concurrent child launches agree; controlled lock contention waits for complete publication                                                                   |
| 24  | Use pathname writes after directory replacement | `home-selection`: replacement during publication refuses startup and leaves legacy bytes unchanged; `pinned-directory.process.test.ts` keeps publication on its original inode |
| 25  | Restore optional-only service safety            | `service-safety`: direct public `UserService` actions reject a legacy binary without optional preflight                                                                        |

The manager-contact claim in `legacy-home` now has a real executable sentinel for
both launchctl and systemctl. A manager that runs and then rejects can no longer
pass that assertion. Existing service lifecycle tests exercise mandatory safety
checks and a process manager fixture whose loaded program is separate from disk.
Existing shutdown regressions are preserved; the gated cases are in a separate file.

Only static checks are permitted this round. Historical packaged idle RSS is
200.36 MiB versus 292.58 MiB from source on Node 24.13.0 at 60 seconds, at head
`6f5b7c61`. Current-head performance needs run at merge. See the benchmark report;
no allocator, worker-count or SQLite cache tuning is claimed.
