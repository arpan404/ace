//! A bot's Permissions through the API (ADR 0171, amendment 7): turning a switch on is the
//! person's alone, for a bot and for the default every bot follows; turning one off never needs
//! them; Commands and Network are the bot's existing settings; and letting bots use an app the
//! never-use list held back needs the person too.

mod support;

use serde_json::{Value, json};
use spade_server::security::attest::HEADER;
use spade_server::security::permissions::{PERSON_ONLY, stamped_list};
use support::Result;
use support::sandbox::{World, world};

fn path(bot: &str) -> String {
    format!("/v1/agents/{bot}/security/permissions")
}

/// Sets one of the bot's switches, stamped as the person's when `person`.
async fn set(w: &World, key: &str, on: Value, person: bool) -> Result<(u16, Value)> {
    let body = json!({ "key": key, "on": on });
    if !person {
        return w.spade.put(&path(&w.bot), body).await;
    }
    let value = format!(
        "permission:{key}:{}",
        on.as_bool().map_or("null".into(), |on| on.to_string())
    );
    let stamp = w.stamp(&w.bot, &value);
    w.spade
        .put_with(&path(&w.bot), body, &[(HEADER, &stamp)])
        .await
}

async fn on(w: &World, key: &str) -> Result<Value> {
    let (status, view) = w
        .spade
        .get(&format!("/v1/agents/{}/security", w.bot))
        .await?;
    assert_eq!(status, 200, "{view}");
    Ok(view["permissions"]["on"][key].clone())
}

#[tokio::test]
async fn turning_a_switch_on_needs_the_persons_say_and_turning_it_off_never_does() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    for key in ["computer_use", "browser", "devices", "commands", "network"] {
        assert_eq!(on(&w, key).await?, false, "{key} starts off");
        // Without the person's stamp (a process holding Spade's token): refused, still off.
        let (status, refused) = set(&w, key, json!(true), false).await?;
        assert_eq!(status, 403, "{key}: {refused}");
        assert!(refused.to_string().contains(PERSON_ONLY), "{refused}");
        assert_eq!(on(&w, key).await?, false, "{key}");
        // With it, on.
        let (status, view) = set(&w, key, json!(true), true).await?;
        assert_eq!(status, 200, "{key}: {view}");
        assert_eq!(view["permissions"]["on"][key], true, "{key}");
        assert_eq!(view["permissions"]["own"][key], true, "{key}");
        // Off needs no one's say.
        let (status, view) = set(&w, key, json!(false), false).await?;
        assert_eq!(status, 200, "{key}: {view}");
        assert_eq!(view["permissions"]["on"][key], false, "{key}");
    }
    // Commands and Network are the bot's own settings, shown as switches.
    set(&w, "commands", json!(true), true).await?;
    let (_, view) = set(&w, "network", json!(true), true).await?;
    assert_eq!(view["commands"], "outside", "{view}");
    assert_eq!(view["network"]["mode"], "open", "{view}");
    Ok(())
}

#[tokio::test]
async fn the_default_is_the_persons_to_raise_and_a_bot_that_follows_it_rises_with_it() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let body = json!({ "key": "computer_use", "on": true });
    let (status, refused) = w
        .spade
        .put("/v1/security/permissions", body.clone())
        .await?;
    assert_eq!(status, 403, "{refused}");
    let stamp = w.stamp("machine", "permission:computer_use:true");
    let (status, machine) = w
        .spade
        .put_with("/v1/security/permissions", body, &[(HEADER, &stamp)])
        .await?;
    assert_eq!(status, 200, "{machine}");
    assert_eq!(machine["permissions"]["on"]["computer_use"], true);
    // The bot sets none of its own, so it follows.
    assert_eq!(on(&w, "computer_use").await?, true);
    // A bot that turned it off for itself, then goes back to following, rises: the person's.
    set(&w, "computer_use", json!(false), false).await?;
    assert_eq!(on(&w, "computer_use").await?, false);
    let (status, refused) = set(&w, "computer_use", Value::Null, false).await?;
    assert_eq!(status, 403, "{refused}");
    let (status, view) = set(&w, "computer_use", Value::Null, true).await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["permissions"]["on"]["computer_use"], true);
    assert_eq!(view["permissions"]["own"]["computer_use"], false);
    Ok(())
}

#[tokio::test]
async fn letting_bots_use_an_app_on_the_never_use_list_needs_the_persons_say() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let (_, machine) = w.spade.get("/v1/security").await?;
    let list: Vec<String> = machine["permissions"]["never_apps"]
        .as_array()
        .map(|apps| {
            apps.iter()
                .filter_map(|app| app.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    assert!(list.iter().any(|app| app == "1Password"), "{machine}");
    let fewer: Vec<String> = list
        .iter()
        .filter(|app| *app != "1Password")
        .cloned()
        .collect();
    let (status, refused) = w
        .spade
        .put("/v1/security/never-apps", json!({ "apps": fewer }))
        .await?;
    assert_eq!(status, 403, "{refused}");
    let stamp = w.stamp("machine", &stamped_list(&fewer));
    let (status, machine) = w
        .spade
        .put_with(
            "/v1/security/never-apps",
            json!({ "apps": fewer }),
            &[(HEADER, &stamp)],
        )
        .await?;
    assert_eq!(status, 200, "{machine}");
    assert_eq!(machine["permissions"]["never_apps"], json!(fewer));
    Ok(())
}
