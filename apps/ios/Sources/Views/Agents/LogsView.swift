import SwiftUI
import UIKit

/// The thread's Logs, as the web's Logs tab: what the agents did as one timed list (sessions,
/// subagents, turns, shell commands and their exits, background work, questions, provider
/// notices), for the whole thread or one agent with the subagents under it. Scope, level and
/// sources are visible controls above the list; the search field filters the words; Copy takes
/// the lines shown. The bridge follows the log only while this is on screen.
struct LogsView: View {
    let model: ClientModel
    /// The scope it opens on: nil is the whole thread.
    var agentId: String? = nil
    @State private var query = LogsSheet.Query.all
    @State private var copying: String?
    @State private var copied = 0
    private var logs: LogsSheet? { model.sheets.logs }

    var body: some View {
        List {
            Section {
                if let logs {
                    if logs.earlier > 0 {
                        Button("Show earlier lines") { model.sheet(["kind": "logs.earlier"]) }
                            .font(AceDesign.Typeface.body).fontWeight(.semibold)
                            .foregroundStyle(AceDesign.Ink.primary)
                            .frame(minHeight: AceDesign.Size.tap)
                            .accessibilityHint("\(logs.earlier) earlier")
                            .accessibilityIdentifier("logs.earlier")
                    }
                    ForEach(logs.lines) { line in LogLineRow(line: line) }
                    if logs.lines.isEmpty {
                        EmptyState(icon: nil, title: logs.all == 0 ? "Nothing logged yet" : "No lines match")
                            .padding(.vertical, AceDesign.Space.section)
                    }
                }
            }
            .listRowSeparator(.hidden).listRowBackground(Color.clear)
            .listSectionSeparator(.hidden)
        }
        .pinnedTopBar { filters.padding(.horizontal, AceDesign.Space.margin) }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceDesign.Surface.background)
        .overlay(alignment: .top) { if logs == nil { SkeletonRows(label: "Loading logs").transition(.opacity) } }
        .searchable(text: $query.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter lines")
        .animation(.default, value: logs?.lines.count)
        .navigationTitle(logs?.scopeName ?? (query.agentId == nil ? "Logs" : "Agent log"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(copied > 0 ? "Copied" : "Copy") { copy() }
                    .disabled(logs?.lines.isEmpty ?? true || copying != nil)
                    .accessibilityIdentifier("logs.copy")
            }
        }
        .sensoryFeedback(.success, trigger: copied)
        .accessibilityIdentifier("logs.list")
        .onAppear {
            query.agentId = agentId
            model.sheet(["kind": "logs", "open": true, "query": query.json])
        }
        .onDisappear { model.sheet(["kind": "logs", "open": false]) }
        .onChange(of: query) { _, next in model.sheet(["kind": "logs", "open": true, "query": next.json]) }
        .onChange(of: copying.flatMap { model.sheets.copies[$0] }) { _, text in
            guard let id = copying, let text else { return }
            UIPasteboard.general.string = text
            model.sheets.copies[id] = nil
            copying = nil
            copied += 1
        }
    }

    /// Scope, level and sources as three capsules; each opens its own short list.
    private var filters: some View {
        ScrollView(.horizontal) {
            HStack(spacing: AceDesign.Space.related) {
                Menu {
                    Picker("Scope", selection: $query.agentId) {
                        Text("Whole thread").tag(String?.none)
                        ForEach(logs?.agents ?? []) { agent in Text(agent.name).tag(String?.some(agent.id)) }
                    }
                } label: { FilterChip(title: scopeTitle, active: query.agentId != nil) }
                .accessibilityIdentifier("logs.scope")
                Menu {
                    Picker("Level", selection: $query.level) {
                        Text("All levels").tag("all")
                        Text("Warnings and errors").tag("warn")
                        Text("Errors only").tag("error")
                    }
                } label: { FilterChip(title: levelTitle, active: query.level != "all") }
                .accessibilityIdentifier("logs.level")
                Menu {
                    ForEach(logs?.sources ?? []) { source in
                        Toggle(source.label, isOn: Binding(
                            get: { !query.hidden.contains(source.id) },
                            set: { shown in
                                if shown { query.hidden.removeAll { $0 == source.id } } else { query.hidden.append(source.id) }
                            }))
                    }
                    if !query.hidden.isEmpty { Button("Show every source") { query.hidden = [] } }
                } label: { FilterChip(title: sourcesTitle, active: !query.hidden.isEmpty) }
                .accessibilityIdentifier("logs.sources")
                if let logs, logs.total != logs.all {
                    Text("\(logs.total) of \(logs.all)").font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
        }
        .scrollIndicators(.hidden)
        .textCase(nil)
    }
    private var scopeTitle: String {
        guard let id = query.agentId else { return "Whole thread" }
        return logs?.agents.first { $0.id == id }?.name ?? "Agent"
    }
    private var levelTitle: String {
        switch query.level { case "warn": "Warnings and errors"; case "error": "Errors only"; default: "All levels" }
    }
    private var sourcesTitle: String {
        query.hidden.isEmpty ? "Every source" : "\((logs?.sources.count ?? 8) - query.hidden.count) sources"
    }
    private func copy() {
        let id = UUID().uuidString
        copying = id
        if !model.sheet(["kind": "logs.copy", "requestId": id]) { copying = nil }
    }
}

/// A filter's current choice in a capsule, with a chevron: filled while it narrows the log.
private struct FilterChip: View {
    let title: String
    let active: Bool
    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            Text(title).lineLimit(1)
            AceIcon(.caretDown, size: AceDesign.Size.icon, relativeTo: .caption)
        }
        .font(AceDesign.Typeface.body).fontWeight(active ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
        .foregroundStyle(active ? AceDesign.Ink.primary : AceDesign.Ink.muted)
        .padding(.horizontal, AceDesign.Space.row)
        .frame(minHeight: AceDesign.Size.tap - AceDesign.Space.related)
        .background(active ? AceDesign.Surface.fill : .clear, in: AceDesign.Shape.control)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(AceDesign.Shape.control)
    }
}

/// One line: its time and source on a quiet line over its words; warnings and errors say so in
/// their own words, and only an error is loud.
private struct LogLineRow: View {
    let line: LogsSheet.Line
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(spacing: AceDesign.Space.related) {
                Text(Date(timeIntervalSince1970: line.at / 1000), format: .dateTime.hour().minute().second())
                    .monospacedDigit()
                Text(line.sourceLabel)
                if line.level != "info" {
                    Text(line.level == "error" ? "Error" : "Warning")
                        .foregroundStyle(line.level == "error" ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                }
            }
            .font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.subtle)
            Group {
                if line.source == "shell" {
                    Text(line.text).font(AceDesign.Typeface.code)
                } else {
                    Text(line.text).font(AceDesign.Typeface.body).fontWeight(.regular)
                }
            }
            .foregroundStyle(AceDesign.Ink.primary)
            .textSelection(.enabled)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
    }
}
