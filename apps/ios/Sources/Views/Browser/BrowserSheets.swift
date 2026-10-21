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
        case .settings:
            NavigationStack {
                if let category = RemoteSettingsCategory.all.first(where: { $0.settings.contains { $0.key.hasPrefix("browser.") } }) {
                    RemoteSettingsView(model: model, category: category)
                        .navigationTitle("Browser settings")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { SheetClose() }
                }
            }
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }
}

extension View {
    /// A hairline row on the page colour, with no rule above the first.
    func browserRow() -> some View {
        listRowBackground(AceTheme.Colours.background).listRowSeparator(.hidden, edges: .top)
    }
}

/// The X that closes a sheet.
struct SheetClose: ToolbarContent {
    @Environment(\.dismiss) private var dismiss
    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
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
                    .accessibilityIdentifier("browser.tab.\(tab.id)")
                }
                if let more = state?.moreTabs, more > 0 {
                    Text("\(more) more tabs").foregroundStyle(AceTheme.Colours.mutedForeground)
                        .browserRow()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .overlay {
                if state?.tabs.isEmpty ?? true { ContentUnavailableView("No tabs open", systemImage: "square.on.square") }
            }
            .navigationTitle(tabCount)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if model.canOperate {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New tab", systemImage: "plus") {
                            model.browserNewTab()
                            dismiss()
                        }
                        .accessibilityIdentifier("browser.newTab")
                    }
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private var tabCount: String {
        let count = (state?.tabs.count ?? 0) + (state?.moreTabs ?? 0)
        return count == 1 ? "1 tab" : "\(count) tabs"
    }
    private func row(_ tab: BrowserViewInfo.Tab) -> some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: tab.agent != nil ? "cursorarrow" : tab.private == true ? "hand.raised" : "globe")
                .font(.system(size: 17))
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(tab.title).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text(detail(tab)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if tab.loading == true { ProgressView().controlSize(.small) }
            if tab.id == state?.activeTabId {
                Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.foreground).accessibilityLabel("Shown")
            }
        }
        .frame(minHeight: InsetStyle.rowHeight)
        .contentShape(Rectangle())
    }
    private func detail(_ tab: BrowserViewInfo.Tab) -> String {
        let host = (tab.host ?? "").isEmpty ? "New tab" : tab.host ?? ""
        if let agent = tab.agent { return "\(host) · \(agent) is using it" }
        if tab.private == true { return "\(host) · Agents kept out" }
        return host
    }
}

/// What the thread's tabs downloaded. Files stay on the machine running the browser.
struct BrowserDownloadsSheet: View {
    @Bindable var model: ClientModel
    private var downloads: [BrowserViewInfo.Download] { model.browser.view?.state?.downloads ?? [] }
    var body: some View {
        NavigationStack {
            List(downloads) { download in
                HStack(spacing: AceTheme.Spacing.md) {
                    Image(systemName: "doc").font(.system(size: 19)).foregroundStyle(AceTheme.Colours.mutedForeground).frame(width: 24)
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(download.filename).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).lineLimit(1)
                        Text(detail(download)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(download.failed || download.risky ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                            .lineLimit(2)
                    }
                }
                .frame(minHeight: InsetStyle.rowHeight)
                .browserRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .overlay { if downloads.isEmpty { ContentUnavailableView("Nothing downloaded yet", systemImage: "arrow.down.circle") } }
            .navigationTitle("Downloads").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
    private func detail(_ download: BrowserViewInfo.Download) -> String {
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
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(visit.title.isEmpty ? visit.url : visit.title)
                            .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                        Text("\(URL(string: visit.url)?.host() ?? visit.url) · \(Date(timeIntervalSince1970: visit.at / 1000).formatted(.relative(presentation: .named)))")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }
                    .frame(minHeight: InsetStyle.rowHeight, alignment: .leading)
                }
                .browserRow()
                .swipeActions { Button("Forget", role: .destructive) { model.browserForget(visit) } }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .searchable(text: $query, prompt: "Search history")
            .overlay {
                if found.isEmpty {
                    ContentUnavailableView(model.browser.visitCount == 0 ? "No history yet" : "No matches", systemImage: "clock.arrow.circlepath")
                }
            }
            .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onChange(of: query, initial: true) { model.browserVisits(open: true, query: query) }
        .onDisappear { model.browserVisits(open: false) }
    }
}
