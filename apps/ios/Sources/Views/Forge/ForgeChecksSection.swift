import SwiftUI

/// A pull request's checks on its page (the web's Checks section): each of GitHub's checks with
/// its state, opening its own page; and the project's local check of this head, with its one
/// control (Run checks, Run again, Stop) and its log. A running local check is read again
/// every few seconds until it settles; a check GitHub couldn't report says so.
struct ForgeChecksSection: View {
    let client: ClientModel
    let route: ForgeRoute
    /// The pull request as its page read it; writes and pushed pages name its repository.
    let target: ForgePullTarget
    let open: (ForgeRoute) -> Void
    /// The pull request's own check words from the page read, drawn until this section's read lands.
    let shown: [ForgePullPage.Check]
    @State private var checks: ForgeChecks?
    @State private var writing = false
    @State private var outcome: ForgeWorkOutcome?
    @State private var showingLog = false
    @State private var stopping = false
    @Environment(\.setCheckCommand) private var setCheckCommand

    private var request: [String: Any] { ClientModel.forgeChecksRead(route) }

    init(client: ClientModel, route: ForgeRoute, target: ForgePullTarget, shown: [ForgePullPage.Check], open: @escaping (ForgeRoute) -> Void) {
        self.client = client
        self.route = route
        self.target = target
        self.shown = shown
        self.open = open
        _checks = State(initialValue: client.kept(ClientModel.forgeChecksRead(route), as: ForgeChecks.self))
    }

    var body: some View {
        // A container that is always there, so its reads run even before anything shows.
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let checks {
                if !checks.checks.isEmpty || checks.local != nil || checks.stale { section(checks) }
            } else if !shown.isEmpty {
                // The page's own words hold the place, so the section never jumps in.
                ForgeSection(title: "Checks") {
                    ForEach(shown, id: \.self) { ForgeLine(leading: $0.name, trailing: $0.word, tone: $0.tone) }
                }
            }
        }
        .animation(AceMotion.smooth, value: checks)
        .task(id: client.readGeneration(request)) { await load(fresh: false) }
        .task(id: checks?.local?.action?.kind == "cancel") { await follow() }
        .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
        .sheet(isPresented: $showingLog) {
            if let runId = checks?.local?.runId, let name = checks?.local?.name {
                NavigationStack {
                    ScrollView { ForgeLogView(client: client, name: name, request: ["type": "forge.local.log", "runId": runId], total: nil, focus: nil,
                                              live: checks?.local?.action?.kind == "cancel") }
                        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showingLog = false } } }
                }
            }
        }
        .confirmationDialog("Stop the local check?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop check", role: .destructive) { localWrite(stop: true) }
        } message: { Text("The run ends where it is. You can run it again.") }
    }

    @ViewBuilder private func section(_ checks: ForgeChecks) -> some View {
        ForgeSection(title: "Checks") {
            if checks.stale {
                HStack {
                    Text("Check details are out of date.").meta()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Refresh") { Task { await load(fresh: true) } }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                }
                .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
            }
            if let local = checks.local { localRow(local, headSha: checks.headSha) }
            ForEach(checks.checks, id: \.id) { check in row(check) }
        }
        ForgeOutcomeLine(outcome: outcome, identifier: "forge.checks.outcome")
    }

    private func row(_ check: ForgeChecks.Row) -> some View {
        Button {
            open(ForgeRoute(kind: .check, machineId: route.machineId, project: route.project, number: route.number, repository: target.repository, checkId: check.id))
        } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(check.name).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(check.word).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(check.tone == "idle" ? AceTheme.Colours.mutedForeground : AceTone(check.tone).text)
                AceIcon(.caretRight, size: 12, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("forge.check.\(check.name)")
    }

    private func localRow(_ local: ForgeChecks.Local, headSha: String) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(local.name).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(local.word).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(local.tone == "idle" ? AceTheme.Colours.mutedForeground : AceTone(local.tone).text)
                    .contentTransition(.opacity)
            }
            HStack(spacing: AceTheme.Spacing.lg) {
                if let action = local.action, client.canOperate {
                    Button(action.label) { action.kind == "cancel" ? (stopping = true) : localWrite(stop: false) }
                        .foregroundStyle(action.kind == "cancel" ? AceTone.failed.text : AceTheme.Colours.foreground)
                        .disabled(writing || action.disabled)
                        .accessibilityIdentifier("forge.local.action")
                }
                if local.runId != nil {
                    Button("Log") { showingLog = true }.accessibilityIdentifier("forge.local.log")
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .buttonStyle(.forgeWord)
            if local.needsCommand == true, client.canOperate, let setCommand = setCheckCommand {
                // Project defaults can set it from the phone: say so and go there.
                Text("This project has no check command.").meta()
                Button("Set check command") { setCommand(route.machineId, route.project) }
                    .buttonStyle(.forgeWord)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .accessibilityIdentifier("forge.local.setCommand")
            } else if let note = local.note { Text(note).meta() }
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.xs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("forge.local")
    }

    private func localWrite(stop: Bool) {
        guard !writing, let checks else { return }
        writing = true
        Task {
            var payload: [String: Any] = ["type": "forge.local.write", "project": target.project, "number": target.number, "repository": target.repository.json]
            payload["action"] = stop ? ["kind": "cancel", "runId": checks.local?.runId ?? ""] : ["kind": "start", "headSha": checks.headSha]
            outcome = await client.forgeWorkWrite(payload)
            await load(fresh: true)
            writing = false
        }
    }

    /// A live local check is read again every few seconds, until it settles or the page goes.
    private func follow() async {
        while checks?.local?.action?.kind == "cancel", !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            await load(fresh: true)
        }
    }

    private func load(fresh: Bool) async {
        do { checks = try await client.forgeWorkRead(request, fresh: fresh, as: ForgeChecks.self) }
        catch {}
    }
}

extension EnvironmentValues {
    /// Opens where a project's check command is set (Project defaults), for a machine and project.
    /// The one place the PR page offers it: while nil, the page says to set it on the computer.
    @Entry var setCheckCommand: ((_ machineId: String, _ projectId: String) -> Void)? = nil
}
