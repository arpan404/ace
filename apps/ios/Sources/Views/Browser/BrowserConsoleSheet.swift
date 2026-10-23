import SwiftUI
import UIKit

/// The shown tab's console messages and network requests: the log agents read. Console filters
/// by level, Network can show only failures; Clear hides what is listed now (agents keep theirs).
struct BrowserConsoleSheet: View {
    @Bindable var model: ClientModel
    @State private var section = "console"
    @State private var level = "all"
    @State private var requests = "all"
    private var entries: [BrowserLog.Entry] {
        guard let logs = model.browser.logs, logs.section == section else { return [] }
        return logs.entries
    }

    var body: some View {
        NavigationStack {
            List(entries) { entry in
                if section == "console" { consoleRow(entry) } else { requestRow(entry) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .overlay {
                if entries.isEmpty {
                    EmptyState(icon: .terminal, title: section == "console" ? "No messages" : "No requests")
                }
            }
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                Picker("Log", selection: $section) {
                    Text("Console").tag("console")
                    Text("Network").tag("network")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .accessibilityIdentifier("browser.console.section")
            }
            .navigationTitle("Console").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                ToolbarItemGroup(placement: .primaryAction) {
                    filter
                    Button("Clear", ace: .prohibit) { send(clear: true) }
                        .accessibilityIdentifier("browser.console.clear")
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .onChange(of: [section, level, requests], initial: true) { send(clear: false) }
        .onDisappear { model.closeBrowserConsole() }
    }

    @ViewBuilder private var filter: some View {
        if section == "console" {
            Menu {
                Picker("Level", selection: $level) {
                    Text("All levels").tag("all")
                    Text("Errors").tag("error")
                    Text("Warnings").tag("warning")
                    Text("Info").tag("info")
                }
            } label: { Label("Level", ace: .funnelSimple) }
            .accessibilityIdentifier("browser.console.level")
        } else {
            Menu {
                Picker("Requests", selection: $requests) {
                    Text("All requests").tag("all")
                    Text("Failed").tag("failed")
                }
            } label: { Label("Requests", ace: .funnelSimple) }
        }
    }

    private func send(clear: Bool) {
        model.browserConsole(section: section, level: level, requests: requests, clear: clear)
    }

    private func consoleRow(_ entry: BrowserLog.Entry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            AceIcon(entry.level == "error" ? .xCircle : entry.level == "warning" ? .warning : .circle, size: 14, relativeTo: .caption)
                .foregroundStyle(entry.level == "error" ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                .opacity(entry.level == "info" ? 0 : 1)
                .accessibilityElement(children: .ignore).accessibilityLabel(entry.level == "error" ? "Error" : entry.level == "warning" ? "Warning" : "")
            Text(entry.text)
                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                .foregroundStyle(entry.level == "error" ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
                .textSelection(.enabled)
        }
        .browserRow()
        .contextMenu { Button("Copy", ace: .copy) { UIPasteboard.general.string = entry.text } }
    }

    private func requestRow(_ entry: BrowserLog.Entry) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(entry.url ?? entry.text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                .lineLimit(2).truncationMode(.middle)
            Text([entry.status, entry.method, entry.size, entry.time].filter { !$0.isEmpty }.joined(separator: " · "))
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(entry.failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
        }
        .foregroundStyle(entry.failed ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
        .browserRow()
    }
}

/// A screenshot the person took: shown, then shared or saved from the share sheet.
struct BrowserShotSheet: View {
    let shot: BrowserShot
    @Environment(\.dismiss) private var dismiss
    private var image: UIImage? { shot.data.flatMap { Data(base64Encoded: $0) }.flatMap(UIImage.init(data:)) }
    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView { Image(uiImage: image).resizable().scaledToFit().padding(AceTheme.Spacing.lg) }
                } else {
                    EmptyState(icon: .camera, title: "Screenshot saved to this thread", line: shot.path)
                }
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Screenshot").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if let image {
                    ToolbarItem(placement: .primaryAction) {
                        let picture = Image(uiImage: image)
                        ShareLink(item: picture, preview: SharePreview("Screenshot", image: picture))
                            .accessibilityIdentifier("browser.shot.share")
                    }
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
}
