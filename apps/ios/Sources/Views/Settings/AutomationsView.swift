import SwiftUI

/// Settings › Automations: every automation on this machine as a row (its name, when it next
/// starts or what starts it, and a loud word only when it failed or needs the person), with New
/// automation at the top. A row opens the automation: its schedule, actions and runs. Rows and
/// words come ready-made from the bridge (`automations.page`).
struct AutomationsView: View {
    let model: ClientModel
    @State private var page: AutomationPage?
    @State private var loading: Bool
    @State private var problem: String?
    @State private var creating = false
    @Environment(\.automationLinks) private var links
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var zone: String { TimeZone.current.identifier }
    private var request: [String: Any] { ["type": "automations.page", "zone": zone] }

    /// Opens on the last list this phone saw, read again behind it.
    init(model: ClientModel) {
        self.model = model
        let kept = model.kept(["type": "automations.page", "zone": TimeZone.current.identifier], as: AutomationPage.self)
        _page = State(initialValue: kept?.ok == true ? kept : nil)
        _loading = State(initialValue: kept == nil)
    }

    private var person: [AutomationListRow] { page?.person ?? [] }
    private var active: [AutomationListRow] { person.filter(\.enabled) }
    private var paused: [AutomationListRow] { person.filter { !$0.enabled } }
    private var threads: [AutomationListRow] { page?.threads ?? [] }
    private var unavailable: Bool { page?.unavailable == true }

    var body: some View {
        List {
            Section {
                Button { creating = true } label: {
                    Text("New automation").aceFont(InsetStyle.label, relativeTo: .body)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .disabled(!model.canOperate || unavailable)
                .accessibilityIdentifier("automations.new")
                if !model.canOperate {
                    ViewOnlyNote(message: "View only. To change automations from this phone, pair it again with View and act.")
                }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
            if loading && page == nil {
                Section { ForEach(0..<3, id: \.self) { _ in AutomationRowPlaceholder() } }
                    .insetRowBackground()
                    .transition(.opacity)
            } else if person.isEmpty && threads.isEmpty && problem == nil {
                Section {
                    Text("Automations run a task for you on a schedule, when a pull request or issue changes, or when files change. Each run opens its own thread.")
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .padding(.vertical, AceTheme.Spacing.sm)
                }
                .insetRowBackground()
                .transition(.opacity)
            }
            group("Upcoming", active)
            group("Paused", paused)
            group("In threads", threads)
        }
        .insetGroupedList()
        .animation(reduceMotion ? AceTheme.Motion.standardCurve : .smooth, value: page?.person ?? [])
        .animation(reduceMotion ? AceTheme.Motion.standardCurve : .smooth, value: loading)
        .navigationTitle("Automations").navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creating) {
            NavigationStack {
                AutomationEditor(model: model, editing: nil) { id in links?.open(id) }
            }
        }
        .task(id: model.readGeneration(request)) { await read(fresh: false) }
        .task { await poll() }
        .refreshable { await read(fresh: true) }
    }

    @ViewBuilder private func group(_ title: String, _ rows: [AutomationListRow]) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row in
                    Button { links?.open(row.id) } label: { AutomationListRowView(row: row) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("automation.row.\(row.id)")
                }
            } header: { InsetHeader(title) }
            .insetRowBackground()
            .transition(.opacity)
        }
    }

    private func read(fresh: Bool) async {
        defer { loading = false }
        var payload = request
        if fresh { payload["fresh"] = true }
        do {
            let next = try await model.read(payload, as: AutomationPage.self)
            if next.ok || next.unavailable == true { page = next }
            problem = next.ok ? nil : next.error ?? "Couldn't read automations."
        } catch { problem = error.localizedDescription }
    }

    /// Runs and next starts move on their own: read again soon while one runs, else each minute.
    private func poll() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(page?.pollMs ?? 60_000))
            if Task.isCancelled { return }
            await read(fresh: true)
        }
    }
}

/// One automation: its name, then when it next starts or what starts it, and a status word only
/// when there is one to act on.
struct AutomationListRowView: View {
    let row: AutomationListRow
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(InsetStyle.label, relativeTo: .body)
                    .foregroundStyle(row.enabled ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .lineLimit(2)
                Text(row.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if let status = row.status {
                StateLabel(status: status.status)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .transition(.opacity)
            }
            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold))
                .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityHidden(true)
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A row's shape while the first list loads, so nothing jumps when it arrives.
struct AutomationRowPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Capsule().fill(AceTheme.Colours.mutedForeground.opacity(0.18)).frame(width: 180, height: 12)
            Capsule().fill(AceTheme.Colours.mutedForeground.opacity(0.12)).frame(width: 120, height: 10)
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityLabel("Reading automations")
    }
}
