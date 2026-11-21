//! Loosening what a bot may do is the person's alone, on every route that can (ADR 0171,
//! amendment 7): moving commands outside the sandbox, widening a network policy, following a
//! wider default, adding a grant, letting a bot use more connected apps, turning a package's
//! effect on and raising autonomy each need the person's stamp from ace's daemon. Tightening never
//! does. Each route: loosening unstamped is refused and changes nothing, stamped it is made, and
//! tightening unstamped is made.

mod support;

use serde_json::{Value, json};
use support::Result;
use support::packaged::{installed, secured, text};
use support::sandbox::{World, world, world_with_options};

const REFUSED: &str = spade_server::security::attest::CONFIRM;

fn refused(status: u16, body: &Value) {
    assert_eq!(status, 403, "{body}");
    assert!(body.to_string().contains(REFUSED), "{body}");
}

fn ok(status: u16, body: &Value) {
    assert!((200..300).contains(&status), "{status} {body}");
}

fn security(w: &World) -> String {
    format!("/v1/agents/{}/security", w.bot)
}

async fn bot_view(w: &World) -> Result<Value> {
    let (status, view) = w.spade.get(&security(w)).await?;
    assert_eq!(status, 200, "{view}");
    Ok(view)
}

async fn machine_view(w: &World) -> Result<Value> {
    let (status, view) = w.spade.get("/v1/security").await?;
    assert_eq!(status, 200, "{view}");
    Ok(view)
}

#[tokio::test]
async fn a_bots_commands_move_outside_only_on_the_persons_say() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let path = format!("{}/commands", security(&w));
    let outside = json!({ "commands": "outside" });
    let (status, body) = w.spade.put_unstamped(&path, outside.clone()).await?;
    refused(status, &body);
    assert_eq!(bot_view(&w).await?["commands"], "sandboxed");
    let (status, body) = w.spade.put(&path, outside).await?;
    ok(status, &body);
    assert_eq!(body["commands"], "outside");
    let (status, body) = w
        .spade
        .put_unstamped(&path, json!({ "commands": "sandboxed" }))
        .await?;
    ok(status, &body);
    assert_eq!(body["commands"], "sandboxed");
    Ok(())
}

#[tokio::test]
async fn the_machines_commands_move_outside_only_on_the_persons_say() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let outside = json!({ "commands": "outside" });
    let (status, body) = w
        .spade
        .put_unstamped("/v1/security/commands", outside.clone())
        .await?;
    refused(status, &body);
    assert_eq!(machine_view(&w).await?["bots"]["commands"], "sandboxed");
    let (status, body) = w.spade.put("/v1/security/commands", outside).await?;
    ok(status, &body);
    // A bot that follows the machine, put back on it, rises with it: the person's too.
    w.spade
        .put_unstamped(
            &format!("{}/commands", security(&w)),
            json!({ "commands": "sandboxed" }),
        )
        .await?;
    let follow = json!({ "commands": null });
    let path = format!("{}/commands", security(&w));
    let (status, body) = w.spade.put_unstamped(&path, follow.clone()).await?;
    refused(status, &body);
    let (status, body) = w.spade.put(&path, follow).await?;
    ok(status, &body);
    let (status, body) = w
        .spade
        .put_unstamped("/v1/security/commands", json!({ "commands": "sandboxed" }))
        .await?;
    ok(status, &body);
    Ok(())
}

/// A network policy.
fn policy(mode: &str, allow: &[&str], dropped: &[&str]) -> Value {
    json!({ "mode": mode, "allow": allow, "dropped": dropped })
}

#[tokio::test]
async fn a_bots_network_reaches_further_only_on_the_persons_say() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    for kind in ["network", "plugin-network"] {
        let path = format!("{}/{kind}", security(&w));
        // Its own: the listed sites with one host, one default dropped.
        let (status, body) = w
            .spade
            .put(&path, policy("allow_list", &["docs.rs"], &["pypi.org"]))
            .await?;
        ok(status, &body);
        // Wider each way: any public host, a host added, a dropped default put back.
        for wider in [
            policy("open", &[], &[]),
            policy("allow_list", &["docs.rs", "example.com"], &["pypi.org"]),
            policy("allow_list", &["docs.rs"], &[]),
        ] {
            let (status, body) = w.spade.put_unstamped(&path, wider.clone()).await?;
            refused(status, &body);
        }
        let field = if kind == "network" {
            "network"
        } else {
            "plugin_network"
        };
        assert_eq!(bot_view(&w).await?[field]["allow"], json!(["docs.rs"]));
        // Narrower each way: a host removed, a default dropped, no network at all.
        for narrower in [
            policy("allow_list", &[], &["pypi.org"]),
            policy("allow_list", &[], &["pypi.org", "crates.io"]),
            policy("off", &[], &[]),
        ] {
            let (status, body) = w.spade.put_unstamped(&path, narrower).await?;
            ok(status, &body);
        }
        assert_eq!(bot_view(&w).await?[field]["mode"], "off");
        // Following the machine's again reaches further than none: the person's.
        let (status, body) = w.spade.delete_unstamped(&path).await?;
        refused(status, &body);
        let (status, body) = w.spade.delete(&path).await?;
        ok(status, &body);
        assert_eq!(body["own"][field], false, "{body}");
        let (status, body) = w.spade.put(&path, policy("open", &[], &[])).await?;
        ok(status, &body);
    }
    Ok(())
}

#[tokio::test]
async fn the_machines_network_reaches_further_only_on_the_persons_say() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    for (path, field) in [
        ("/v1/security/network", "network"),
        ("/v1/security/plugin-network", "plugin_network"),
    ] {
        let (status, body) = w
            .spade
            .put(path, policy("allow_list", &["docs.rs"], &[]))
            .await?;
        ok(status, &body);
        let wider = policy("allow_list", &["docs.rs", "example.com"], &[]);
        let (status, body) = w.spade.put_unstamped(path, wider.clone()).await?;
        refused(status, &body);
        assert_eq!(
            machine_view(&w).await?["bots"][field]["allow"],
            json!(["docs.rs"])
        );
        let (status, body) = w.spade.put(path, wider).await?;
        ok(status, &body);
        let (status, body) = w.spade.put_unstamped(path, policy("off", &[], &[])).await?;
        ok(status, &body);
    }
    Ok(())
}

#[tokio::test]
async fn a_grant_is_made_only_on_the_persons_say_and_taken_back_by_anyone() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let path = format!("/v1/agents/{}/grants", w.bot);
    let project = w.home.join("project");
    std::fs::create_dir_all(&project)?;
    for scope in [
        json!({ "kind": "folder", "path": project, "write": true }),
        json!({ "kind": "git_push", "repo": "acme/app", "branch": "spade/*" }),
        json!({ "kind": "drive_app", "app": "com.apple.TextEdit" }),
        json!({ "kind": "drive_site", "host": "docs.rs" }),
    ] {
        let (status, body) = w.spade.post_unstamped(&path, scope.clone()).await?;
        refused(status, &body);
        let (status, made) = w.spade.post(&path, scope.clone()).await?;
        assert_eq!(status, 201, "{scope}: {made}");
        let id = made["grant"]["id"].as_str().unwrap_or_default().to_owned();
        let (status, body) = w.spade.delete_unstamped(&format!("{path}/{id}")).await?;
        assert_eq!(status, 204, "{body}");
    }
    let (_, grants) = w.spade.get(&path).await?;
    assert_eq!(grants["grants"], json!([]), "{grants}");
    Ok(())
}

#[tokio::test]
async fn a_bot_uses_more_connected_apps_only_on_the_persons_say() -> Result {
    let options = support::Options {
        connectors: true,
        ..support::Options::default()
    };
    let w = world_with_options(options, false, |_| vec![]).await?;
    let path = format!("/v1/agents/{}/connectors", w.bot);
    let all = json!({ "all": true });
    let (status, body) = w.spade.put_unstamped(&path, all.clone()).await?;
    refused(status, &body);
    let (_, now) = w.spade.get(&path).await?;
    assert_ne!(now["all"], true, "{now}");
    let (status, body) = w.spade.put(&path, all).await?;
    ok(status, &body);
    let (status, body) = w
        .spade
        .put_unstamped(&path, json!({ "all": false, "connectors": [] }))
        .await?;
    ok(status, &body);
    Ok(())
}

#[tokio::test]
async fn a_packages_effect_is_turned_on_only_on_the_persons_say() -> Result {
    let spade = secured(vec![], vec![]).await?;
    let agent = installed(&spade, json!({}), false).await?;
    let bot = text(&agent["id"]);
    let path = format!("/v1/agents/{bot}/package/effects");
    let on = json!({ "key": "send_as_person", "on": true });
    let (status, body) = spade.put_unstamped(&path, on.clone()).await?;
    refused(status, &body);
    let (status, body) = spade.put(&path, on).await?;
    ok(status, &body);
    let (status, body) = spade
        .put_unstamped(&path, json!({ "key": "send_as_person", "on": false }))
        .await?;
    ok(status, &body);
    Ok(())
}

#[tokio::test]
async fn autonomy_rises_only_on_the_persons_say_and_comes_back_for_anyone() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    for (path, target) in [
        (format!("{}/autonomy", security(&w)), w.bot.clone()),
        ("/v1/security/autonomy".to_owned(), "machine".to_owned()),
    ] {
        let full = json!({ "autonomy": "full_access" });
        let (status, body) = w.spade.put_unstamped(&path, full.clone()).await?;
        assert_eq!(status, 403, "{body}");
        let stamp = w.stamp(&target, "full_access");
        let (status, body) = w
            .spade
            .put_with(
                &path,
                full,
                &[(spade_server::security::attest::HEADER, &stamp)],
            )
            .await?;
        ok(status, &body);
        let (status, body) = w
            .spade
            .put_unstamped(&path, json!({ "autonomy": "auto_review" }))
            .await?;
        ok(status, &body);
    }
    Ok(())
}
