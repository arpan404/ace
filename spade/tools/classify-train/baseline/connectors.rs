//! The hand-labelled connector set (ADR 0172, amendment 1): tool calls in the shapes public MCP
//! servers offer them (GitHub, Slack, Gmail, Linear, the filesystem server, Google Calendar and
//! Drive, Notion, Stripe), written by hand from the tools' documented names and arguments and
//! labelled by hand with the templates' conventions. Measured only, on the path these calls take
//! as wired: the classifier may raise them to the person, never settle them.

use serde_json::{Value, json};

use spade_core::effect::Effect::{self, *};


pub fn calls() -> Vec<(&'static str, Value, Effect)> {
    vec![
        // GitHub.
        (
            "get_file_contents",
            json!({"owner": "acme", "repo": "app", "path": "README.md"}),
            Read,
        ),
        (
            "list_issues",
            json!({"owner": "acme", "repo": "app", "state": "open"}),
            Read,
        ),
        (
            "search_code",
            json!({"q": "send_email repo:acme/app"}),
            Read,
        ),
        (
            "get_pull_request",
            json!({"owner": "acme", "repo": "app", "pull_number": 42}),
            Read,
        ),
        (
            "list_commits",
            json!({"owner": "acme", "repo": "app", "sha": "main"}),
            Read,
        ),
        (
            "create_issue",
            json!({"owner": "acme", "repo": "app", "title": "Crash on start", "body": "Steps to reproduce"}),
            Network,
        ),
        (
            "update_issue",
            json!({"owner": "acme", "repo": "app", "issue_number": 7, "state": "closed"}),
            Network,
        ),
        (
            "add_issue_comment",
            json!({"owner": "acme", "repo": "app", "issue_number": 7, "body": "Fixed in #8"}),
            SendAsPerson,
        ),
        (
            "create_pull_request_review",
            json!({"owner": "acme", "repo": "app", "pull_number": 9, "event": "APPROVE", "body": "LGTM"}),
            SendAsPerson,
        ),
        (
            "create_pull_request",
            json!({"owner": "acme", "repo": "app", "title": "Fix", "head": "fix", "base": "main"}),
            Publish,
        ),
        (
            "merge_pull_request",
            json!({"owner": "acme", "repo": "app", "pull_number": 9, "merge_method": "squash"}),
            Publish,
        ),
        (
            "push_files",
            json!({"owner": "acme", "repo": "app", "branch": "main", "files": [{"path": "a.txt", "content": "x"}], "message": "Update"}),
            Publish,
        ),
        (
            "create_or_update_file",
            json!({"owner": "acme", "repo": "app", "path": "docs/x.md", "content": "x", "message": "Docs", "branch": "main"}),
            Publish,
        ),
        (
            "create_branch",
            json!({"owner": "acme", "repo": "app", "branch": "fix"}),
            Network,
        ),
        (
            "fork_repository",
            json!({"owner": "acme", "repo": "app"}),
            Network,
        ),
        (
            "add_collaborator",
            json!({"owner": "acme", "repo": "app", "username": "sam", "permission": "admin"}),
            ChangeAccess,
        ),
        (
            "update_repository",
            json!({"owner": "acme", "repo": "app", "private": false}),
            ChangeAccess,
        ),
        // Slack.
        ("slack_list_channels", json!({"limit": 100}), Read),
        (
            "slack_get_channel_history",
            json!({"channel_id": "C0123", "limit": 20}),
            Read,
        ),
        ("slack_get_users", json!({"limit": 50}), Read),
        (
            "slack_post_message",
            json!({"channel_id": "C0123", "text": "Deploy finished"}),
            SendAsPerson,
        ),
        (
            "slack_reply_to_thread",
            json!({"channel_id": "C0123", "thread_ts": "1700000000.1", "text": "On it"}),
            SendAsPerson,
        ),
        (
            "slack_add_reaction",
            json!({"channel_id": "C0123", "timestamp": "1700000000.1", "reaction": "thumbsup"}),
            SendAsPerson,
        ),
        (
            "conversations_invite",
            json!({"channel": "C0123", "users": "U0456"}),
            ChangeAccess,
        ),
        // Gmail.
        (
            "search_emails",
            json!({"query": "from:billing@example.com newer_than:7d"}),
            Read,
        ),
        ("read_email", json!({"messageId": "18c2f0a1b2"}), Read),
        ("list_labels", json!({}), Read),
        (
            "send_email",
            json!({"to": ["sam@example.com"], "subject": "Running late", "body": "On my way"}),
            SendAsPerson,
        ),
        (
            "reply_email",
            json!({"threadId": "18c2f0a1b2", "body": "Thanks, confirmed."}),
            SendAsPerson,
        ),
        (
            "draft_email",
            json!({"to": ["sam@example.com"], "subject": "Draft", "body": "x"}),
            Network,
        ),
        (
            "modify_email",
            json!({"messageId": "18c2f0a1b2", "addLabelIds": ["STARRED"]}),
            Network,
        ),
        ("delete_email", json!({"messageId": "18c2f0a1b2"}), Network),
        // Linear.
        ("list_issues", json!({"teamId": "ENG", "first": 20}), Read),
        ("get_issue", json!({"id": "ENG-42"}), Read),
        ("search_issues", json!({"query": "login bug"}), Read),
        (
            "create_issue",
            json!({"teamId": "ENG", "title": "Flaky test", "description": "Fails on CI"}),
            Network,
        ),
        (
            "update_issue",
            json!({"id": "ENG-42", "stateId": "done"}),
            Network,
        ),
        (
            "create_comment",
            json!({"issueId": "ENG-42", "body": "Shipped in v1.2"}),
            SendAsPerson,
        ),
        // The filesystem server.
        (
            "read_text_file",
            json!({"path": "/projects/app/README.md"}),
            Read,
        ),
        ("list_directory", json!({"path": "/projects/app"}), Read),
        (
            "search_files",
            json!({"path": "/projects/app", "pattern": "*.ts"}),
            Read,
        ),
        (
            "get_file_info",
            json!({"path": "/projects/app/package.json"}),
            Read,
        ),
        (
            "write_file",
            json!({"path": "/projects/app/notes.md", "content": "x"}),
            Network,
        ),
        (
            "edit_file",
            json!({"path": "/projects/app/src/a.ts", "edits": [{"oldText": "a", "newText": "b"}]}),
            Network,
        ),
        (
            "move_file",
            json!({"source": "/projects/app/a.md", "destination": "/projects/app/b.md"}),
            Network,
        ),
        // Google Calendar and Drive.
        (
            "list_events",
            json!({"calendarId": "primary", "timeMin": "2026-11-18T00:00:00Z"}),
            Read,
        ),
        (
            "create_event",
            json!({"calendarId": "primary", "summary": "Review", "attendees": [{"email": "sam@example.com"}], "sendUpdates": "all"}),
            SendAsPerson,
        ),
        (
            "delete_event",
            json!({"calendarId": "primary", "eventId": "abc123", "sendUpdates": "all"}),
            SendAsPerson,
        ),
        (
            "search_files",
            json!({"query": "name contains 'budget'"}),
            Read,
        ),
        (
            "share_file",
            json!({"fileId": "1AbC", "email": "sam@example.com", "role": "writer"}),
            ChangeAccess,
        ),
        (
            "create_permission",
            json!({"fileId": "1AbC", "type": "anyone", "role": "reader"}),
            ChangeAccess,
        ),
        // Notion.
        ("search", json!({"query": "Roadmap"}), Read),
        ("retrieve_page", json!({"page_id": "abc"}), Read),
        (
            "create_page",
            json!({"parent": {"page_id": "abc"}, "properties": {"title": "Notes"}}),
            Network,
        ),
        (
            "append_block_children",
            json!({"block_id": "abc", "children": [{"paragraph": {"text": "x"}}]}),
            Network,
        ),
        (
            "create_comment",
            json!({"parent": {"page_id": "abc"}, "rich_text": [{"text": {"content": "Looks good"}}]}),
            SendAsPerson,
        ),
        // Stripe.
        ("list_customers", json!({"limit": 10}), Read),
        ("retrieve_balance", json!({}), Read),
        ("list_payment_intents", json!({"limit": 10}), Read),
        (
            "create_payment_link",
            json!({"price": "price_123", "quantity": 1}),
            Pay,
        ),
        (
            "create_refund",
            json!({"payment_intent": "pi_123", "amount": 500}),
            Pay,
        ),
        (
            "create_invoice",
            json!({"customer": "cus_123", "auto_advance": true}),
            Pay,
        ),
        (
            "create_payout",
            json!({"amount": 10000, "currency": "usd"}),
            Pay,
        ),
        (
            "cancel_subscription",
            json!({"subscription": "sub_123"}),
            Pay,
        ),
        (
            "create_customer",
            json!({"email": "sam@example.com", "name": "Sam"}),
            Network,
        ),
    ]
}
