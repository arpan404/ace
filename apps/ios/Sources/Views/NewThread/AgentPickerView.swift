import SwiftUI

/// The machine's coding agents and their models, grouped by agent. One that isn't installed, is
/// signed out or needs attention stays listed, disabled, with the reason the bridge gave. Each
/// agent leads with the model in use (else its default); the rest of a long list waits behind
/// "More models", in the order the bridge sent (`newThreadModelList` in `@ace/ui-core/mobile`).
struct AgentPickerView: View {
    @Bindable var compose: ComposeModel
    /// Provider, model key and account currently chosen.
    let selected: (String, String, String)?
    let reload: () -> Void
    let choose: (ComposeAgent, ComposeAgent.Model) -> Void
    @State private var expanded: Set<String> = []
    var body: some View {
        List {
            switch compose.agentsState {
            case "ready":
                ForEach(compose.agents) { agent in
                    Section {
                        if agent.ready {
                            ForEach(agent.leading) { model in row(agent, model) }
                            if !agent.more.isEmpty { more(agent) }
                        } else {
                            Text(agent.reason ?? "Not ready").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .accessibilityIdentifier("agent.\(agent.provider).reason")
                        }
                    } header: {
                        HStack { Text(agent.name); Spacer(); StateLabel(status: agent.status) }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("agent.\(agent.provider)")
                    }
                }
            case "failed":
                ContentUnavailableView {
                    Label("Couldn't read coding agents", systemImage: "wifi.exclamationmark")
                } description: { Text("Your computer didn't answer.") } actions: { Button("Try again", action: reload) }
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            }
        }
        .navigationTitle("Coding agent").navigationBarTitleDisplayMode(.inline)
        .refreshable { reload() }
    }
    @ViewBuilder private func more(_ agent: ComposeAgent) -> some View {
        if expanded.contains(agent.provider) {
            ForEach(agent.more) { model in row(agent, model) }
            Button("Fewer models") { expanded.remove(agent.provider) }
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .accessibilityIdentifier("agent.\(agent.provider).fewer")
        } else {
            Button { expanded.insert(agent.provider) } label: {
                HStack {
                    Text("More models")
                    Spacer(minLength: AceTheme.Spacing.none)
                    Text("\(agent.more.count)").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                    Image(systemName: "chevron.down").foregroundStyle(AceTheme.Colours.decoration).accessibilityHidden(true)
                }
                .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
            }
            .accessibilityLabel("More models")
            .accessibilityValue("\(agent.more.count) more")
            .accessibilityIdentifier("agent.\(agent.provider).more")
        }
    }
    private func row(_ agent: ComposeAgent, _ model: ComposeAgent.Model) -> some View {
        let chosen = selected.map { $0.0 == agent.provider && $0.1 == model.key && $0.2 == model.account } ?? false
        let account = agent.accounts.count > 1 ? agent.accounts.first { $0.id == model.account } : nil
        return Button { choose(agent, model) } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(model.label).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                    if let account {
                        Text("\(account.label) · \(account.usage)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                Spacer(minLength: AceTheme.Spacing.none)
                if chosen { Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.foreground) }
            }
            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier("model.\(agent.provider).\(model.label)")
    }
}

/// Files in the chosen project to `@`-mention, searched on the computer before the thread exists.
struct MentionSearchView: View {
    @Bindable var compose: ComposeModel
    let workspaceId: String
    let search: (String) -> Void
    let choose: (String) -> Void
    @State private var query = ""
    private var result: (workspaceId: String, query: String, state: String, paths: [String])? {
        compose.mentions.flatMap { $0.workspaceId == workspaceId && $0.query == query ? $0 : nil }
    }
    var body: some View {
        List {
            switch result?.state {
            case "ready":
                if result?.paths.isEmpty == true { ContentUnavailableView.search(text: query) }
                ForEach(result?.paths ?? [], id: \.self) { path in
                    Button { choose(path) } label: { FilePathRow(path: path) }
                        .buttonStyle(.plain).accessibilityIdentifier("mention.\(path)")
                }
            case "failed":
                ContentUnavailableView("Couldn't search files", systemImage: "wifi.exclamationmark", description: Text("Check the connection and try again."))
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            }
        }
        .searchable(text: $query, prompt: "Search files")
        .navigationTitle("Mention a file").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            search(query)
        }
    }
}

/// A file as lists show it: its name, then the folder it sits in, in SF Mono.
struct FilePathRow: View {
    let path: String
    var folder: Bool = false
    var body: some View {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: folder ? "folder" : "doc.text").foregroundStyle(AceTheme.Colours.decoration)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(String(parts.last ?? Substring(path))).aceMonospace(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if parts.count > 1 {
                    Text(parts.dropLast().joined(separator: "/")).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
    }
}
