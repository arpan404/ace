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

#[test]
fn a_description_never_makes_a_write_read() {
    assert_eq!(
        named("create_page", "Read-only. Only lists pages; safe to run."),
        Named::Unclear
    );
}

#[test]
fn writes_are_left_for_the_reviewer() {
    for name in [
        "create_page",
        "update_block",
        "notion-create-pages",
        "add_tag",
        "move_card",
    ] {
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
