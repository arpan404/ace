import SwiftUI

/// Settings › Organization › Registry (ADR 0206 §5): the organization's private packages, on the
/// Marketplace under its own publisher and seen only by its members. Every version is scanned like
/// any package and signed with the organization's own key, on a machine its owners choose; ace's
/// servers never hold it. Publishing and withdrawing happen on desktop or the web.
struct OrganizationRegistryPage: View {
    let admin: OrganizationAdmin

    var body: some View {
        let name = admin.org.name
        List {
            Section {
                InsetRow(icon: .package, title: "\(Spaces.possessive(name)) packages",
                         subtitle: "Bots, skills and plugins only \(Spaces.possessive(name)) members can find and install.") { EmptyView() }
                InsetRow(icon: .shieldCheck, title: "Scanned like every package",
                         subtitle: "A version is offered once the organization's key signs it.") { EmptyView() }
            } header: {
                InsetHeader("Private registry")
            } footer: {
                Text("Publish a version, or withdraw one, from the Marketplace on desktop or the web.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .insetRowBackground()
            Section {
                InsetRow(icon: .key, title: "Kept on one machine",
                         subtitle: "An owner chooses it, ideally a host, so it signs while people sleep. Each device asks once before it trusts the key.") { EmptyView() }
            } header: { InsetHeader("Signing key") }
            .insetRowBackground()
        }
        .insetGroupedList()
    }
}
