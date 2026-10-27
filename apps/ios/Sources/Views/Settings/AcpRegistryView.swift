import SwiftUI

struct RegistryRowData: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let publisher: String
    let description: String
    let version: String
    let standing: String?
    let tone: String?
    let unavailable: Bool
}
struct RegistryScreenData: Decodable, Equatable {
    let rows: [RegistryRowData]
    let age: String
    let empty: String?
    let noMatch: Bool
    let revalidate: Bool
}
private struct RegistryAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let screen: RegistryScreenData?
}

/// The ACP registry: search by name, publisher or what an agent does, open one to install it,
/// or add an agent the registry doesn't list by its command. The saved list shows at once and
/// is downloaded again behind it when it's old.
struct AcpRegistryView: View {
    let model: ClientModel
    @State private var query = ""
    @State private var screen: RegistryScreenData?
    @State private var problem: String?
    @State private var refreshing = false
    @State private var refreshProblem: String?
    @State private var revalidated = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        List {
            Group {
                Section {
                    NavigationLink { ManualAcpAgentView(model: model) } label: {
                        InsetRow("Add by command", systemImage: "terminal", subtitle: "For an agent the registry doesn't list")
                    }
                }
                if let screen {
                    Section {
                        ForEach(screen.rows) { row in
                            NavigationLink { AcpAgentView(model: model, agentId: row.id, name: row.name) } label: { RegistryRow(row: row) }
                        }
                        if let empty = screen.empty {
                            Text(empty).foregroundStyle(AceTheme.Colours.mutedForeground).transition(.opacity)
                            if screen.noMatch {
                                NavigationLink("Add one by command") { ManualAcpAgentView(model: model) }
                            }
                        }
                    } header: { InsetHeader("ACP registry") } footer: { footer(screen) }
                } else if problem == nil {
                    Section { ForEach(0..<5, id: \.self) { _ in RegistryRow.placeholder } }.redacted(reason: .placeholder)
                }
                if let problem {
                    Section {
                        ServiceProblem(message: problem)
                        Button("Retry") { Task { await read() } }
                    }
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.25), value: screen)
        .searchable(text: $query, prompt: "Search agents")
        .navigationTitle("Add agent").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(120)) }
            await read()
        }
        .refreshable { await refresh() }
        .sensoryFeedback(.success, trigger: refreshing) { was, now in was && !now && refreshProblem == nil }
    }
    private func footer(_ screen: RegistryScreenData) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if refreshing { ProgressView().controlSize(.mini); Text("Updating…") }
            else {
                Text(refreshProblem ?? screen.age).lineLimit(1)
                Button("Refresh") { Task { await refresh() } }.buttonStyle(.borderless).frame(minHeight: 44)
            }
        }
        .animation(.smooth(duration: 0.2), value: refreshing)
    }
    private func read() async {
        do {
            let answer = try await model.manage(["type": "acp.registry", "query": query], as: RegistryAnswer.self)
            screen = answer.screen; problem = nil
            if answer.screen?.revalidate == true, !revalidated {
                revalidated = true
                Task { await refresh() }
            }
        } catch { if !Task.isCancelled, screen == nil { problem = error.localizedDescription } }
    }
    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true; refreshProblem = nil
        do { _ = try await model.manage(["type": "acp.registry.refresh"], as: PlainAnswer.self, timeout: .seconds(60)) }
        catch { refreshProblem = error.localizedDescription }
        refreshing = false
        await read()
    }
}

/// One registry entry: name, publisher and what it is, with where it stands only when it matters.
private struct RegistryRow: View {
    let row: RegistryRowData
    static var placeholder: some View {
        RegistryRow(row: RegistryRowData(id: "", name: "Agent name", publisher: "Publisher", description: "What the agent does", version: "1.0.0", standing: nil, tone: nil, unavailable: false))
    }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text([row.publisher, row.description].filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if let standing = row.standing {
                Text(standing).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(row.tone == "needsYou" ? AceTheme.StatusText.needsYou : AceTheme.Colours.subtleForeground)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .opacity(row.unavailable ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}
