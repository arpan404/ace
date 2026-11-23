import SwiftUI

/// Settings › Organization › Members (ADR 0206 §2.7): everyone from the organization's mirror and
/// their role; a role to change, a member to remove and invitations to send or revoke, each asked
/// first. A role the identity provider sets is read-only. Remove deletes the membership only: the
/// person keeps their account, their machines and everything on them. Leave is the same for
/// oneself.
struct OrganizationMembersPage: View {
    let admin: OrganizationAdmin
    @Environment(SpacesModel.self) private var spaces: SpacesModel?
    @State private var asking: Ask?
    @State private var notice: String?
    @State private var email = ""
    @State private var inviteRole = "member"

    /// A change waiting on the person's yes.
    private enum Ask: Identifiable {
        case role(AceOrgPerson, String), remove(AceOrgPerson), leave(AceOrgPerson), revoke(AceOrgInvite)
        var id: String {
            switch self {
            case .role(let member, let role): "role.\(member.account).\(role)"
            case .remove(let member): "remove.\(member.account)"
            case .leave(let member): "leave.\(member.account)"
            case .revoke(let invite): "revoke.\(invite.id)"
            }
        }
    }

    var body: some View {
        List {
            Section {
                if let problem = admin.problem, admin.members == nil { quiet(problem) }
                else if admin.members == nil { quiet("Loading members…") }
                ForEach(admin.members ?? []) { member in row(member) }
            } header: { InsetHeader("People") }
            .insetRowBackground()
            invitations
        }
        .insetGroupedList()
        .refreshable { await admin.readMembers() }
        .task { await admin.readMembers() }
        .confirmationDialog(asking.map(title) ?? "", isPresented: isAsking, titleVisibility: .visible, presenting: asking) { ask in
            Button(confirmWord(ask), role: isLoss(ask) ? .destructive : nil) { run(ask) }
                .accessibilityIdentifier("organization.members.confirm")
        } message: { ask in Text(message(ask)) }
        .organizationNotice($notice)
    }

    private func row(_ member: AceOrgPerson) -> some View {
        let you = member.account == admin.accountId
        return InsetRow(icon: .user, title: you ? "\(name(member)) (you)" : name(member), subtitle: subtitle(member)) {
            if admin.canChange(member) {
                Menu {
                    Picker("Role", selection: Binding(get: { member.role }, set: { role in
                        if role != member.role { asking = .role(member, role) }
                    })) {
                        ForEach(OrgRoles.assignable(by: admin.org.role), id: \.self) { Text(Spaces.roleWord($0)).tag($0) }
                    }
                } label: {
                    Text(Spaces.roleWord(member.role)).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.action)
                }
                .disabled(admin.busy)
                .accessibilityLabel("\(name(member))'s role, \(Spaces.roleWord(member.role))")
            } else {
                InsetValue(text: Spaces.roleWord(member.role))
            }
        }
        .accessibilityIdentifier("organization.member.\(member.account)")
        .swipeActions(edge: .trailing) { removal(member, you: you) }
        .contextMenu { removal(member, you: you) }
    }

    @ViewBuilder private func removal(_ member: AceOrgPerson, you: Bool) -> some View {
        if you {
            Button("Leave", role: .destructive) { asking = .leave(member) }
        } else if admin.canChange(member) {
            Button("Remove", role: .destructive) { asking = .remove(member) }
        }
    }

    @ViewBuilder private var invitations: some View {
        if admin.allows(.membersManage) {
            Section {
                TextField("name@example.com", text: $email)
                    .keyboardType(.emailAddress).textContentType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Email address to invite")
                    .accessibilityIdentifier("organization.invite.email")
                Picker("Invite as", selection: $inviteRole) {
                    ForEach(OrgRoles.assignable(by: admin.org.role), id: \.self) { Text(Spaces.roleWord($0)).tag($0) }
                }
                Button("Invite") {
                    let address = email, role = inviteRole
                    Task {
                        notice = await admin.invite(email: address, role: role)
                        if notice == nil { email = "" }
                    }
                }
                .foregroundStyle(AceDesign.Ink.action)
                .disabled(email.trimmingCharacters(in: .whitespaces).isEmpty || admin.busy)
                .accessibilityIdentifier("organization.invite.send")
                ForEach(admin.invitations ?? []) { invite in
                    InsetRow(icon: .envelopeSimple, title: invite.email, subtitle: "\(Spaces.roleWord(invite.role ?? "member")) · Invited") {
                        EmptyView()
                    }
                    .swipeActions(edge: .trailing) { Button("Revoke", role: .destructive) { asking = .revoke(invite) } }
                    .contextMenu { Button("Revoke", role: .destructive) { asking = .revoke(invite) } }
                }
            } header: {
                InsetHeader("Invitations")
            } footer: {
                Text("Your sign-in provider sends the invitation. Nobody joins until they choose to.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .insetRowBackground()
        }
    }

    private func run(_ ask: Ask) {
        Task {
            switch ask {
            case .role(let member, let role): notice = await admin.changeRole(member, to: role)
            case .remove(let member): notice = await admin.remove(member)
            case .revoke(let invite): notice = await admin.revoke(invite)
            case .leave:
                // Leaving takes the space off this phone, and this page with it.
                notice = await spaces?.leave(admin.org.id)
            }
        }
    }

    private func title(_ ask: Ask) -> String {
        switch ask {
        case .role(let member, let role): "Make \(name(member)) \(article(role)) \(Spaces.roleWord(role).lowercased())?"
        case .remove(let member): "Remove \(name(member))?"
        case .leave: "Leave \(admin.org.name)?"
        case .revoke(let invite): "Revoke the invitation to \(invite.email)?"
        }
    }
    private func message(_ ask: Ask) -> String {
        let org = admin.org.name
        switch ask {
        case .role(_, let role) where role == "owner": return "An owner can do everything in \(org), including removing you."
        case .role: return "What they can do in \(org) changes at once."
        case .remove: return "They lose \(Spaces.possessive(org)) hosts and shared bots. Their own account, machines and data stay theirs, untouched."
        case .leave: return "Its hosts and shared bots stay \(Spaces.possessive(org)). Your own account, machines and everything on them stay as they are."
        case .revoke: return "Its link stops working. You can invite them again."
        }
    }
    private func confirmWord(_ ask: Ask) -> String {
        switch ask {
        case .role(_, let role): "Make \(Spaces.roleWord(role).lowercased())"
        case .remove: "Remove"
        case .leave: "Leave"
        case .revoke: "Revoke"
        }
    }
    private func isLoss(_ ask: Ask) -> Bool {
        if case .role(_, let role) = ask { return role == "member" }
        return true
    }
    private var isAsking: Binding<Bool> { Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }) }

    private func name(_ member: AceOrgPerson) -> String {
        [member.name, member.email].compactMap { $0 }.first { !$0.isEmpty } ?? member.account
    }
    private func subtitle(_ member: AceOrgPerson) -> String? {
        let parts = [
            member.name?.isEmpty == false ? member.email : nil,
            member.status == "pending" ? "Hasn't joined yet" : nil,
            member.directoryManaged ? "Set by your identity provider" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    private func article(_ role: String) -> String { role == "admin" || role == "owner" ? "an" : "a" }
    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }
}
