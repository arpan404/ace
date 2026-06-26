use ace_project::{AddProjectResult, RemoveProjectResult};
use ace_protocol::{
    project::{
        ProjectAddRequest, ProjectDeleteRequest, ProjectSnapshotRequest, ProjectSnapshotResponse,
        ProjectThreadsRequest, ThreadMessagesRequest, ThreadMessagesResponse,
    },
    ws::methods,
};
use ace_rpc::{RpcEndpoint, RpcError, RpcMethod, WsRpcClient};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    env, fmt, io,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use thiserror::Error;
use tokio::{net::TcpStream, runtime::Handle, runtime::Runtime, time};

const DEFAULT_BACKEND_PORT: u16 = 3773;
const STARTUP_ATTEMPTS: usize = 1200;
const STARTUP_POLL_DELAY: Duration = Duration::from_millis(50);
const DEV_PORT_FALLBACK_ATTEMPTS: u16 = 24;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum BackendError {
    #[error("failed to create backend runtime: {0}")]
    Runtime(io::Error),
    #[error("failed to spawn backend: {0}")]
    Spawn(io::Error),
    #[error("backend executable was not found next to desktop binary")]
    MissingExecutable,
    #[error("backend exited before opening port {port}")]
    EarlyExit { port: u16 },
    #[error("backend did not open port {port}")]
    StartupTimeout { port: u16 },
    #[error("backend rpc failed: {0}")]
    Rpc(#[from] RpcError),
    #[error("no compatible backend port was available near {port}")]
    NoCompatiblePort { port: u16 },
    #[error("backend host does not exist: {0}")]
    UnknownHost(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendLaunchMode {
    Reused,
    Spawned,
}

pub struct DesktopBackend {
    runtime: Runtime,
    hosts: BackendHosts,
    process: Option<Child>,
    launch_mode: BackendLaunchMode,
}

impl DesktopBackend {
    pub fn connect_or_spawn() -> Result<Self, BackendError> {
        let runtime = Runtime::new().map_err(BackendError::Runtime)?;
        let mut endpoint = desktop_endpoint();
        let mut process = None;
        let (rpc, launch_mode) = if runtime.block_on(is_port_open(&endpoint)) {
            let rpc = runtime.block_on(WsRpcClient::connect(endpoint.clone()))?;
            if runtime.block_on(validate_backend_rpc(&rpc)).is_ok() {
                (rpc, BackendLaunchMode::Reused)
            } else {
                let spawned = spawn_compatible_backend(&runtime, endpoint.port, &mut endpoint)?;
                process = Some(spawned.0);
                (spawned.1, BackendLaunchMode::Spawned)
            }
        } else {
            let child = spawn_backend(endpoint.port)?;
            process = Some(child);
            if let Err(error) = runtime.block_on(wait_for_backend(&endpoint, process.as_mut())) {
                stop_backend_child(process.take());
                return Err(error);
            }
            let rpc = runtime.block_on(WsRpcClient::connect(endpoint.clone()))?;
            runtime.block_on(validate_backend_rpc(&rpc))?;
            (rpc, BackendLaunchMode::Spawned)
        };
        let hosts = BackendHosts::with_local(runtime.handle().clone(), endpoint.clone(), rpc);

        Ok(Self {
            runtime,
            hosts,
            process,
            launch_mode,
        })
    }

    #[must_use]
    pub fn active_host(&self) -> BackendHostClient {
        self.hosts
            .active_host()
            .expect("local backend host must exist")
            .clone()
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn hosts(&self) -> &BackendHosts {
        &self.hosts
    }

    #[allow(dead_code)]
    pub fn connect_remote_host(
        &mut self,
        id: HostId,
        label: impl Into<String>,
        endpoint: RpcEndpoint,
    ) -> Result<BackendHostClient, BackendError> {
        let rpc = self
            .runtime
            .block_on(WsRpcClient::connect(endpoint.clone()))?;
        Ok(self.hosts.insert(id, label.into(), endpoint, rpc).clone())
    }

    #[must_use]
    pub fn launch_mode(&self) -> BackendLaunchMode {
        self.launch_mode
    }

    pub fn check_status(&self) -> Result<BackendStatus, BackendError> {
        self.runtime
            .block_on(self.active_host().rpc.request::<StatusRead>(&()))
            .map_err(BackendError::Rpc)
    }
}

impl Drop for DesktopBackend {
    fn drop(&mut self) {
        stop_backend_child(self.process.take());
    }
}

#[derive(Debug, Deserialize)]
pub struct BackendStatus {
    pub ok: bool,
    pub protocol_version: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostId(String);

impl HostId {
    #[must_use]
    pub fn local() -> Self {
        Self("local".to_string())
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn remote(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub struct BackendHosts {
    runtime: Handle,
    active_host_id: HostId,
    hosts: HashMap<HostId, BackendHostClient>,
}

#[allow(dead_code)]
impl BackendHosts {
    fn with_local(runtime: Handle, endpoint: RpcEndpoint, rpc: WsRpcClient) -> Self {
        let mut hosts = Self {
            runtime: runtime.clone(),
            active_host_id: HostId::local(),
            hosts: HashMap::new(),
        };
        hosts.insert(HostId::local(), "Local".to_string(), endpoint, rpc);
        hosts
    }

    pub fn insert(
        &mut self,
        id: HostId,
        label: String,
        endpoint: RpcEndpoint,
        rpc: WsRpcClient,
    ) -> &BackendHostClient {
        self.hosts.entry(id.clone()).or_insert(BackendHostClient {
            id,
            label,
            endpoint,
            rpc,
            runtime: self.runtime.clone(),
        })
    }

    #[must_use]
    pub fn active_host(&self) -> Option<&BackendHostClient> {
        self.hosts.get(&self.active_host_id)
    }

    pub fn set_active_host(&mut self, id: HostId) -> Result<(), BackendError> {
        if self.hosts.contains_key(&id) {
            self.active_host_id = id;
            Ok(())
        } else {
            Err(BackendError::UnknownHost(id.0))
        }
    }

    #[must_use]
    pub fn host(&self, id: &HostId) -> Option<&BackendHostClient> {
        self.hosts.get(id)
    }

    #[must_use]
    pub fn all_hosts(&self) -> Vec<BackendHostClient> {
        self.hosts.values().cloned().collect()
    }
}

#[derive(Clone)]
#[allow(dead_code)]
pub struct BackendHostClient {
    id: HostId,
    label: String,
    endpoint: RpcEndpoint,
    rpc: WsRpcClient,
    runtime: Handle,
}

impl fmt::Debug for BackendHostClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendHostClient")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl BackendHostClient {
    #[must_use]
    #[allow(dead_code)]
    pub fn id(&self) -> &HostId {
        &self.id
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn label(&self) -> &str {
        &self.label
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn endpoint(&self) -> &RpcEndpoint {
        &self.endpoint
    }

    pub fn request<M: RpcMethod>(&self, payload: &M::Request) -> Result<M::Response, BackendError> {
        self.runtime
            .block_on(self.rpc.request::<M>(payload))
            .map_err(BackendError::Rpc)
    }

    #[allow(dead_code)]
    pub fn call<T, O>(&self, method: impl Into<String>, payload: &T) -> Result<O, BackendError>
    where
        T: Serialize,
        O: DeserializeOwned,
    {
        self.runtime
            .block_on(self.rpc.call(method, payload))
            .map_err(BackendError::Rpc)
    }
}

struct StatusRead;

impl RpcMethod for StatusRead {
    type Request = ();
    type Response = BackendStatus;

    const METHOD: &'static str = methods::SERVER_STATUS;
}

pub struct ProjectsSnapshot;

impl RpcMethod for ProjectsSnapshot {
    type Request = ProjectSnapshotRequest;
    type Response = ProjectSnapshotResponse;

    const METHOD: &'static str = methods::PROJECTS_SNAPSHOT;
}

pub struct ProjectsProjectThreads;

impl RpcMethod for ProjectsProjectThreads {
    type Request = ProjectThreadsRequest;
    type Response = Vec<ace_runtime::chat::ThreadSummary>;

    const METHOD: &'static str = methods::PROJECTS_PROJECT_THREADS;
}

pub struct ProjectsThreadMessages;

impl RpcMethod for ProjectsThreadMessages {
    type Request = ThreadMessagesRequest;
    type Response = ThreadMessagesResponse;

    const METHOD: &'static str = methods::PROJECTS_THREAD_MESSAGES;
}

pub struct ProjectsAdd;

impl RpcMethod for ProjectsAdd {
    type Request = ProjectAddRequest;
    type Response = AddProjectResult;

    const METHOD: &'static str = methods::PROJECTS_ADD;
}

pub struct ProjectsDelete;

impl RpcMethod for ProjectsDelete {
    type Request = ProjectDeleteRequest;
    type Response = RemoveProjectResult;

    const METHOD: &'static str = methods::PROJECTS_DELETE;
}

fn desktop_endpoint() -> RpcEndpoint {
    let port = env::var("ACE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BACKEND_PORT);
    RpcEndpoint::localhost(port)
}

async fn is_port_open(endpoint: &RpcEndpoint) -> bool {
    TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .is_ok()
}

async fn wait_for_backend(
    endpoint: &RpcEndpoint,
    child: Option<&mut Child>,
) -> Result<(), BackendError> {
    let mut child = child;
    for _ in 0..STARTUP_ATTEMPTS {
        if is_port_open(endpoint).await {
            return Ok(());
        }
        if let Some(process) = child.as_deref_mut()
            && matches!(process.try_wait(), Ok(Some(_)))
        {
            return Err(BackendError::EarlyExit {
                port: endpoint.port,
            });
        }
        time::sleep(STARTUP_POLL_DELAY).await;
    }
    Err(BackendError::StartupTimeout {
        port: endpoint.port,
    })
}

async fn validate_backend_rpc(rpc: &WsRpcClient) -> Result<(), BackendError> {
    rpc.request::<ProjectsSnapshot>(&ProjectSnapshotRequest {})
        .await
        .map(|_| ())
        .map_err(BackendError::Rpc)
}

fn spawn_compatible_backend(
    runtime: &Runtime,
    preferred_port: u16,
    endpoint: &mut RpcEndpoint,
) -> Result<(Child, WsRpcClient), BackendError> {
    for port in
        preferred_port.saturating_add(1)..preferred_port.saturating_add(DEV_PORT_FALLBACK_ATTEMPTS)
    {
        let candidate = RpcEndpoint::localhost(port);
        if runtime.block_on(is_port_open(&candidate)) {
            continue;
        }

        let mut child = spawn_backend(port)?;
        if let Err(error) = runtime.block_on(wait_for_backend(&candidate, Some(&mut child))) {
            stop_backend_child(Some(child));
            return Err(error);
        }

        let rpc = runtime.block_on(WsRpcClient::connect(candidate.clone()))?;
        if let Err(error) = runtime.block_on(validate_backend_rpc(&rpc)) {
            stop_backend_child(Some(child));
            return Err(error);
        }

        *endpoint = candidate;
        return Ok((child, rpc));
    }

    Err(BackendError::NoCompatiblePort {
        port: preferred_port,
    })
}

fn spawn_backend(port: u16) -> Result<Child, BackendError> {
    let mut command = backend_command()?;
    command
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(BackendError::Spawn)
}

fn stop_backend_child(child: Option<Child>) {
    if let Some(mut process) = child {
        if let Err(error) = process.kill() {
            tracing::debug!(%error, "failed to stop desktop-managed backend");
        }
        if let Err(error) = process.wait() {
            tracing::debug!(%error, "failed to wait for desktop-managed backend");
        }
    }
}

fn backend_command() -> Result<Command, BackendError> {
    if cfg!(debug_assertions) {
        let mut command = Command::new("cargo");
        command
            .current_dir(workspace_root())
            .arg("run")
            .arg("-p")
            .arg("ace-backend")
            .arg("--");
        return Ok(command);
    }

    if let Some(backend) = backend_executable()? {
        return Ok(Command::new(backend));
    }

    Err(BackendError::MissingExecutable)
}

fn backend_executable() -> Result<Option<PathBuf>, BackendError> {
    let mut path = env::current_exe().map_err(BackendError::Spawn)?;
    let binary_name = if cfg!(windows) {
        "ace-backend.exe"
    } else {
        "ace-backend"
    };
    path.set_file_name(binary_name);
    if path.exists() {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("desktop crate must be under apps/desktop")
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_uses_default_local_backend_port() {
        unsafe {
            env::remove_var("ACE_PORT");
        }
        let endpoint = desktop_endpoint();

        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, DEFAULT_BACKEND_PORT);
        assert_eq!(endpoint.path, "/ws");
    }
}
