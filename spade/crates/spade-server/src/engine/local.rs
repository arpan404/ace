//! Models on this computer in the engine (`crate::local_models`): which local servers run and
//! what they have, and using one of their models in one step (the endpoint made the first time,
//! the model saved on it).

use crate::local_models::{self, LocalServer};

use super::{EndpointError, EndpointInput, EndpointView, Engine, ModelInput};

/// A local server as the person's settings show it.
#[derive(Debug, Clone)]
pub struct LocalStatus {
    pub server: LocalServer,
    pub running: bool,
    /// Its models, when running.
    pub models: Vec<String>,
    /// The endpoint the person already added at its address.
    pub endpoint: Option<String>,
}

impl Engine {
    /// Sets the local servers Spade looks for, in place of Ollama's and LM Studio's defaults.
    pub fn set_local_servers(&self, servers: Vec<LocalServer>) {
        *self.local_servers.lock().unwrap_or_else(|p| p.into_inner()) = Some(servers);
    }

    fn local_server_list(&self) -> Vec<LocalServer> {
        self.local_servers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(local_models::defaults)
    }

    /// Each local server: whether it runs now, its models, and the endpoint already added for
    /// it. Looked at together, so the slowest bounds the wait.
    pub async fn local_servers(&self) -> Vec<LocalStatus> {
        let client = local_models::client();
        let servers = self.local_server_list();
        let looks = servers
            .iter()
            .map(|server| local_models::probe(&client, &server.base_url));
        let found = futures_util::future::join_all(looks).await;
        let added = self.store.endpoints().unwrap_or_default();
        servers
            .into_iter()
            .zip(found)
            .map(|(server, models)| LocalStatus {
                endpoint: added
                    .iter()
                    .find(|e| local_models::same_base(&e.base_url, &server.base_url))
                    .map(|e| e.id.clone()),
                running: models.is_some(),
                models: models.unwrap_or_default(),
                server,
            })
            .collect()
    }

    /// Uses `model` of local server `server`: adds the server as an endpoint the first time
    /// (no key, OpenAI Chat Completions), saves the model on it, and answers the endpoint and
    /// the `endpoint/model` a picker sets.
    pub fn use_local_model(
        &self,
        server: &str,
        model: &str,
    ) -> Result<(EndpointView, String), EndpointError> {
        let server = self
            .local_server_list()
            .into_iter()
            .find(|s| s.id == server)
            .ok_or(EndpointError::NotFound)?;
        let existing = self
            .store
            .endpoints()?
            .into_iter()
            .find(|e| local_models::same_base(&e.base_url, &server.base_url));
        let endpoint = match existing {
            Some(stored) => stored.id,
            None => {
                self.create_endpoint(EndpointInput {
                    name: Some(server.name.clone()),
                    format: Some("openai-chat".to_owned()),
                    base_url: Some(server.base_url.clone()),
                    needs_key: Some(false),
                    ..EndpointInput::default()
                })?
                .stored
                .id
            }
        };
        let view = self.save_model(
            &endpoint,
            ModelInput {
                id: model.to_owned(),
                ..ModelInput::default()
            },
        )?;
        let value = format!("{endpoint}/{}", model.trim());
        Ok((view, value))
    }
}
