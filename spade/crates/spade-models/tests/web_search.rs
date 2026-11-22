//! An endpoint's own web search failing, over real HTTP from a local fake: the error Spade keeps
//! (and logs) says the HTTP status, never what the endpoint wrote, which can echo the query.

use std::time::Duration;

use serde_json::json;
use spade_models::{Capability, Catalog, Endpoint, Format, Keys, Model, Models};
use spade_testkit::FakeModelList;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const QUERY: &str = "patient-4417 lab results interpretation";

fn models(root: &str) -> Result<Models> {
    let presets = Catalog::from_json(&json!({ "endpoints": [] }).to_string())?;
    let models = Models::new(presets, Keys::new(|_| Some("sk-key".to_owned())), "9.9.9")?;
    models.set_endpoints(vec![Endpoint {
        id: "mine".into(),
        name: "Mine".into(),
        format: Format::Anthropic,
        base_url: root.to_owned(),
        needs_key: true,
        key_env: None,
        headers: Vec::new(),
        session_header: None,
        sign_in: None,
        models: vec![Model {
            id: "searcher".into(),
            name: "Searcher".into(),
            context: None,
            capabilities: vec![Capability::WebSearch],
            price: None,
        }],
    }]);
    Ok(models)
}

#[tokio::test]
async fn a_refused_endpoint_search_keeps_its_status_and_never_the_endpoints_words() -> Result {
    // An endpoint whose error message echoes the request, as some do.
    let echo = json!({ "type": "error",
                       "error": { "type": "invalid_request_error",
                                  "message": format!("could not search for: {QUERY}") } });
    let fake = FakeModelList::start(400, echo.to_string(), Duration::ZERO).await?;
    let models = models(&fake.root)?;
    assert!(models.searches_natively("mine/searcher"));
    let error = models
        .web_search("mine/searcher", QUERY, 5)
        .await
        .err()
        .ok_or("the search should have failed")?;
    let said = error.to_string();
    assert!(!said.contains("patient-4417"), "{said}");
    assert!(!said.contains("could not search"), "{said}");
    assert!(said.contains("400"), "{said}");
    Ok(())
}
