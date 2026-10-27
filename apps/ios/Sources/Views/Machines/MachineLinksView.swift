import SwiftUI

/// The machines this one links to, so its agents can reach them (ADR 0078), as the web's Fleet
/// › Machines: link it to another machine this phone is paired with, or unlink one. Linking asks
/// the other machine for a one-time link and has this one redeem it.
struct MachineLinksView: View {
    let inbox: MachineInbox
    let hostId: String
    @State private var overview: FleetOverview?
    @State private var problem: String?
    @State private var linking: MachineSession?
    @State private var unlinking: FleetOverview.Link?
    @State private var notice: String?
    @State private var busy = false

    private var client: ClientModel? { inbox.client(hostId) }
    private var name: String { inbox.name(hostId) }

    var body: some View {
        List {
            if let overview {
                if overview.forbidden {
                    Section { ServiceProblem(message: overview.linksProblem) }.insetRowBackground()
                } else {
                    linked(overview)
                    others(overview)
                }
            } else if let problem {
                Section { ServiceProblem(message: problem); Button("Retry") { Task { await read() } } }.insetRowBackground()
            } else {
                Section { HStack { ProgressView().controlSize(.small); Text("Reading this machine's links…").foregroundStyle(AceTheme.Colours.mutedForeground) } }
                    .insetRowBackground()
            }
        }
        .insetGroupedList()
        .disabled(busy)
        .navigationTitle("Linked machines").navigationBarTitleDisplayMode(.inline)
        .task(id: client?.connection) { await read() }
        .refreshable { await read() }
        .confirmationDialog("Link \(name) to \(linking.map { inbox.name($0.hostId) } ?? "")", isPresented: Binding(get: { linking != nil }, set: { if !$0 { linking = nil } }), titleVisibility: .visible, presenting: linking) { target in
            Button("Agents can read and act") { Task { await link(to: target, access: "operate") } }
                .accessibilityIdentifier("links.link.operate")
            Button("Agents can only read") { Task { await link(to: target, access: "read") } }
        } message: { target in
            Text("Agents on \(name) can then reach \(inbox.name(target.hostId)), up to that machine's own setting for agents from other machines.")
        }
        .confirmationDialog("Unlink \(unlinking?.name ?? "")?", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }), titleVisibility: .visible, presenting: unlinking) { link in
            Button("Unlink", role: .destructive) { Task { await unlink(link) } }.accessibilityIdentifier("links.unlink.confirm")
        } message: { link in Text("Agents on \(name) can't reach \(link.name) any more. Linking again needs a new pairing.") }
        .alert("Couldn't do that", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
    }

    @ViewBuilder private func linked(_ overview: FleetOverview) -> some View {
        Section {
            if overview.links.isEmpty, overview.linksProblem == nil {
                Text("\(name) doesn't link to another machine yet.").foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            ForEach(overview.links) { link in
                HStack(spacing: AceTheme.Spacing.sm) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(link.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                        Text(link.line).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if client?.canOperate == true, link.hostId != nil {
                        Button("Unlink", role: .destructive) { unlinking = link }
                            .buttonStyle(.borderless).foregroundStyle(AceTheme.Status.failed)
                            .accessibilityIdentifier("links.unlink.\(link.profile)")
                    }
                }
            }
            if let problem = overview.linksProblem { ServiceProblem(message: problem) }
        } header: { InsetHeader("\(name) reaches") } footer: { Text("Agents here use these machines by name.") }
        .insetRowBackground()
    }

    @ViewBuilder private func others(_ overview: FleetOverview) -> some View {
        let linked = Set(overview.links.compactMap(\.hostId))
        let candidates = inbox.sessions.filter { $0.hostId != hostId && !linked.contains($0.hostId) }
        if !candidates.isEmpty, client?.canOperate == true {
            Section {
                ForEach(candidates) { session in
                    HStack {
                        Text(inbox.name(session.hostId)).aceFont(InsetStyle.label, relativeTo: .body)
                        Spacer()
                        Button("Link") { linking = session }.buttonStyle(.borderless)
                            .disabled(session.client.connection != "ready")
                            .accessibilityIdentifier("links.link.\(session.hostId)")
                    }
                }
            } header: { InsetHeader("Link to another machine") } footer: { Text("Both machines need to be online, and the other one needs remote access on.") }
            .insetRowBackground()
        }
    }

    private func read() async {
        guard let client, client.connection == "ready" else { return }
        do { overview = try await client.fleetOverview(machine: name); problem = nil }
        catch { problem = error.localizedDescription }
    }

    /// The other machine issues a one-time link; this one redeems it and keeps it.
    private func link(to target: MachineSession, access: String) async {
        guard let client else { return }
        busy = true
        defer { busy = false }
        let targetName = inbox.name(target.hostId)
        let issued = await target.client.fleet(["op": "issueLink", "access": access], machine: targetName)
        guard issued.ok, let url = issued.url else { notice = issued.message; return }
        let redeemed = await client.fleet(["op": "redeemLink", "pairingUrl": url, "hostId": target.hostId, "name": targetName], machine: name)
        if !redeemed.ok { notice = redeemed.message }
        await read()
    }

    /// This machine forgets the link; the other revokes the device it used, when this phone can reach it.
    private func unlink(_ link: FleetOverview.Link) async {
        guard let client, let target = link.hostId else { return }
        busy = true
        defer { busy = false }
        let answer = await client.fleet(["op": "unlink", "hostId": target], machine: name)
        if !answer.ok { notice = answer.message; return }
        if let other = inbox.client(target), other.connection == "ready" {
            _ = await other.fleet(["op": "revoke", "deviceId": link.deviceId], machine: inbox.name(target))
        }
        await read()
    }
}
