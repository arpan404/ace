use super::{HostOptionProjection, RuntimeStatusProjection};
use ace_protocol::provider_runtime::ProviderRuntimeStateGetResponse;
use ace_runtime::{provider::ProviderRuntimeHealth, threads::RemoteConnectionRecord};

pub(super) fn provider_health_label(health: ProviderRuntimeHealth) -> &'static str {
    match health {
        ProviderRuntimeHealth::Ready => "ready",
        ProviderRuntimeHealth::Starting => "starting",
        ProviderRuntimeHealth::Running => "running",
        ProviderRuntimeHealth::Stopped => "stopped",
        ProviderRuntimeHealth::Unavailable => "unavailable",
        ProviderRuntimeHealth::Degraded => "degraded",
        ProviderRuntimeHealth::Unknown => "unknown",
    }
}

pub(super) fn host_option_projection(connection: &RemoteConnectionRecord) -> HostOptionProjection {
    let status = connection
        .status
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let project_count = json_collection_len(&connection.projects);
    let label = connection
        .display_name
        .clone()
        .or_else(|| connection.host.clone())
        .unwrap_or_else(|| connection.host_id.clone());
    let mut detail = connection.host.as_ref().map_or_else(
        || format!("{} · {}", connection.provider, status),
        |host| format!("{} · {} · {}", connection.provider, host, status),
    );
    if project_count > 0 {
        detail.push_str(&format!(
            " · {project_count} project{}",
            plural(project_count)
        ));
    }

    HostOptionProjection {
        provider: connection.provider.clone(),
        host_id: connection.host_id.clone(),
        label,
        detail,
        connected: is_connected_remote_status(&status),
        status,
        execution_location: connection.execution_location,
        project_count,
    }
}

pub(super) fn is_connected_remote_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "connected" | "online" | "ready"
    )
}

pub(super) fn runtime_status_projection_from_state(
    response: &ProviderRuntimeStateGetResponse,
    provider_count: usize,
    updated_at: String,
) -> RuntimeStatusProjection {
    let mut projection = RuntimeStatusProjection {
        providers: response.providers.len().max(provider_count),
        updated_at: Some(updated_at),
        ..RuntimeStatusProjection::default()
    };

    for provider in &response.providers {
        let summary = &provider.summary;
        projection.threads += summary.threads;
        projection.active_threads += summary.active_threads;
        projection.active_turns += summary.active_turns;
        projection.handoffs += summary.handoffs;
        projection.pending_approvals += summary.pending_approvals;
        projection.warnings += summary.warnings;
        projection.remote_connections += summary.remote_connections;
        projection.remote_host_connections += summary.remote_host_connections;
        projection.connected_remote_connections += summary.connected_remote_connections;
        projection.disconnected_remote_connections += summary.disconnected_remote_connections;
        projection.remote_connections_with_projects += summary.remote_connections_with_projects;
    }

    projection
}

fn json_collection_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => items.len(),
        serde_json::Value::Object(entries) => entries.len(),
        _ => 0,
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_protocol::provider_runtime::{
        ProviderRuntimeProviderState, ProviderRuntimeStateSource, ProviderRuntimeStateSummary,
    };
    use ace_runtime::threads::{AgentRuntimeSnapshot, ExecutionLocation};

    #[test]
    fn host_option_projection_labels_connection_and_project_count() {
        let option = host_option_projection(&RemoteConnectionRecord {
            provider: "ssh".to_string(),
            host_id: "build-host".to_string(),
            host: Some("build.example.test".to_string()),
            display_name: Some("Build host".to_string()),
            status: Some("online".to_string()),
            execution_location: ExecutionLocation::RemoteHost,
            projects: serde_json::json!([
                { "name": "ace" },
                { "name": "mobile" }
            ]),
            metadata: serde_json::Value::Null,
        });

        assert_eq!(option.label, "Build host");
        assert_eq!(option.status, "online");
        assert!(option.connected);
        assert_eq!(option.project_count, 2);
        assert!(option.detail.contains("2 projects"));
    }

    #[test]
    fn connected_remote_status_accepts_known_ready_values() {
        assert!(is_connected_remote_status(" connected "));
        assert!(is_connected_remote_status("ONLINE"));
        assert!(is_connected_remote_status("ready"));
        assert!(!is_connected_remote_status("offline"));
    }

    #[test]
    fn runtime_status_projection_aggregates_provider_summaries() {
        let response = ProviderRuntimeStateGetResponse {
            providers: vec![ProviderRuntimeProviderState {
                provider: ace_core::ProviderKind::Codex,
                runtime_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                source: ProviderRuntimeStateSource::Live,
                persisted_replay_available: false,
                last_persisted_sequence: None,
                summary: ProviderRuntimeStateSummary {
                    threads: 8,
                    active_threads: 3,
                    active_turns: 2,
                    handoffs: 4,
                    pending_approvals: 1,
                    warnings: 5,
                    remote_connections: 6,
                    remote_host_connections: 2,
                    connected_remote_connections: 3,
                    disconnected_remote_connections: 1,
                    remote_connections_with_projects: 4,
                    ..ProviderRuntimeStateSummary::default()
                },
                state: AgentRuntimeSnapshot::default(),
            }],
        };

        let projection = runtime_status_projection_from_state(&response, 2, "updated".to_string());

        assert_eq!(projection.providers, 2);
        assert_eq!(projection.threads, 8);
        assert_eq!(projection.active_threads, 3);
        assert_eq!(projection.active_turns, 2);
        assert_eq!(projection.handoffs, 4);
        assert_eq!(projection.pending_approvals, 1);
        assert_eq!(projection.remote_connections, 6);
        assert_eq!(projection.remote_host_connections, 2);
        assert_eq!(projection.connected_remote_connections, 3);
        assert_eq!(projection.disconnected_remote_connections, 1);
        assert_eq!(projection.remote_connections_with_projects, 4);
        assert_eq!(projection.updated_at.as_deref(), Some("updated"));
    }
}
