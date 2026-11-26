// SPDX-License-Identifier: Apache-2.0
//! A repository's canonical key (`repository-key.ts`): identity is insensitive to URL case.

use ace_json::{Map, Value};

/// `JSON.stringify({forge, host, owner, name})` with host, owner and name lower-cased.
pub fn repository_key(forge: &str, host: &str, owner: &str, name: &str) -> String {
    let mut key = Map::new();
    key.insert(String::from("forge"), Value::from(forge));
    key.insert(String::from("host"), Value::from(host.to_lowercase()));
    key.insert(String::from("owner"), Value::from(owner.to_lowercase()));
    key.insert(String::from("name"), Value::from(name.to_lowercase()));
    ace_json::ser::to_string(&Value::Object(key)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::repository_key;

    #[test]
    fn the_key_is_compact_json_with_a_canonical_case() {
        assert_eq!(
            repository_key("github", "GitHub.com", "Octo", "Ace"),
            r#"{"forge":"github","host":"github.com","owner":"octo","name":"ace"}"#
        );
    }

    #[test]
    fn different_repositories_do_not_collide() {
        assert_ne!(
            repository_key("github", "github.com", "octo", "ace"),
            repository_key("gitlab", "github.com", "octo", "ace")
        );
        assert_ne!(
            repository_key("github", "github.com", "octo", "ace"),
            repository_key("github", "github.com", "octo", "ace2")
        );
    }
}
