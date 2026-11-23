import SwiftUI

/// Settings › Organization › Hosts (ADR 0206 §2.1, §2.7): the organization's machines and when
/// each was last seen; an owner releases one, after a yes. Nothing on the machine is deleted.
/// Giving a machine to the organization isn't here: it needs the machine's owner at the machine.
struct OrganizationHostsPage: View {
    let admin: OrganizationAdmin
    @State private var releasing: AceMachine?
    @State private var notice: String?

    var body: some View {
        List {
            Section {
                if let hosts = admin.hosts {
                    if hosts.isEmpty { quiet("No hosts yet. A host is the machine your shared bots run on.") }
                    ForEach(hosts) { host in
                        InsetRow(AceAccountView.name(host), icon: AceAccountView.icon(host.platform), subtitle: seen(host))
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("organization.host.\(host.hostId)")
                            .swipeActions(edge: .trailing) { release(host) }
                            .contextMenu { release(host) }
                    }
                } else {
                    quiet(admin.problem ?? "Loading hosts…")
                }
            } header: {
                InsetHeader("Machines")
            } footer: {
                Text("To give a machine to \(admin.org.name), its owner opens Settings › Organization › Hosts on that machine.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .refreshable { await admin.readHosts() }
        .task { await admin.readHosts() }
        .confirmationDialog(releasing.map { "Release \(AceAccountView.name($0))?" } ?? "", isPresented: isReleasing,
                            titleVisibility: .visible, presenting: releasing) { host in
            Button("Release", role: .destructive) { Task { notice = await admin.release(host) } }
                .accessibilityIdentifier("organization.host.release.confirm")
        } message: { _ in
            Text("It stops answering to \(admin.org.name) and signs in again before it speaks for anyone. Its bots and history stay on it.")
        }
        .organizationNotice($notice)
    }

    @ViewBuilder private func release(_ host: AceMachine) -> some View {
        if admin.allows(.owners) { Button("Release", role: .destructive) { releasing = host } }
    }

    private func seen(_ host: AceMachine) -> String? {
        guard host.lastSeenAt > 0 else { return nil }
        let at = Date(timeIntervalSince1970: host.lastSeenAt / 1000)
        return "Seen " + at.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
    private var isReleasing: Binding<Bool> { Binding(get: { releasing != nil }, set: { if !$0 { releasing = nil } }) }
    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }
}
