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
    @State private var pollProblem: String?
    @State private var failedCancellation = false
    @State private var copied = false
    @State private var starting = false
    @State private var pollAttempt = 0
    var body: some View {
        List {
            Group {
                if let agent { content(agent) }
                else if problem == nil { Section { SkeletonRows(count: 2, label: "Loading the agent").listRowInsets(EdgeInsets()) } }
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
        .animation(.default, value: agent)
        .animation(.default, value: install)
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: agentId) { await read() }
        .task(id: "\(install?.session ?? "")/\(pollAttempt)") { await follow() }
        .sensoryFeedback(.success, trigger: install?.succeeded == true)
        .sensoryFeedback(.error, trigger: install.map { $0.finished && !$0.succeeded } == true)
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
    }
    @ViewBuilder private func content(_ agent: RegistryAgentData) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text([agent.publisher, agent.version].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                Text(agent.description).foregroundStyle(AceDesign.Ink.primary)
            }
            .padding(.vertical, AceDesign.Space.tight)
            if let standing = agent.standing { InsetRow("On this machine", systemImage: nil, value: standing) }
            if let install { progress(install) }
            if let message = installProblem ?? pollProblem {
                ServiceProblem(message: message)
                Button("Retry") {
                    if installProblem != nil {
                        if failedCancellation, let install { Task { await cancel(install) } }
                        else { Task { await start(agent) } }
                    } else { pollProblem = nil; pollAttempt += 1 }
                }.buttonStyle(.textAction()).disabled(starting)
            }
        }
        if install == nil, let label = agent.actionLabel, model.canOperate {
            Section {
                Button { Task { await start(agent) } } label: {
                    Text(starting ? "Starting…" : label).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                }
                .buttonStyle(.textAction(.prominent))
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .disabled(agent.planProblem != nil || starting)
            }
        }
        if !agent.facts.isEmpty || agent.planProblem != nil {
            Section {
                ForEach(agent.facts) { fact in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(fact.label).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        Text(fact.value).font(fact.code == true ? .system(.footnote, design: .monospaced) : .body)
                            .foregroundStyle(AceDesign.Ink.primary).textSelection(.enabled)
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
                    Text(run).font(AceDesign.Typeface.codeBody).textSelection(.enabled)
                    Spacer()
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = run
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                    }
                    .buttonStyle(.borderless).contentTransition(.opacity)
                }
                .frame(minHeight: AceDesign.Size.tap)
                if let prompt = agent.setup.prompt { InsetRow("Then type", systemImage: nil, value: prompt) }
            }
            if let note = agent.setup.note { Text(note).foregroundStyle(AceDesign.Ink.muted) }
        } header: { InsetHeader("Set up") } footer: {
            Text(agent.setup.run == nil ? "\(agent.name) signs in with its own CLI, never through ace." : "\(agent.name) signs in with its own CLI, never through ace. Run this in a terminal on the computer running ace.")
        }
    }
    private func progress(_ install: InstallData) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            if !install.finished && pollProblem == nil { WorkingMark(label: "Installing") }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(pollProblem == nil ? install.title : "Install status unavailable")
                    .foregroundStyle(install.finished && !install.succeeded ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                    .contentTransition(.opacity)
                if let detail = install.detail {
                    Text(detail).font(AceDesign.Typeface.code).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                }
            }
            Spacer()
            if !install.finished, model.canOperate {
                Button("Cancel") { Task { await cancel(install) } }.buttonStyle(.borderless)
            } else if install.finished, !install.succeeded {
                Button("Try again") { self.install = nil }.buttonStyle(.borderless)
            }
        }
        .frame(minHeight: AceDesign.Size.tap)
    }
    private func read() async {
        do {
            guard let next = try await model.manage(["type": "acp.registry.agent", "acpAgentId": agentId], as: AgentAnswer.self).agent else {
                throw ServiceFailure(message: "Couldn't read this agent.")
            }
            agent = next; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func start(_ agent: RegistryAgentData) async {
        guard let action = agent.action, !starting else { return }
        starting = true
        defer { starting = false }
        installProblem = nil; pollProblem = nil; failedCancellation = false
        do {
            guard let next = try await model.manage(["type": "acp.registry.install", "acpAgentId": agent.id, "action": action], as: InstallAnswer.self).install else {
                throw ServiceFailure(message: "Couldn't read the install status.")
            }
            install = next
        } catch { installProblem = error.localizedDescription }
    }
    private func cancel(_ install: InstallData) async {
        do {
            guard let next = try await model.manage(["type": "acp.registry.cancel", "session": install.session], as: InstallAnswer.self).install else {
                throw ServiceFailure(message: "Couldn't read the install status.")
            }
            self.install = next; installProblem = nil; failedCancellation = false
        } catch { failedCancellation = true; installProblem = error.localizedDescription }
    }
    /// Polls the running install; when it finishes, the page and providers are read again.
    private func follow() async {
        while let current = install, !current.finished, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            do {
                guard let next = try await model.manage(["type": "acp.registry.progress", "session": current.session], as: InstallAnswer.self).install else {
                    throw ServiceFailure(message: "Couldn't read the install status.")
                }
                install = next; pollProblem = nil
                if next.finished { installProblem = nil; failedCancellation = false }
            } catch {
                if !Task.isCancelled { pollProblem = error.localizedDescription }
                return
            }
        }
        if install?.succeeded == true {
            model.refreshMachine()
            await read()
            install = nil
        }
    }
}
