import SwiftUI
import UIKit

extension View {
    /// A message's long-press menu, as the system's own apps offer one: Copy, Select text (the
    /// words in a sheet where any part of them can be selected) and Share. The lifted preview is
    /// the message's opening, never a tall answer squeezed into the menu.
    func messageMenu(_ text: String, title: String) -> some View {
        modifier(MessageMenu(text: text, title: title))
    }
}

private struct MessageMenu: ViewModifier {
    let text: String
    let title: String
    @State private var selecting = false
    func body(content: Content) -> some View {
        if text.isEmpty {
            content
        } else {
            content
                .contextMenu {
                    Button("Copy", ace: .copy) { UIPasteboard.general.string = text }
                    Button("Select text", ace: .textAlignLeft) { selecting = true }
                    ShareLink(item: text) { Label("Share", ace: .export) }
                } preview: {
                    MarkdownView(text: String(text.prefix(600)), selectable: false)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .padding(AceTheme.Spacing.lg)
                        .frame(width: 340, alignment: .topLeading)
                        .frame(maxHeight: 360, alignment: .top)
                        .clipped()
                        .background(AceTheme.Colours.background)
                }
                .sheet(isPresented: $selecting) { SelectTextSheet(text: text, title: title) }
        }
    }
}

/// The message's words in a read-only text view: drag to select any part, as in Notes or Mail.
struct SelectTextSheet: View {
    let text: String
    let title: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            SelectableText(text: text)
                .background(AceTheme.Colours.background)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }.accessibilityIdentifier("select.done")
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct SelectableText: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = .label
        view.textContainerInset = UIEdgeInsets(top: AceTheme.Spacing.lg, left: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.xxl, right: AceTheme.Spacing.lg)
        view.accessibilityIdentifier = "select.text"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}
