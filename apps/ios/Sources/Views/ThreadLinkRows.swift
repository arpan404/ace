import SwiftUI

/// Another thread named in the transcript, as a chip that opens it: its title as the thread list
/// has it now (renames included), else the row's own words for it. With nowhere to open it
/// reads as plain words.
struct ThreadLinkChip: View {
    let threadId: String
    let title: String?
    let fallback: String
    let open: ((String) -> Void)?
    var body: some View {
        let name = title ?? fallback
        if let open {
            Button { open(threadId) } label: { chip(name) }
                .buttonStyle(.plain)
                .accessibilityLabel(name)
                .accessibilityHint("Opens that thread")
                .accessibilityIdentifier("transcript.threadLink")
        } else {
            Text(name).lineLimit(1).truncationMode(.tail)
        }
    }
    private func chip(_ name: String) -> some View {
        HStack(spacing: AceDesign.Space.tight) {
            AceIcon(.chatText, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            Text(name).lineLimit(1).truncationMode(.tail)
                .foregroundStyle(AceTheme.Colours.foreground)
        }
        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .padding(.horizontal, AceDesign.Space.related)
        .frame(minHeight: AceDesign.Size.slimControl)
        .background(AceDesign.Surface.fill, in: AceShape.capsule)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
    }
}

/// The prompt ace started this thread with rather than the person typing it (the web's
/// `TaskCard`): "Handoff from <thread>" or "Automation" over the task, and a handoff's chip back
/// to the thread it came from.
struct TaskCardRow: View {
    let event: EventRow
    let links: TranscriptLinks?
    var body: some View {
        let parent = event.threadId ?? ""
        let from = parent.isEmpty ? nil : links?.threadTitle?(parent)
        let heading = event.text == "Handoff" && from != nil ? "Handoff from \(from ?? "")" : event.text
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(heading).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            Text(event.detail).aceFont(AceDesign.TextRole.message, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .textSelection(.enabled)
            if !parent.isEmpty {
                HStack(spacing: AceDesign.Space.tight) {
                    Text("Back to").aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                    ThreadLinkChip(threadId: parent, title: from, fallback: "the parent thread", open: links?.openThread)
                }
            }
        }
        .padding(AceDesign.Space.row)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(AceShape.group.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(heading)
        .accessibilityIdentifier("event.task")
    }
}

/// A fork merged back into this thread (the web's `MergedForkNotice`): "Merged from <fork>", that
/// code came with it, and the fork's summary behind Show summary.
struct MergedLine: View {
    let event: EventRow
    let links: TranscriptLinks?
    @State private var open = false
    var body: some View {
        let source = event.threadId ?? ""
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(spacing: AceDesign.Space.tight) {
                AceIcon(.gitMerge, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(minWidth: AceDesign.Size.lead)
                Text(event.text).foregroundStyle(AceTheme.Colours.mutedForeground)
                ThreadLinkChip(threadId: source, title: links?.threadTitle?(source), fallback: "the forked thread",
                               open: source.isEmpty ? nil : links?.openThread)
                    .layoutPriority(1)
                if !event.note.isEmpty {
                    Text("· \(event.note)").lineLimit(1).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                Spacer(minLength: AceDesign.Space.related)
                if !event.detail.isEmpty {
                    Button(open ? "Hide summary" : "Show summary") { withAnimation { open.toggle() } }
                        .buttonStyle(.plain)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceDesign.Size.tap)
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            if open {
                Text(event.detail)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .textSelection(.enabled)
                    .padding(.leading, AceDesign.Size.lead + AceDesign.Space.tight)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("event.merged")
    }
}
