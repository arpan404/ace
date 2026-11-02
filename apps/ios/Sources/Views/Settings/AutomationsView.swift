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
    @State private var made: String?
    @State private var restored = 0
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
                    Text("New automation").font(AceDesign.Typeface.body)
                        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .disabled(!model.canOperate || unavailable)
                .accessibilityIdentifier("automations.new")
                if !model.canOperate {
                    ViewOnlyNote(message: "View only. To change automations from this phone, pair it again with View and act.")
                }
                ServiceProblem(message: problem)
                if let off = page?.off {
                    // Nothing runs while the machine has automations off: said once, above the rows.
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(off.text).foregroundStyle(AceDesign.Ink.primary)
                        Text(off.fix).foregroundStyle(AceDesign.Ink.muted)
                    }
                    .font(AceDesign.Typeface.meta)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("automations.off")
                    .transition(.opacity)
                }
            }
            .insetRowBackground()
            if loading && page == nil {
                Section { ForEach(0..<3, id: \.self) { _ in AutomationRowPlaceholder() } }
                    .insetRowBackground()
                    .transition(.opacity)
            } else if person.isEmpty && threads.isEmpty && problem == nil {
                Section {
                    Text("Automations run a task for you on a schedule, when a pull request or issue changes, or when files change. Each run opens its own thread.")
                        .font(AceDesign.Typeface.title)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .padding(.vertical, AceDesign.Space.related)
                }
                .insetRowBackground()
                .transition(.opacity)
            }
            group("Upcoming", active)
            group("Paused", paused)
            group("In threads", threads)
        }
        .insetGroupedList()
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { undoStrip }
        .animation(AceDesign.Motion.arriving(reduceMotion), value: links?.undo.deleted)
        .sensoryFeedback(.success, trigger: restored)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: page?.person ?? [])
        .animation(AceDesign.Motion.arriving(reduceMotion), value: loading)
        .nativeTitle("Automations")
        // The new automation opens once the editor has gone, so the push never races its dismissal.
        .sheet(isPresented: $creating, onDismiss: {
            if let made { links?.open(made) }
            made = nil
        }) {
            NavigationStack {
                AutomationEditor(model: model, editing: nil) { id in made = id }
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

    /// "Deleted Nightly." with Undo, for a few seconds after an automation's Delete.
    @ViewBuilder private var undoStrip: some View {
        if let deleted = links?.undo.deleted {
            FilesStripView(message: "Deleted \(deleted.title).", action: ("Undo", { Task { await undo(deleted) } }),
                           dismiss: { links?.undo.deleted = nil })
                .accessibilityIdentifier("automations.undo")
                .task(id: deleted) {
                    try? await Task.sleep(for: .seconds(8))
                    if !Task.isCancelled, links?.undo.deleted == deleted { links?.undo.deleted = nil }
                }
        }
    }

    /// Makes the deleted automation again from its definition, under its own id.
    private func undo(_ deleted: AutomationUndo.Deleted) async {
        links?.undo.deleted = nil
        do {
            let reply = try await model.service(["type": "automations.restore", "automation": deleted.automation.any],
                                                as: AutomationWrite.self)
            guard reply.ok else { problem = reply.error ?? "Couldn't bring it back. Try again."; return }
            restored += 1
            await read(fresh: true)
        } catch { problem = error.localizedDescription }
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
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).font(AceDesign.Typeface.body)
                    .foregroundStyle(row.enabled ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                    .lineLimit(2)
                Text(row.detail).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
            }
            Spacer(minLength: AceDesign.Space.related)
            if let status = row.status {
                StateLabel(status: status.status)
                    .font(AceDesign.Typeface.meta)
                    .transition(.opacity)
            }
            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold))
                .foregroundStyle(AceDesign.Ink.muted).accessibilityHidden(true)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A row's shape while the first list loads, so nothing jumps when it arrives.
struct AutomationRowPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            // The bars trace a row's name and its schedule line: content geometry.
            SkeletonBar(width: 180, height: 12)
            SkeletonBar(width: 120, height: 10)
        }
        .padding(.vertical, AceDesign.Space.related)
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
        .accessibilityLabel("Reading automations")
    }
}
