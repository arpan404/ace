import SwiftUI

/// The sheet a browser screen opened.
struct BrowserSheets: View {
    @Bindable var model: ClientModel
    let sheet: BrowserSheet
    var body: some View {
        switch sheet {
        case .tabs: BrowserTabsSheet(model: model)
        case .console: BrowserConsoleSheet(model: model)
        case .history: BrowserHistorySheet(model: model)
        case .downloads: BrowserDownloadsSheet(model: model)
        case .source: BrowserSourceSheet(model: model)
        case .sizes: BrowserSizesSheet(model: model)
        case .extensions: BrowserExtensionsSheet(model: model)
        case .settings:
            NavigationStack {
                RemoteSettingsView(model: model, category: .browser)
                    .navigationTitle("Browser settings")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { SheetClose() }
            }
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }
}

extension View {
    /// A hairline row on the page colour, with no rule above the first.
    func browserRow() -> some View {
        listRowBackground(AceDesign.Surface.background).listRowSeparator(.hidden, edges: .top)
    }
}

/// The X that closes a sheet.
struct SheetClose: ToolbarContent {
    @Environment(\.dismiss) private var dismiss
    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: { AceIcon(.x) }.accessibilityLabel("Close")
        }
    }
}

/// The thread's tabs, the person's and every agent's: the shown one ticked, an agent's marked
/// with its name. Tap to show one, swipe to close it, + for a new tab.
struct BrowserTabsSheet: View {
    @Bindable var model: ClientModel
    @Environment(\.dismiss) private var dismiss
    private var state: BrowserViewInfo.State? { model.browser.view?.state }

    var body: some View {
        NavigationStack {
            List {
                ForEach(state?.tabs ?? []) { tab in
                    Button {
                        model.browserSelectTab(tab.id)
                        dismiss()
                    } label: { row(tab) }
                    .browserRow()
                    .swipeActions {
                        if model.canOperate {
                            Button("Close", role: .destructive) { model.browserCloseTab(tab.id) }
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .accessibilityIdentifier("browser.tab.\(tab.id)")
                }
                if let more = state?.moreTabs, more > 0 {
                    Button("Show \(more) more tabs") { model.action(["type": "browser", "action": ["kind": "tabs.more"]]) }.buttonStyle(.textAction())
                        .browserRow()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .overlay {
                if state?.tabs.isEmpty ?? true { EmptyState(icon: .browsers, title: "No tabs open") }
            }
            .navigationTitle(tabCount)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if model.canOperate {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New tab", ace: .plus) {
                            model.browserNewTab()
                            dismiss()
                        }
                        .accessibilityIdentifier("browser.newTab")
                    }
                }
            }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private var tabCount: String {
        let count = (state?.tabs.count ?? 0) + (state?.moreTabs ?? 0)
        return count == 1 ? "1 tab" : "\(count) tabs"
    }
    private func row(_ tab: BrowserViewInfo.Tab) -> some View {
        QuietSectionRow {
            QuietRowText(title: tab.title, detail: detail(tab))
            if tab.loading == true { WorkingMark(label: "Loading") }
            if tab.id == state?.activeTabId {
                AceIcon(.check).foregroundStyle(AceDesign.Ink.primary)
                    .accessibilityElement(children: .ignore).accessibilityLabel("Shown")
            }
        }

    }
    private func detail(_ tab: BrowserViewInfo.Tab) -> String {
        let host = (tab.host ?? "").isEmpty ? "New tab" : tab.host ?? ""
        if let agent = tab.agent { return "\(host) · \(agent) is using it" }
        if tab.private == true { return "\(host) · Agents kept out" }
        return host
    }
}

/// What the thread's tabs downloaded, on the machine running the browser. A finished file can
/// be saved onto this phone: Save copies it over, then Share offers it to Files or any app.
struct BrowserDownloadsSheet: View {
    @Bindable var model: ClientModel
    private var downloads: [BrowserViewInfo.Download] { model.browser.view?.state?.downloads ?? [] }
    var body: some View {
        NavigationStack {
            List(downloads) { download in
                QuietSectionRow {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(download.filename).aceMonospace(AceDesign.TextRole.rowTitle, relativeTo: .callout).lineLimit(1)
                        Text(detail(download)).font(AceDesign.Typeface.meta)
                            .foregroundStyle(download.failed || download.risky || saving(download)?.phase == "failed" ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                            .lineLimit(2)
                            .contentTransition(.opacity)
                    }
                    Spacer(minLength: AceDesign.Space.related)
                    save(download)
                }
                .listRowInsets(EdgeInsets())
                .animation(.default, value: saving(download))
                .browserRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .overlay { if downloads.isEmpty { EmptyState(icon: .arrowCircleDown, title: "Nothing downloaded yet") } }
            .navigationTitle("Downloads").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
    private func saving(_ download: BrowserViewInfo.Download) -> BrowserSaving? {
        model.browser.threadId.flatMap { model.browser.saving[BrowserSaving.key(threadId: $0, downloadId: download.id)] }
    }
    /// Save, then its progress, then Share once the file is on the phone.
    @ViewBuilder private func save(_ download: BrowserViewInfo.Download) -> some View {
        let saving = saving(download)
        if saving?.phase == "ready", let saving,
           let file = SavedFiles(scope: model.hostId ?? "").file(id: saving.key, name: download.filename) {
            ShareLink(item: file) { Text("Share") }
                .buttonStyle(.textAction())
                .frame(minHeight: AceDesign.Size.tap)
                .transition(.opacity)
                .accessibilityIdentifier("browser.download.share")
        } else if saving?.phase == "saving" {
            Button { model.browserSaveCancel(download.id) } label: {
                HStack(spacing: AceDesign.Space.related) {
                    ProgressView(value: saving?.progress ?? 0).progressViewStyle(.circular)
                    Text("Stop")
                }
            }
            .buttonStyle(.textAction())
            .accessibilityLabel("Stop saving")
            .accessibilityValue("\(Int((saving?.progress ?? 0) * 100)) percent")
            .transition(.opacity)
        } else if download.saveable == true {
            Button(saving?.phase == "failed" ? "Retry" : "Save") { model.browserSave(download.id) }
                .buttonStyle(.textAction())
                .frame(minHeight: AceDesign.Size.tap)
                .transition(.opacity)
                .accessibilityLabel("Save to this phone")
                .accessibilityIdentifier("browser.download.save")
        }
    }
    private func detail(_ download: BrowserViewInfo.Download) -> String {
        if let saving = saving(download) {
            switch saving.phase {
            case "ready": return "On this phone"
            case "failed": return saving.message ?? "Couldn't save it to this phone"
            default: return "Saving to this phone…"
            }
        }
        var parts = [download.state]
        if download.bytes > 0 { parts.append(ByteCountFormatter.string(fromByteCount: Int64(download.bytes), countStyle: .file)) }
        if download.risky { parts.append("Executable: check it before running") }
        return parts.joined(separator: " · ")
    }
}

/// The pages this thread's browser showed on this phone, newest first, searchable. Tap one to
/// open it in the shown tab; swipe to forget it.
struct BrowserHistorySheet: View {
    @Bindable var model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    /// The visits matching the search, as the bridge filters them.
    private var found: [BrowserVisit] { model.browser.visits }
    var body: some View {
        NavigationStack {
            List(found) { visit in
                Button {
                    model.browserGo(visit.url)
                    dismiss()
                } label: {
                    QuietSectionRow {
                        QuietRowText(title: visit.title.isEmpty ? visit.url : visit.title,
                                     detail: "\(URL(string: visit.url)?.host() ?? visit.url) · \(Date(timeIntervalSince1970: visit.at / 1000).formatted(.relative(presentation: .named)))")
                        RowCaret()
                    }
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
                .browserRow()
                .swipeActions { Button("Forget", role: .destructive) { model.browserForget(visit) } }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .searchable(text: $query, prompt: "Search history")
            .overlay {
                if found.isEmpty {
                    EmptyState(icon: .clockCounterClockwise, title: model.browser.visitCount == 0 ? "No history yet" : "No matches")
                }
            }
            .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onChange(of: query, initial: true) { model.browserVisits(open: true, query: query) }
        .onDisappear { model.browserVisits(open: false) }
    }
}
