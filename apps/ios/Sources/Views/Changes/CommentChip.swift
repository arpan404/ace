import SwiftUI

/// The thread's unsent line comments on the next message, as one chip: "2 comments on wires.ts".
/// They go to the agent with Send, before the words typed with them. Tap for Show in Changes or
/// Remove.
struct CommentChip: View {
    let chip: CommentChipRow
    let remove: () -> Void
    @Environment(\.openChanges) private var openChanges

    var body: some View {
        Menu {
            if let openChanges {
                Button("Show in Changes") { openChanges(chip.path) }
            }
            Button(chip.count == 1 ? "Remove comment" : "Remove comments", ace: .x, role: .destructive, action: remove)
        } label: {
            Text(chip.label)
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1)
                .padding(.horizontal, AceDesign.Space.row)
                .frame(minHeight: AceDesign.Size.slimControl)
                .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
                .frame(minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(chip.label)
        .accessibilityHint("Goes to the agent with your message")
        .accessibilityIdentifier("composer.comments")
    }
}
