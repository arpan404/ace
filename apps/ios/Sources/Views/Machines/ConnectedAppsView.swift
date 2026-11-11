import SwiftUI

/// One machine's connected apps (ADR 0117): outside MCP clients such as claude.ai that signed in,
/// or were pasted in with `ace mcp enroll`. Each row says what the app may do, where, until when
/// and when it last came by; a row opens its detail to change that or revoke it. Needs
/// administrator access on that machine.
struct ConnectedAppsView: View {
    let model: ClientModel
    let machine: String
    @State private var apps: ConnectedApps?
    @State private var problem: String?

    var body: some View {
        List {
            if let apps {
                let live = apps.grants.filter(\.active)
                let ended = apps.grants.filter { !$0.active }
                Section {
                    if live.isEmpty {
                        Text("No apps are connected. An app such as claude.ai asks to sign in here, and you approve it in ace.")
                            .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                    ForEach(live) { grant in
                        NavigationLink {
                            ConnectedAppDetailView(model: model, machine: machine, grant: grant, apps: apps) { Task { await read() } }
                        } label: { ConnectedAppRow(grant: grant) }
                        .accessibilityIdentifier("outside.grant.\(grant.id)")
                    }
                } header: { InsetHeader("Connected to \(machine)") } footer: {
                    Text("Apps outside ace that can reach this machine's threads. None can answer approvals or questions; you answer those in ace.")
                }
                .insetRowBackground()
                if !ended.isEmpty {
                    Section {
                        ForEach(ended) { grant in ConnectedAppRow(grant: grant) }
                    } header: { InsetHeader("Ended") }
                    .insetRowBackground()
                }
            } else if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }
                }
                .insetRowBackground()
            } else {
                Section { SkeletonRows(count: 2, label: "Reading this machine's connected apps").listRowInsets(EdgeInsets()) }
                    .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(apps == nil)
        .smoothChange(apps?.grants.map(\.id))
        .navigationTitle("Connected apps").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { await read() }
        .refreshable { await read() }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        do { apps = try await model.connectedApps(machine: machine); problem = nil }
        catch { problem = error.localizedDescription }
    }
}

/// "Claude · claude.ai", then what it may do, where, and when it ends and was last used.
struct ConnectedAppRow: View {
    let grant: ConnectedApps.Grant
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(grant.name).font(AceDesign.Typeface.body)
                .foregroundStyle(grant.active ? AceDesign.Ink.primary : AceDesign.Ink.muted)
            Text("\(grant.domain) · \(grant.access)").font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(ConnectedAppWords.when(grant)).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
    }
}

enum ConnectedAppWords {
    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
    /// "All projects · Ends in 29 days · Used 2 hours ago", or how it ended.
    static func when(_ grant: ConnectedApps.Grant) -> String {
        var parts = [grant.projectsLine]
        switch grant.state {
        case "revoked": parts.append("Revoked \(date(grant.revokedAt ?? grant.createdAt).formatted(.relative(presentation: .named)))")
        case "expired": parts.append("Ended \(date(grant.expiresAt ?? grant.createdAt).formatted(.relative(presentation: .named)))")
        default: parts.append(expires(grant))
        }
        parts.append(used(grant))
        return parts.joined(separator: " · ")
    }
    static func expires(_ grant: ConnectedApps.Grant) -> String {
        grant.expiresAt.map { "Ends \(date($0).formatted(.relative(presentation: .named)))" } ?? "Until revoked"
    }
    static func used(_ grant: ConnectedApps.Grant) -> String {
        grant.lastUsedAt.map { "Used \(date($0).formatted(.relative(presentation: .named)))" } ?? "Not used yet"
    }
}

/// One connected app: who it is, what it did, and its access to change or revoke.
struct ConnectedAppDetailView: View {
    let model: ClientModel
    let machine: String
    let grant: ConnectedApps.Grant
    let apps: ConnectedApps
    let changed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var scopes: Set<String>
    @State private var allProjects: Bool
    @State private var chosen: Set<String>
    @State private var expiry: String?
    @State private var revoking = false
    @State private var saving = false
    @State private var problem: String?
    @State private var saved = 0

    init(model: ClientModel, machine: String, grant: ConnectedApps.Grant, apps: ConnectedApps, changed: @escaping () -> Void) {
        self.model = model; self.machine = machine; self.grant = grant; self.apps = apps; self.changed = changed
        _scopes = State(initialValue: Set(grant.scopes))
        if case .chosen(let ids) = grant.projects { _allProjects = State(initialValue: false); _chosen = State(initialValue: Set(ids)) }
        else { _allProjects = State(initialValue: true); _chosen = State(initialValue: []) }
    }

    private var edited: Bool { scopes != Set(grant.scopes) || expiry != nil || projectsChanged }
    private var projectsChanged: Bool {
        switch grant.projects {
        case .all: !allProjects
        case .chosen(let ids): allProjects || Set(ids) != chosen
        }
    }
    private var projectsWire: Any? { OutsideAccessSections.wire(all: allProjects, chosen: chosen) }

    var body: some View {
        Form {
            Section {
                LabeledContent("Domain", value: grant.domain)
                LabeledContent("Signed in", value: grant.pasted ? "Pasted token" : (grant.verified ? "Verified" : "Unverified"))
                LabeledContent("Connected", value: ConnectedAppWords.date(grant.createdAt).formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Last used", value: ConnectedAppWords.used(grant).replacingOccurrences(of: "Used ", with: ""))
                if grant.started > 0 || grant.messaged > 0 {
                    LabeledContent("Threads", value: threadsLine)
                }
            } header: { InsetHeader(grant.name) }
            .insetRowBackground()
            OutsideAccessSections(choices: grant.choices, scopes: $scopes, projects: apps.projects,
                                  allProjects: $allProjects, chosen: $chosen, expiries: apps.expiries, expiry: $expiry,
                                  expiryNote: ConnectedAppWords.expires(grant))
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
            Section {
                Button("Revoke", role: .destructive) { revoking = true }.accessibilityIdentifier("outside.revoke")
            } footer: { Text("\(grant.name) loses access to \(machine) at once and stops any work it started here.") }
            .insetRowBackground()
        }
        .insetGroupedList()
        .disabled(saving)
        .sensoryFeedback(.success, trigger: saved)
        .navigationTitle(grant.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if edited {
                ToolbarItem(placement: .confirmationAction) {
                    if saving { WorkingMark(label: "Saving") } else {
                        Button("Save") { Task { await save() } }.disabled(projectsWire == nil)
                            .accessibilityIdentifier("outside.save")
                    }
                }
            }
        }
        .confirmationDialog("Revoke \(grant.name)?", isPresented: $revoking, titleVisibility: .visible) {
            Button("Revoke", role: .destructive) { Task { await revoke() } }.accessibilityIdentifier("outside.revoke.confirm")
        } message: { Text("It has to sign in again, and you approve it again, to reach \(machine).") }
    }

    private var threadsLine: String {
        [grant.started > 0 ? "Started \(grant.started)" : nil, grant.messaged > 0 ? "messaged \(grant.messaged)" : nil]
            .compactMap { $0 }.joined(separator: ", ")
    }
    private func save() async {
        saving = true; problem = nil
        defer { saving = false }
        var request: [String: Any] = ["op": "update", "grantId": grant.id]
        if scopes != Set(grant.scopes) { request["scopes"] = grant.choices.map(\.scope).filter { scopes.contains($0) } }
        if projectsChanged, let projectsWire { request["projects"] = projectsWire }
        if let expiry { request["expiry"] = expiry }
        if let refusal = await model.outsideChange(request, machine: machine) { problem = refusal; return }
        saved += 1
        changed(); dismiss()
    }
    private func revoke() async {
        if let refusal = await model.outsideChange(["op": "revoke", "grantId": grant.id], machine: machine) { problem = refusal; return }
        changed(); dismiss()
    }
}
