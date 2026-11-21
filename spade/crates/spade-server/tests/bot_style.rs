//! A bot's accent (ADR 0200 §5.3): its package's `style.accent` until the person chooses one in
//! its profile, and their choice (a colour, or its face's colour) wins from then on, through an
//! update of its package. Spade itself has no accent.

mod support;

use serde_json::{Value, json};
use support::packaged::*;
use support::{Result, Spade};

async fn style_in_list(spade: &Spade, bot: &str) -> Result<Value> {
    let all = bots(spade).await?;
    Ok(all
        .iter()
        .find(|a| a["id"] == bot)
        .map(|a| a["style"].clone())
        .unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_packaged_bot_shows_its_packages_accent_until_the_person_chooses_and_their_choice_survives_an_update()
-> Result {
    let spade = secured(Vec::new(), Vec::new()).await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    assert_eq!(
        agent["style"],
        json!({ "accent": "#2f7bea", "chosen": false })
    );
    assert_eq!(style_in_list(&spade, &bot).await?["accent"], "#2f7bea");

    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{bot}"),
            json!({ "style": { "accent": "#C2410C" } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["agent"]["style"],
        json!({ "accent": "#c2410c", "chosen": true })
    );

    // The person's choice is kept through an update of the package.
    move_to(&spade, &bot, "2.0.0", "update-1").await?;
    assert_eq!(style_in_list(&spade, &bot).await?["accent"], "#c2410c");

    // Its face's colour is a choice too: the package's accent doesn't come back.
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{bot}"),
            json!({ "style": { "accent": null } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["agent"]["style"],
        json!({ "accent": null, "chosen": true })
    );
    Ok(())
}

#[tokio::test]
async fn an_accent_that_isnt_one_colour_is_refused_and_spade_itself_has_none() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let bot = spade.new_agent("Trips", "").await?;
    let id = text(&bot["id"]);
    assert_eq!(
        bot["style"],
        Value::Null,
        "a bot of the person's own has none"
    );

    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{id}"),
            json!({ "style": { "accent": "red; background: url(x)" } }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    assert_eq!(style_in_list(&spade, &id).await?, Value::Null);

    let (_, all) = spade.get("/v1/agents").await?;
    let main = all["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main").cloned())
        .unwrap_or_default();
    assert_eq!(main["style"], Value::Null);
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{}", text(&main["id"])),
            json!({ "style": { "accent": "#2f7bea" } }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");
    Ok(())
}
