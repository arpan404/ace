import SwiftUI

/// Select mode's actions on the picked threads, in words along the foot of the list where the
/// tab bar was: Pin (or Unpin when every pick is pinned), Move, Settle, Archive and Delete in
/// red. Each runs on every machine the picks are on and leaves Select mode; Delete asks first.
struct InboxSelectionBar: View {
    let inbox: MachineInbox
    let selection: Set<InboxKey>
    let organize: InboxOrganize
    let finish: () -> Void

    /// Picks in list order, so a bulk pin keeps the order they were listed in.
    private var picked: [InboxKey] {
        inbox.merged.sections.flatMap(\.rows).filter(selection.contains)
    }
    private func operable(_ keys: [InboxKey]) -> [InboxKey] {
        keys.filter { inbox.client($0.machineId)?.canOperate == true }
    }

    var body: some View {
        let keys = operable(picked)
        let rows = keys.compactMap { inbox.row($0) }
        let allPinned = !rows.isEmpty && rows.allSatisfy { $0.pinned == true }
        // The shared menu says which threads can settle now (none while their tree works).
        let settles = rows.contains { $0.menu?.contains("settle") == true }
        let machines = Set(keys.map(\.machineId))
        HStack(spacing: AceTheme.Spacing.none) {
            word(allPinned ? "Unpin" : "Pin", id: "select.pin", enabled: !keys.isEmpty) {
                run(allPinned ? .unpin : .pin, keys)
            }
            // A move picks one machine's project: threads on several machines can't share one.
            word("Move", id: "select.move", enabled: machines.count == 1) {
                guard let machine = machines.first else { return }
                organize.moving = MoveAsk(machineId: machine, keys: keys)
                finish()
            }
            word("Settle", id: "select.settle", enabled: settles) { run(.settle, keys) }
            word("Archive", id: "select.archive", enabled: !keys.isEmpty) { run(.archive, keys) }
            word("Delete", id: "select.delete", enabled: !keys.isEmpty, danger: true) {
                Task { await organize.askDelete(keys, in: inbox); finish() }
            }
        }
        .padding(.horizontal, AceTheme.Spacing.sm)
        .aceGlass(in: AceShape.capsule)
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.sm)
    }

    private func run(_ action: BulkAction, _ keys: [InboxKey]) {
        finish()
        Task { await organize.run(action, keys, in: inbox) }
    }

    private func word(_ title: String, id: String, enabled: Bool, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.medium)
                // The system's destructive red, as menus and alerts draw Delete.
                .foregroundStyle(danger ? Color(uiColor: .systemRed) : AceTheme.Colours.foreground)
                .lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityIdentifier(id)
    }
}
