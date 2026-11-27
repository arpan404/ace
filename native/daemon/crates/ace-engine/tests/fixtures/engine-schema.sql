CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
CREATE TABLE events (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    at INTEGER NOT NULL, type TEXT NOT NULL, payload JSON NOT NULL
  );
CREATE INDEX events_thread_seq ON events(thread_id, seq);
CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, received_at INTEGER NOT NULL, result JSON NOT NULL
  );
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
CREATE TABLE threads (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL,
    provider TEXT NOT NULL, status JSON NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    archived_at INTEGER, root_agent_id TEXT
  , imported JSON, acp JSON, transitions JSON, provider_metadata JSON, client JSON);
CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes JSON NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
  , expires_at INTEGER, install_id TEXT, merged_into TEXT, account_link TEXT, person INTEGER, standing_key TEXT);
CREATE TABLE items (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    created_seq INTEGER NOT NULL UNIQUE, item JSON NOT NULL
  );
CREATE INDEX items_thread_creation ON items(thread_id, created_seq);
CREATE TABLE output_streams (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL UNIQUE, size INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE output_chunks (
    stream_id TEXT NOT NULL REFERENCES output_streams(id) ON DELETE CASCADE,
    offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
  );
CREATE TABLE blobs (
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    UNIQUE(thread_id, sha256)
  );
CREATE TABLE host_sequence (id INTEGER PRIMARY KEY CHECK(id = 1), seq INTEGER NOT NULL);
CREATE TABLE payload_migration (id INTEGER PRIMARY KEY);
CREATE TABLE item_heads (
    id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, created_seq INTEGER NOT NULL UNIQUE,
    size INTEGER NOT NULL, item_type TEXT NOT NULL, text_prefix INTEGER NOT NULL
  , text_last_unit INTEGER NOT NULL DEFAULT -1, agent_id TEXT NOT NULL DEFAULT '', raw_seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX item_heads_thread_creation ON item_heads(thread_id, created_seq);
CREATE TABLE item_text_chunks (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, field TEXT NOT NULL, append TEXT NOT NULL, PRIMARY KEY(item_id, seq)
  );
CREATE TABLE view_entities (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    collection TEXT NOT NULL, id TEXT NOT NULL, value JSON NOT NULL,
    PRIMARY KEY(thread_id, collection, id)
  );
CREATE TABLE status_migration (id INTEGER PRIMARY KEY);
CREATE TABLE text_encoding_migration (id INTEGER PRIMARY KEY);
CREATE TABLE item_previews (
    id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, item JSON NOT NULL, target INTEGER NOT NULL
  );
CREATE TABLE item_preview_migration (id INTEGER PRIMARY KEY);
CREATE UNIQUE INDEX imported_source ON threads(json_extract(imported,'$.sourceId')) WHERE imported IS NOT NULL;
CREATE TABLE history_blobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,size INTEGER NOT NULL);
CREATE TABLE history_blob_chunks(blob_id TEXT NOT NULL REFERENCES history_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob_id,offset));
CREATE TABLE usage_deletions (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE item_text_streams (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     item_id TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL
   );
CREATE TABLE "item_source_chunks" (
     stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE,
     offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
   );
CREATE INDEX item_text_streams_item ON item_text_streams(item_id, part);
CREATE TABLE item_text_targets (
     item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
     stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE
   );
CREATE TABLE streamed_blobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,size INTEGER NOT NULL,sha256 TEXT,storage_id TEXT NOT NULL,chunks INTEGER NOT NULL DEFAULT 0);
CREATE TABLE streamed_blob_chunks(blob_id TEXT NOT NULL REFERENCES streamed_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob_id,offset));
CREATE INDEX streamed_blob_hash ON streamed_blobs(thread_id,sha256);
CREATE INDEX engine_live_threads ON threads(id)
    WHERE json_extract(status,'$.state') NOT IN ('new','done','failed');
CREATE TABLE upgrade_cleanup (id TEXT PRIMARY KEY);
CREATE INDEX item_heads_thread_agent ON item_heads(thread_id, agent_id, created_seq);
CREATE TABLE thread_cold (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE ON UPDATE CASCADE,
    details JSON,
    capabilities JSON
  );
CREATE TABLE skill_usage (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(item_id, name)
  );
CREATE INDEX skill_usage_name_at ON skill_usage(name, at);
CREATE TABLE machine_children (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, parent_thread TEXT NOT NULL,
  parent_agent TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, view TEXT,
  settled INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, settled_at INTEGER, rechecked INTEGER NOT NULL DEFAULT 0, device_id TEXT, lost_at INTEGER, lost_key TEXT, lost_ask TEXT, seen_at INTEGER, silent_since INTEGER, stop_started_at INTEGER, stop_attempts INTEGER NOT NULL DEFAULT 0, stop_last_at INTEGER, stopped_unconfirmed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX machine_children_settled ON machine_children(settled, settled_at);
CREATE INDEX machine_children_recheck
    ON machine_children(settled, machine, rechecked);
CREATE TABLE machine_child_messages (
    child_id TEXT NOT NULL, request_id TEXT NOT NULL, message TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (child_id, request_id));
CREATE INDEX machine_child_messages_due
    ON machine_child_messages(next_retry_at, created_at);
CREATE TABLE machine_threads (
  thread_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL,
  origin_host TEXT NOT NULL, origin_thread TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE machine_child_launches (
    thread_id TEXT PRIMARY KEY, parent TEXT NOT NULL, role TEXT NOT NULL, outcome TEXT,
    active INTEGER NOT NULL DEFAULT 0);
CREATE INDEX machine_child_launches_active
    ON machine_child_launches(parent, active);
CREATE INDEX machine_children_lost ON machine_children(lost_ask)
    WHERE lost_ask IS NOT NULL;
CREATE INDEX machine_children_parent ON machine_children(parent_thread, settled);
CREATE INDEX machine_children_undelivered ON machine_children(settled_at)
    WHERE settled = 1 AND delivered = 0;
CREATE TABLE machine_child_cursors (
    machine TEXT PRIMARY KEY, served INTEGER NOT NULL DEFAULT 0, after TEXT);
CREATE INDEX machine_child_cursors_served
    ON machine_child_cursors(served, machine);
CREATE INDEX machine_children_unsettled ON machine_children(machine, id)
    WHERE settled = 0;
CREATE TABLE machine_message_rejections (
    request_key TEXT PRIMARY KEY, device_id TEXT NOT NULL, code TEXT NOT NULL,
    message TEXT NOT NULL);
CREATE INDEX machine_message_rejections_device
    ON machine_message_rejections(device_id);
CREATE TRIGGER machine_message_rejections_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_message_rejections WHERE device_id = NEW.id; END;
CREATE TABLE machine_grants (
  device_id TEXT NOT NULL, capability TEXT NOT NULL, level TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, capability));
CREATE TRIGGER machine_grants_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_grants WHERE device_id = NEW.id; END;
CREATE TABLE machine_jobs (
  machine TEXT NOT NULL, job_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  deadline INTEGER NOT NULL, stopping INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (machine, job_id));
CREATE TABLE agent_conversations (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      owner_thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      owner_agent TEXT NOT NULL, root_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(owner_thread,request_id)
    );
CREATE INDEX agent_conversations_owner ON agent_conversations(owner_thread,thread_id);
CREATE INDEX agent_conversations_root ON agent_conversations(root_id,thread_id);
CREATE INDEX machine_children_seen ON machine_children(seen_at)
    WHERE settled = 0;
CREATE INDEX machine_children_stopping ON machine_children(stop_started_at)
    WHERE settled = 0 AND stop_started_at IS NOT NULL;
CREATE TABLE machine_code (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    hash TEXT,
    version INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER
  );
CREATE TABLE machine_code_passes (
    device_id TEXT NOT NULL,
    account TEXT NOT NULL,
    version INTEGER NOT NULL,
    passed_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, account)
  );
CREATE INDEX devices_install ON devices(install_id) WHERE install_id IS NOT NULL;
CREATE TABLE outside_grants (
    id TEXT PRIMARY KEY,
    client_kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    scopes TEXT NOT NULL,
    projects TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    approved_by TEXT NOT NULL
  );
CREATE TABLE outside_grant_tokens (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER,
    rotated_at INTEGER,
    pair TEXT,
    successor TEXT
  , resource TEXT);
CREATE INDEX outside_grant_tokens_grant ON outside_grant_tokens(grant_id);
CREATE INDEX outside_grant_tokens_pair ON outside_grant_tokens(pair);
CREATE TABLE outside_grant_threads (
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (grant_id, thread_id, kind)
  );
CREATE TABLE outside_oauth_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );
CREATE TABLE spade_computer_drivers (bot TEXT PRIMARY KEY, takeover TEXT NOT NULL);
CREATE TABLE sidebar_thread_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE
    );
CREATE TABLE sidebar_thread_deletes (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL
    );
CREATE TABLE sidebar_epoch (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    );
CREATE TABLE sidebar_thread_removals (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL
    );
CREATE TABLE sidebar_revisions_complete (id INTEGER PRIMARY KEY CHECK (id = 1));
CREATE TRIGGER sidebar_thread_insert AFTER INSERT ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
CREATE TRIGGER sidebar_thread_update AFTER UPDATE ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
CREATE TRIGGER sidebar_thread_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
      UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
      INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
      DELETE FROM sidebar_thread_removals
        WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - 4096;
    END;
CREATE TRIGGER sidebar_thread_delete AFTER DELETE ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
      UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
      INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
      DELETE FROM sidebar_thread_removals
        WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - 4096;
    END;
CREATE TABLE thread_row_shape (
      id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
    );
CREATE TABLE thread_row_trust (
      thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL
    );
CREATE TABLE thread_row_trust_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, orphans_after TEXT
    );
CREATE TRIGGER thread_row_trust_owner_delete AFTER DELETE ON threads BEGIN
      DELETE FROM thread_row_trust WHERE thread_id = OLD.id;
    END;
CREATE TRIGGER thread_row_trust_owner_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      DELETE FROM thread_row_trust WHERE thread_id = OLD.id;
    END;
CREATE TABLE workspace_metadata (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), icon TEXT, default_icon TEXT
  , badge TEXT, defaults TEXT, notes TEXT, kind TEXT, repositories TEXT);
CREATE TABLE workspace_unregistered (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), removed_at INTEGER NOT NULL
  );
CREATE TABLE workspace_recent (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), opened_at INTEGER NOT NULL
  );
CREATE INDEX threads_project_order ON threads(workspace_id, id);
CREATE INDEX workspace_recent_order ON workspace_recent(opened_at DESC, workspace_id);
CREATE TABLE workspace_identity (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), identity_id TEXT NOT NULL,
    source TEXT NOT NULL, linked_at INTEGER NOT NULL
  );
CREATE INDEX workspace_identity_by_id ON workspace_identity(identity_id);
CREATE TABLE identity_alias (
    from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL, at INTEGER NOT NULL
  );
CREATE INDEX identity_alias_by_target ON identity_alias(to_id, at DESC);
CREATE TABLE workspace_remote_key (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), remotes TEXT, subpath TEXT,
    read_at INTEGER, apart INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE storage_removed_roots(root TEXT PRIMARY KEY,at INTEGER NOT NULL);
CREATE TABLE workspace_root_reservations (
      root TEXT PRIMARY KEY, thread_id TEXT NOT NULL, command_id TEXT NOT NULL
    );
CREATE INDEX workspace_reservation_owner ON workspace_root_reservations(thread_id);
CREATE TABLE workspace_canonical_roots (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), root TEXT NOT NULL);
CREATE INDEX workspace_canonical_root ON workspace_canonical_roots(root,workspace_id);
CREATE TRIGGER thread_cold_insert AFTER INSERT ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id = NEW.thread_id;
    END;
CREATE TRIGGER thread_cold_update AFTER UPDATE ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id IN (OLD.thread_id, NEW.thread_id)
        AND thread_id IN (SELECT id FROM threads);
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id IN (OLD.thread_id, NEW.thread_id);
    END;
CREATE TRIGGER thread_cold_delete AFTER DELETE ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.thread_id
        AND thread_id IN (SELECT id FROM threads);
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id = OLD.thread_id;
    END;
CREATE TRIGGER thread_cold_owner_delete AFTER DELETE ON threads BEGIN
      DELETE FROM thread_cold WHERE thread_id = OLD.id;
    END;
CREATE TRIGGER thread_cold_owner_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      UPDATE thread_cold SET thread_id = NEW.id WHERE thread_id = OLD.id;
    END;
CREATE TABLE thread_cold_moved (id INTEGER PRIMARY KEY CHECK (id = 1));
CREATE TABLE sidebar_thread_columns (
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  readable INTEGER NOT NULL,
  workspace_id TEXT,
  deleted INTEGER,
  archived INTEGER,
  settled INTEGER,
  counted INTEGER,
  activity,
  archived_at INTEGER);
CREATE TABLE sidebar_columns_shape (
      id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
    );
CREATE INDEX sidebar_columns_paged ON sidebar_thread_columns(activity DESC, thread_id) WHERE deleted = 0 AND archived = 0 AND settled = 1;
CREATE INDEX sidebar_columns_paged_project ON sidebar_thread_columns(workspace_id, activity DESC, thread_id) WHERE deleted = 0 AND archived = 0 AND settled = 1;
CREATE INDEX sidebar_columns_active ON sidebar_thread_columns(workspace_id, activity DESC, thread_id) WHERE deleted = 0 AND archived = 0 AND settled = 0;
CREATE INDEX sidebar_columns_archived ON sidebar_thread_columns(archived_at DESC, thread_id) WHERE deleted = 0 AND archived = 1;
CREATE INDEX sidebar_columns_archived_project ON sidebar_thread_columns(workspace_id, archived_at DESC, thread_id) WHERE deleted = 0 AND archived = 1;
CREATE INDEX sidebar_columns_counted ON sidebar_thread_columns(archived, workspace_id) WHERE deleted = 0 AND counted = 1;
CREATE INDEX sidebar_columns_unreadable ON sidebar_thread_columns(thread_id) WHERE readable = 0;
CREATE TABLE sidebar_columns_complete (id INTEGER PRIMARY KEY CHECK (id = 1));
CREATE TRIGGER sidebar_columns_insert AFTER INSERT ON sidebar_thread_revisions BEGIN
      DELETE FROM sidebar_thread_columns WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_columns SELECT threads.id, revisions.revision, 1, workspace_id AS workspace_id, ((json_extract(client, '$.deletedAt') IS NOT NULL OR json_extract(client, '$.host') IS NOT NULL)) AS deleted, archived_at IS NOT NULL AS archived, (COALESCE(json_extract(client, '$.pinned'), 0) != 1 AND json_extract(client, '$.settledAt') IS NOT NULL AND json_extract(status, '$.state') NOT IN ('working', 'needs_you') AND NOT COALESCE(json_extract(status, '$.state') = 'failed' AND json_extract(client, '$.activityAt') > json_extract(client, '$.settledAt') AND COALESCE(json_extract(client, '$.readAt'), 0) < json_extract(client, '$.activityAt'), 0) AND (CASE WHEN COALESCE(json_extract(client, '$.settledReason'), '') = 'manual' THEN NOT COALESCE((COALESCE(json_extract(provider_metadata, '$.queue.paused'), 0) = 1 AND json_extract(provider_metadata, '$.queue.resumeAt') IS NULL AND json_extract(provider_metadata, '$.queue.reason') IS NOT NULL AND json_extract(provider_metadata, '$.queue.reason') NOT IN ('limit', 'snooze') AND NOT (json_extract(provider_metadata, '$.queue.reason') = 'manual' AND COALESCE(json_extract(provider_metadata, '$.queue.pendingCount'), 0) = 0)) AND json_extract(provider_metadata, '$.queue.reason') IN ('not_sent', 'uncertain') AND json_extract(client, '$.settledOverQueue') IS NOT json_extract(provider_metadata, '$.queue.revision'), 0) ELSE NOT (COALESCE(json_extract(provider_metadata, '$.queue.paused'), 0) = 1 AND json_extract(provider_metadata, '$.queue.resumeAt') IS NULL AND json_extract(provider_metadata, '$.queue.reason') IS NOT NULL AND json_extract(provider_metadata, '$.queue.reason') NOT IN ('limit', 'snooze') AND NOT (json_extract(provider_metadata, '$.queue.reason') = 'manual' AND COALESCE(json_extract(provider_metadata, '$.queue.pendingCount'), 0) = 0)) END)) AS settled, CASE WHEN (COALESCE(json_extract(client, '$.hasSentMessage'), 1) != 0 AND NOT (json_extract(client, '$.hasSentMessage') IS NULL AND json_extract(status, '$.state') = 'new' AND title = 'New thread') AND json_extract(transitions, '$.delegatedFrom') IS NULL) THEN 1 ELSE 0 END AS counted, COALESCE(json_extract(client, '$.activityAt'), updated_at) AS activity, archived_at AS archived_at FROM (SELECT threads.*, ((json_valid(client) IS NOT 0 AND json_valid(status) IS NOT 0 AND json_valid(provider_metadata) IS NOT 0 AND json_valid(transitions) IS NOT 0 AND typeof(client) != 'blob' AND typeof(status) != 'blob' AND typeof(provider_metadata) != 'blob' AND typeof(transitions) != 'blob')) AS readable FROM threads WHERE id = NEW.thread_id) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE threads.readable
    UNION ALL SELECT threads.id, revisions.revision, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM (SELECT threads.*, ((json_valid(client) IS NOT 0 AND json_valid(status) IS NOT 0 AND json_valid(provider_metadata) IS NOT 0 AND json_valid(transitions) IS NOT 0 AND typeof(client) != 'blob' AND typeof(status) != 'blob' AND typeof(provider_metadata) != 'blob' AND typeof(transitions) != 'blob')) AS readable FROM threads WHERE id = NEW.thread_id) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE NOT threads.readable;
    END;
CREATE TRIGGER sidebar_columns_delete AFTER DELETE ON sidebar_thread_revisions BEGIN
      DELETE FROM sidebar_thread_columns WHERE thread_id = OLD.thread_id;
    END;
CREATE TABLE stored_event_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, first_seq INTEGER NOT NULL
  );
CREATE TABLE stored_event_generation (
    id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL
  );
CREATE TRIGGER stored_event_shape_inserted AFTER INSERT ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER stored_event_shape_updated AFTER UPDATE ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER stored_event_shape_deleted AFTER DELETE ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TABLE stored_event_confirmed (
    id INTEGER PRIMARY KEY CHECK(id = 1), build TEXT NOT NULL, shape TEXT NOT NULL,
    generation INTEGER NOT NULL, from_seq INTEGER NOT NULL
  );
CREATE TABLE stored_event_rejected (seq INTEGER PRIMARY KEY);
CREATE INDEX threads_update_blockers ON threads(id) WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed');
CREATE INDEX threads_workspace_live ON threads(workspace_id, archived_at, id);
CREATE TABLE native_images (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, path TEXT NOT NULL, source TEXT, hash TEXT, attachment JSON, error TEXT,
      PRIMARY KEY(thread_id,item_id));
CREATE INDEX native_image_reference ON native_images(thread_id,path);
CREATE INDEX native_image_retention ON native_images(thread_id,hash);
CREATE TABLE ace_tools (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, seq INTEGER NOT NULL,
      started INTEGER NOT NULL, status TEXT NOT NULL);
CREATE INDEX ace_tool_match ON ace_tools(thread_id,agent_id,name,args,seq);
CREATE TABLE ace_results (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER, since_seq INTEGER NOT NULL,
      item_id TEXT UNIQUE, bound_id TEXT, result JSON, notice_id TEXT);
CREATE INDEX ace_result_pending ON ace_results(thread_id,agent_id,name,args,finished) WHERE item_id IS NULL;
CREATE INDEX ace_result_session ON ace_results(session_id,name,args) WHERE item_id IS NULL;
CREATE TABLE ace_result_images (
      result_id TEXT NOT NULL REFERENCES ace_results(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, hash TEXT NOT NULL,
      PRIMARY KEY(result_id,hash));
CREATE INDEX ace_result_image ON ace_result_images(thread_id,hash);
CREATE TABLE measurement_tools (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, seq INTEGER NOT NULL,
      started INTEGER NOT NULL, status TEXT NOT NULL);
CREATE INDEX measurement_tool_match ON measurement_tools(thread_id,name,args,started,seq);
CREATE TABLE step_measurements (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER NOT NULL, since_seq INTEGER NOT NULL,
      item_id TEXT UNIQUE, bound_id TEXT, measurement JSON NOT NULL, filmstrip TEXT);
CREATE INDEX measurement_pending ON step_measurements(thread_id,name,args,finished) WHERE item_id IS NULL;
CREATE INDEX measurement_lease ON step_measurements(session_id,name,args) WHERE item_id IS NULL;
CREATE INDEX measurement_attachment ON step_measurements(thread_id,filmstrip);
CREATE INDEX output_streams_thread ON output_streams(thread_id);
CREATE INDEX item_text_streams_thread ON item_text_streams(thread_id);
CREATE INDEX history_blobs_thread ON history_blobs(thread_id);
CREATE INDEX ace_results_thread ON ace_results(thread_id);
CREATE TABLE history_inventory (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, total INTEGER NOT NULL
    );
CREATE TABLE history_items (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      created_seq INTEGER NOT NULL, ordinal INTEGER NOT NULL
    );
CREATE INDEX history_items_creation ON history_items(thread_id,created_seq);
CREATE TABLE history_item_revisions (
      item_id TEXT NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, item JSON NOT NULL, PRIMARY KEY(item_id,seq)
    );
CREATE INDEX history_completed_revisions ON history_item_revisions(item_id,seq)
      WHERE json_extract(item,'$.complete')=1;
CREATE TABLE history_stream_versions (
      stream_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, seq INTEGER NOT NULL, size INTEGER NOT NULL,
      encoding TEXT NOT NULL, PRIMARY KEY(stream_id,seq)
    );
CREATE TABLE history_index_migration (id INTEGER PRIMARY KEY);
CREATE INDEX view_entity_ids ON view_entities(collection, id);
CREATE TABLE view_entity_windows (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      collection TEXT NOT NULL, id TEXT NOT NULL, created_seq INTEGER NOT NULL,
      active INTEGER NOT NULL, PRIMARY KEY(thread_id,collection,id)
    );
CREATE INDEX entity_recent ON view_entity_windows(thread_id,collection,created_seq);
CREATE INDEX entity_active ON view_entity_windows(thread_id,collection,active,created_seq);
CREATE TABLE client_run_index(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(thread_id,run_id),UNIQUE(thread_id,ordinal));
CREATE TABLE client_run_sequence(thread_id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
CREATE TABLE client_run_migration(id INTEGER PRIMARY KEY);
CREATE TABLE client_checkpoint_start(thread_id TEXT PRIMARY KEY,command_id TEXT NOT NULL,checkpoints TEXT NOT NULL);
CREATE TABLE client_checkpoint_due(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(thread_id,run_id));
CREATE TABLE client_turn_sequence(thread_id TEXT PRIMARY KEY,turn INTEGER NOT NULL);
CREATE TABLE client_run_turn(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,turn INTEGER NOT NULL,PRIMARY KEY(thread_id,run_id));
CREATE TABLE client_turn_asks(thread_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(thread_id,item_id));
CREATE TABLE client_turn_after_steer(thread_id TEXT PRIMARY KEY);
CREATE INDEX client_run_turn_number ON client_run_turn(thread_id,turn);
CREATE TABLE stored_entity_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL
  );
CREATE TABLE long_items(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,ordinal INTEGER NOT NULL,created_seq INTEGER NOT NULL,role TEXT,preview TEXT NOT NULL DEFAULT '',counters TEXT NOT NULL DEFAULT '{}',agent_id TEXT,PRIMARY KEY(thread_id,item_id));
CREATE TABLE long_meta(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL);
CREATE TABLE long_heads(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL DEFAULT 0,root TEXT,status TEXT NOT NULL);
CREATE TABLE long_turns(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,root_run TEXT,root_outcome TEXT NOT NULL DEFAULT 'active',settled_seq INTEGER,initiating TEXT NOT NULL DEFAULT '',latest TEXT NOT NULL DEFAULT '',PRIMARY KEY(thread_id,ordinal));
CREATE TABLE long_runs(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,ordinal INTEGER NOT NULL,root INTEGER NOT NULL,live INTEGER NOT NULL,PRIMARY KEY(thread_id,id));
CREATE TABLE long_agents(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,child_thread TEXT,name TEXT,started_at INTEGER NOT NULL,ended_at INTEGER,last_seq INTEGER NOT NULL,completion_relevant INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(thread_id,id));
CREATE INDEX long_agents_turn ON long_agents(thread_id,ordinal,id);
CREATE INDEX long_agents_children ON long_agents(child_thread,thread_id,ordinal) WHERE child_thread IS NOT NULL;
CREATE TABLE long_agent_counts(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,agent_id TEXT NOT NULL,key TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,agent_id,key));
CREATE INDEX long_items_message_recent ON long_items(thread_id,role,created_seq) WHERE role IS NOT NULL;
CREATE INDEX long_items_messages ON long_items(thread_id,ordinal,role,created_seq) WHERE role IS NOT NULL;
CREATE INDEX long_items_agent ON long_items(thread_id,ordinal,agent_id,created_seq);
CREATE TABLE long_agent_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,agent_id TEXT NOT NULL,path TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,refs INTEGER NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,agent_id,path));
CREATE TABLE long_file_prefix(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,path TEXT NOT NULL,seq INTEGER NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,PRIMARY KEY(thread_id,path,seq));
CREATE INDEX long_items_turn ON long_items(thread_id,ordinal,created_seq);
CREATE TABLE long_entities(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,kind TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,counters TEXT NOT NULL,data TEXT NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,kind,id));
CREATE INDEX long_entities_turn ON long_entities(thread_id,ordinal,kind,id);
CREATE INDEX long_entities_recent ON long_entities(thread_id,kind,last_seq,id);
CREATE TABLE long_counts(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,key TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,key));
CREATE TABLE long_prefix(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,key TEXT NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,key,seq));
CREATE INDEX long_prefix_time ON long_prefix(thread_id,key,at,seq);
CREATE TABLE long_item_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,path TEXT NOT NULL,ordinal INTEGER NOT NULL,added INTEGER,removed INTEGER,PRIMARY KEY(thread_id,item_id,path));
CREATE TABLE long_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,path TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,refs INTEGER NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,path));
CREATE INDEX long_files_recent ON long_files(thread_id,ordinal,last_seq,path);
CREATE TABLE long_commands(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,item_id TEXT NOT NULL,data TEXT NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,item_id));
CREATE INDEX long_commands_recent ON long_commands(thread_id,ordinal,last_seq,item_id);
CREATE TABLE long_usage_counters(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(thread_id,id));
CREATE TABLE long_read_state(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,device_id TEXT NOT NULL,last_seen_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(thread_id,device_id));
CREATE INDEX events_thread_time ON events(thread_id,at,seq);
CREATE INDEX long_turns_settled ON long_turns(thread_id,settled_seq,ordinal);
CREATE INDEX long_turns_start ON long_turns(thread_id,start_seq);
CREATE TABLE long_range_nodes(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,owner TEXT NOT NULL,level INTEGER NOT NULL,bucket INTEGER NOT NULL,key TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,owner,level,bucket,key));
CREATE TABLE long_time_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,path TEXT NOT NULL,at INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(thread_id,path));
CREATE INDEX long_time_files_recent ON long_time_files(thread_id,at,path);
CREATE TABLE long_time_commands(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,at INTEGER NOT NULL,seq INTEGER NOT NULL,data TEXT,PRIMARY KEY(thread_id,item_id));
CREATE INDEX long_time_commands_recent ON long_time_commands(thread_id,at,item_id);
CREATE TABLE long_time_command_nodes(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,level INTEGER NOT NULL,bucket INTEGER NOT NULL,seq INTEGER NOT NULL,data TEXT,PRIMARY KEY(thread_id,item_id,level,bucket));
CREATE TABLE long_completions(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal));
CREATE TABLE long_range_migration(id INTEGER PRIMARY KEY,stage INTEGER NOT NULL,through INTEGER NOT NULL,thread TEXT NOT NULL,key TEXT NOT NULL,seq INTEGER NOT NULL);
CREATE TABLE long_range_file_members(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(thread_id,item_id,path));
CREATE TABLE client_thread_migration(id INTEGER PRIMARY KEY);
CREATE TABLE stored_trust_rows (
        seq INTEGER NOT NULL, kind INTEGER NOT NULL, item_id TEXT NOT NULL,
        PRIMARY KEY(seq, kind, item_id)
      ) WITHOUT ROWID;
CREATE TABLE stored_trust_rows_backfill (
        kind INTEGER PRIMARY KEY, item_id TEXT, seq INTEGER
      );
CREATE TRIGGER stored_trust_rows_history_item_revisions_insert AFTER INSERT ON history_item_revisions BEGIN
          INSERT OR IGNORE INTO stored_trust_rows VALUES (new.seq, 0, new.item_id);
        END;
CREATE TRIGGER stored_trust_rows_history_item_revisions_delete AFTER DELETE ON history_item_revisions BEGIN
          DELETE FROM stored_trust_rows WHERE seq = old.seq AND kind = 0 AND item_id = old.item_id;
        END;
CREATE TRIGGER stored_trust_rows_item_text_chunks_insert AFTER INSERT ON item_text_chunks BEGIN
          INSERT OR IGNORE INTO stored_trust_rows VALUES (new.seq, 1, new.item_id);
        END;
CREATE TRIGGER stored_trust_rows_item_text_chunks_delete AFTER DELETE ON item_text_chunks BEGIN
          DELETE FROM stored_trust_rows WHERE seq = old.seq AND kind = 1 AND item_id = old.item_id;
        END;
CREATE TABLE pairing_codes (
      code_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
      scopes TEXT NOT NULL, label TEXT, device_ttl_ms INTEGER, person INTEGER
    );
CREATE TABLE mcp_agents (thread_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id, id));
CREATE TABLE mcp_intents (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), payload TEXT NOT NULL);
CREATE INDEX mcp_intents_type ON mcp_intents(json_extract(payload, '$.type'));
CREATE TABLE mcp_meta (id INTEGER PRIMARY KEY CHECK(id = 1), indexed INTEGER NOT NULL, pending INTEGER NOT NULL);
CREATE TABLE search_tombstones(thread TEXT PRIMARY KEY);
CREATE TABLE search_meta (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
      seq INTEGER NOT NULL, generation INTEGER NOT NULL, writes INTEGER NOT NULL, trigrams INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );
CREATE TABLE search_threads (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, seq INTEGER NOT NULL
    );
CREATE TABLE search_stage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, item TEXT NOT NULL,
      agent TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, tool_kind TEXT,
      head TEXT NOT NULL, tail TEXT NOT NULL, size INTEGER NOT NULL,
      dirty INTEGER NOT NULL, complete INTEGER NOT NULL, dirty_since INTEGER NOT NULL,
      UNIQUE(thread,item)
    );
CREATE INDEX search_dirty ON search_stage(dirty_since,id) WHERE dirty=1;
CREATE INDEX search_ready ON search_stage(complete,dirty_since,id) WHERE dirty=1;
CREATE INDEX search_stage_thread ON search_stage(thread);
CREATE TABLE search_docs (
      id INTEGER PRIMARY KEY, thread TEXT NOT NULL, item TEXT NOT NULL,
      agent TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL
    );
CREATE INDEX search_docs_thread ON search_docs(thread);
CREATE INDEX search_recent_titles ON search_docs(kind,at DESC,id);
CREATE VIRTUAL TABLE search_prose USING fts5(title,body,content='search_docs',content_rowid='id',tokenize='unicode61');
CREATE VIRTUAL TABLE search_titles USING fts5(title,content='search_docs',content_rowid='id',tokenize='unicode61',prefix='2 3 4');
CREATE TRIGGER search_pending_insert AFTER INSERT ON search_stage WHEN NEW.dirty=1
      BEGIN UPDATE search_meta SET pending=pending+1 WHERE id=1; END;
CREATE TRIGGER search_pending_update AFTER UPDATE OF dirty ON search_stage WHEN NEW.dirty<>OLD.dirty
      BEGIN UPDATE search_meta SET pending=pending+NEW.dirty-OLD.dirty WHERE id=1; END;
CREATE TRIGGER search_pending_delete AFTER DELETE ON search_stage WHEN OLD.dirty=1
      BEGIN UPDATE search_meta SET pending=pending-1 WHERE id=1; END;
CREATE VIRTUAL TABLE search_trigram USING fts5(title,body,content='search_docs',content_rowid='id',tokenize='trigram');
CREATE VIRTUAL TABLE search_title_trigram USING fts5(title,content='search_docs',content_rowid='id',tokenize='trigram');
CREATE TABLE search_full_meta(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL,pending INTEGER NOT NULL DEFAULT 0);
CREATE TABLE search_full_items(
      thread TEXT NOT NULL,item TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,
      tool_kind TEXT,delta_segment INTEGER,PRIMARY KEY(thread,item)
    );
CREATE TABLE search_full_segments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,thread TEXT NOT NULL,item TEXT NOT NULL,
      name TEXT NOT NULL,category TEXT NOT NULL,stream TEXT,encoding TEXT,
      target INTEGER NOT NULL DEFAULT 0,offset INTEGER NOT NULL DEFAULT 0,
      tail TEXT NOT NULL DEFAULT 't',chunk_id INTEGER,dirty INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,
      UNIQUE(thread,item,name)
    );
CREATE TRIGGER search_full_pending_insert AFTER INSERT ON search_full_segments WHEN NEW.offset<NEW.target OR NEW.dirty=1 BEGIN
      UPDATE search_full_meta SET pending=pending+1 WHERE id=1; END;
CREATE TRIGGER search_full_pending_update AFTER UPDATE OF offset,target,dirty ON search_full_segments BEGIN
      UPDATE search_full_meta SET pending=pending+(NEW.offset<NEW.target OR NEW.dirty=1)-(OLD.offset<OLD.target OR OLD.dirty=1) WHERE id=1; END;
CREATE TRIGGER search_full_pending_delete AFTER DELETE ON search_full_segments WHEN OLD.offset<OLD.target OR OLD.dirty=1 BEGIN
      UPDATE search_full_meta SET pending=pending-1 WHERE id=1; END;
CREATE INDEX search_full_pending ON search_full_segments(id) WHERE offset<target;
CREATE INDEX search_full_dirty ON search_full_segments(id) WHERE dirty=1;
CREATE TABLE search_full_chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,segment INTEGER NOT NULL,
      thread TEXT NOT NULL,item TEXT NOT NULL,seq INTEGER NOT NULL,category TEXT NOT NULL,body TEXT NOT NULL
    );
CREATE INDEX search_full_chunk_segment ON search_full_chunks(segment,id);
CREATE INDEX search_full_chunk_item ON search_full_chunks(thread,item,id);
CREATE VIRTUAL TABLE search_full_fts USING fts5(body,thread,category,content='search_full_chunks',content_rowid='id',tokenize='unicode61');
CREATE TRIGGER search_full_insert AFTER INSERT ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(rowid,body,thread,category) VALUES(NEW.id,NEW.body,NEW.thread,NEW.category); END;
CREATE TRIGGER search_full_delete AFTER DELETE ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(search_full_fts,rowid,body,thread,category) VALUES('delete',OLD.id,OLD.body,OLD.thread,OLD.category); END;
CREATE TRIGGER search_full_update AFTER UPDATE OF body ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(search_full_fts,rowid,body,thread,category) VALUES('delete',OLD.id,OLD.body,OLD.thread,OLD.category);
      INSERT INTO search_full_fts(rowid,body,thread,category) VALUES(NEW.id,NEW.body,NEW.thread,NEW.category); END;
CREATE TABLE storage_cleanup_fences(thread_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
CREATE TABLE thread_cleanup (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), command TEXT NOT NULL
    );
CREATE TABLE thread_cleanup_members (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), owner TEXT NOT NULL REFERENCES thread_cleanup(thread_id)
    );
CREATE INDEX thread_cleanup_owner ON thread_cleanup_members(owner);
CREATE INDEX thread_liveness_candidates ON threads(id)
      WHERE json_extract(client,'$.deletedAt') IS NULL AND json_extract(status,'$.state') NOT IN ('new','done','failed');
CREATE TABLE engine_ace_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(thread_id,command_id)
    );
CREATE TABLE engine_schema_version (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  );
CREATE TABLE thread_state (
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
CREATE INDEX engine_provider_frames_thread ON engine_provider_frames(thread_id);
CREATE INDEX engine_interaction_records ON engine_state_records(section,thread_id)
      WHERE section IN ('interactions','interactionHistory');
CREATE INDEX engine_agent_records ON engine_state_records(thread_id)
      WHERE section='agents';
CREATE TABLE engine_attachment_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, intent_id INTEGER NOT NULL,
      attachment JSON NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
CREATE TABLE engine_attachment_paths (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID;
CREATE INDEX engine_attachment_read_paths ON engine_attachment_paths(thread_id,path);
CREATE INDEX engine_first_person_input ON items(thread_id,created_seq) WHERE json_extract(item,'$.type')='message' AND json_extract(item,'$.role')='user'
  AND COALESCE(json_extract(item,'$.synthetic'),0)=0
  AND COALESCE(json_extract(item,'$.origin.kind'),'person') IN ('person','queue');
CREATE INDEX engine_entity_ids ON engine_state_records(thread_id,section,json_extract(value,'$.id')) WHERE section IN ('interactions','tasks');
CREATE TABLE engine_permissions (
        thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT, parent TEXT,
        ceiling_provider TEXT, ceiling_mode TEXT, ceiling_identity TEXT
      );
CREATE INDEX engine_sessions_root ON engine_sessions(cwd,thread_id);
CREATE TABLE engine_cursor_prune(thread_id TEXT PRIMARY KEY);
CREATE TABLE engine_steer_notes (
        intent_id INTEGER PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,
        person INTEGER NOT NULL DEFAULT 0, fell_back INTEGER NOT NULL DEFAULT 0);
CREATE TABLE engine_queue (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT,
        hold_token INTEGER NOT NULL DEFAULT 0, last_failure TEXT, preferences JSON,
        exited INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE engine_queue_attachments (
        intent_id INTEGER NOT NULL REFERENCES intents(id),thread_id TEXT NOT NULL,hash TEXT NOT NULL,
        PRIMARY KEY(intent_id,hash)
      );
CREATE INDEX engine_queue_attachment_lookup ON engine_queue_attachments(thread_id,hash);
CREATE INDEX engine_queue_deadline ON engine_queue(resume_at) WHERE resume_at IS NOT NULL;
CREATE INDEX intents_live_positions ON intents(thread_id,position) WHERE status IN ('pending','queued','running') OR uncertain=1;
CREATE INDEX intents_uncertain ON intents(thread_id) WHERE uncertain=1;
CREATE INDEX intents_queue_messages_recovery ON intents(thread_id,position,id) WHERE ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1));
CREATE INDEX intents_queue_order ON intents(thread_id,position,id) WHERE status IN ('pending','queued');
CREATE INDEX engine_queue_recovery ON engine_queue(thread_id) WHERE continuation IS NOT NULL OR trigger IS NOT NULL OR limited=1 OR paused=1;
CREATE INDEX intents_submission_generation ON intents(thread_id,submitted_generation);
CREATE INDEX intents_dispatch ON intents(thread_id,kind,position,id) WHERE status IN ('pending','queued');
CREATE INDEX intents_latest_inputs ON intents(thread_id,id DESC) WHERE kind IN ('thread.send','thread.create');
CREATE INDEX intents_running ON intents(thread_id) WHERE status='running';
CREATE TABLE engine_inputs (
      ordinal INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, item_key TEXT NOT NULL,
      signature TEXT NOT NULL, origin JSON NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0, generation INTEGER, run_id TEXT, UNIQUE(thread_id,item_key));
CREATE INDEX engine_inputs_echo ON engine_inputs(thread_id,signature,sent,matched,ordinal);
CREATE TABLE engine_input_echoes (
        thread_id TEXT NOT NULL, native_key TEXT NOT NULL, item_key TEXT NOT NULL,
        PRIMARY KEY(thread_id,native_key));
CREATE TABLE engine_input_identities (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        native_id TEXT NOT NULL, command_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,native_id));
CREATE TABLE engine_input_replacements (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL, replacement_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,command_id));
CREATE INDEX engine_inputs_run ON engine_inputs(thread_id,run_id);
CREATE INDEX engine_inputs_delivery ON engine_inputs(thread_id,generation,signature,sent,matched,ordinal);
CREATE TRIGGER engine_inputs_delete AFTER DELETE ON threads BEGIN
          DELETE FROM engine_input_echoes WHERE thread_id=OLD.id;
          DELETE FROM engine_inputs WHERE thread_id=OLD.id;
        END;
CREATE TABLE engine_interaction_requests (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        interaction_id TEXT NOT NULL, native_key TEXT NOT NULL, native_item TEXT,
        binding TEXT NOT NULL, generation INTEGER, state TEXT NOT NULL,
        PRIMARY KEY(thread_id,interaction_id));
CREATE INDEX engine_requests_generation ON engine_interaction_requests(thread_id,generation);
CREATE INDEX engine_requests_native ON engine_interaction_requests(thread_id,binding,native_item,state);
CREATE INDEX engine_requests_key ON engine_interaction_requests(thread_id,native_key,state);
CREATE TABLE engine_handoff_grants (
      recipient TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      through_seq INTEGER NOT NULL, PRIMARY KEY(recipient, source)
    );
CREATE TABLE engine_provider_sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '',
        backend TEXT, native_session_id TEXT NOT NULL, through_seq INTEGER NOT NULL,
        PRIMARY KEY(thread_id, provider, instance_id)
      );
CREATE TABLE engine_store_generations (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL
      );
CREATE TABLE engine_transitions (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, value JSON NOT NULL
      );
CREATE TABLE engine_transition_guards (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, command_id TEXT NOT NULL
      );
CREATE TABLE engine_model_options (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, model TEXT NOT NULL, value JSON NOT NULL,
        PRIMARY KEY(thread_id,provider,model)
      );
CREATE TABLE engine_transition_blockers (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_key TEXT NOT NULL, PRIMARY KEY(thread_id, agent_key)
    );
CREATE TABLE thread_ownership (
  thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, transfer_id TEXT NOT NULL,
  peer TEXT NOT NULL, epoch INTEGER NOT NULL, prior TEXT, at INTEGER NOT NULL);
CREATE TABLE engine_steer_aims (
        intent_id INTEGER PRIMARY KEY, run TEXT);
CREATE TABLE engine_restart_resumes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        streak INTEGER NOT NULL
      );
