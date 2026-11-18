import SwiftUI

/// `machine.software` (`bridge/machine-software.ts`): the machine's ace version, the release on
/// offer, the update's progress or result, and what this phone may do about it.
struct MachineSoftwareData: Decodable, Equatable {
    struct Action: Decodable, Equatable, Identifiable { let action: String; let label: String; var id: String { action } }
    struct Link: Decodable, Equatable { let words: String; let url: String }
    struct Confirm: Decodable, Equatable { let title: String; let body: String; let confirm: String; let agents: Int }
    let line: String
    let progress: String?
    let progressTone: String
    let actions: [Action]
    let link: Link?
    let note: String?
    let confirm: Confirm?
    let updating: Bool
    /// False when the machine didn't answer and this is the last status it gave.
    let reachable: Bool
    let problem: String?

    /// The request for `action`; Update now carries the agents the person agreed to stop.
    static func act(_ action: String, name: String, access: String, agents: Int? = nil) -> [String: Any] {
        var request: [String: Any] = ["type": "machine.software.act", "name": name, "access": access, "action": action]
        if let agents { request["agents"] = agents }
        return request
    }
    static func read(name: String, access: String) -> [String: Any] {
        ["type": "machine.software", "name": name, "access": access]
    }
}

/// A machine page's Software, as web's: the version line, progress while an update runs, then
/// Update when idle beside Update now (asked first, naming the agents it stops), Cancel or Check,
/// as one row of buttons.
struct MachineSoftwareSection: View {
    let model: ClientModel
    let name: String
    @State private var software: MachineSoftwareFollow
    @State private var acting = false
    @State private var confirming = false
    /// Moves when an action starts an update: the page's read task follows it from there.
    @State private var round = 0

    init(model: ClientModel, name: String) {
        self.model = model
        self.name = name
        let label = Self.label(name)
        _software = State(initialValue: MachineSoftwareFollow(fetch: { [weak model] in
            guard let model else { throw CancellationError() }
            return try await model.service(MachineSoftwareData.read(name: label, access: Self.access(model)), as: MachineSoftwareData.self)
        }))
    }

    private static func access(_ model: ClientModel) -> String { model.canAdmin.map { $0 ? "admin" : "read" } ?? "unknown" }
    private static func label(_ name: String) -> String { String((name.isEmpty ? "This machine" : name).prefix(128)) }
    private var data: MachineSoftwareData? { software.data }

    var body: some View {
        Section {
            if let data {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(data.line).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                    if let progress = data.progress {
                        HStack(spacing: AceDesign.Space.related) {
                            if data.updating { WorkingMark(label: "Updating") }
                            if data.progressTone == "off" {
                                Text(progress).foregroundStyle(AceDesign.Ink.muted)
                            } else {
                                StateLabel(status: StatusDisplay(label: progress, token: data.progressTone == "warn" ? "failed" : "done"))
                            }
                        }
                        .font(AceDesign.Typeface.meta)
                        .transition(.opacity)
                    }
                    if let note = data.note {
                        Text(note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .smoothChange(data)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("machine.software")
                if !data.actions.isEmpty { actions(data.actions) }
                if let link = data.link, let url = URL(string: link.url), url.scheme == "https" {
                    Link(link.words, destination: url)
                }
            } else {
                Text(model.connection == "ready" ? "Reading its version…" : "Its version shows when it's back online.")
                    .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            if let problem = software.problem ?? data?.problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("service.problem")
            }
        } header: { InsetHeader("Software") }
        .insetRowBackground()
        .disabled(acting)
        .sensoryFeedback(.success, trigger: data?.progressTone == "on") { _, on in on }
        .confirmationDialog(data?.confirm?.title ?? "", isPresented: $confirming, titleVisibility: .visible, presenting: data?.confirm) { confirm in
            Button(confirm.confirm, role: .destructive) { act("now", agents: confirm.agents) }
                .accessibilityIdentifier("machine.software.now.confirm")
        } message: { confirm in Text(confirm.body) }
        // Read when connected, and while an update runs follow it to its result (`MachineSoftwareFollow`).
        .readWhenConnected(model, id: "\(name)/\(round)") { await software.follow() }
    }

    /// The offered actions as one row of buttons, side by side: the first (Update when idle, or
    /// Check) is the way forward, the rest sit beside it. They stack when they don't fit.
    private func actions(_ entries: [MachineSoftwareData.Action]) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: AceDesign.Space.related) { actionButtons(entries) }
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) { actionButtons(entries) }
        }
        .padding(.vertical, AceDesign.Space.tight)
    }

    @ViewBuilder private func actionButtons(_ entries: [MachineSoftwareData.Action]) -> some View {
        ForEach(entries) { entry in
            let button = Button(entry.label) {
                if entry.action == "now" { confirming = true } else { act(entry.action) }
            }
            Group {
                if entry.id == entries.first?.id { button.buttonStyle(.primaryAction) } else { button.buttonStyle(.secondaryAction) }
            }
            .fixedSize()
            .accessibilityIdentifier("machine.software.\(entry.action)")
        }
    }

    private func act(_ action: String, agents: Int? = nil) {
        acting = true
        Task {
            defer { acting = false }
            do {
                let request = MachineSoftwareData.act(action, name: Self.label(name), access: Self.access(model), agents: agents)
                let next = try await model.service(request, as: MachineSoftwareData.self, timeout: .seconds(20))
                withAnimation { software.show(next) }
                if next.updating { round += 1 }
            } catch { software.fail(error.localizedDescription) }
        }
    }
}
