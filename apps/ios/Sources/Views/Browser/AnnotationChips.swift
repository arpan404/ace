import SwiftUI

/// The drawings on the next message as one chip, "Drawing 1 attached" or "3 drawings attached":
/// each drawing's crop and the page's still go to the agent with the words. Tap for each
/// drawing by its number (its comment, if one was written), Show on page, and Remove.
struct AnnotationChips: View {
    let items: [AnnotationChip]
    let remove: (String) -> Void
    let clear: () -> Void
    @Environment(\.openBrowser) private var openBrowser

    /// "Drawing 1 attached", "3 drawings attached".
    static func label(_ items: [AnnotationChip]) -> String {
        if items.count == 1, let only = items.first { return "Drawing \(only.number) attached" }
        return "\(items.count) drawings attached"
    }

    var body: some View {
        Menu {
            if let openBrowser {
                Button("Show on page", ace: .browsers) { openBrowser() }
            }
            Section {
                ForEach(items) { item in
                    Button("Remove \(item.number)\(item.comment.isEmpty ? "" : ": \(item.comment)")", ace: .x, role: .destructive) { remove(item.id) }
                }
            }
            if items.count > 1 {
                Button("Remove all", ace: .x, role: .destructive, action: clear)
            }
        } label: { chip }
        .sensoryFeedback(.selection, trigger: items.count)
        .accessibilityIdentifier("composer.annotations")
    }

    private var chip: some View {
        HStack(spacing: AceDesign.Space.tight) {
            Text(Self.label(items))
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1)
            if items.contains(where: { $0.state == "uploading" }) {
                WorkingMark(label: "Attaching")
            } else if items.contains(where: { $0.state == "failed" }) {
                Text("No picture").font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.failed)
            }
        }
        .padding(.horizontal, AceDesign.Space.row)
        .frame(minHeight: AceDesign.Size.slimControl)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.label(items))
        .accessibilityHint("Goes to the agent with your message, with a picture of the page")
    }
}
