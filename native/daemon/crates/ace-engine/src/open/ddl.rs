// SPDX-License-Identifier: Apache-2.0
//! The engine opener's DDL, byte for byte from the TypeScript constructors `open.ts` runs.
//! Each constant is the exact `db.exec` text; SQLite publishes it in `sqlite_master`.

/// `initializeThreadCleanup` (`thread-cleanup.ts`): the cleanup fences and the two per-thread plans.
pub(crate) const CLEANUP: &str = r#"
    CREATE TABLE IF NOT EXISTS storage_cleanup_fences(thread_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_cleanup (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), command TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_cleanup_members (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), owner TEXT NOT NULL REFERENCES thread_cleanup(thread_id)
    );
    CREATE INDEX IF NOT EXISTS thread_cleanup_owner ON thread_cleanup_members(owner);
  "#;

/// `AceInputs` (`ace-inputs.ts`): the outcomes ace recorded for its own inputs.
pub(crate) const ACE_INPUTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_ace_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(thread_id,command_id)
    )"#;

/// `migrateEngine` (`migrations.ts:9`): the version row.
pub(crate) const SCHEMA_VERSION: &str = r#"CREATE TABLE IF NOT EXISTS engine_schema_version (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )"#;

/// `migrateEngine` (`migrations.ts:31`-`:70`): a fresh home's core engine tables.
pub(crate) const ENGINE_SCHEMA: &str = r#"CREATE TABLE thread_state (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), state JSON NOT NULL, seq INTEGER NOT NULL
  );
  CREATE TABLE engine_sessions (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), cwd TEXT NOT NULL,
    model TEXT, native_session_id TEXT, instance_id TEXT, options JSON,
    workspace_ready INTEGER NOT NULL DEFAULT 1 CHECK(workspace_ready IN (0,1)), backend TEXT
  );
  CREATE TABLE intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL, payload JSON NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, resolution_id TEXT UNIQUE,
    awaiting INTEGER NOT NULL DEFAULT 0, ack_target INTEGER,
    acknowledged INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'queue', trigger TEXT,
    submitted_generation INTEGER, resolution_generation INTEGER,
    position INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX intents_pending ON intents(thread_id, status, id);
  CREATE INDEX intents_waiting_ack ON intents(thread_id,id) WHERE awaiting=1;
  CREATE INDEX intents_outstanding ON intents(status,id) WHERE status IN ('pending','queued','running');
  CREATE TABLE engine_state_records (
    thread_id TEXT NOT NULL REFERENCES thread_state(thread_id), section TEXT NOT NULL, key TEXT NOT NULL, value JSON NOT NULL,
    PRIMARY KEY(thread_id, section, key)
  );
  CREATE TABLE engine_slots (thread_id TEXT PRIMARY KEY);
  CREATE TABLE engine_raw_blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  CREATE TABLE engine_state_appends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
    section TEXT NOT NULL, key TEXT NOT NULL, patch JSON NOT NULL
  );
  CREATE INDEX engine_state_appends_by_key ON engine_state_appends(thread_id,section,key,id);
  CREATE TABLE engine_provider_cursors (thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, offset INTEGER NOT NULL);
  CREATE TABLE engine_provider_frames (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, generation TEXT NOT NULL, seq INTEGER NOT NULL,
    frame JSON NOT NULL, PRIMARY KEY(thread_id,generation,seq)
  );
  CREATE INDEX engine_provider_frames_thread ON engine_provider_frames(thread_id);"#;

/// `indexEngineRecords` (`engine-record-indexes.ts`).
pub(crate) const RECORD_INDEXES: &str = r#"
    CREATE INDEX IF NOT EXISTS engine_interaction_records ON engine_state_records(section,thread_id)
      WHERE section IN ('interactions','interactionHistory');
    CREATE INDEX IF NOT EXISTS engine_agent_records ON engine_state_records(thread_id)
      WHERE section='agents';
  "#;

/// `AttachmentCorrelations` (`attachment-correlations.ts`).
pub(crate) const ATTACHMENT_INPUTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_attachment_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, intent_id INTEGER NOT NULL,
      attachment JSON NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_attachment_paths (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS engine_attachment_read_paths ON engine_attachment_paths(thread_id,path);"#;

/// The interaction and task entity index (`repository.ts:126`).
pub(crate) const ENTITY_INDEX: &str = r#"CREATE INDEX IF NOT EXISTS engine_entity_ids ON engine_state_records(thread_id,section,json_extract(value,'$.id')) WHERE section IN ('interactions','tasks')"#;

/// `createPermissionTables` (`permission-storage.ts:46`).
pub(crate) const PERMISSIONS: &str = r#"
      CREATE TABLE IF NOT EXISTS engine_permissions (
        thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT, parent TEXT,
        ceiling_provider TEXT, ceiling_mode TEXT, ceiling_identity TEXT
      );
    "#;

/// `workspaceReservations.initializeSessions` (`workspace-reservations.ts`).
pub(crate) const SESSIONS_INDEX: &str =
    r#"CREATE INDEX IF NOT EXISTS engine_sessions_root ON engine_sessions(cwd,thread_id)"#;

/// `ProviderRecovery` (`recovery.ts`): the cursor prune marker.
pub(crate) const CURSOR_PRUNE: &str =
    r#"CREATE TABLE IF NOT EXISTS engine_cursor_prune(thread_id TEXT PRIMARY KEY)"#;

/// `SteerNotes` (`steer-notes.ts`).
pub(crate) const STEER_NOTES: &str = r#"CREATE TABLE IF NOT EXISTS engine_steer_notes (
        intent_id INTEGER PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,
        person INTEGER NOT NULL DEFAULT 0, fell_back INTEGER NOT NULL DEFAULT 0)"#;

/// `SteerAims` (`steer-aims.ts`).
pub(crate) const STEER_AIMS: &str = r#"CREATE TABLE IF NOT EXISTS engine_steer_aims (
        intent_id INTEGER PRIMARY KEY, run TEXT)"#;

/// `QueueStore` (`queue-store.ts:62`-`:79`).
pub(crate) const QUEUE: &str = r#"CREATE TABLE IF NOT EXISTS engine_queue (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT,
        hold_token INTEGER NOT NULL DEFAULT 0, last_failure TEXT, preferences JSON,
        exited INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS engine_queue_attachments (
        intent_id INTEGER NOT NULL REFERENCES intents(id),thread_id TEXT NOT NULL,hash TEXT NOT NULL,
        PRIMARY KEY(intent_id,hash)
      );
      CREATE INDEX IF NOT EXISTS engine_queue_attachment_lookup ON engine_queue_attachments(thread_id,hash);
      CREATE INDEX IF NOT EXISTS engine_queue_deadline ON engine_queue(resume_at) WHERE resume_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS intents_live_positions ON intents(thread_id,position) WHERE status IN ('pending','queued','running') OR uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_uncertain ON intents(thread_id) WHERE uncertain=1;
      CREATE INDEX IF NOT EXISTS intents_queue_messages_recovery ON intents(thread_id,position,id) WHERE ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1));
      CREATE INDEX IF NOT EXISTS intents_queue_order ON intents(thread_id,position,id) WHERE status IN ('pending','queued');"#;

/// `QueueStore` (`queue-store.ts:71`).
pub(crate) const QUEUE_RECOVERY: &str = r#"CREATE INDEX IF NOT EXISTS engine_queue_recovery ON engine_queue(thread_id) WHERE continuation IS NOT NULL OR trigger IS NOT NULL OR limited=1 OR paused=1"#;

/// `IntentStore` (`intents.ts`).
pub(crate) const INTENT_INDEXES: &str = r#"CREATE INDEX IF NOT EXISTS intents_submission_generation ON intents(thread_id,submitted_generation);
        CREATE INDEX IF NOT EXISTS intents_dispatch ON intents(thread_id,kind,position,id) WHERE status IN ('pending','queued');
        CREATE INDEX IF NOT EXISTS intents_latest_inputs ON intents(thread_id,id DESC) WHERE kind IN ('thread.send','thread.create');
        CREATE INDEX IF NOT EXISTS intents_running ON intents(thread_id) WHERE status='running';"#;

/// `InputJournal` (`input-journal.ts:71`).
pub(crate) const INPUTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_inputs (
      ordinal INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, item_key TEXT NOT NULL,
      signature TEXT NOT NULL, origin JSON NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0, generation INTEGER, run_id TEXT, UNIQUE(thread_id,item_key));
      CREATE INDEX IF NOT EXISTS engine_inputs_echo ON engine_inputs(thread_id,signature,sent,matched,ordinal);
      CREATE TABLE IF NOT EXISTS engine_input_echoes (
        thread_id TEXT NOT NULL, native_key TEXT NOT NULL, item_key TEXT NOT NULL,
        PRIMARY KEY(thread_id,native_key));"#;

/// `InputJournal` (`input-journal.ts:82`).
pub(crate) const INPUT_IDENTITIES: &str = r#"CREATE TABLE IF NOT EXISTS engine_input_identities (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        native_id TEXT NOT NULL, command_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,native_id))"#;

/// `InputJournal` (`input-journal.ts:88`).
pub(crate) const INPUT_REPLACEMENTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_input_replacements (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL, replacement_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,command_id))"#;

/// `InputJournal` (`input-journal.ts:95`).
pub(crate) const INPUT_INDEXES: &str = r#"CREATE INDEX IF NOT EXISTS engine_inputs_run ON engine_inputs(thread_id,run_id);
        CREATE INDEX IF NOT EXISTS engine_inputs_delivery ON engine_inputs(thread_id,generation,signature,sent,matched,ordinal);
        CREATE TRIGGER IF NOT EXISTS engine_inputs_delete AFTER DELETE ON threads BEGIN
          DELETE FROM engine_input_echoes WHERE thread_id=OLD.id;
          DELETE FROM engine_inputs WHERE thread_id=OLD.id;
        END;"#;

/// `InteractionLedger` (`interaction-ledger.ts:9`).
pub(crate) const INTERACTION_REQUESTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_interaction_requests (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        interaction_id TEXT NOT NULL, native_key TEXT NOT NULL, native_item TEXT,
        binding TEXT NOT NULL, generation INTEGER, state TEXT NOT NULL,
        PRIMARY KEY(thread_id,interaction_id));
        CREATE INDEX IF NOT EXISTS engine_requests_generation ON engine_interaction_requests(thread_id,generation);
        CREATE INDEX IF NOT EXISTS engine_requests_native ON engine_interaction_requests(thread_id,binding,native_item,state);
        CREATE INDEX IF NOT EXISTS engine_requests_key ON engine_interaction_requests(thread_id,native_key,state);"#;

/// `engine_handoff_grants` (`repository.ts`, the handoff grant table).
pub(crate) const HANDOFF_GRANTS: &str = r#"CREATE TABLE IF NOT EXISTS engine_handoff_grants (
      recipient TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      through_seq INTEGER NOT NULL, PRIMARY KEY(recipient, source)
    )"#;

/// `engine_provider_sessions` (the provider session binding table).
pub(crate) const PROVIDER_SESSIONS: &str = r#"CREATE TABLE IF NOT EXISTS engine_provider_sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '',
        backend TEXT, native_session_id TEXT NOT NULL, through_seq INTEGER NOT NULL,
        PRIMARY KEY(thread_id, provider, instance_id)
      )"#;

/// `engine_store_generations` (`store-generations.ts`).
pub(crate) const STORE_GENERATIONS: &str = r#"CREATE TABLE IF NOT EXISTS engine_store_generations (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL
      )"#;

/// `TransitionState` (`transition-state.ts`).
pub(crate) const TRANSITIONS: &str = r#"
      CREATE TABLE IF NOT EXISTS engine_transitions (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, value JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engine_transition_guards (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, command_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engine_model_options (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, model TEXT NOT NULL, value JSON NOT NULL,
        PRIMARY KEY(thread_id,provider,model)
      );"#;

/// `TransitionReadiness` (`transition-readiness.ts:54`).
pub(crate) const TRANSITION_BLOCKERS: &str = r#"CREATE TABLE IF NOT EXISTS engine_transition_blockers (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_key TEXT NOT NULL, PRIMARY KEY(thread_id, agent_key)
    )"#;

/// `threadOwnershipTable` (`thread-ownership.ts`).
pub(crate) const OWNERSHIP: &str = r#"CREATE TABLE IF NOT EXISTS thread_ownership (
  thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, transfer_id TEXT NOT NULL,
  peer TEXT NOT NULL, epoch INTEGER NOT NULL, prior TEXT, at INTEGER NOT NULL)"#;

/// `RestartStreaks` (`restart-resume.ts:78`).
pub(crate) const RESTART_RESUMES: &str = r#"CREATE TABLE IF NOT EXISTS engine_restart_resumes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        streak INTEGER NOT NULL
      )"#;

/// `RestartCaptures` (`restart-captures.ts:23`): what the restart evidence waits on.
pub(crate) const RESTART_CAPTURES: &str = r#"CREATE TABLE IF NOT EXISTS engine_restart_captures (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        waiting_on TEXT
      )"#;
