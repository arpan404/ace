import SwiftUI

/// Anything in the transcript that is neither the person's words nor the agent's answer or work,
/// drawn as the bridge's `EventRow` says (`@ace/ui-core` `eventView`, the web's same decision):
/// ace's own inputs and thread events as quiet rows, errors as one readable row, notices as one
/// quiet line, a handoff as the one centred divider. Never a chat bubble.
struct EventRowView: View {
    let event: EventRow
    @Bindable var item: ItemModel
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var body: some View {
        switch event.kind {
        case "none": EmptyView()
        case "user": UserMessageRow(row: item.row)
        case "handoff":
            if let handoff = item.row.handoff { HandoffRow(handoff: handoff) }
        case "event", "system": SystemRow(event: event)
        case "error": ErrorLine(event: event)
        case "refusal": RefusalLine(event: event)
        case "notSent": NotSentLine(reason: event.note)
        case "notice": NoticeLine(event: event)
        case "quiet": QuietText(text: event.text)
        default: ItemRowView(item: item, openMedia: openMedia, openMessage: openMessage)
        }
    }
}

/// The row anatomy every transcript row shares: a 16pt lead in the subtle tier, the title, an
/// optional second line, and a meta (time, ×N) at the right. At least 32pt tall.
struct EventRowLayout<Lead: View>: View {
    @ViewBuilder var lead: () -> Lead
    let title: String
    var subtitle = ""
    var meta = ""
    /// An agent, error or question reads strong; a step or event is muted.
    var strong = false
    var body: some View {
        HStack(alignment: .center, spacing: AceTheme.Spacing.sm) {
            lead().frame(minWidth: AceTheme.Spacing.xl).foregroundStyle(AceTheme.Colours.subtleForeground)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(title).lineLimit(1).truncationMode(.tail)
                    .fontWeight(strong ? .medium : .regular)
                    .foregroundStyle(strong ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                if !subtitle.isEmpty {
                    Text(subtitle).lineLimit(1).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if !meta.isEmpty {
                Text(meta).aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .frame(minHeight: AceTheme.Spacing.xxxl)
        .contentShape(Rectangle())
    }
}

private func clock(_ at: Double) -> String {
    at > 0 ? Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.hour().minute()) : ""
}

/// Where a row's details open: indented to the title, past the lead and the gap.
private let detailIndent = AceTheme.Spacing.xl + AceTheme.Spacing.sm

/// "Resumed after restart", "Context compacted": a glyph (or the provider's mark), the words and
/// the time. What ace sent on the person's behalf opens from the row itself, folded until asked.
struct SystemRow: View {
    let event: EventRow
    @State private var open = false
    var body: some View {
        let opens = !event.note.isEmpty || !event.detail.isEmpty
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if opens {
                Button { open.toggle() } label: { row }
                    .buttonStyle(.plain)
                    .aceConcentricBackground(open ? AceTheme.Colours.fill : .clear, minimum: AceShape.rowRadius)
                    .accessibilityValue(open ? "Expanded" : "Collapsed")
            } else {
                row
            }
            if open {
                ScrollView {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        if !event.note.isEmpty { Text(event.note) }
                        if !event.detail.isEmpty {
                            if event.mono { Text(verbatim: event.detail).monospaced() } else { Text(event.detail) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                }
                .frame(maxHeight: 288)
                .fixedSize(horizontal: false, vertical: true)
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.leading, detailIndent)
            }
        }
        .accessibilityIdentifier("event.\(event.kind)")
    }
    private var row: some View {
        EventRowLayout(lead: { lead }, title: event.text, meta: clock(event.at))
    }
    @ViewBuilder private var lead: some View {
        if !event.provider.isEmpty {
            ProviderMark(provider: event.provider, size: 14)
        } else {
            AceIcon(glyph, size: 14, relativeTo: .subheadline)
        }
    }
    private var glyph: AceIcon.Name {
        switch event.icon {
        case "restart": .arrowClockwise
        case "resume": .clockCounterClockwise
        case "background": .terminalWindow
        case "switch": .arrowsLeftRight
        case "automation": .lightning
        case "compaction": .arrowsInLineVertical
        default: .info
        }
    }
}

/// One failure as one row: what went wrong in words, ×N for repeats, and the provider's own text
/// behind Details. A limit lifts on its own, so it takes a quiet hourglass, not an alarm.
struct ErrorLine: View {
    let event: EventRow
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                AceIcon(event.icon == "limit" ? .hourglass : .warningCircle, size: 16, relativeTo: .subheadline)
                    .foregroundStyle(event.icon == "limit" ? AceTheme.Colours.subtleForeground : AceTheme.Status.failed)
                    .frame(minWidth: AceTheme.Spacing.xl)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                (Text(event.text).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
                 + Text(event.count > 1 ? " ×\(event.count)" : "").foregroundStyle(AceTheme.Colours.subtleForeground)
                 + Text(event.note.isEmpty ? "" : " · \(event.note)").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !event.detail.isEmpty {
                    Button("Details") { open.toggle() }
                        .buttonStyle(.plain).fontWeight(.medium)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
            .frame(minHeight: AceTheme.Spacing.xxxl)
            if open {
                Text(event.detail).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).textSelection(.enabled)
                    .padding(.leading, detailIndent)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(event.note.isEmpty ? event.text : "\(event.text): \(event.note)")
        .accessibilityIdentifier("event.error")
    }
}

/// A refused or failed agent tool as one failed tool row: what failed, the reason once, ×N.
struct RefusalLine: View {
    let event: EventRow
    var body: some View {
        EventRowLayout(lead: { AceIcon(.robot, size: 16, relativeTo: .subheadline).foregroundStyle(AceTheme.Status.failed) },
                       title: event.text, subtitle: event.note, meta: event.count > 1 ? "×\(event.count)" : "", strong: true)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("event.refusal")
    }
}

/// "Not sent · the reason", where the daemon put its notice: just after the message.
struct NotSentLine: View {
    let reason: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            AceIcon(.warning, size: 12, relativeTo: .caption)
            Text("Not sent").fontWeight(.medium)
            if !reason.isEmpty { Text("· \(reason)").foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2) }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.StatusText.failed)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
    }
}

/// A notice as one quiet line, its words as written.
struct NoticeLine: View {
    let event: EventRow
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            AceIcon(event.icon == "info" ? .info : .warning, size: 16, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            Text(event.text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
}

/// A message the provider injected that ace has no words for: one line, the rest on demand.
struct QuietText: View {
    let text: String
    @State private var open = false
    var body: some View {
        let first = text.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
        let more = text.trimmingCharacters(in: .whitespacesAndNewlines) != first.trimmingCharacters(in: .whitespaces)
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            AceIcon(.info, size: 16, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(open ? text : first).lineLimit(open ? nil : 1)
                if more {
                    Button(open ? "Show less" : "Show all") { open.toggle() }
                        .buttonStyle(.plain)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}

/// "⇄ Context handoff  GPT-6.1-Sol, Muse Spark → Claude Opus 5.5" between two hairlines: the
/// transcript's one centred row, each model with its own mark, at most three sources then "+N".
/// Static: nothing opens from it.
struct HandoffRow: View {
    let handoff: HandoffLine
    private static let shownSources = 3
    var body: some View {
        let shown = Array(handoff.from.prefix(Self.shownSources))
        let hidden = handoff.from.count - shown.count
        CentredDivider {
            AceIcon(.arrowsLeftRight, size: 12, relativeTo: .caption)
            Text(handoff.label).fontWeight(.medium)
            ForEach(Array(shown.enumerated()), id: \.offset) { index, side in
                end(side, comma: index < shown.count - 1 || hidden > 0)
            }
            if hidden > 0 { Text("+\(hidden)") }
            if !shown.isEmpty { AceIcon(.arrowRight, size: 12, relativeTo: .caption) }
            end(handoff.to, target: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(handoff.text)
        .accessibilityIdentifier("event.handoff")
    }
    private func end(_ side: HandoffLine.End, target: Bool = false, comma: Bool = false) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            ProviderMark(provider: side.provider, size: 12)
            Text(side.name + (comma ? "," : "")).fontWeight(.medium)
                .foregroundStyle(target ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .truncationMode(.middle)
        }
    }
}
