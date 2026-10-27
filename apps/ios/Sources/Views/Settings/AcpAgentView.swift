import SwiftUI

struct RegistryAgentData: Decodable, Equatable {
    struct Fact: Decodable, Equatable, Identifiable { let label: String; let value: String; let code: Bool?; var id: String { label } }
    struct Setup: Decodable, Equatable { let run: String?; let prompt: String?; let note: String? }
    let id: String
    let name: String
    let publisher: String
    let description: String
    let version: String
    let homepage: String?
    let license: String?
    let standing: String?
    let action: String?
    let actionLabel: String?
    let installed: String?
    let setup: Setup
    let facts: [Fact]
    let planProblem: String?
}
struct InstallData: Decodable, Equatable {
    let session: String
    let state: String
    let finished: Bool
    let succeeded: Bool
    let title: String
    let detail: String?
}
private struct AgentAnswer: ManageAnswer { let ok: Bool; let problem: String?; let agent: RegistryAgentData? }
private struct InstallAnswer: ManageAnswer { let ok: Bool; let problem: String?; let install: InstallData? }

/// One registry agent: what it is, the exact install plan to review, Install or Update, and
/// how to set it up with its own CLI afterwards (ace never signs ACP agents in, ADR 0002).
struct AcpAgentView: View {
    let model: ClientModel
    let agentId: String
    let name: String
    @State private var agent: RegistryAgentData?
    @State private var problem: String?
    @State private var install: InstallData?
    @State private var installProblem: String?
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        List {
            Group {
                if let agent { content(agent) }
                else if problem == nil { Section { HStack { Spacer(); ProgressView(); Spacer() }.frame(minHeight: 88) } }
                if let problem {
                    Section {
                        ServiceProblem(message: problem)
                        Button("Retry") { Task { await read() } }
                    }
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: agent)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: install)
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: agentId) { await read() }
        .task(id: install?.session) { await follow() }
        .sensoryFeedback(.success, trigger: install?.succeeded == true)
        .sensoryFeedback(.error, trigger: install.map { $0.finished && !$0.succeeded } == true)
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
    }
    @ViewBuilder private func content(_ agent: RegistryAgentData) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Text([agent.publisher, agent.version].filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                Text(agent.description).foregroundStyle(AceTheme.Colours.foreground)
            }
            .padding(.vertical, AceTheme.Spacing.xs)
            if let standing = agent.standing { InsetRow("On this machine", systemImage: nil, value: standing) }
            if let install { progress(install) }
            if let installProblem { ServiceProblem(message: installProblem) }
        }
        if install == nil, let label = agent.actionLabel, model.canOperate {
            Section {
                Button { Task { await start(agent) } } label: {
                    Text(label).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.accent).foregroundStyle(AceTheme.Colours.onAccent)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .disabled(agent.planProblem != nil)
            }
        }
        if !agent.facts.isEmpty || agent.planProblem != nil {
            Section {
                ForEach(agent.facts) { fact in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(fact.label).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        Text(fact.value).font(fact.code == true ? .system(.footnote, design: .monospaced) : .body)
                            .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                    }
                    .padding(.vertical, AceTheme.Spacing.xxs)
                }
                if let planProblem = agent.planProblem { ServiceProblem(message: planProblem) }
            } header: { InsetHeader("Install plan") }
        }
        setup(agent)
        if agent.homepage != nil || agent.license != nil {
            Section {
                if let raw = agent.homepage, let url = URL(string: raw), url.scheme == "https" { Link("Website", destination: url) }
                if let license = agent.license { InsetRow("Licence", systemImage: nil, value: license) }
            }
        }
    }
    @ViewBuilder private func setup(_ agent: RegistryAgentData) -> some View {
        Section {
            if let run = agent.setup.run {
                HStack {
                    Text(run).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    Spacer()
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = run
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                    }
                    .buttonStyle(.borderless).contentTransition(.opacity)
                }
                .frame(minHeight: 44)
                if let prompt = agent.setup.prompt { InsetRow("Then type", systemImage: nil, value: prompt) }
            }
            if let note = agent.setup.note { Text(note).foregroundStyle(AceTheme.Colours.mutedForeground) }
        } header: { InsetHeader("Set up") } footer: {
            Text(agent.setup.run == nil ? "\(agent.name) signs in with its own CLI, never through ace." : "\(agent.name) signs in with its own CLI, never through ace. Run this in a terminal on the computer running ace.")
        }
    }
    private func progress(_ install: InstallData) -> some View {
        HStack(spacing: AceTheme.Spacing.md) {
            if !install.finished { ProgressView() }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(install.title)
                    .foregroundStyle(install.finished && !install.succeeded ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
                    .contentTransition(.opacity)
                if let detail = install.detail {
                    Text(detail).font(.system(.caption, design: .monospaced)).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                }
            }
            Spacer()
            if !install.finished, model.canOperate {
                Button("Cancel") { Task { await cancel(install) } }.buttonStyle(.borderless)
            } else if install.finished, !install.succeeded {
                Button("Try again") { self.install = nil }.buttonStyle(.borderless)
            }
        }
        .frame(minHeight: 44)
    }
    private func read() async {
        do {
            agent = try await model.manage(["type": "acp.registry.agent", "acpAgentId": agentId], as: AgentAnswer.self).agent
            problem = nil
        } catch { if !Task.isCancelled, agent == nil { problem = error.localizedDescription } }
    }
    private func start(_ agent: RegistryAgentData) async {
        guard let action = agent.action else { return }
        installProblem = nil
        do {
            install = try await model.manage(["type": "acp.registry.install", "acpAgentId": agent.id, "action": action], as: InstallAnswer.self).install
        } catch { installProblem = error.localizedDescription }
    }
    private func cancel(_ install: InstallData) async {
        _ = try? await model.manage(["type": "acp.registry.cancel", "session": install.session], as: InstallAnswer.self)
    }
    /// Polls the running install; when it finishes, the page and providers are read again.
    private func follow() async {
        while let current = install, !current.finished, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            if let next = try? await model.manage(["type": "acp.registry.progress", "session": current.session], as: InstallAnswer.self).install {
                install = next
            }
        }
        if install?.succeeded == true {
            model.refreshMachine()
            await read()
            install = nil
        }
    }
}
