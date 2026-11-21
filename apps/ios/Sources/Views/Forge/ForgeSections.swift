import SwiftUI

/// A page section without a card: the shared quiet section (design language §5 "Inner pages"),
/// a quiet heading over rows split by hairlines from the margin.
struct ForgeSection<Rows: View>: View {
    let title: String?
    @ViewBuilder let rows: () -> Rows

    var body: some View { QuietSection(title, content: rows) }
}

/// A two-sided row: what, then its value; the value takes its state's colour when it has one
/// that needs saying (idle values stay muted). At accessibility sizes the value goes under the
/// title, so neither splits a word.
struct ForgeLine: View {
    let leading: String
    let trailing: String
    var tone: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ForgeTwoSided {
            Text(leading).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
        } trailing: {
            Text(trailing).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(tone.flatMap { $0 == "idle" ? nil : AceTone($0).text } ?? AceTheme.Colours.mutedForeground)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .combine)
    }
}

/// A title and its value on one line, or the value under the title at accessibility sizes.
struct ForgeTwoSided<Leading: View, Trailing: View>: View {
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                leading().fixedSize(horizontal: false, vertical: true)
                trailing()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, AceDesign.Space.tight)
        } else {
            HStack(spacing: AceTheme.Spacing.sm) {
                leading()
                Spacer(minLength: AceTheme.Spacing.sm)
                trailing()
            }
        }
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
                            AceIcon(.chats, size: AceDesign.Size.icon, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
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
                        .frame(minHeight: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("forge.thread.\(thread.id)")
                }
            }
        }
    }
}

/// A row that opens a page: its title, a quiet detail, and the caret.
struct ForgeLinkRow: View {
    let title: String
    var detail: String = ""
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgeTwoSided {
                    Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                        .foregroundStyle(AceTheme.Colours.foreground)
                } trailing: {
                    if !detail.isEmpty { Text(detail).meta() }
                }
                AceIcon(.caretRight, size: AceDesign.Size.caret, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .frame(minHeight: AceDesign.Size.tap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityIdentifier(identifier)
    }
}

/// The trailing value of a row that opens a menu (Milestone, Lock), drawn as Settings draws its
/// menus: the value in muted ink beside the up and down chevrons.
struct ForgeMenuValue: View {
    let text: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            Text(text).lineLimit(1).contentTransition(.opacity)
            AceIcon(.caretUpDown, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
        }
        .font(AceDesign.Typeface.body)
        .foregroundStyle(AceDesign.Ink.muted)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
    }
}
