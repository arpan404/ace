import SwiftUI

/// `machine.rename` (`bridge/machine-rename.ts`): the name the machine now reports, or why not.
struct MachineRenameReply: Decodable {
    let ok: Bool
    let name: String?
    let message: String?
}

/// A machine page's Rename and its one remove action, each saying what it changes and where.
/// Rename saves the name on the machine, as web does, so every device shows it. An account
/// machine is removed from the ace account on every device; a paired one only from this phone.
struct MachineManageSection: View {
    let inbox: MachineInbox
    /// Nil for the debug fixture: Rename still saves on the machine; nothing can be removed.
    let machines: MachinesModel?
    let hostId: String
    let name: String
    /// Leaves the page once the machine is gone.
    let removed: () -> Void
    @State private var renaming = false
    @State private var newName = ""
    @State private var saving = false
    @State private var removing = false
    @State private var notice: ProblemNotice?
    @State private var removalFailed = false

    private var client: ClientModel? { inbox.client(hostId) }
    private var account: Bool { machines?.entry(hostId)?.isAccountMachine == true }
    /// Saving a machine's name is an administrator setting there.
    private var canRename: Bool { client?.connection == "ready" && client?.canAdmin != false }

    var body: some View {
        Section {
            Button(saving ? "Renaming…" : "Rename") { newName = name; renaming = true }
                .disabled(!canRename || saving)
                .foregroundStyle(AceDesign.Ink.primary)
                .accessibilityIdentifier("machine.rename")
        } footer: {
            Text(renameFooter)
        }
        .insetRowBackground()
        .alert("Rename \(name)", isPresented: $renaming) {
            TextField("Name", text: $newName).accessibilityIdentifier("machine.rename.field")
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await rename() } }.accessibilityIdentifier("machine.rename.save")
        } message: { Text("Every device shows this name.") }
        .confirmationDialog(confirmTitle, isPresented: $removing, titleVisibility: .visible) {
            Button(removeTitle, role: .destructive) { Task { await remove() } }
                .accessibilityIdentifier("machine.remove.confirm")
        } message: { Text(removeFooter) }
        .alert("Couldn't update \(name)", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            if removalFailed { Button("Retry") { notice = nil; removing = true } }
            Button("OK") { notice = nil }
        } message: { Text(notice?.message ?? "") }

        if machines != nil {
            Section {
                Button(removeTitle, role: .destructive) { removing = true }
                    .accessibilityIdentifier("machine.remove")
            } footer: {
                Text(removeFooter)
            }
            .insetRowBackground()
        }
    }

    private var renameFooter: String {
        if client?.canAdmin == false { return "Only a phone paired with full access can rename \(name)." }
        if client?.connection != "ready" { return "Rename \(name) once this phone reaches it." }
        return "The name is saved on \(name), so every device shows it."
    }
    private var removeTitle: String { account ? "Remove from your ace account" : "Remove from this iPhone" }
    private var confirmTitle: String { account ? "Remove \(name) from your ace account?" : "Remove \(name) from this iPhone?" }
    private var removeFooter: String {
        account
            ? "\(name) leaves your ace account on every device, and this iPhone deletes its unsent work for it. It comes back when it signs in to ace again."
            : "Only this iPhone forgets \(name): its access and unsent work for it are deleted here. \(name) and your other devices keep everything. To cut this iPhone's access on the computer too, revoke it under Devices."
    }

    private func rename() async {
        guard let client else { return }
        saving = true
        defer { saving = false }
        do {
            let reply = try await client.service(["type": "machine.rename", "name": String(newName.prefix(256))], as: MachineRenameReply.self)
            guard reply.ok, let saved = reply.name else {
                removalFailed = false
                notice = ProblemNotice(code: "rename", message: reply.message ?? "Couldn't rename \(name).")
                return
            }
            // This phone's own label follows the machine's name; an account machine's comes from
            // the account's list, which shows the new name once the machine reports it.
            if let machines, !account {
                if let problem = await machines.rename(hostId, to: saved) { removalFailed = false; notice = problem }
            } else {
                inbox.rename(hostId, to: saved)
            }
        } catch {
            removalFailed = false
            notice = ProblemNotice(code: "rename", message: error.localizedDescription)
        }
    }

    private func remove() async {
        guard let machines else { return }
        await machines.remove(hostId)
        if machines.entry(hostId) == nil { removed() }
        else { removalFailed = true; notice = machines.problem ?? .unknown }
    }
}
