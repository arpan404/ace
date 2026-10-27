import SwiftUI
import UIKit

/// What a message's actions do on the open thread. The bridge says which apply to a row
/// (`TranscriptRow.actions`, `TransitionsRow`); the thread screen supplies what they do. Nil where
/// messages offer only Copy (a lane sheet, a pushed message, a view-only machine).
struct MessageTransitions {
    /// The thread's transitions: which answer Retry sits under, whether Pi can go back now.
    var row: TransitionsRow?
    let fork: (TranscriptRow) -> Void
    let edit: (TranscriptRow) -> Void
    let retry: (TranscriptRow) -> Void
    let rewind: (TranscriptRow) -> Void

    /// The row's actions beyond Copy, in the order the action row and long-press menu list them.
    func offered(for row: TranscriptRow) -> [MessageAction] {
        guard let actions = row.actions, row.complete else { return [] }
        var offered: [MessageAction] = []
        if actions.edit { offered.append(.edit) }
        if actions.fork { offered.append(.fork) }
        if self.row?.retry?.answerId == row.id { offered.append(.retry) }
        if actions.rewind, self.row?.settled == true, self.row?.retry?.answerId != row.id { offered.append(.rewind) }
        return offered
    }
    func run(_ action: MessageAction, _ row: TranscriptRow) {
        switch action {
        case .edit: edit(row)
        case .fork: fork(row)
        case .retry: retry(row)
        case .rewind: rewind(row)
        }
    }
}

enum MessageAction: CaseIterable {
    case edit, fork, retry, rewind
    var label: String {
        switch self {
        case .edit: "Edit"
        case .fork: "Fork from here"
        case .retry: "Retry"
        case .rewind: "Rewind to here"
        }
    }
    var icon: AceIcon.Name {
        switch self {
        case .edit: .pencilSimple
        case .fork: .gitFork
        case .retry: .arrowClockwise
        case .rewind: .clockCounterClockwise
        }
    }
    var identifier: String {
        switch self {
        case .edit: "edit"
        case .fork: "fork"
        case .retry: "retry"
        case .rewind: "rewind"
        }
    }
}

extension EnvironmentValues {
    @Entry var messageTransitions: MessageTransitions? = nil
}

/// A message's time, Copy and what can be done from it, under it: always shown, since nothing
/// hovers on a phone. Bare icons in the quiet ink of the time beside them; each names itself to
/// VoiceOver, and the message's long-press menu repeats them in words.
struct MessageActions: View {
    let row: TranscriptRow
    let copy: String?
    let label: String
    @Environment(\.messageTransitions) private var transitions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    var body: some View {
        let offered = transitions?.offered(for: row) ?? []
        HStack(spacing: AceTheme.Spacing.none) {
            Text(Date(timeIntervalSince1970: row.createdAt / 1000), format: .dateTime.hour().minute())
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            if let copy {
                MessageActionButton(icon: copied ? .check : .copy, label: copied ? "Copied" : label, identifier: "copy.\(row.id)") {
                    UIPasteboard.general.string = copy
                    copied = true
                }
            }
            if let transitions {
                ForEach(offered, id: \.self) { action in
                    MessageActionButton(icon: action.icon, label: action.label, identifier: "\(action.identifier).\(row.id)") {
                        transitions.run(action, row)
                    }
                    .modifier(ForkSource(rowId: row.id, active: action == .fork || action == .edit))
                    .transition(.opacity)
                }
            }
            if copied {
                Text("Copied").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .transition(.opacity)
            }
        }
        // A turn ending brings Fork in, Copy turns to Copied: each fades rather than pops.
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: offered)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: copied)
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.5)); copied = false } catch { }
        }
    }
}

/// One bare icon of a message's action row: a 15pt glyph in a full 44pt touch target, so a thumb
/// hits it without the row taking more room than a caption line (the target reaches past it).
private struct MessageActionButton: View {
    let icon: AceIcon.Name
    let label: String
    let identifier: String
    let action: () -> Void
    private let reach = (AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xxl) / 2
    var body: some View {
        Button(action: action) {
            AceIcon(icon, size: 15, relativeTo: .caption)
                .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Spacing.xxl)
                // The full target's height, reaching into the room above and below the row.
                .padding(.vertical, reach)
                .contentShape(Rectangle())
                .padding(.vertical, -reach)
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
        .accessibilityLabel(label)
        .accessibilityIdentifier("message.\(identifier)")
    }
}

extension EnvironmentValues {
    /// The thread screen's namespace for the fork strip growing out of the button that opened it,
    /// and the row whose button that was.
    @Entry var forkMorph: (namespace: Namespace.ID, rowId: String?)? = nil
}

/// The Fork or Edit button the open fork strip grew out of: the strip takes its place in one motion.
private struct ForkSource: ViewModifier {
    let rowId: String
    let active: Bool
    @Environment(\.forkMorph) private var morph
    func body(content: Content) -> some View {
        if active, let morph {
            content.matchedGeometryEffect(id: "fork.\(rowId)", in: morph.namespace, isSource: true)
        } else {
            content
        }
    }
}
