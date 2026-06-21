use ace_core::{Command, CommandId};
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct RuntimeCommand {
    pub id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone)]
pub struct RuntimeHandle {
    commands: mpsc::Sender<RuntimeCommand>,
}

impl RuntimeHandle {
    #[must_use]
    pub fn new(commands: mpsc::Sender<RuntimeCommand>) -> Self {
        Self { commands }
    }

    pub async fn submit(&self, command: Command) -> Result<CommandId, RuntimeError> {
        let id = CommandId::new();
        self.commands
            .send(RuntimeCommand { id, command })
            .await
            .map_err(|_| RuntimeError::Stopped)?;
        Ok(id)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("runtime is stopped")]
    Stopped,
}

pub mod provider {
    use ace_core::{ProviderCapability, ProviderKind};

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ProviderDescriptor {
        pub kind: ProviderKind,
        pub capabilities: Vec<ProviderCapability>,
    }

    pub trait ProviderDriver: Send + Sync + 'static {
        fn descriptor(&self) -> ProviderDescriptor;
    }
}
