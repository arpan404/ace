import SwiftUI

/// A page section without a card (DESIGN.md: heading and hairline rows): a quiet heading, then
/// its rows each over a hairline.
struct ForgeSection<Rows: View>: View {
    let title: String?
    @ViewBuilder let rows: () -> Rows

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let title {
                Text(title).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .padding(.bottom, AceTheme.Spacing.xs)
                    .accessibilityAddTraits(.isHeader)
            }
            Divider().overlay(AceTheme.Colours.separator)
            Group(subviews: rows()) { subviews in
                ForEach(subviews) { row in
                    row
                    Divider().overlay(AceTheme.Colours.separator).padding(.leading, AceTheme.Spacing.lg)
                }
            }
        }
    }
}

/// A two-sided row: what, then its value; the value takes its state's colour when it has one
/// that needs saying (idle values stay muted).
struct ForgeLine: View {
    let leading: String
    let trailing: String
    var tone: String?

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Text(leading).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.sm)
            Text(trailing).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(tone.flatMap { $0 == "idle" ? nil : AceTone($0).text } ?? AceTheme.Colours.mutedForeground)
                .lineLimit(1)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
    }
}

/// The threads working on a pull request or issue; one waiting on the person says so. A tap
/// opens it on the Threads tab.
struct ForgeThreadsSection: View {
    let threads: [ForgeRelatedThread]
    let machineId: String
    let openThread: (InboxKey) -> Void

    var body: some View {
        if !threads.isEmpty {
            ForgeSection(title: threads.count == 1 ? "Thread" : "Threads") {
                ForEach(threads, id: \.self) { thread in
                    Button { openThread(InboxKey(machineId: machineId, id: thread.id)) } label: {
                        HStack(spacing: AceTheme.Spacing.sm) {
                            AceIcon(.chats, size: 15, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                            Text(thread.title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                                .foregroundStyle(thread.archived ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                                .lineLimit(1)
                            Spacer(minLength: AceTheme.Spacing.sm)
                            if thread.needsYou {
                                StatusLabel(word: "Needs you", tone: .needsYou, glyph: .needsYou, loud: true)
                            } else if thread.archived {
                                Text("Archived").meta(AceTheme.Colours.subtleForeground)
                            }
                        }
                        .padding(.horizontal, AceTheme.Spacing.lg)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("forge.thread.\(thread.id)")
                }
            }
        }
    }
}
