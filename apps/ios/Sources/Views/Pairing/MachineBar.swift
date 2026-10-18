import SwiftUI

/// The connected computer, why it isn't ready, and switching between paired computers.
struct MachineBar: View {
    @Bindable var machines: MachinesModel
    @Binding var adding: Bool
    @State private var removing: MachineEntry?

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Menu {
                    Picker("Machine", selection: Binding(get: { machines.activeHostId ?? "" }, set: { id in
                        Task { await machines.select(id) }
                    })) {
                        ForEach(machines.machines) { entry in Text(entry.displayName).tag(entry.hostId) }
                    }
                    Divider()
                    Button("Pair another computer", systemImage: "plus") { adding = true }
                    if let active = machines.active {
                        Button("Remove \(active.displayName)", systemImage: "trash", role: .destructive) { removing = active }
                    }
                } label: {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        Circle().fill(machines.client.connection == "ready" ? AceTheme.Status.done : AceTheme.Colours.decoration)
                            .frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
                        Text(machines.active?.displayName ?? "Choose a computer").aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        Image(systemName: "chevron.down").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }.foregroundStyle(AceTheme.Colours.foreground)
                }
                .accessibilityIdentifier("machine.picker")
                Spacer(minLength: AceTheme.Spacing.none)
                if machines.activeIsReadOnly {
                    Text("View only").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("machine.readOnly")
                }
            }
            if let notice = machines.problem ?? machines.client.problem {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                    Text(notice.message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("machine.problem")
                    Spacer(minLength: AceTheme.Spacing.none)
                    if ["pin", "revoked", "identity"].contains(notice.code) {
                        Button("Pair again") { adding = true }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    } else if notice.code == "unreachable" {
                        Button("Retry") { machines.client.retry() }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    }
                }
            }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
        .confirmationDialog("Remove this computer?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            presenting: removing) { entry in
            Button("Remove \(entry.displayName)", role: .destructive) { Task { await machines.remove(entry.hostId) } }
        } message: { _ in
            Text("This phone forgets its access and unsent work for that computer. Revoke the device on the computer too.")
        }
    }
}
