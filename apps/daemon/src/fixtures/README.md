These compressed SQLite fixtures were generated from ace `origin/main` revision
`5233692f3e45b031394ab73cb22628e0c5c41027` on 2026-10-07. A temporary copy of that
revision used its public Store, Engine and ConductorStore with a scripted adapter.
No provider CLI ran.

`events.sqlite.gz` captures a prepared Deck root with a pending conductor plan gate
and a live planner provider session with a pending private browser approval. The
original main schema includes Deck ownership, execution bindings and command
attempts. `conductor.sqlite.gz` contains the matching planning run and live lane,
created through ConductorStore.create. The event database was backed up while the
scripted session was live, before shutdown. All paths, identities and input are
synthetic; the old temporary workspace no longer exists.

The upgrade test extracts copies into a fresh temporary daemon home and remaps
the synthetic workspace path to an existing directory inside that home. It verifies
that startup preserves the threads, cancels only the removed host gate, retains
the shared browser owner's normal orphan-expiration behavior, permits an ordinary
follow-up and leaves the retired conductor database untouched across two starts.
