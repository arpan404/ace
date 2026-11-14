import SwiftUI

/// Settings › Source control as the bridge words it (`bridge/source-control-screen.ts`).
struct SourceControlScreen: Decodable, Equatable {
    struct Host: Decodable, Equatable, Identifiable {
        let host: String
        /// A provider id; one this build doesn't know arrives as-is.
        let forge: String
        let name: String
        let account: String?
        let active: Bool
        /// "full", "browse" (read-only in Code review) or "pending" (Git only: no pull request API yet).
        let support: String
        var id: String { host }
    }
    struct Line: Decodable, Equatable { let title: String; let value: String }
    struct Account: Decodable, Equatable, Identifiable { let login: String; let active: Bool; var id: String { login } }
    struct Status: Decodable, Equatable {
        let forge: String
        let name: String
        let cli: Line
        let api: Line
        let accounts: [Account]
        let note: String?
        let instructions: String?
        /// The host's own site, where ace can't act on its pull requests and issues.
        let site: String?
    }
    struct Transport: Decodable, Equatable { let value: String; let instructions: String }
    struct Provider: Decodable, Equatable, Identifiable {
        let forge: String
        let name: String
        let host: String
        let fixedHost: Bool
        let hostHint: String
        let support: String
        var id: String { forge }
    }
    let host: String
    let remote: String
    let hosts: [Host]
    let status: Status
    let transport: Transport
    let providers: [Provider]
}
private struct SourceControlAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let screen: SourceControlScreen?
}

/// A saved Git host opened for editing; `original` is nil for a new one.
private struct HostDraft: Identifiable {
    let original: String?
    let forge: String
    let host: String
    let account: String
    var id: String { original ?? "" }
}

struct SourceControlView: View {
    let model: ClientModel
    @State private var screen: SourceControlScreen?
    @State private var remote = "origin"
    @State private var projects: [NativeProject] = []
    @State private var project = ""
    @State private var problem: String?
    @State private var busy = false
    @State private var editing: HostDraft?
    private static let projectsRead: [String: Any] = ["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]]
    private static func screenRead(_ project: String, fresh: Bool = false) -> [String: Any] {
        var read: [String: Any] = ["type": "source-control.screen"]
        if !project.isEmpty { read["workspaceId"] = project }
        if fresh { read["fresh"] = true }
        return read
    }

    /// Opens on the last check this phone saw, checked again behind it.
    init(model: ClientModel) {
        self.model = model
        _projects = State(initialValue: model.kept(Self.projectsRead, as: ProjectListReply.self)?.result.projects ?? [])
        if let screen = model.kept(Self.screenRead(""), as: SourceControlAnswer.self)?.screen {
            _screen = State(initialValue: screen)
            _remote = State(initialValue: screen.remote)
        }
    }
    var body: some View {
        Form {
            Group {
                if let screen {
                    hosts(screen)
                    status(screen.status)
                    remoteSection(screen)
                } else if busy {
                    SkeletonRows(count: 2, label: "Checking source control").listRowInsets(EdgeInsets())
                }
                Section {
                    Picker("Project", selection: $project) {
                        Text("Choose project").tag("")
                        ForEach(projects) { Text($0.name).tag($0.id) }
                    }
                    if let transport = screen?.transport {
                        LabeledContent("Transport", value: transport.value)
                        Text(transport.instructions).textSelection(.enabled)
                    }
                } header: { InsetHeader("Repository transport") } footer: {
                    Text("Reads from the remote; nothing is pushed.")
                }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.default, value: screen)
        .nativeTitle("Source control")
        .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(Self.screenRead(project))]) {
            guard model.connection == "ready" else { return }
            do {
                let reply = try await model.read(Self.projectsRead, as: ProjectListReply.self)
                projects = reply.result.projects ?? []
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
            await read()
        }
        .task(id: project) { if model.connection == "ready" { await read() } }
        .sheet(item: $editing) { draft in
            NavigationStack {
                GitHostEditor(model: model, providers: screen?.providers ?? [], draft: draft) { Task { await read() } }
            }
        }
    }

    /// Every saved host under its provider. Editing a host and choosing the one requests use
    /// are separate actions.
    private func hosts(_ screen: SourceControlScreen) -> some View {
        Section {
            ForEach(screen.hosts) { entry in
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    HStack(spacing: AceDesign.Space.row) {
                        GitHostMark(forge: entry.forge)
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            Text(entry.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                            Text([entry.host, entry.account].compactMap { $0 }.joined(separator: " · "))
                                .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                        }
                        Spacer(minLength: AceDesign.Space.related)
                        Text(entry.active ? "In use" : supportWord(entry.support) ?? "")
                            .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                    .accessibilityElement(children: .combine)
                    if model.canOperate {
                        HStack(spacing: AceDesign.Space.margin) {
                            Button("Edit") {
                                editing = HostDraft(original: entry.host, forge: entry.forge, host: entry.host, account: entry.account ?? "")
                            }
                            .accessibilityLabel("Edit \(entry.host)")
                            if !entry.active {
                                Button("Use for requests") { Task { await write(["kind": "use", "host": entry.host]) } }
                                    .accessibilityLabel("Use \(entry.host) for requests")
                            }
                        }
                        .buttonStyle(.borderless)
                        .font(AceDesign.Typeface.body)
                        .disabled(busy)
                    }
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            if model.canOperate {
                Button("Add host") { editing = HostDraft(original: nil, forge: "github", host: "github.com", account: "") }
                    .frame(minHeight: AceDesign.Size.tap)
                    .disabled(busy)
            }
        } header: { InsetHeader("Git hosts") }
    }

    private func supportWord(_ support: String) -> String? {
        switch support {
        case "browse": "Browse only"
        case "pending": "Git only"
        default: nil
        }
    }

    /// The host requests use: its provider's CLI and API, in the bridge's words.
    private func status(_ status: SourceControlScreen.Status) -> some View {
        Section {
            LabeledContent(status.cli.title, value: status.cli.value)
            LabeledContent(status.api.title, value: status.api.value)
            ForEach(status.accounts) { account in LabeledContent(account.login, value: account.active ? "Active" : "") }
            if let note = status.note { Text(note).foregroundStyle(AceDesign.Ink.muted) }
            if let instructions = status.instructions { Text(instructions).textSelection(.enabled) }
            if let site = status.site, let url = URL(string: site) {
                Link("Open \(url.host() ?? site)", destination: url)
                    .accessibilityIdentifier("sourceControl.site")
            }
            Button("Rescan") { Task { await read(fresh: true) } }.disabled(busy)
        } header: { InsetHeader(status.name) }
    }

    private func remoteSection(_ screen: SourceControlScreen) -> some View {
        Section {
            LabeledContent("Git remote") {
                TextField("origin", text: $remote).multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if remote != screen.remote {
                Button("Save remote") { Task { await write(["kind": "remote", "remote": remote]) } }
                    .disabled(busy || remote.isEmpty)
            }
        } header: { InsetHeader("Repository remote") } footer: {
            Text("The Git remote that names a project's repository.")
        }
        .disabled(!model.canOperate)
    }

    private func read(fresh: Bool = false) async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            let answer = try await model.read(Self.screenRead(project, fresh: fresh), as: SourceControlAnswer.self)
            guard answer.ok, let screen = answer.screen else {
                throw ServiceFailure(message: answer.problem ?? "Couldn't check source control.")
            }
            self.screen = screen; remote = screen.remote
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func write(_ change: [String: Any]) async {
        busy = true; problem = nil
        do {
            _ = try await model.manage(["type": "source-control.write", "change": change], as: PlainAnswer.self)
            busy = false
            await read()
        } catch { problem = error.localizedDescription; busy = false }
    }
}

/// Add a Git host, or change a saved one's provider, name or expected account. Which host
/// requests use is chosen on the list, never here.
private struct GitHostEditor: View {
    let model: ClientModel
    let providers: [SourceControlScreen.Provider]
    let draft: HostDraft
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var forge: String
    @State private var host: String
    @State private var account: String
    @State private var problem: String?
    @State private var busy = false

    init(model: ClientModel, providers: [SourceControlScreen.Provider], draft: HostDraft, saved: @escaping () -> Void) {
        self.model = model
        self.providers = providers
        self.draft = draft
        self.saved = saved
        _forge = State(initialValue: draft.forge)
        _host = State(initialValue: draft.host)
        _account = State(initialValue: draft.account)
    }
    private var provider: SourceControlScreen.Provider? { providers.first { $0.forge == forge } }
    private var name: String { provider?.name ?? forge }

    var body: some View {
        Form {
            Group {
                Section {
                    Picker("Provider", selection: $forge) {
                        ForEach(providers) { Text($0.name).tag($0.forge) }
                        // A provider this build doesn't know stays selectable as saved.
                        if provider == nil { Text(forge).tag(forge) }
                    }
                } footer: {
                    if provider?.support == "pending" {
                        Text("Commits, branches, pushes and worktrees work through Git. \(name) pull requests and issues aren't in ace yet, so they open on the host.")
                    } else if provider?.support == "browse" {
                        Text("Browse only: pull requests open in Code review, and reviews and merges open on the host.")
                    }
                }
                Section {
                    TextField(provider?.host.isEmpty == false ? provider?.host ?? "" : "git.example.com", text: $host)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .disabled(provider?.fixedHost == true)
                } header: { InsetHeader("\(name) host") } footer: { Text(provider?.hostHint ?? "") }
                Section {
                    TextField("Any account", text: $account)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(forge == "origin" ? .emailAddress : .asciiCapable)
                } header: { InsetHeader("Expected account") } footer: {
                    Text("Requests stop if the CLI is signed in as someone else.")
                }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle(draft.original == nil ? "Add host" : "Edit host").navigationBarTitleDisplayMode(.inline)
        .onChange(of: forge) { _, next in
            // A new provider starts from its public host, as the web's picker does.
            host = providers.first { $0.forge == next }?.host ?? ""
            account = ""
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            ToolbarItem(placement: .confirmationAction) {
                Button(busy ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(busy || host.isEmpty || !model.canOperate)
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func save() async {
        busy = true; problem = nil
        defer { busy = false }
        var change: [String: Any] = ["kind": "host", "forge": forge, "host": host, "account": account]
        if let original = draft.original { change["original"] = original }
        do {
            _ = try await model.manage(["type": "source-control.write", "change": change], as: PlainAnswer.self)
            saved(); dismiss()
        } catch { problem = error.localizedDescription }
    }
}
