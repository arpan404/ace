import SwiftUI

/// The person's message, as the web draws it: a quiet "Steer" or "Queued" eyebrow when it wasn't
/// simply sent, its attachments above, unframed, then a right-aligned bubble of its words (none for
/// a message of attachments only), and its time and Copy under the bubble. Everything is the
/// bridge's (`BubbleLine`); Swift only lays it out.
struct UserMessageRow: View {
    let row: TranscriptRow
    var body: some View {
        let readable = row.bubble?.readable ?? !row.text.isEmpty
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            if let origin = row.bubble?.origin, !origin.isEmpty { MessageEyebrow(origin: origin) }
            if let attachments = row.attachments, !attachments.isEmpty {
                AttachmentChips(attachments: attachments, more: row.moreAttachments ?? 0)
                    .padding(.leading, UserBubble.inset)
            }
            if readable { UserBubble(text: row.text, bubble: row.bubble, id: row.id) }
            MessageActions(at: row.createdAt, copy: readable ? copyText : nil, label: "Copy message")
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityIdentifier("message.user.\(row.id)")
    }
    /// The bubble's words as shown: mentions by name, code as written.
    private var copyText: String {
        guard let segments = row.bubble?.segments, !segments.isEmpty else { return row.text }
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
            AceIcon(origin == "steer" ? .arrowBendDownRight : .clock, size: 12, relativeTo: .caption)
        }
        .labelStyle(.titleAndIcon)
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

/// A tailless bubble at the answers' reading size, at most about 80% of the column. Prose as typed,
/// fenced code (or a paste that is plainly code) in monospace on the code surface, mentions as
/// chips. A long message shows its first ten lines under a fade, with Show more / Show less.
struct UserBubble: View {
    /// What the bubble leaves free beside it: about a fifth of a phone's column.
    static let inset = AceTheme.Spacing.xxxl * 2 + AceTheme.Spacing.sm
    let text: String
    var bubble: BubbleLine? = nil
    var id = ""
    @State private var open = false
    @ScaledMetric(relativeTo: .body) private var foldHeight = AceTheme.Typography.body.lineHeight * 10
    var body: some View {
        let long = bubble?.long ?? false
        let folded = long && !open
        HStack(spacing: AceTheme.Spacing.none) {
            Spacer(minLength: Self.inset)
            VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
                // Full height, then clipped: the fold cuts the text rather than squeezing it.
                BubbleText(text: text, bubble: bubble)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxHeight: folded ? foldHeight : nil, alignment: .top)
                    .clipped()
                    .mask {
                        LinearGradient(stops: [.init(color: .black, location: folded ? 0.7 : 1), .init(color: folded ? .clear : .black, location: 1)],
                                       startPoint: .top, endPoint: .bottom)
                    }
                if long {
                    Button(open ? "Show less" : "Show more") { open.toggle() }
                        .buttonStyle(.plain)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption).fontWeight(.medium)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceTheme.Spacing.xxl)
                        .contentShape(Rectangle())
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                        .accessibilityIdentifier("message.fold.\(id)")
                }
            }
            .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.sm)
            // Round as a capsule while it's one line; continuous corners once it wraps.
            .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble, style: .continuous))
        }
    }
}

/// The bubble's runs: prose and mentions flow as one paragraph; code breaks out as its own block.
private struct BubbleText: View {
    let text: String
    let bubble: BubbleLine?
    private enum Piece { case prose(AttributedString), code(String) }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .prose(let text):
                    Text(text).aceFont(AceTheme.Typography.body, relativeTo: .body)
                case .code(let text):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(verbatim: text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
                    }
                    // Concentric with the bubble: its radius less the bubble's padding.
                    .background(AceTheme.Colours.background.opacity(0.5),
                                in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble - AceTheme.Spacing.md, style: .continuous))
                }
            }
        }
        .textSelection(.enabled)
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

/// A message's time and Copy, under it: always shown, since nothing hovers on a phone.
struct MessageActions: View {
    let at: Double
    let copy: String?
    let label: String
    @State private var copied = false
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            if let copy {
                Button {
                    UIPasteboard.general.string = copy
                    copied = true
                } label: {
                    AceIcon(copied ? .check : .copy, size: 14, relativeTo: .caption)
                        .frame(width: AceTheme.Spacing.xxl, height: AceTheme.Spacing.xxl)
                        .contentShape(Rectangle().inset(by: -AceTheme.Spacing.sm))
                }
                .buttonStyle(.plain)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityLabel(copied ? "Copied" : label)
            }
            if copied {
                Text("Copied").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .frame(minHeight: AceTheme.Spacing.xxl)
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.5)); copied = false } catch { }
        }
    }
}

/// A message's files by name, never by a host path.
struct AttachmentChips: View {
    let attachments: [AttachmentLine]
    let more: Int
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                Label(attachment.name.isEmpty ? "Attachment" : attachment.name, ace: attachment.kind == "image" ? .image : attachment.kind == "pdf" ? .fileText : .file)
                    .lineLimit(1).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
                    .background(AceTheme.Colours.fill, in: Capsule(style: .continuous))
            }
            if more > 0 { Text("+\(more)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit() }
        }
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
}
