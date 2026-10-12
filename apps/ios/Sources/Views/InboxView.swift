import SwiftUI

struct InboxView: View {
    @Bindable var model: ClientModel
    @State private var path: [String] = []
    @State private var search = ""
    @State private var showingSearch = false
    @State private var showingMachines = false
    @State private var showSettled = false
    private var rows: [ThreadRow] {
        model.inbox.values.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.project.localizedCaseInsensitiveContains(search) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        NavigationStack(path: $path) {
            List {
                if showingSearch { TextField("Search threads", text: $search).textFieldStyle(.plain).accessibilityIdentifier("inbox.search") }
                if model.connection != "ready" {
                    Button { model.retry() } label: {
                        Label(model.connection == "fatal" ? "Connection needs attention" : "Connecting to your machine…", systemImage: "wifi.slash")
                            .font(.footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }.listRowSeparator(.hidden)
                }
                group("Needs you", state: "needs_you")
                let working = rows.filter { ["working", "waiting", "limited", "failed", "unresponsive", "new"].contains($0.state) && $0.snoozedUntil == nil }
                section("Working", entries: working)
                let unsent = model.pending.values.filter { ["saving", "sent", "failed"].contains($0.state) }
                if !unsent.isEmpty {
                    Section {
                        ForEach(unsent.sorted { $0.id < $1.id }) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(entry.text).lineLimit(2).font(.body)
                                Text(entry.state == "failed" ? "Send needs attention" : "Sends on reconnect").font(.caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                            }
                        }
                    } header: { sectionHeader("Unsent", count: unsent.count) }
                }
                DisclosureGroup(isExpanded: $showSettled) {
                    ForEach(rows.filter { $0.state == "done" || $0.snoozedUntil != nil }) { row in inboxRow(row) }
                } label: {
                    Text("Done today (\(rows.filter { $0.state == "done" }.count)) · Snoozed (\(rows.filter { $0.snoozedUntil != nil }.count))")
                        .font(.footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }.listRowSeparator(.hidden)
                if model.inboxLoaded && rows.isEmpty {
                    ContentUnavailableView("Your inbox is clear", systemImage: "tray", description: Text("Tasks from your machines will appear here."))
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 10) {
                        Text("ace.").font(.title3.weight(.bold)).foregroundStyle(AceTheme.Colours.foreground)
                        Button { showingMachines = true } label: {
                            HStack(spacing: 5) {
                                Circle().fill(model.connection == "ready" ? AceTheme.Status.done : AceTheme.Colours.decoration).frame(width: 5, height: 5)
                                Text("1 machine").font(.caption)
                            }.foregroundStyle(AceTheme.Colours.mutedForeground)
                        }.accessibilityLabel("Machines")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { withAnimation(.spring) { showingSearch.toggle() } } label: { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel("Search threads")
                }
            }
            .navigationDestination(for: String.self) { id in
                if let thread = model.thread, thread.id == id { ThreadView(model: model, thread: thread) }
            }
            .sheet(isPresented: $showingMachines) { machinesSheet }
            .onChange(of: path) { old, new in if !old.isEmpty && new.isEmpty { model.back() } }
        }
        .tint(AceTheme.Colours.foreground)
        .alert("Request needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }
    @ViewBuilder private func group(_ title: String, state: String) -> some View { section(title, entries: rows.filter { $0.state == state && $0.snoozedUntil == nil }) }
    @ViewBuilder private func section(_ title: String, entries: [ThreadRow]) -> some View {
        if !entries.isEmpty {
            Section { ForEach(entries) { row in inboxRow(row) } } header: { sectionHeader(title, count: entries.count) }
        }
    }
    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 10) {
            Text(title).font(.caption.weight(.medium)).textCase(nil)
            Rectangle().fill(AceTheme.Colours.separator).frame(height: 0.5)
            Text(count.formatted()).font(.caption.monospacedDigit())
        }.foregroundStyle(AceTheme.Colours.mutedForeground).padding(.vertical, 3)
    }
    private func inboxRow(_ row: ThreadRow) -> some View {
        Button { model.open(row.id); path.append(row.id) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Image(systemName: "folder").font(.caption2)
                    Text(row.project).font(.caption)
                    Spacer()
                    StateLabel(state: row.state)
                }.foregroundStyle(AceTheme.Colours.mutedForeground)
                Text(row.title).font(.body.weight(.medium)).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                HStack(spacing: 6) {
                    Text(row.branch).font(.caption2.monospaced()).lineLimit(1)
                    Text("· \(row.machine)").font(.caption2).lineLimit(1)
                    Spacer(minLength: 0)
                    if row.agents > 1 { Label("\(row.agents) agents", systemImage: "point.3.connected.trianglepath.dotted").font(.caption2) }
                }.foregroundStyle(AceTheme.Colours.mutedForeground)
            }.padding(.vertical, 7).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("thread.\(row.id)")
        .listRowBackground(row.state == "needs_you" ? AceTheme.Colours.needsYouSurface : AceTheme.Colours.background)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Archive", systemImage: "archivebox") { model.archive(row.id) }.tint(.secondary)
        }
        .contextMenu { Button("Archive", systemImage: "archivebox") { model.archive(row.id) } }
    }
    private var machinesSheet: some View {
        NavigationStack {
            List {
                Label(model.inbox.values.first?.machine ?? "Your machine", systemImage: "laptopcomputer")
                LabeledContent("Connection", value: model.connection)
                Text("Phase 0 connects to the local spike daemon. Pairing is part of the MVP.").font(.footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .navigationTitle("Machines").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingMachines = false } } }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}
