import SwiftUI

/// The other paired machines, as a view on one machine reaches them: their runtimes (to choose a
/// folder there) and a way to open one of their threads in the inbox.
struct OtherMachines {
    var client: @MainActor (String) -> ClientModel? = { _ in nil }
    /// Opens that machine's thread on the Threads tab; false when this phone can't show it.
    /// Nil where nothing can be opened from (inside Settings).
    var open: (@MainActor (InboxKey) -> Bool)? = nil
}

extension EnvironmentValues {
    @Entry var otherMachines = OtherMachines()
}

/// A transfer in one sentence with its text buttons at the right: "Sending to Studio · 312 MB of
/// 1.2 GB  Cancel", "Continued on Studio  Open". No glyph, no tint (ADR 0101). Open shows only
/// while this phone is connected to the machine the work is on.
struct TransferLineView: View {
    let model: ClientModel
    let line: TransferLineRow
    /// After Open has gone to the work (the sheet closes).
    var opened: () -> Void = {}
    @Environment(\.otherMachines) private var others

    private var actions: [TransferLineRow.Action] {
        line.actions.filter { action in
            guard action.act == "open" else { return true }
            guard let target = line.open, target.threadId != nil, others.open != nil else { return false }
            return others.client(target.hostId) != nil
        }
    }
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Text(line.words)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground)
                .monospacedDigit()
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("transfer.words")
            ForEach(actions) { action in
                Button(action.label) { run(action) }
                    .buttonStyle(StripTextButtonStyle())
                    .disabled(action.disabled)
                    .accessibilityIdentifier("transfer.\(action.act)")
            }
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transfer.line")
        .onChange(of: line.alert ? line.words : nil) { _, words in
            if let words { AccessibilityNotification.Announcement(words).post() }
        }
    }
    private func run(_ action: TransferLineRow.Action) {
        if action.act == "open" {
            guard let target = line.open else { return }
            if let thread = target.threadId, others.open?(InboxKey(machineId: target.hostId, id: thread)) == true { opened() }
            return
        }
        guard let transferId = line.transferId else {
            // A refusal before the transfer existed: Try again repeats the send.
            if action.act == "retry" { model.transfer(["kind": "retry"]) }
            return
        }
        if action.act == "retry", model.transfers.sheet != nil { model.transfer(["kind": "retry"]); return }
        model.transferLine(transferId, act: action.act)
    }
}

/// The open thread's transfer above its composer, inside the composer's one strip.
struct ThreadTransferStrip: View {
    let model: ClientModel
    let line: TransferLineRow
    var body: some View {
        StripSurface { TransferLineView(model: model, line: line) }
            .accessibilityIdentifier("thread.transfer")
    }
}
