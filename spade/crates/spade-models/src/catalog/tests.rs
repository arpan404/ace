use super::*;

fn problems(json: &str) -> Vec<String> {
    Catalog::from_json(json)
        .err()
        .map(|e| e.problems)
        .unwrap_or_default()
}

/// One endpoint `local` with one model `m`, and every role on it, plus `endpoints` appended.
fn file(extra_endpoints: &str) -> String {
    format!(
        r#"{{ "roles": {{ "main": "local/m", "fast": "local/m", "deep": "local/m" }},
             "endpoints": [
               {{ "id": "local", "name": "Local", "format": "openai-chat",
                  "base_url": "http://127.0.0.1:11434/v1", "models": [ {{ "id": "m", "name": "M" }} ] }}
               {extra_endpoints}
             ] }}"#
    )
}

#[test]
fn the_shipped_catalogue_is_valid_and_every_role_resolves() -> Result<(), CatalogError> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/models.json");
    let catalog = Catalog::load(&path)?;
    for role in [Role::Main, Role::Fast, Role::Deep] {
        assert!(catalog.resolve(catalog.role(role)).is_some(), "{role:?}");
    }
    Ok(())
}

#[test]
fn the_shipped_opencode_go_endpoints_route_by_session() -> Result<(), CatalogError> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/models.json");
    let catalog = Catalog::load(&path)?;
    for id in ["opencode-go", "opencode-go-anthropic"] {
        let endpoint = catalog.endpoints().iter().find(|e| e.id == id);
        assert_eq!(
            endpoint.and_then(|e| e.session_header.as_deref()),
            Some("x-opencode-session"),
            "{id}"
        );
    }
    Ok(())
}

#[test]
fn a_session_header_that_is_not_a_header_name_is_refused() {
    let json = file(
        r#", { "id": "routed", "name": "Routed", "format": "openai-chat",
              "base_url": "https://routed.example/v1/", "session_header": "x session",
              "models": [ { "id": "m", "name": "M" } ] }"#,
    );
    let found = problems(&json);
    assert!(
        found.iter().any(|p| p.contains("routed: session_header")),
        "{found:?}"
    );
}

#[test]
fn a_model_id_may_contain_a_slash_but_the_endpoint_comes_first() -> Result<(), CatalogError> {
    let catalog = Catalog::from_json(&file(
        r#", { "id": "router", "name": "Router", "format": "openai-chat",
              "base_url": "https://router.example/api/v1/",
              "models": [ { "id": "anthropic/claude-sonnet-5.5", "name": "Sonnet" } ] }"#,
    ))?;
    let resolved = catalog.resolve("router/anthropic/claude-sonnet-5.5");
    assert_eq!(
        resolved.map(|r| (r.endpoint.id.as_str(), r.model.id.as_str())),
        Some(("router", "anthropic/claude-sonnet-5.5"))
    );
    assert!(catalog.resolve("router/claude-sonnet-5.5").is_none());
    assert!(catalog.resolve("no-slash").is_none());
    Ok(())
}

#[test]
fn a_base_url_gets_its_trailing_slash_and_a_local_server_needs_no_key() -> Result<(), CatalogError>
{
    let catalog = Catalog::from_json(&file(""))?;
    let endpoint = catalog.resolve("local/m").map(|r| r.endpoint);
    assert_eq!(
        endpoint.map(|e| (e.base_url.as_str(), e.key_env.clone())),
        Some(("http://127.0.0.1:11434/v1/", None))
    );
    Ok(())
}

#[test]
fn a_role_that_names_nothing_in_the_file_is_refused() {
    let json = file("").replace(
        r#""deep": "local/m""#,
        r#""deep": "anthropic/claude-opus-5-5""#,
    );
    assert_eq!(
        problems(&json),
        vec![
            "the deep role names anthropic/claude-opus-5-5, which is not an endpoint/model in this file"
        ]
    );
}

#[test]
fn an_endpoint_listed_twice_or_with_a_slash_in_its_id_is_refused() {
    let json = file(
        r#", { "id": "local", "name": "Again", "format": "anthropic", "base_url": "https://a.example/",
              "models": [ { "id": "x", "name": "X" } ] },
            { "id": "bad/id", "name": "Bad", "format": "anthropic", "base_url": "https://b.example/",
              "models": [ { "id": "y", "name": "Y" } ] }"#,
    );
    let found = problems(&json);
    assert!(
        found.contains(&"endpoint local is listed more than once".to_owned()),
        "{found:?}"
    );
    assert!(found.iter().any(|p| p.contains("\"bad/id\"")), "{found:?}");
}

#[test]
fn an_unknown_format_or_a_misspelt_field_is_refused_not_ignored() {
    let format = file("").replace(r#""format": "openai-chat""#, r#""format": "gemini""#);
    assert!(problems(&format).iter().any(|p| p.contains("gemini")));
    let typo = file("").replace(r#""base_url""#, r#""base_ur""#);
    assert!(problems(&typo).iter().any(|p| p.contains("base_ur")));
}

#[test]
fn a_bad_url_key_name_or_price_is_refused() {
    let json = file(
        r#", { "id": "paid", "name": "Paid", "format": "anthropic", "base_url": "api.example.com",
              "key": { "env": "my key" },
              "models": [ { "id": "z", "name": "Z", "price": { "input": -1, "output": 1 } } ] }"#,
    );
    let found = problems(&json);
    assert!(
        found.iter().any(|p| p.contains("base_url must start")),
        "{found:?}"
    );
    assert!(found.iter().any(|p| p.contains("key env")), "{found:?}");
    assert!(
        found.iter().any(|p| p.contains("paid/z: prices")),
        "{found:?}"
    );
}

#[test]
fn every_problem_is_reported_at_once() {
    let json = r#"{ "roles": { "main": "a/x", "fast": "a/x", "deep": "a/x" },
                   "endpoints": [ { "id": "a", "name": "", "format": "anthropic",
                                    "base_url": "https://a.example/", "models": [] } ] }"#;
    assert_eq!(
        problems(json),
        vec![
            "endpoint a has an empty name",
            "endpoint a lists no models",
            "the main role names a/x, which is not an endpoint/model in this file",
            "the fast role names a/x, which is not an endpoint/model in this file",
            "the deep role names a/x, which is not an endpoint/model in this file",
        ]
    );
}

#[test]
fn a_missing_file_names_the_path() {
    let error = Catalog::load(Path::new("/nonexistent/models.json"));
    assert!(matches!(&error, Err(e) if e.source == "/nonexistent/models.json"));
}
