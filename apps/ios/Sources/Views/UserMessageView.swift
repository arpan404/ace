import SwiftUI

/// The person's message, as the web draws it: a quiet "Steer" or "Queued" eyebrow when it wasn't
/// simply sent, its attachments above, unframed, then a right-aligned bubble of what it replies to
/// and its words (none for a message of attachments only), and its time and Copy under the bubble. Everything is the
/// bridge's (`BubbleLine`); Swift only lays it out.
struct UserMessageRow: View {
    let row: TranscriptRow
    var body: some View {
        let readable = row.bubble?.readable ?? !row.text.isEmpty
        let quoted = !(row.bubble?.quotes ?? []).isEmpty
        VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
            if let origin = row.bubble?.origin, !origin.isEmpty { MessageEyebrow(origin: origin) }
            if let attachments = row.attachments, !attachments.isEmpty {
                MessageAttachments(row: row, attachments: attachments, more: row.moreAttachments ?? 0)
                    .padding(.leading, UserBubble.inset)
            }
            if readable || quoted {
                UserBubble(text: row.text, bubble: row.bubble, id: row.id)
                    .modifier(BubbleMenu(text: copyText, cut: readable && row.bubble?.cut == true, id: row.id, row: row))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.user.\(row.id)")
    }
    /// The bubble's words as written (the bridge's `source`). A message with mentions copies its
    /// runs, the chips by name; a message of only quotes copies the passages, never the block the
    /// agent reads.
    private var copyText: String {
        if row.bubble?.readable == false, let quotes = row.bubble?.quotes, !quotes.isEmpty {
            return quotes.map(\.text).joined(separator: "\n\n")
        }
        if let source = row.bubble?.source, !source.isEmpty { return source }
        guard let segments = row.bubble?.segments, !segments.isEmpty else { return row.text }
        return segments.map { $0.kind == "code" ? "\n\($0.text)\n" : $0.text }.joined()
            .trimmingCharacters(in: .newlines)
    }
}

/// A bubble's long-press menu over its words as written: Copy, Select text and Share hold what
/// the bubble shows, never less. A bubble the bridge cut reads its whole words (`readBubble`)
/// while it is on screen, and the menu holds those once they arrive.
private struct BubbleMenu: ViewModifier {
    let text: String
    let cut: Bool
    let id: String
    /// The person's own message, whose Edit, Fork and Retry the menu offers; nil for a brief.
    var row: TranscriptRow? = nil
    @Environment(\.readBubble) private var readBubble
    @State private var whole: String?
    func body(content: Content) -> some View {
        content
            .messageMenu(whole ?? text, title: "Message", row: row)
            .task(id: cut) {
                guard cut, whole == nil, let readBubble else { return }
                whole = try? await readBubble(id)
            }
    }
}

extension EnvironmentValues {
    /// Reads a message's whole bubble words (`native.message` with `bubble`), for a bubble longer
    /// than its row carries. Nil where nothing can read it.
    @Entry var readBubble: (@MainActor (String) async throws -> String)? = nil
}

/// A message another thread's agent sent, as the web draws it: the person's bubble of its words
/// (without ace's frame), folded to a few lines, under a quiet line naming the sender: its
/// provider's mark and "Sent by <title>", with " · <machine>" when the sender is on another
/// machine. A local sender reads by its current title in the thread list. The line opens the
/// sender: on this machine, or on its paired machine while that one is connected here; a sender
/// ace doesn't know, or can't reach, is plain text.
struct SentMessageRow: View {
    let event: EventRow
    let sent: EventRow.SentBy
    let row: TranscriptRow
    let links: TranscriptLinks
    @Environment(\.remoteThreads) private var remote
    var body: some View {
        VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
            senderLine
            if sent.bubble.readable {
                // Its words copy as written; Edit, Fork and Retry belong to the person's own messages.
                UserBubble(text: words(of: sent.bubble), bubble: sent.bubble, id: row.id, caret: true)
                    .modifier(BubbleMenu(text: words(of: sent.bubble), cut: sent.bubble.cut == true, id: row.id))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.sent.\(row.id)")
    }
    /// The brief's words as written; from an older bridge, its runs.
    private func words(of bubble: BubbleLine) -> String {
        if let source = bubble.source, !source.isEmpty { return source }
        return bubble.segments.map(\.text).joined()
    }
    /// What tapping the line does, if it can open the sender.
    private var opener: (() -> Void)? {
        let id = sent.threadId
        guard !id.isEmpty else { return nil }
        if sent.hostId.isEmpty { return { links.openThread(id) } }
        guard let open = remote?.on(sent.hostId) else { return nil }
        return { open(id) }
    }
    /// The line's words: a local sender by its current title, as the thread list has it.
    private var words: String {
        if sent.hostId.isEmpty, !sent.threadId.isEmpty,
           let title = links.threadTitle?(sent.threadId)?.trimmingCharacters(in: .whitespaces), !title.isEmpty {
            return "Sent by \(title)"
        }
        return sent.line
    }
    @ViewBuilder private var senderLine: some View {
        let label = HStack(spacing: AceDesign.Space.tight) {
            if !event.provider.isEmpty { ProviderMark(provider: event.provider, size: AceDesign.Size.glyphSmall) }
            Text(words).lineLimit(1).truncationMode(.tail)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .padding(.leading, UserBubble.inset)
        if let opener {
            Button(action: opener) { label.foregroundStyle(AceTheme.Colours.mutedForeground) }
                .buttonStyle(.plain)
                .frame(minHeight: AceDesign.Space.group)
                .contentShape(Rectangle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(words)
                .accessibilityHint("Opens the thread that sent it")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("message.sentBy")
        } else {
            label.foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(words)
                .accessibilityIdentifier("message.sentBy")
        }
    }
}

/// Opens threads on the other paired machines: `on(hostId)` is the opener for a thread there,
/// nil while that machine isn't connected here.
struct RemoteThreads {
    let on: (String) -> ((String) -> Void)?
}

extension EnvironmentValues {
    @Entry var remoteThreads: RemoteThreads? = nil
}

/// "Steer" or "Queued": how a message reached the agent, above its bubble.
private struct MessageEyebrow: View {
    let origin: String
    var body: some View {
        Label {
            Text(origin == "steer" ? "Steer" : "Queued")
        } icon: {
            AceIcon(origin == "steer" ? .arrowBendDownRight : .clock, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
        }
        .labelStyle(.titleAndIcon)
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

/// A tailless bubble at the answers' reading size, at most about 80% of the column. Markdown the
/// writer meant renders as answers do; otherwise prose as typed, fenced code (or a paste that is
/// plainly code) in monospace on the code surface, mentions as chips. A long message shows its
/// first lines under a fade (the bridge's `fold`: ten of the person's words, four of a brief
/// another thread sent), with Show more / Show less.
struct UserBubble: View {
    /// What the bubble leaves free beside it: about a fifth of a phone's column.
    static let inset = AceDesign.Space.section * 2 + AceDesign.Space.related
    let text: String
    var bubble: BubbleLine? = nil
    var id = ""
    /// Show more / Show less carry a caret: most of a brief another thread sent is folded away.
    var caret = false
    @State private var open = false
    /// Rendered markdown's drawn height: it folds by what it draws, as on the web.
    @State private var drawn: CGFloat?
    @ScaledMetric(relativeTo: .body) private var lineHeight = AceTheme.Typography.body.lineHeight
    private var foldLines: Int { max(1, bubble?.fold ?? 10) }
    private var foldHeight: CGFloat { lineHeight * CGFloat(foldLines) }
    /// The fade covers the last folded line; a long fold of plain text fades two.
    private var fadeFrom: CGFloat { 1 - CGFloat(foldLines > 4 && !markdown ? 2 : 1) / CGFloat(foldLines) }
    private var markdown: Bool { !(bubble?.markdown ?? "").isEmpty }
    var body: some View {
        let long = markdown ? drawn.map { $0 > foldHeight + 1 } ?? (bubble?.long ?? false) : bubble?.long ?? false
        let folded = long && !open
        HStack(spacing: AceTheme.Spacing.none) {
            Spacer(minLength: Self.inset)
            VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
                // What it replies to shares the words' leading edge, above them.
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    if let quotes = bubble?.quotes, !quotes.isEmpty { BubbleQuotes(quotes: quotes) }
                    // Full height, then clipped: the fold cuts the text rather than squeezing it.
                    if bubble?.readable != false {
                        BubbleText(text: text, bubble: bubble)
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                                if markdown { drawn = height }
                            }
                            .frame(maxHeight: folded ? foldHeight : nil, alignment: .top)
                            .clipped()
                            .mask {
                                LinearGradient(stops: [.init(color: .black, location: folded ? fadeFrom : 1), .init(color: folded ? .clear : .black, location: 1)],
                                               startPoint: .top, endPoint: .bottom)
                            }
                    }
                }
                if long {
                    Button { open.toggle() } label: {
                        HStack(spacing: AceDesign.Space.tight) {
                            Text(open ? "Show less" : "Show more")
                            if caret { AceIcon(open ? .caretUp : .caretDown, size: AceDesign.Size.glyphSmall, relativeTo: .caption) }
                        }
                    }
                        .buttonStyle(.plain)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption).fontWeight(AceDesign.Typeface.regular)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceDesign.Space.group)
                        .contentShape(Rectangle())
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                        .accessibilityIdentifier("message.fold.\(id)")
                }
            }
            .padding(.horizontal, AceDesign.Space.bubbleH).padding(.vertical, AceDesign.Space.bubbleV)
            // The raised fill with 19pt continuous corners, as the approved mockup draws it.
            .background(AceDesign.Surface.group, in: RoundedRectangle(cornerRadius: AceDesign.Size.bubbleCorner, style: .continuous))
        }
    }
}

/// What the message replied to, at the top of its bubble: each quoted passage of the agent's
/// words set off by a rule, muted, to three lines, as the web's quotes card draws them.
private struct BubbleQuotes: View {
    let quotes: [BubbleLine.Quote]
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            ForEach(Array(quotes.enumerated()), id: \.offset) { _, quote in
                Text(verbatim: quote.text)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, AceDesign.Space.related)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(AceTheme.Colours.separator).frame(width: 2)
                    }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Replying to \(quotes.map(\.text).joined(separator: ", "))")
    }
}

/// The bubble's words. Markdown renders through the answers' renderer (markit), lists, code and
/// links included, with code and tables scrolling inside the bubble. Otherwise its runs: prose and
/// mentions flow as one paragraph; code breaks out as its own block.
private struct BubbleText: View {
    let text: String
    let bubble: BubbleLine?
    private enum Piece { case prose(AttributedString), code(String) }
    var body: some View {
        if let markdown = bubble?.markdown, !markdown.isEmpty {
            // Copy and Select text are the bubble's long-press menu, so the text isn't selectable.
            AceMarkdown(text: markdown, selectable: false)
        } else {
            runs
        }
    }
    private var runs: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .prose(let text):
                    Text(text).aceFont(AceDesign.TextRole.message, relativeTo: .body)
                case .code(let text):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(verbatim: text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, AceDesign.Space.related).padding(.vertical, AceDesign.Space.tight)
                    }
                    // Concentric with the bubble: its radius less the bubble's padding.
                    .background(AceDesign.Surface.nested,
                                in: AceShape.bubbleInset)
                }
            }
        }
        // Copy and Select text are the bubble's long-press menu (`messageMenu`).
    }
    private var pieces: [Piece] {
        guard let segments = bubble?.segments, !segments.isEmpty else { return [.prose(AttributedString(text))] }
        var pieces: [Piece] = []
        var prose = AttributedString()
        for segment in segments {
            switch segment.kind {
            case "code":
                if !prose.characters.isEmpty { pieces.append(.prose(prose)); prose = AttributedString() }
                pieces.append(.code(segment.text))
            case "mention":
                var chip = AttributedString("\u{2009}\(segment.text)\u{2009}")
                chip.backgroundColor = AceTheme.Colours.separator
                chip.inlinePresentationIntent = .stronglyEmphasized
                prose.append(chip)
            default:
                prose.append(AttributedString(segment.text))
            }
        }
        if !prose.characters.isEmpty { pieces.append(.prose(prose)) }
        return pieces
    }
}

