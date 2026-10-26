import SwiftUI

/// The device's log tail while the sheet shows: newest at the end, warnings and errors in their
/// status colours. The search narrows it in the bridge, by the web's rule; Pause holds the lines.
struct DeviceLogsSheet: View {
    @Bindable var model: ClientModel
    let deviceId: String
    @Environment(\.dismiss) private var dismiss
    @State private var filter = ""
    @State private var held: DeviceLogs?
    private var devices: DevicesModel { model.devices }
    private var logs: DeviceLogs? { held ?? devices.logs.flatMap { $0.deviceId == deviceId ? $0 : nil } }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scroller in
                List {
                    if let logs {
                        if !logs.error.isEmpty {
                            Text(logs.error).foregroundStyle(AceTheme.Colours.mutedForeground)
                        } else if logs.lines.isEmpty {
                            Text(logs.total == 0 ? "No log lines yet." : "No lines match.").foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                        if logs.dropped > 0 { Text("\(logs.dropped) lines skipped").foregroundStyle(AceTheme.Colours.subtleForeground) }
                        ForEach(Array(logs.lines.enumerated()), id: \.offset) { index, line in
                            Text(line.text)
                                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                                .foregroundStyle(colour(line.level))
                                .textSelection(.enabled)
                                .id(index)
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, 0)
                .onChange(of: logs?.lines.count) { _, count in
                    if let count, count > 0, held == nil { scroller.scrollTo(count - 1, anchor: .bottom) }
                }
            }
            .searchable(text: $filter, prompt: "Filter logs")
            .navigationTitle("Logs").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", ace: .x) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button(held == nil ? "Pause" : "Resume", ace: held == nil ? .pause : .play) {
                        held = held == nil ? logs : nil
                    }
                    .accessibilityIdentifier("devices.logs.pause")
                }
            }
            .onChange(of: filter) { _, text in held = nil; devices.showLogs(model, deviceId: deviceId, filter: text) }
            .onAppear { devices.showLogs(model, deviceId: deviceId, filter: filter) }
            .onDisappear { devices.hideLogs(model, deviceId: deviceId) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func colour(_ level: String) -> Color {
        switch level {
        case "error": AceTheme.StatusText.failed
        case "warning": AceTheme.StatusText.needsYou
        default: AceTheme.Colours.mutedForeground
        }
    }
}

/// The accessibility tree agents read, with their `@eN` refs, read again on demand.
struct DeviceTreeSheet: View {
    @Bindable var model: ClientModel
    let deviceId: String
    let live: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var tree: DeviceTree?
    @State private var failure: String?
    @State private var reading = false
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if !live {
                    Text("Start the live view to read the screen.").foregroundStyle(AceTheme.Colours.mutedForeground)
                } else if let failure {
                    Text("Couldn't read the screen. \(failure)").foregroundStyle(AceTheme.Colours.mutedForeground)
                } else if let tree {
                    if tree.rows.isEmpty { Text("Nothing on screen to read.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                    ForEach(shown(tree)) { row in
                        HStack(spacing: AceTheme.Spacing.sm) {
                            if !row.ref.isEmpty {
                                Text("@\(row.ref)").aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                            }
                            Text(row.role).foregroundStyle(AceTheme.Colours.mutedForeground)
                            if !row.name.isEmpty { Text(row.name).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1) }
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .padding(.leading, query.isEmpty ? CGFloat(row.depth) * AceTheme.Spacing.md : 0)
                        .accessibilityElement(children: .combine)
                    }
                    if tree.truncated { Text("The tree is cut short here.").foregroundStyle(AceTheme.Colours.subtleForeground) }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 36)
            .searchable(text: $query, prompt: "Search elements")
            .navigationTitle("UI tree").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", ace: .x) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Read again", ace: .arrowClockwise) { Task { await read() } }.disabled(!live || reading)
                }
            }
            .task { if live { await read() } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func shown(_ tree: DeviceTree) -> [DeviceTree.Row] {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return tree.rows }
        return tree.rows.filter { "\($0.ref) \($0.role) \($0.name)".localizedCaseInsensitiveContains(words) }
    }
    private func read() async {
        reading = true
        defer { reading = false }
        do { tree = try await model.devices.tree(model, deviceId: deviceId); failure = nil }
        catch { failure = error.localizedDescription }
    }
}
