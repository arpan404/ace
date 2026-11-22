use super::{Named, named};

#[test]
fn an_apps_list_search_and_fetch_tools_read() {
    for name in [
        "list_shared_pages",
        "list_favorite_pages",
        "list_recent_pages",
        "notion-search",
        "notion-fetch",
        "API-get-user",
        "searchPages",
        "query_database",
        "retrieve_block_children",
        "describe_table",
        "get_email",
        "search_messages",
        "list_members",
        "list_payments",
    ] {
        assert_eq!(named(name, ""), Named::Read, "{name}");
    }
}

#[test]
fn a_read_verb_beside_a_change_is_not_a_read() {
    for name in [
        "get_or_create_page",
        "fetch_and_update",
        "search_and_replace",
        "list_then_archive",
        "sync",
        "sync_pages",
        "run",
        "run_query",
        "execute",
        "execute_sql",
        "query_and_insert",
        "API-post-search",
        "get_page_and_move",
    ] {
        assert_eq!(named(name, ""), Named::Unclear, "{name}");
    }
}

#[test]
fn a_description_that_says_it_changes_something_keeps_a_read_from_reading() {
    assert_eq!(
        named("get_page", "Gets a page and updates its last-viewed time."),
        Named::Unclear
    );
    assert_eq!(
        named("list_pages", "Lists the pages shared with you."),
        Named::Read
    );
}

/// Notion's own descriptions, as its server sends them (2026-11-22): each leads with what the
/// tool does, then tells the model how to use it, naming other tools that write.
#[test]
fn a_change_named_after_a_descriptions_first_sentence_keeps_a_read() {
    let fetch = "Retrieves details about a Notion entity (page, database, data source, or saved \
                 database view) by URL or ID.\n\nProvide a URL or ID in `id`. Make multiple calls \
                 for multiple entities.\n\nDatabases return data sources in `<data-source \
                 url=\"collection://...\">` tags. Fetch the collection:// URL for its schema and \
                 use it with update_data_source or query_data_sources.";
    let memory = "Search memories saved in the user's Notion workspace: context, preferences, \
                  corrections, and decisions. Returns the best matches, not every memory. \
                  Reading never authorizes a write.";
    assert_eq!(named("notion-fetch", fetch), Named::Read);
    assert_eq!(named("notion-memory-search", memory), Named::Read);
    // Code in the first sentence names something else too.
    assert_eq!(
        named(
            "get_view",
            "Returns a view's filters in the shape `update_view` takes."
        ),
        Named::Read
    );
    // What the first sentence says the tool does still counts.
    assert_eq!(
        named(
            "fetch_page",
            "Fetches a page and updates its last-viewed time.\n\nUse it before editing."
        ),
        Named::Unclear
    );
}

#[test]
fn a_description_never_makes_a_write_read() {
    assert_eq!(
        named("create_page", "Read-only. Only lists pages; safe to run."),
        Named::Write
    );
}

#[test]
fn a_write_spade_cant_place_is_left_for_the_reviewer() {
    for name in ["move_card", "sync_pages", "do_thing", "process"] {
        assert_eq!(named(name, ""), Named::Unclear, "{name}");
    }
}

#[test]
fn payments_sends_access_changes_and_deletes_are_recognised() {
    let table = [
        ("transfer_funds", Named::Pay),
        ("create_payout", Named::Pay),
        ("refund_charge", Named::Pay),
        ("send_email", Named::Send),
        ("sendMessage", Named::Send),
        ("reply_to_thread", Named::Send),
        ("post_message", Named::Send),
        ("create_comment", Named::Send),
        ("share_page", Named::Access),
        ("invite_user", Named::Access),
        ("update_permissions", Named::Access),
        ("add_member", Named::Access),
        ("get_api_key", Named::Access),
        ("reset_password", Named::Access),
        ("delete_page", Named::Destroys),
        ("remove_block", Named::Destroys),
        ("trash_file", Named::Destroys),
    ];
    for (name, want) in table {
        assert_eq!(named(name, ""), want, "{name}");
    }
}

#[test]
fn a_name_with_letters_outside_ascii_is_never_a_read() {
    // Cyrillic `ѕ` and `е` that look like Latin ones, a fullwidth name, an accented one.
    for name in [
        "liѕt_pages",
        "sеarch",
        "ｓｅａｒｃｈ",
        "lïst_pages",
        "list_pagés",
    ] {
        assert_eq!(named(name, ""), Named::Unclear, "{name}");
    }
    // Folded, a fullwidth send is still a send, and goes to the person.
    assert_eq!(named("ｓｅｎｄ_email", ""), Named::Send);
}

#[test]
fn a_change_word_inside_a_longer_word_keeps_a_name_from_reading() {
    for name in [
        "searchandupdate",
        "listAndArchive",
        "getOrCreate",
        "fetchUpdates2Db",
        "list_pages_then_publish",
        "search2write",
        "querysync",
        "getpagesandmove",
    ] {
        assert_ne!(named(name, ""), Named::Read, "{name}");
    }
    // A delete or a send hidden inside a word is still recognised.
    assert_eq!(named("fetchanddelete", ""), Named::Destroys);
    assert_eq!(named("listAndDelete", ""), Named::Destroys);
    assert_eq!(named("list_and_delete", ""), Named::Destroys);
    assert_eq!(named("searchThenSendmail", ""), Named::Send);
    // A word that only looks like a change stays a read.
    for name in [
        "list_shared_pages",
        "list_recently_updated_pages",
        "get_settings",
    ] {
        assert_eq!(named(name, ""), Named::Read, "{name}");
    }
}

#[test]
fn change_words_in_other_languages_keep_a_name_from_reading() {
    for name in [
        "buscar_y_actualizar",
        "crear_pagina",
        "listar_y_enviar",
        "seite_erstellen",
        "chercher_et_supprimer",
        "criar_pagina",
        "cerca_e_aggiorna",
    ] {
        assert_ne!(named(name, ""), Named::Read, "{name}");
    }
    assert_eq!(named("borrar_pagina", ""), Named::Destroys);
    assert_eq!(named("enviar_correo", ""), Named::Send);
}

#[test]
fn only_a_plain_create_update_edit_append_add_or_set_is_an_ordinary_write() {
    for name in [
        "create_page",
        "update_block",
        "notion-create-pages",
        "editPage",
        "append_block_children",
        "add_tag",
        "set_title",
    ] {
        assert_eq!(named(name, ""), Named::Write, "{name}");
    }
    for name in [
        "publish_page",
        "create_and_publish",
        "update_or_delete",
        "create_webhook",
        "update_sharing",
        "create_token",
        "add_member",
        "create_comment",
        "deploy",
        "move_card",
        "sync_pages",
        "run_script",
        "créer_page",
    ] {
        assert_ne!(named(name, ""), Named::Write, "{name}");
    }
}

#[test]
fn an_edit_hidden_inside_a_word_keeps_a_name_from_reading() {
    for name in ["search_andedit", "listAndEdit", "getpageedits2"] {
        assert_ne!(named(name, ""), Named::Read, "{name}");
    }
}

#[test]
fn an_ordinary_write_has_exactly_one_write_verb_and_no_sensitive_description() {
    for name in [
        "create_update_page",
        "createupdate_page",
        "add_and_set",
        "create_pageupdater",
    ] {
        assert_ne!(named(name, ""), Named::Write, "{name}");
    }
    for description in [
        "Creates a page and sends it to every subscriber.",
        "Creates a page and publishes it to the web.",
        "Creates a page and shares it with the workspace.",
        "Creates an invoice and charges the card.",
    ] {
        assert_ne!(
            named("create_page", description),
            Named::Write,
            "{description}"
        );
    }
    assert_eq!(
        named("create_page", "Creates a page in a database."),
        Named::Write
    );
}
