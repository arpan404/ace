//! First run: what became of the About-you interview and the starter bots is kept, across a
//! restart, so no client asks again; only the known steps and states are taken.

mod support;

use serde_json::json;
use spade_testkit::Script;
use support::{Result, Spade};

#[tokio::test]
async fn a_finished_interview_stays_finished_after_a_restart() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (status, fresh) = spade.get("/v1/onboarding").await?;
    assert_eq!(status, 200);
    assert_eq!(fresh, json!({ "about_you": null, "starters": null }));

    let response = spade
        .http
        .put(format!("{}/v1/onboarding", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&json!({ "about_you": "done", "starters": "skipped" }))
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let bad = spade
        .http
        .put(format!("{}/v1/onboarding", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&json!({ "about_you": "maybe", "tour": "done" }))
        .send()
        .await?;
    assert_eq!(bad.status().as_u16(), 400);

    let spade = spade
        .restart(Vec::new(), vec![Script::reply("unused")])
        .await?;
    let (_, kept) = spade.get("/v1/onboarding").await?;
    assert_eq!(kept, json!({ "about_you": "done", "starters": "skipped" }));
    Ok(())
}
