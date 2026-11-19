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
    @State private var revocation: FleetOverview.Link?
    @State private var busy = false
    @State private var changes = 0

    private var client: ClientModel? { inbox.client(hostId) }
    private var name: String { inbox.name(hostId) }

    var body: some View {
        List {
            if let problem {
                ProblemRow(problem, id: "links.problem") { client?.retry(); Task { await read() } }
            }
            if let overview {
                if overview.forbidden {
                    ProblemRow(overview.linksProblem ?? "Only a phone paired with full access can manage links.", id: "links.problem")
                } else {
                    linked(overview)
                    others(overview)
                }
            }
            if problem == nil, overview == nil {
                Section { SkeletonRows(count: 2, label: "Reading this machine's links").listRowInsets(EdgeInsets()) }
                    .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(overview == nil)
        .smoothChange(overview?.links.map(\.profile))
        .sensoryFeedback(.success, trigger: changes)
        .disabled(busy)
        .navigationTitle("Linked machines").navigationBarTitleDisplayMode(.inline)
        .task(id: client?.connection) { await read() }
        .refreshable { await read() }
        .confirmationDialog("Link \(name) to \(linking.map { inbox.name($0.hostId) } ?? "")", isPresented: Binding(get: { linking != nil }, set: { if !$0 { linking = nil } }), titleVisibility: .visible, presenting: linking) { target in
            Button("Agents can read and act") { Task { await link(to: target, access: "operate") } }
                .accessibilityIdentifier("links.link.operate")
            Button("Agents can only read") { Task { await link(to: target, access: "read") } }
        } message: { target in
            Text("\(inbox.name(target.hostId))’s “Agents from other machines” setting limits what \(name)’s agents can do.")
        }
        .confirmationDialog("Unlink \(unlinking?.name ?? "")?", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }), titleVisibility: .visible, presenting: unlinking) { link in
            Button("Unlink", role: .destructive) { Task { await unlink(link) } }.accessibilityIdentifier("links.unlink.confirm")
        } message: { link in Text("Agents on \(name) can't reach \(link.name) any more. Linking again needs a new pairing.") }
        .alert("Couldn't do that", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            if let revocation { Button("Try again") { Task { await revokeOther(revocation) } } }
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
    }

    @ViewBuilder private func linked(_ overview: FleetOverview) -> some View {
        Section {
            if overview.links.isEmpty, overview.linksProblem == nil {
                Text("\(name) doesn't link to another machine yet.").foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(overview.links) { link in
                RowWithActions(title: link.name, detail: link.line, actionsLabel: "Actions for \(link.name)",
                               actionsId: "links.actions.\(link.profile)", canOperate: client?.canOperate == true && link.hostId != nil) {
                    Button("Unlink…", systemImage: "link", role: .destructive) { unlinking = link }
                        .accessibilityIdentifier("links.unlink.\(link.profile)")
                }
            }
            if let problem = overview.linksProblem {
                ServiceProblem(message: problem)
                Button("Try again") { Task { await read() } }.buttonStyle(.rowAction)
            }
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
                        Text(inbox.name(session.hostId)).font(AceDesign.Typeface.body)
                        Spacer()
                        Button("Link") { linking = session }.buttonStyle(.secondaryAction).controlSize(.small)
                            .disabled(session.client.connection != "ready")
                            .accessibilityIdentifier("links.link.\(session.hostId)")
                    }
                }
            } header: { InsetHeader("Link to another machine") } footer: { Text("Both machines need to be online, and the other one needs remote access on.") }
            .insetRowBackground()
        }
    }

    private func read() async {
        guard let client, client.connection == "ready" else { problem = "Can’t reach \(name)."; return }
        do { overview = try await client.fleetOverview(machine: name); problem = nil }
        catch { problem = error.localizedDescription }
    }

    /// The other machine issues a one-time link; this one redeems it and keeps it.
    private func link(to target: MachineSession, access: String) async {
        revocation = nil
        guard let client else { return }
        busy = true
        defer { busy = false }
        let targetName = inbox.name(target.hostId)
        let issued = await target.client.fleet(["op": "issueLink", "access": access], machine: targetName)
        guard issued.ok, let url = issued.url else { notice = issued.message; return }
        let redeemed = await client.fleet(["op": "redeemLink", "pairingUrl": url, "hostId": target.hostId, "name": targetName], machine: name)
        if redeemed.ok { changes += 1 } else { notice = redeemed.message }
        await read()
    }

    private func revokeOther(_ link: FleetOverview.Link) async {
        guard let target = link.hostId else { return }
        guard let other = inbox.client(target), other.connection == "ready" else {
            revocation = link
            notice = "The link was removed. Reconnect the other machine to revoke its access, then retry."
            return
        }
        let answer = await other.fleet(["op": "revoke", "deviceId": link.deviceId], machine: inbox.name(target))
        if answer.ok { revocation = nil; notice = nil }
        else { revocation = link; notice = answer.message ?? "Couldn’t revoke access on the other machine." }
    }

    /// This machine forgets the link; the other revokes the device it used, when this phone can reach it.
    private func unlink(_ link: FleetOverview.Link) async {
        revocation = nil
        guard let client, let target = link.hostId else { return }
        busy = true
        defer { busy = false }
        let answer = await client.fleet(["op": "unlink", "hostId": target], machine: name)
        if !answer.ok { notice = answer.message; return }
        await revokeOther(link)
        changes += 1
        await read()
    }
}
