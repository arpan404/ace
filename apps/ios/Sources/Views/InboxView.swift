import SwiftUI

/// The single inbox (issue #560): the bridge's shared sections in order, Done and Snoozed folded
/// away below. Swift filters by search text and draws; grouping and wording come from the SDK side.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: ClientModel
    @State private var path: [String] = []
    @State private var search = ""
    @State private var showingSearch = false
    @State private var showingMachines = false
    @State private var showSettled = false
    @State private var snoozing: ThreadRow?
    @State private var archived: ThreadRow?
    private static let settledKeys: Set<String> = ["done", "snoozed"]

    private var sections: [InboxLayout.Section] { model.inboxLayout.sections.compactMap(filtered) }
    private var open: [InboxLayout.Section] { sections.filter { !Self.settledKeys.contains($0.key) } }
    private var settled: [InboxLayout.Section] { sections.filter { Self.settledKeys.contains($0.key) } }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if showingSearch {
                    TextField("Search threads", text: $search).textFieldStyle(.plain).accessibilityIdentifier("inbox.search")
                }
                if model.connection != "ready" {
                    InboxConnectionBanner(connection: model.connection) { model.retry() }.listRowSeparator(.hidden)
                }
                if !model.canOperate { ViewOnlyNote.inbox.listRowSeparator(.hidden) }
                ForEach(open) { section in
                    Section { rows(section) } header: { InboxSectionHeader(title: section.label, count: section.ids.count) }
                }
                if !settled.isEmpty {
                    Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showSettled.toggle() } } label: {
                        HStack(spacing: AceTheme.Spacing.md) {
                            Text(settled.map { "\($0.label) (\($0.ids.count))" }.joined(separator: " · "))
                            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                            Image(systemName: "chevron.down").rotationEffect(.degrees(showSettled ? 180 : 0))
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("inbox.settled")
                    .accessibilityValue(showSettled ? "Expanded" : "Collapsed")
                    if showSettled {
                        ForEach(settled) { section in
                            Section { rows(section) } header: { InboxSectionHeader(title: section.label, count: section.ids.count) }
                        }
                    }
                }
                if model.inboxLayout.more && search.isEmpty {
                    Button("Show older threads") { model.loadOlderThreads() }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .listRowSeparator(.hidden).accessibilityIdentifier("inbox.more")
                }
                emptyState.listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .refreshable { await refresh() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .navigationDestination(for: String.self) { id in
                if let thread = model.thread, thread.id == id { ThreadView(model: model, thread: thread) }
            }
            .sheet(isPresented: $showingMachines) { machinesSheet }
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { row in
                ForEach(model.inboxLayout.snooze) { option in
                    Button(option.label) { Task { _ = await model.snooze(row.id, preset: option.id) } }
                }
            }
            .overlay(alignment: .bottom) { undoArchive }
            .onChange(of: path) { old, new in if !old.isEmpty && new.isEmpty { model.back() } }
        }
        .tint(AceTheme.Colours.foreground)
        .alert("Request needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    @ViewBuilder private func rows(_ section: InboxLayout.Section) -> some View {
        if section.key == "unsent" {
            ForEach(section.ids, id: \.self) { id in
                if let entry = model.pending[id] {
                    Button { openThread(entry.threadId) } label: { InboxUnsentRow(entry: entry, thread: model.inbox[entry.threadId]) }
                        .buttonStyle(.plain).accessibilityIdentifier("unsent.\(id)")
                }
            }
        } else {
            ForEach(section.ids, id: \.self) { id in
                if let row = model.inbox[id] { threadRow(row, section: section.key) }
            }
        }
    }
    private func threadRow(_ row: ThreadRow, section: String) -> some View {
        let snoozed = section == "snoozed"
        return Button { openThread(row.id) } label: { InboxThreadRow(row: row, snoozed: snoozed) }
            .buttonStyle(.plain)
            .accessibilityIdentifier("thread.\(row.id)")
            .listRowBackground(section == "needs-you" ? AceTheme.Colours.needsYouSurface : AceTheme.Colours.background)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if model.canOperate { Button("Archive", systemImage: "archivebox") { archive(row) }.tint(AceTheme.Colours.mutedForeground) }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: snoozed) {
                if !model.canOperate { EmptyView() }
                else if snoozed { Button("Wake", systemImage: "sun.max") { Task { _ = await model.wake(row.id) } }.tint(AceTheme.Status.waiting) }
                else { Button("Snooze", systemImage: "moon.zzz") { snoozing = row }.tint(AceTheme.Status.waiting) }
            }
            .contextMenu {
                if !model.canOperate { EmptyView() }
                else if snoozed { Button("Wake", systemImage: "sun.max") { Task { _ = await model.wake(row.id) } } }
                else {
                    Menu("Snooze", systemImage: "moon.zzz") {
                        ForEach(model.inboxLayout.snooze) { option in
                            Button(option.label) { Task { _ = await model.snooze(row.id, preset: option.id) } }
                        }
                    }
                }
                if model.canOperate { Button("Archive", systemImage: "archivebox") { archive(row) } }
            }
    }
    @ViewBuilder private var emptyState: some View {
        if sections.isEmpty {
            if !search.isEmpty && !model.inboxLayout.sections.isEmpty { ContentUnavailableView.search(text: search) }
            else if !model.inboxLoaded {
                if model.connection == "fatal" || model.connection == "offline" {
                    ContentUnavailableView {
                        Label("Can't reach your machine", systemImage: "wifi.slash")
                    } description: { Text("Your threads appear once it's back.") } actions: { Button("Retry") { model.retry() } }
                } else {
                    ContentUnavailableView { Label { Text("Connecting to your machine…") } icon: { ProgressView() } }
                }
            } else {
                ContentUnavailableView("Your inbox is clear", systemImage: "tray", description: Text("Tasks from your machines appear here."))
            }
        }
    }
    @ViewBuilder private var undoArchive: some View {
        if let row = archived {
            HStack(spacing: AceTheme.Spacing.md) {
                Text("Archived “\(row.title)”").lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button("Undo") { archived = nil; Task { _ = await model.unarchive(row.id) } }.bold().accessibilityIdentifier("inbox.undoArchive")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            .floatingGlass()
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.md)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: row.id) {
                try? await Task.sleep(for: .seconds(5))
                if archived?.id == row.id { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { archived = nil } }
            }
        }
    }
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            Text("ace.").aceFont(AceTheme.Typography.wordmark, relativeTo: .title3).fixedSize(horizontal: true, vertical: false).foregroundStyle(AceTheme.Colours.foreground)
            Button { showingMachines = true } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Circle().fill(model.connection == "ready" ? AceTheme.Status.done : AceTheme.Colours.decoration).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
                    Text("1 machine").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                }.foregroundStyle(AceTheme.Colours.mutedForeground)
            }.accessibilityLabel("Machines")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showingSearch.toggle(); if !showingSearch { search = "" } } } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search threads")
        }
    }
    private var machinesSheet: some View {
        NavigationStack {
            List {
                Label(model.inbox.values.first?.machine ?? "Your machine", systemImage: "laptopcomputer")
                LabeledContent("Connection", value: model.connection)
            }
            .navigationTitle("Machines").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingMachines = false } } }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private func filtered(_ section: InboxLayout.Section) -> InboxLayout.Section? {
        guard !search.isEmpty else { return section }
        let ids = section.ids.filter { id in
            let row = section.key == "unsent" ? model.pending[id].flatMap { model.inbox[$0.threadId] } : model.inbox[id]
            let text = section.key == "unsent" ? model.pending[id]?.text ?? "" : ""
            return [row?.title ?? "", row?.project ?? "", text].contains { $0.localizedCaseInsensitiveContains(search) }
        }
        return ids.isEmpty ? nil : InboxLayout.Section(key: section.key, label: section.label, ids: ids)
    }
    private func openThread(_ id: String) {
        guard model.inbox[id] != nil else { return }
        model.open(id); path.append(id)
    }
    private func archive(_ row: ThreadRow) {
        Task {
            guard await model.archive(row.id) else { return }
            withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { archived = row }
        }
    }
    /// The list is live; a pull asks the SDK to reconnect now and waits briefly for it.
    private func refresh() async {
        guard model.connection != "ready" else { return }
        model.retry()
        for _ in 0..<20 where model.connection != "ready" { try? await Task.sleep(for: .milliseconds(100)) }
    }
}
