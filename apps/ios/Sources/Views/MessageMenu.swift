import SwiftUI
import UIKit

/// Puts the words between two UTF-16 offsets of an agent's message on the next message as a
/// quote, caret in the composer. Equal for one thread, so a redraw of the thread leaves every
/// message's menu as it is: `add` only reaches the model and the composer's focus.
struct MessageReply: Equatable {
    let threadId: String
    let add: (String, Int, Int) -> Void
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.threadId == rhs.threadId }
}

extension EnvironmentValues {
    /// Reply, where a composer can take a quote now; nil elsewhere.
    @Entry var replyToMessage: MessageReply? = nil
}

extension View {
    /// A message's long-press menu, as the system's own apps offer one: Copy, Select text (the
    /// words in a sheet where any part of them can be selected) and Share. The lifted preview is
    /// the message's opening, never a tall answer squeezed into the menu. A `quotable` message (an
    /// agent's) offers Reply too, where the composer can take a quote: the same sheet, to pick
    /// the words the reply is about. `row`'s actions (Edit, Fork, Retry, Rewind) follow, as its
    /// action row offers them.
    func messageMenu(_ text: String, title: String, row: TranscriptRow? = nil, quotable: Bool = false) -> some View {
        modifier(MessageMenu(text: text, title: title, row: row, quotable: quotable))
    }
}

private struct MessageMenu: ViewModifier {
    let text: String
    let title: String
    let row: TranscriptRow?
    let quotable: Bool
    @Environment(\.messageTransitions) private var transitions
    @Environment(\.replyToMessage) private var replyToMessage
    @State private var selecting = false
    @State private var replying = false
    /// Reply, for an agent's message the composer can take a quote of.
    private var reply: ((Int, Int) -> Void)? {
        guard quotable, let replyToMessage else { return nil }
        let text = text
        return { start, end in replyToMessage.add(text, start, end) }
    }
    /// One structure whether or not there is text yet: an answer that stops streaming gains its
    /// menu without its content being rebuilt (markit would lay the whole answer out again). With
    /// no text the menu holds nothing and isn't offered.
    func body(content: Content) -> some View {
        content
            .contextMenu {
                if !text.isEmpty {
                    // When it was sent heads the menu: nothing sits under a message at rest.
                    if let row {
                        Section(Date(timeIntervalSince1970: row.createdAt / 1000).formatted(date: .abbreviated, time: .shortened)) {}
                    }
                    if reply != nil {
                        Button("Reply", ace: .arrowBendUpLeft) { replying = true }
                    }
                    Button("Copy", ace: .copy) { UIPasteboard.general.string = text }
                    Button("Select text", ace: .textAlignLeft) { selecting = true }
                    ShareLink(item: text) { Label("Share", ace: .export) }
                    if let row, let transitions {
                        let offered = transitions.offered(for: row)
                        if !offered.isEmpty {
                            Section {
                                ForEach(offered, id: \.self) { action in
                                    Button(action.label, ace: action.icon) { transitions.run(action, row) }
                                }
                            }
                        }
                    }
                }
            } preview: {
                AceMarkdown(text: String(text.prefix(600)), selectable: false)
                    .padding(AceDesign.Space.margin)
                    .frame(width: AceDesign.Size.popover, alignment: .topLeading)
                    .frame(maxHeight: AceDesign.Size.popoverHeight, alignment: .top)
                    .clipped()
                    .background(AceTheme.Colours.background)
            }
            .sheet(isPresented: $selecting) { SelectTextSheet(text: text, title: title, reply: reply) }
            .sheet(isPresented: $replying) { SelectTextSheet(text: text, title: "Reply", reply: reply, replying: true) }
    }
}

/// The message's words in a read-only text view: drag to select any part, as in Notes or Mail.
/// With `reply`, the selection's menu offers Reply first, putting the words on the next message
/// as a quote. `replying` is the sheet Reply opens: select the words, then Reply in its bar.
struct SelectTextSheet: View {
    let text: String
    let title: String
    var reply: ((Int, Int) -> Void)? = nil
    var replying = false
    @Environment(\.dismiss) private var dismiss
    @State private var selection = NSRange(location: 0, length: 0)
    var body: some View {
        NavigationStack {
            SelectableText(text: text, selection: $selection, reply: reply.map { reply in
                { range in
                    reply(range.location, range.location + range.length)
                    dismiss()
                }
            })
                .background(AceTheme.Colours.background)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if replying, let reply {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { dismiss() }.accessibilityIdentifier("select.cancel")
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Reply") {
                                reply(selection.location, selection.location + selection.length)
                                dismiss()
                            }
                            .disabled(selection.length == 0)
                            .accessibilityHint("Select the words you're replying to first")
                            .accessibilityIdentifier("select.reply")
                        }
                    } else {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { dismiss() }.accessibilityIdentifier("select.done")
                        }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct SelectableText: UIViewRepresentable {
    let text: String
    @Binding var selection: NSRange
    /// Reply, first in the selection's menu; nil leaves the system's menu as it is.
    let reply: ((NSRange) -> Void)?
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = .label
        view.textContainerInset = UIEdgeInsets(top: AceDesign.Space.margin, left: AceDesign.Space.margin, bottom: AceDesign.Space.group, right: AceDesign.Space.margin)
        view.accessibilityIdentifier = "select.text"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
    }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SelectableText
        init(_ parent: SelectableText) { self.parent = parent }
        func textViewDidChangeSelection(_ view: UITextView) {
            if parent.selection != view.selectedRange { parent.selection = view.selectedRange }
        }
        func textView(_ view: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let reply = parent.reply, range.length > 0 else { return nil }
            let action = UIAction(title: "Reply", image: UIImage(named: "ph-\(AceIcon.Name.arrowBendUpLeft.rawValue)")) { _ in reply(range) }
            return UIMenu(children: [action] + suggestedActions)
        }
    }
}
