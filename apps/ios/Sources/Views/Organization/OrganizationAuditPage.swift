import SwiftUI

/// What the bridge answers for an org host's log (`OrganizationAudit` in `bridge/organization.ts`).
struct OrgAuditLog: Decodable {
    let ok: Bool
    var message: String? = nil
    var key: String? = nil
    var rows: [Row]? = nil
    var people: [String]? = nil
    var kinds: [Kind]? = nil
    var checkpoints: Int? = nil
    var total: Int? = nil
    struct Row: Decodable, Identifiable {
        let seq: Int
        let title: String
        let at: Double
        let actor: String
        let targets: String
        var allowedBy: String? = nil
        var id: Int { seq }
    }
    struct Kind: Decodable, Hashable { let action: String; let title: String }
}

/// Settings › Organization › Audit log (ADR 0206 §4): each host keeps a signed, chained log of what
/// its shared bots did and who allowed it, read here from the host's own Spade. The newest
/// entries show, by person and kind; Export shares the whole log as JSON Lines for
/// `ace org audit verify`, which checks it offline. The organization's copy in WorkOS is
/// exported and streamed from the Admin Portal.
struct OrganizationAuditPage: View {
    let admin: OrganizationAdmin
    let inbox: MachineInbox
    @Environment(\.openURL) private var openURL
    @State private var picked: String?
    @State private var person: String?
    @State private var kind: String?
    @State private var log: OrgAuditLog?
    @State private var shared: SharedFile?
    @State private var notice: String?

    /// The organization's hosts this phone is connected to (the space shows only those).
    private var hosts: [MachineSession] { inbox.sessions }
    private var host: MachineSession? { hosts.first { $0.hostId == picked } ?? hosts.first }
    private var hostName: String { host.map { inbox.name($0.hostId) } ?? "Host" }

    var body: some View {
        List {
            Section {
                if host == nil {
                    quiet("Connect to one of \(Spaces.possessive(admin.org.name)) hosts to read its log.")
                } else if let log, !log.ok {
                    quiet(log.message ?? "Couldn't read \(hostName)'s log. Try again.")
                } else if let log {
                    filters(log)
                    if log.rows?.isEmpty ?? true { quiet(log.total == 0 ? "Nothing on record yet." : "No entries match.") }
                    ForEach(log.rows ?? []) { row in entry(row) }
                } else {
                    quiet("Reading \(hostName)'s log…")
                }
            } header: {
                InsetHeader(hosts.count > 1 ? "\(hostName)'s log" : "Hosts' logs")
            } footer: {
                quiet("Every outward step of a shared bot, and the member who allowed it. Never message text.")
            }
            .insetRowBackground()
            if let log, log.ok, host != nil { exportSection(log) }
            Section {
                Button("Export as CSV") { portal(.auditLogs) }.foregroundStyle(AceDesign.Ink.action)
                if admin.allows(.ssoManage) {
                    Button("Stream to your SIEM") { portal(.logStreams) }.foregroundStyle(AceDesign.Ink.action)
                }
            } header: {
                InsetHeader("Organization's copy")
            } footer: {
                quiet("Kept for a year by default. CSV exports cover up to 31 days each.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .toolbar {
            if hosts.count > 1 {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker("Host", selection: Binding(get: { host?.hostId ?? "" }, set: { picked = $0 })) {
                            ForEach(hosts) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                        }
                    } label: { Image(bar: .hardDrives) }
                    .accessibilityLabel("Host")
                }
            }
        }
        .refreshable { await read(fresh: true) }
        .task(id: "\(host?.hostId ?? "")|\(person ?? "")|\(kind ?? "")") { await read(fresh: false) }
        .sheet(item: $shared) { file in ShareSheet(url: file.url) { shared = nil } }
        .organizationNotice($notice)
    }

    @ViewBuilder private func filters(_ log: OrgAuditLog) -> some View {
        Picker("Person", selection: $person) {
            Text("Everyone").tag(String?.none)
            ForEach(log.people ?? [], id: \.self) { Text($0).tag(String?.some($0)) }
        }
        .pickerStyle(.menu)
        Picker("Kind", selection: $kind) {
            Text("Everything").tag(String?.none)
            ForEach(log.kinds ?? [], id: \.self) { Text($0.title).tag(String?.some($0.action)) }
        }
        .pickerStyle(.menu)
    }

    private func entry(_ row: OrgAuditLog.Row) -> some View {
        let detail = [row.actor, row.allowedBy.map { "allowed by \($0)" }].compactMap { $0 }.joined(separator: " · ")
        let at = Date(timeIntervalSince1970: row.at / 1000).formatted(date: .abbreviated, time: .shortened)
        return InsetRow(icon: nil, title: row.targets.isEmpty ? row.title : "\(row.title) · \(row.targets)", subtitle: detail) {
            Text(at).aceFont(AceDesign.TextRole.time).foregroundStyle(AceDesign.Ink.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func exportSection(_ log: OrgAuditLog) -> some View {
        Section {
            Button("Export the whole log") { Task { await export() } }
                .foregroundStyle(AceDesign.Ink.action)
                .accessibilityIdentifier("organization.audit.export")
        } header: {
            InsetHeader("Export")
        } footer: {
            quiet("JSON Lines with its \(log.checkpoints ?? 0) signed checkpoints. On any machine with ace, `ace org audit verify <file> --key <key>` checks it offline. Use the key \(admin.org.name) registered for the host when it enrolled, never one the file itself names.")
        }
        .insetRowBackground()
    }

    private func read(fresh: Bool) async {
        guard let host else { log = nil; return }
        var request: [String: Any] = ["op": "audit"]
        if let person { request["person"] = person }
        if let kind { request["kind"] = kind }
        if fresh { request["fresh"] = true }
        do {
            log = try await host.client.service(["type": "native.organization", "request": request], as: OrgAuditLog.self)
        } catch {
            log = OrgAuditLog(ok: false, message: "Couldn't reach \(hostName). Try again.")
        }
    }

    private func export() async {
        guard let host else { return }
        struct Answer: Decodable { let ok: Bool; var text: String? = nil; var message: String? = nil }
        let answer = try? await host.client.service(["type": "native.organization", "request": ["op": "auditExport"]],
                                                    as: Answer.self, timeout: .seconds(60))
        guard let text = answer?.text else {
            notice = answer?.message ?? "Couldn't export the log. Try again."
            return
        }
        let name = "\(admin.org.name)-\(hostName)-audit.jsonl".replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "-", options: .regularExpression)
        let url = FileManager.default.temporaryDirectory.appending(path: name)
        do {
            try Data(text.utf8).write(to: url, options: .atomic)
            shared = SharedFile(url: url)
        } catch { notice = "Couldn't save the export. Try again." }
    }

    private func portal(_ intent: AceOrgPortalIntent) {
        Task {
            switch await admin.portal(intent) {
            case .success(let url): openURL(url)
            case .failure(let refused): notice = refused.sentence
            }
        }
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }
}
