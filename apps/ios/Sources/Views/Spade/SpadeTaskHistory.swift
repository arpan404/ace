import SwiftUI

/// The task's history, folded under the task (spade/docs/agents.md, "A bot's task over time"):
/// each earlier version, newest first, with who made it and when ("Nov 19, 8:02 AM"), opening to
/// read whole. Read again whenever the task changes; nothing shows while it has only ever had one.
struct SpadeTaskHistory: View {
    let scope: SpadeProfileScope
    let task: String
    @State private var versions: [SpadeTaskVersion] = []
    @State private var open = false

    var body: some View {
        Group {
            if versions.count > 1 {
                DisclosureGroup(isExpanded: $open) {
                    ForEach(versions.dropFirst()) { version in
                        NavigationLink { SpadeTaskVersionPage(version: version) } label: { row(version) }
                            .accessibilityIdentifier("spade.task.version")
                    }
                } label: {
                    Label("Earlier versions", ace: .clockCounterClockwise)
                        .aceFont(AceDesign.TextRole.rowTitle)
                        .foregroundStyle(AceDesign.Ink.primary)
                }
                .accessibilityIdentifier("spade.task.history")
            }
        }
        .task(id: task) {
            let answer = await scope.client.spadeTaskHistory(scope.agent)
            // A read that failed leaves the history folded away as it was.
            if let read = answer.versions { versions = read }
        }
    }

    private func row(_ version: SpadeTaskVersion) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(version.firstLine)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(2)
            Text(Self.meta(version))
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted)
        }
        .accessibilityElement(children: .combine)
    }

    /// "Changed by you · Restored an earlier task · Nov 19, 8:02 AM".
    static func meta(_ version: SpadeTaskVersion) -> String {
        var parts = [version.by]
        if !version.why.isEmpty { parts.append(version.why) }
        if let at = version.at { parts.append(when(at)) }
        return parts.joined(separator: " · ")
    }

    /// When a version was made, in the person's locale: "Nov 19, 8:02 AM".
    static func when(_ at: Double) -> String {
        Date(timeIntervalSince1970: at / 1000)
            .formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

/// One version of the task, whole, to read.
struct SpadeTaskVersionPage: View {
    let version: SpadeTaskVersion

    var body: some View {
        List {
            Section {
                Text(version.task)
                    .aceFont(AceDesign.TextRole.message)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .textSelection(.enabled)
            } footer: {
                Text(SpadeTaskHistory.meta(version))
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(version.at.map(SpadeTaskHistory.when) ?? "Its first task")
        .navigationBarTitleDisplayMode(.inline)
    }
}
