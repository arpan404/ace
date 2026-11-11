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
            .background(AceDesign.Surface.background)
            .overlay {
                if model.browser.logs?.state == "error" {
                    VStack {
                        Text(model.browser.logs?.message ?? "Couldn't read the log.").foregroundStyle(AceTheme.StatusText.failed)
                        Button("Retry") { send(clear: false) }.buttonStyle(.textAction())
                    }
                } else if model.browser.logs == nil || model.browser.logs?.state == "loading" {
                    SkeletonRows(label: "Reading log")
                } else if entries.isEmpty {
                    EmptyState(icon: .terminal, title: section == "console" ? "No messages" : "No requests")
                }
            }
            .pinnedTopBar {
                Picker("Log", selection: $section) {
                    Text("Console").tag("console")
                    Text("Network").tag("network")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.related)
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
        .tint(AceDesign.Ink.accent)
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
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            AceIcon(entry.level == "error" ? .xCircle : entry.level == "warning" ? .warning : .circle, size: AceDesign.Size.icon, relativeTo: .caption)
                .foregroundStyle(entry.level == "error" ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                .opacity(entry.level == "info" ? 0 : 1)
                .accessibilityElement(children: .ignore).accessibilityLabel(entry.level == "error" ? "Error" : entry.level == "warning" ? "Warning" : "")
            Text(entry.text)
                .font(AceDesign.Typeface.code)
                .foregroundStyle(entry.level == "error" ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                .textSelection(.enabled)
        }
        .browserRow()
        .contextMenu { Button("Copy", ace: .copy) { UIPasteboard.general.string = entry.text } }
    }

    private func requestRow(_ entry: BrowserLog.Entry) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(entry.url ?? entry.text).font(AceDesign.Typeface.code)
                .lineLimit(2).truncationMode(.middle)
            Text([entry.status, entry.method, entry.size, entry.time].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(entry.failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
        }
        .foregroundStyle(entry.failed ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
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
                    ScrollView { Image(uiImage: image).resizable().scaledToFit().padding(AceDesign.Space.margin) }
                } else {
                    EmptyState(icon: .camera, title: "Screenshot saved to this thread") {
                        Text(shot.path).aceMonospace(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
                    }
                }
            }
            .background(AceDesign.Surface.background)
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
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
}
