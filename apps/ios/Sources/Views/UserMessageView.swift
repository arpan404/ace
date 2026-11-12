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
                    .messageMenu(Self.copyText(row.bubble, text: row.text), title: "Message", row: row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.user.\(row.id)")
    }
    /// The bubble's words as shown: mentions by name, code as written, markdown as its source
    /// (its one run), never the drawn text. A message of only quotes copies the passages, never
    /// the block the agent reads.
    static func copyText(_ bubble: BubbleLine?, text: String) -> String {
        if bubble?.readable == false, let quotes = bubble?.quotes, !quotes.isEmpty {
            return quotes.map(\.text).joined(separator: "\n\n")
        }
        guard let segments = bubble?.segments, !segments.isEmpty else { return text }
        return segments.map { $0.kind == "code" ? "\n\($0.text)\n" : $0.text }.joined()
            .trimmingCharacters(in: .newlines)
    }
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
/// writer meant renders as answers do, every line break kept; anything else is prose as typed, a
/// paste that is plainly code in monospace on the code surface, mentions as chips. Nothing is wider
/// than the bubble: long words wrap, code and tables scroll inside it. A long message shows its
/// first lines (`BubbleLine.fold`: ten, or four for a brief another thread sent) under a fade,
/// with Show more / Show less.
struct UserBubble: View {
    /// What the bubble leaves free beside it: about a fifth of a phone's column.
    static let inset = AceDesign.Space.section * 2 + AceDesign.Space.related
    let text: String
    var bubble: BubbleLine? = nil
    var id = ""
    @State private var open = false
    @ScaledMetric(relativeTo: .body) private var lineHeight = AceTheme.Typography.body.lineHeight
    /// A brief's short fold, or rendered markdown, fades only its last line; a long plain fold two.
    private var fade: CGFloat {
        let lines = CGFloat(foldLines)
        return (foldLines > 4 && markdown.isEmpty ? 2 : 1) / lines
    }
    private var foldLines: Int { max(1, bubble?.fold ?? 10) }
    private var markdown: String { bubble?.markdown ?? "" }
    /// Most of a brief is hidden when folded: its button carries a caret, as on the web.
    private var caret: Bool { foldLines < 10 }
    var body: some View {
        let long = bubble?.long ?? false
        let folded = long && !open
        let foldHeight = lineHeight * CGFloat(foldLines)
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
                            .frame(maxHeight: folded ? foldHeight : nil, alignment: .top)
                            .clipped()
                            .mask {
                                LinearGradient(stops: [.init(color: .black, location: folded ? 1 - fade : 1), .init(color: folded ? .clear : .black, location: 1)],
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

/// The bubble's runs: prose and mentions flow as one paragraph; code breaks out as its own block.
/// Markdown renders through the answers' view instead, without its own selection: the bubble's
/// long-press menu offers Copy and Select text.
private struct BubbleText: View {
    let text: String
    let bubble: BubbleLine?
    private enum Piece { case prose(AttributedString), code(String) }
    var body: some View {
        if let markdown = bubble?.markdown, !markdown.isEmpty {
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

/// A brief another thread's agent sent, as the web draws it: the person's sent bubble of its words,
/// folded to four lines, under a muted line with the sender's mark and "Sent by <thread>", plus
/// " · <machine>" for a sender on another machine. The line opens the sending thread: here on
/// this machine, or through its `ace://` link on the paired machine it is on. A sender ace knows
/// nothing of reads "Sent from another thread" and opens nothing.
struct SentMessageRow: View {
    let sent: SentLine
    let bubble: BubbleLine
    let row: TranscriptRow
    let links: TranscriptLinks?
    @Environment(\.openURL) private var openURL
    var body: some View {
        VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
            SentByLine(provider: sent.provider, line: line, open: open)
            if bubble.readable {
                UserBubble(text: "", bubble: bubble, id: row.id)
                    .messageMenu(UserMessageRow.copyText(bubble, text: ""), title: "Message", row: row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.sent.\(row.id)")
    }
    private var line: String { sent.shown(current: sent.threadId.isEmpty ? nil : links?.threadTitle?(sent.threadId)) }
    private var open: (() -> Void)? {
        switch sent.target {
        case .thread(let id):
            guard let links else { return nil }
            return { links.openThread(id) }
        case .link(let url):
            // The app opens its own link on that machine, or says why it can't.
            let openURL = openURL
            return { openURL(url) }
        case nil:
            return nil
        }
    }
}

/// The quiet line above a sent brief: the sender's mark and its words on one line, ending in an
/// ellipsis when long. A button when there is a thread to open.
private struct SentByLine: View {
    let provider: String
    let line: String
    let open: (() -> Void)?
    var body: some View {
        if let open {
            Button(action: open) { label }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the thread that sent it")
                .accessibilityIdentifier("message.sentBy")
        } else {
            label.accessibilityIdentifier("message.sentBy")
        }
    }
    private var label: some View {
        HStack(spacing: AceDesign.Space.tight) {
            if !provider.isEmpty { ProviderMark(provider: provider, size: AceDesign.Size.glyphSmall) }
            Text(line).lineLimit(1).truncationMode(.tail)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .frame(minHeight: AceDesign.Space.group)
        .contentShape(Rectangle())
        .padding(.leading, UserBubble.inset)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(line)
    }
}
