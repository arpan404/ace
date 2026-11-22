import SwiftUI

/// Settings › Account's spaces (ADR 0206 §1.4): Personal and each organization the person
/// belongs to with their role, the one shown ticked; a tap switches. New organization makes one
/// the person owns. Leave is an organization row's swipe and long-press action, and deletes
/// nothing on the phone. An organization's own pages are on desktop and the web, so an admin
/// gets one row saying so.
struct SpacesSection: View {
    let spaces: SpacesModel
    @State private var creating = false
    @State private var name = ""
    @State private var leaving: AceOrgSpace?
    @State private var notice: String?

    var body: some View {
        Section {
            row(id: Spaces.personal, icon: .user, title: "Personal", subtitle: "Your own machines")
            ForEach(spaces.spaces ?? []) { org in
                row(id: org.id, icon: .users, title: org.name, subtitle: Spaces.roleWord(org.role))
                    .swipeActions(edge: .trailing) { leave(org) }
                    .contextMenu { leave(org) }
            }
            if spaces.spaces == nil && !spaces.failed {
                Text("Loading your organizations…")
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            if let manage = Spaces.manageLine(spaces.shown) {
                Text(manage)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("account.spaces.manage")
            }
            Button { name = ""; creating = true } label: { AddRow("New organization") }
                .disabled(spaces.busy)
                .accessibilityIdentifier("account.spaces.create")
        } header: {
            InsetHeader("Spaces")
        }
        .insetRowBackground()
        .alert("New organization", isPresented: $creating) {
            TextField("Name", text: $name)
                .textInputAutocapitalization(.words)
                .accessibilityIdentifier("account.spaces.create.name")
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let chosen = name
                Task { notice = await spaces.create(name: chosen) }
            }
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("account.spaces.create.confirm")
        } message: {
            Text("You'll be its owner. Invite people and add machines on desktop or the web.")
        }
        .confirmationDialog(leaving.map { "Leave \($0.name)?" } ?? "", isPresented: leaveQuestion, titleVisibility: .visible) {
            if let org = leaving {
                Button("Leave", role: .destructive) { Task { notice = await spaces.leave(org.id) } }
                    .accessibilityIdentifier("account.spaces.leave.confirm")
            }
        } message: {
            Text("Its space goes from this phone. Your threads and drafts stay on this device.")
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        }
    }

    private func row(id: String, icon: AceIcon.Name, title: String, subtitle: String) -> some View {
        Button { spaces.choose(id) } label: {
            InsetRow(icon: icon, title: title, subtitle: subtitle) {
                if spaces.shown?.id == id {
                    AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                        .foregroundStyle(AceDesign.Ink.action)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(spaces.shown?.id == id ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("account.space.\(id)")
    }

    private func leave(_ org: AceOrgSpace) -> some View {
        Button("Leave") { leaving = org }
            .tint(AceDesign.Ink.destructive)
    }

    private var leaveQuestion: Binding<Bool> {
        Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } })
    }
}
