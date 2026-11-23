import SwiftUI

/// What the bridge answers for the registry (`RegistryAnswer` in `bridge/organization-registry.ts`).
struct OrgRegistryAnswer: Decodable {
    let ok: Bool
    var message: String? = nil
    var intent: String? = nil
    var entries: [Entry]? = nil
    struct Entry: Decodable, Identifiable {
        let type: String
        let name: String
        let title: String
        let versions: [Version]
        var id: String { "\(type)/\(name)" }
    }
    struct Version: Decodable, Identifiable {
        let version: String
        /// "Live · Scan passed", in the registry's words.
        let line: String
        var detail: String? = nil
        let canWithdraw: Bool
        var id: String { version }
    }
}

/// Settings › Organization › Registry (ADR 0206 §5, amendment 5): the organization's private
/// packages, each version with its state and scan, read through one of the organization's hosts
/// with the person's own grant for that one request. Withdraw asks first, with a reason, and waits
/// for the registry's signer. Every version is signed with the organization's own key, on a
/// machine its owners choose; ace's servers never hold it. Publishing happens on desktop or the web.
struct OrganizationRegistryPage: View {
    let admin: OrganizationAdmin
    let inbox: MachineInbox
    @State private var answer: OrgRegistryAnswer?
    @State private var asking: Asking?
    @State private var reason = ""
    @State private var notice: String?
    @State private var busy = false

    struct Asking: Equatable { let entry: String; let title: String; let type: String; let name: String; let version: String }

    private var host: MachineSession? { inbox.sessions.first }
    private var name: String { admin.org.name }

    var body: some View {
        List {
            if host == nil {
                Section { quiet("Connect to one of \(Spaces.possessive(name)) hosts to read its registry.") }
                    .insetRowBackground()
            } else if let answer, !answer.ok {
                Section { quiet(answer.message ?? "Couldn't read the registry. Try again.") }.insetRowBackground()
            } else if let entries = answer?.entries {
                if entries.isEmpty {
                    Section { quiet("Nothing is published to \(Spaces.possessive(name)) registry yet.") }
                        .insetRowBackground()
                }
                ForEach(entries) { entry in
                    Section {
                        ForEach(entry.versions) { version in row(entry, version) }
                    } header: { InsetHeader(entry.title) }
                    .insetRowBackground()
                }
            } else {
                Section { quiet("Reading \(Spaces.possessive(name)) registry…") }.insetRowBackground()
            }
            Section {
                InsetRow(icon: .key, title: "Kept on one machine",
                         subtitle: "An owner chooses it, ideally a host, so it signs while people sleep. Each device asks once before it trusts the key.") { EmptyView() }
            } header: {
                InsetHeader("Signing key")
            } footer: {
                quiet("Publish a version from the Marketplace on desktop or the web.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .refreshable { await read() }
        .task(id: host?.hostId ?? "") { await read() }
        .alert(asking.map { "Withdraw \($0.title) \($0.version)?" } ?? "",
               isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil; reason = "" } })) {
            TextField("Why it's withdrawn", text: $reason)
            Button("Cancel", role: .cancel) { asking = nil; reason = "" }
            Button("Withdraw", role: .destructive) {
                let asked = asking, why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                asking = nil; reason = ""
                if let asked, !why.isEmpty { Task { await withdraw(asked, reason: why) } }
            }
            .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("It stays offered until the registry's signer signs the withdrawal. Machines that installed it keep it until then.")
        }
        .organizationNotice($notice)
    }

    private func row(_ entry: OrgRegistryAnswer.Entry, _ version: OrgRegistryAnswer.Version) -> some View {
        InsetRow(icon: nil, title: version.version,
                 subtitle: [version.line, version.detail].compactMap { $0 }.joined(separator: "\n")) {
            if version.canWithdraw {
                Button("Withdraw", role: .destructive) {
                    asking = Asking(entry: entry.id, title: entry.title, type: entry.type, name: entry.name, version: version.version)
                }
                .buttonStyle(.borderless)
                .disabled(busy)
                .accessibilityIdentifier("organization.registry.withdraw.\(entry.id)@\(version.version)")
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// Names the request, gets the person's grant for it, and sends it through the host.
    private func ask(_ request: [String: Any], intent: [String: Any]) async -> OrgRegistryAnswer {
        guard let host else { return OrgRegistryAnswer(ok: false, message: "Connect to one of \(Spaces.possessive(name)) hosts first.") }
        let failed = OrgRegistryAnswer(ok: false, message: "Couldn't reach \(inbox.name(host.hostId)). Try again.")
        guard let named = try? await host.client.service(["type": "native.organization", "request": intent], as: OrgRegistryAnswer.self),
              let action = named.intent else { return failed }
        switch await admin.marketGrant(action: action) {
        case .failure(let refused): return OrgRegistryAnswer(ok: false, message: refused.sentence)
        case .success(let grant):
            var sent = request
            sent["grant"] = grant
            return (try? await host.client.service(["type": "native.organization", "request": sent], as: OrgRegistryAnswer.self)) ?? failed
        }
    }

    private func read() async {
        guard host != nil else { answer = nil; return }
        let org = admin.org.id
        answer = await ask(["op": "registry", "org": org], intent: ["op": "registryIntent", "org": org])
    }

    private func withdraw(_ asked: Asking, reason: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let org = admin.org.id
        let withdrawal: [String: Any] = ["type": asked.type, "name": asked.name, "version": asked.version, "reason": reason]
        let request = withdrawal.merging(["op": "registryWithdraw", "org": org]) { $1 }
        let done = await ask(request, intent: ["op": "registryIntent", "org": org, "withdraw": withdrawal])
        if !done.ok { notice = done.message ?? "Couldn't withdraw it. Try again." }
        await read()
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }
}
