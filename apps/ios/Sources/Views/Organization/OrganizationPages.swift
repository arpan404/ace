import SwiftUI

/// A page of Settings › Organization (ADR 0206 §2.7, amendment 4), with what a role needs to see it.
enum OrganizationPage: String, Hashable, CaseIterable {
    case members, signIn, hosts, policy, registry, audit

    var title: String {
        switch self {
        case .members: "Members"
        case .signIn: "Sign-in"
        case .hosts: "Hosts"
        case .policy: "Policy"
        case .registry: "Registry"
        case .audit: "Audit log"
        }
    }
    var icon: AceIcon.Name {
        switch self {
        case .members: .users
        case .signIn: .lock
        case .hosts: .hardDrives
        case .policy: .slidersHorizontal
        case .registry: .package
        case .audit: .scroll
        }
    }
    var needs: OrgRoles.Permission {
        switch self {
        case .members, .hosts: .membersManage
        case .signIn: .ssoManage
        case .policy: .policySet
        case .registry: .registryPublish
        case .audit: .auditRead
        }
    }
}

/// Settings' Organization row: only for the shown space's admins and owners. A member, and
/// Personal, show no row at all.
struct OrganizationSettingsRow: View {
    @Environment(SpacesModel.self) private var spaces: SpacesModel?

    var body: some View {
        if let org = spaces?.shown?.org, OrgRoles.isAdmin(org.role) {
            Section {
                GroupLink(.organization) { InsetRow(org.name, icon: .users, value: Spaces.roleWord(org.role)) }
                    .accessibilityIdentifier("settings.organization")
            } header: { InsetHeader("Organization") }
            .insetRowBackground()
        }
    }
}

/// Settings › Organization: the organization's pages its role allows, one row each.
struct OrganizationPagesView: View {
    var body: some View {
        OrganizationGate(needs: .membersManage) { admin in
            List {
                Section {
                    ForEach(OrganizationPage.allCases.filter { admin.allows($0.needs) }, id: \.self) { page in
                        GroupLink(.organizationPage(page)) { InsetRow(page.title, icon: page.icon) }
                            .accessibilityIdentifier("organization.\(page.rawValue)")
                    }
                } footer: {
                    Text("Giving a machine to \(admin.org.name) happens on that machine, by its owner.")
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                .insetRowBackground()
            }
            .insetGroupedList()
            .nativeTitle(admin.org.name)
        }
    }
}

/// One page of Settings › Organization.
struct OrganizationPageView: View {
    let page: OrganizationPage
    let inbox: MachineInbox

    var body: some View {
        OrganizationGate(needs: page.needs) { admin in
            switch page {
            case .members: OrganizationMembersPage(admin: admin)
            case .signIn: OrganizationSignInPage(admin: admin)
            case .hosts: OrganizationHostsPage(admin: admin)
            case .policy: OrganizationPolicyPage(admin: admin, inbox: inbox)
            case .registry: OrganizationRegistryPage(admin: admin, inbox: inbox)
            case .audit: OrganizationAuditPage(admin: admin, inbox: inbox)
            }
        }
        .nativeTitle(page.title)
    }
}

/// Draws `content` only in an organization's space, for a role that has `needs`; otherwise one
/// line saying why, and nothing of the organization's settings. A switch of space or a change of
/// role (read again with the spaces) takes the page away at once.
struct OrganizationGate<Content: View>: View {
    let needs: OrgRoles.Permission
    @ViewBuilder let content: (OrganizationAdmin) -> Content
    @Environment(AceAccountModel.self) private var account: AceAccountModel?
    @Environment(SpacesModel.self) private var spaces: SpacesModel?
    @State private var admin: OrganizationAdmin?

    var body: some View {
        Group {
            if let org, OrgRoles.allows(org.role, needs) {
                if let admin, admin.org == org { content(admin) } else { Color.clear }
            } else {
                List {
                    Text(org == nil ? "Switch to an organization in Profile to see its settings."
                                    : "Only your organization's admins see this page.")
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        .insetRowBackground()
                }
                .insetGroupedList()
            }
        }
        .task(id: org) { admin = make() }
    }

    private var org: AceOrgSpace? { spaces?.signedIn == true ? spaces?.shown?.org : nil }

    private func make() -> OrganizationAdmin? {
        guard let org, let origin = account?.backend, let token = account?.sessionToken else { return nil }
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(origin.host ?? "")
        return OrganizationAdmin(org: org, api: AceAccountAPI(origin: origin, allowLoopback: loopback),
                                 token: token, accountId: account?.account?.id)
    }
}

/// A refusal or a page's problem, as the pages show it: one alert with the sentence.
struct OrganizationNotice: ViewModifier {
    @Binding var notice: String?
    func body(content: Content) -> some View {
        content.alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("Close", role: .cancel) { notice = nil }
        }
    }
}
extension View {
    func organizationNotice(_ notice: Binding<String?>) -> some View { modifier(OrganizationNotice(notice: notice)) }
}
