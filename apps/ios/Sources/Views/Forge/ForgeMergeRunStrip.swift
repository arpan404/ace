import SwiftUI

/// What the merge strip shows (`forge.merge-run`, `bridge/forge-merge-run.ts`): the picked rows'
/// offer, the run in view and its actions, and why a ready row can't join. Every word is the web
/// strip's (`@ace/ui-core` `merge-run-words`); Swift draws and routes.
struct ForgeMergeRunReply: Decodable, Sendable, Equatable {
    /// `refusal`: Verify refused the list, in the web's words; nothing can start, and a check
    /// command wouldn't help.
    struct Pick: Decodable, Sendable, Equatable { let sentence: String; let start: Bool; let refusal: String? }
    struct Blocked: Decodable, Sendable, Equatable { let key: String; let reason: String }
    struct Action: Decodable, Sendable, Equatable, Hashable {
        /// stop, dismiss, again, without, log, open or command.
        let kind: String
        let label: String
        let pr: Int?
        let repository: ForgeRepository?
    }
    struct Run: Decodable, Sendable, Equatable {
        let id: String
        let sentence: String
        /// While live: when it started, in ms since 1970.
        let since: Double?
        /// It has ended; a new selection takes its place.
        let settled: Bool
        let actions: [Action]
    }
    struct Method: Decodable, Sendable, Equatable, Hashable { let value: String; let label: String }
    let pick: Pick?
    /// The picks still selected, each at the head it was picked at.
    let picked: [String]
    /// Picks whose head moved since they were picked: they leave the selection.
    let notice: String?
    let blocked: [Blocked]
    let run: Run?
    /// A run that merged something: the list reads again once for it.
    let merged: String?
    let methods: [Method]
}

/// The Pull requests list's verified merge: the ready rows picked, each with the head it was
/// picked at, the method, and the strip's answer for them. A pick whose row gets new commits
/// leaves the selection with a notice, so Start never merges a head the person didn't choose.
/// Picks go when the project changes; a run keeps its own state in the bridge, so the strip
/// finds it again after the list is left.
@MainActor @Observable final class ForgeMergeRunModel {
    /// As picked: the head here is the one Start sends.
    private(set) var picks: [ForgeMergePick] = []
    var picked: [String] { picks.map(\.key) }
    /// Why picks left the selection, until the next pick or Clear.
    private(set) var notice: String?
    var method = "squash"
    private(set) var reply: ForgeMergeRunReply?
    private(set) var busy = false
    private(set) var problem: String?
    @ObservationIgnored private var mergedSeen: String?

    func isPicked(_ pick: ForgeMergePick) -> Bool { picks.contains { $0.key == pick.key } }
    func blocked(_ pick: ForgeMergePick) -> String? { reply?.blocked.first { $0.key == pick.key }?.reason }
    func toggle(_ client: ClientModel, project: String, _ pick: ForgeMergePick) {
        if let at = picks.firstIndex(where: { $0.key == pick.key }) { picks.remove(at: at) } else { picks.append(pick) }
        problem = nil
        notice = nil
        // A new selection replaces a settled run's ending for good, as the web's strip does.
        if let run = reply?.run, run.settled {
            Task { await write(client, project: project, op: ["kind": "dismiss", "runId": run.id]) }
        }
    }
    func clear() { picks = []; problem = nil; notice = nil }

    /// The ready rows on show as the bridge compares picks with them: their heads now.
    static func rows(_ ready: [ForgeMergePick]) -> [[String: Any]] {
        ready.map { ["key": $0.key, "base": $0.base, "headSha": $0.headSha] }
    }
    /// The request for the rows on show: the picks as made, and every ready one as it is now.
    static func request(project: String, picked: [ForgeMergePick], ready: [ForgeMergePick]) -> [String: Any] {
        ["type": "forge.merge-run", "project": project, "picked": picked.map(\.json), "rows": rows(ready)]
    }

    /// Reads the strip; `merged` runs once for each run that merged something.
    func read(_ client: ClientModel, project: String, ready: [ForgeMergePick], merged: () async -> Void) async {
        let sent = picks
        do {
            let next = try await client.read(Self.request(project: project, picked: sent, ready: ready), as: ForgeMergeRunReply.self)
            // A pick or Clear while this was read asks again; this answer is for picks no longer held.
            guard sent == picks else { return }
            reply = next
            // Rows that left the list or moved to a newer head leave the selection; the bridge says which.
            let kept = Set(next.picked)
            if picks.contains(where: { !kept.contains($0.key) }) {
                picks = next.picked.compactMap { key in picks.first { $0.key == key } }
                if let said = next.notice { notice = said }
            }
            if let id = next.merged, id != mergedSeen { mergedSeen = id; await merged() }
        } catch is CancellationError {
        } catch { problem = error.localizedDescription }
    }

    /// Sends the picks at the heads they were picked at, with the rows on show: one whose head
    /// moved since starts nothing, and the next read takes it out of the selection.
    func start(_ client: ClientModel, project: String, ready: [ForgeMergePick]) async {
        guard !picks.isEmpty else { return }
        let op: [String: Any] = ["kind": "start", "method": method, "prs": picks.map(\.json), "rows": Self.rows(ready)]
        if await write(client, project: project, op: op) { picks = [] }
    }

    func act(_ client: ClientModel, project: String, _ action: ForgeMergeRunReply.Action, run: ForgeMergeRunReply.Run) async {
        var op: [String: Any] = ["kind": action.kind, "runId": run.id]
        if action.kind == "without", let pr = action.pr { op["pr"] = pr }
        _ = await write(client, project: project, op: op)
    }

    @discardableResult
    private func write(_ client: ClientModel, project: String, op: [String: Any]) async -> Bool {
        guard client.canOperate else { problem = "View only. Pair this phone with View and act to merge."; return false }
        busy = true
        defer { busy = false }
        struct Outcome: Decodable { let ok: Bool; let message: String }
        do {
            let outcome = try await client.service(["type": "forge.merge-run.write", "project": project, "op": op], as: Outcome.self)
            problem = outcome.ok ? nil : outcome.message
            return outcome.ok
        } catch {
            problem = error.localizedDescription
            return false
        }
    }
}

/// The merge strip over the list's foot, as the web's under its toolbar: "Verify and merge 3 pull
/// requests into main · Squash ⌄ · Start · Clear" for the picked rows; then the run's progress
/// with its time and Stop, settling into its ending ("#224 conflicts with #233 · Remove #224 and
/// retry · Dismiss"). One glass shape, words for actions; nothing shows with nothing to say.
struct ForgeMergeRunStrip: View {
    let client: ClientModel
    let scope: ForgeListScope
    let model: ForgeMergeRunModel
    let ready: [ForgeMergePick]
    let open: (ForgeRoute) -> Void
    @Environment(\.setCheckCommand) private var setCheckCommand
    @State private var logRun: LogRun?
    private struct LogRun: Identifiable { let id: String }

    var body: some View {
        if let reply = model.reply, let run = reply.run {
            strip { runLine(run) } actions: {
                ForEach(Array(run.actions.enumerated()), id: \.element) { index, action in
                    Button(action.label) { take(action, run: run) }
                        .buttonStyle(StripTextButtonStyle(prominent: index == 0))
                        .disabled(model.busy || !allowed(action))
                        .accessibilityIdentifier("forge.mergeRun.\(action.kind)")
                }
            }
            .sheet(item: $logRun) { log in
                NavigationStack {
                    ScrollView {
                        ForgeLogView(client: client, name: "Merge run", request: ["type": "forge.local.log", "runId": log.id], total: nil, focus: nil)
                    }
                    .navigationTitle("Log").navigationBarTitleDisplayMode(.inline)
                }
                .presentationDetents([.medium, .large])
            }
        } else if let reply = model.reply, let pick = reply.pick, !model.picked.isEmpty {
            strip { pickLine(pick) } actions: {
                Menu {
                    Picker("Merge method", selection: Binding(get: { model.method }, set: { model.method = $0 })) {
                        ForEach(reply.methods, id: \.value) { Text($0.label).tag($0.value) }
                    }
                } label: {
                    Text(reply.methods.first { $0.value == model.method }?.label ?? model.method)
                }
                .buttonStyle(StripTextButtonStyle(prominent: false))
                .accessibilityIdentifier("forge.mergeRun.method")
                if pick.start {
                    Button("Start") { Task { await model.start(client, project: scope.project, ready: ready) } }
                        .buttonStyle(StripTextButtonStyle(prominent: true))
                        .disabled(model.busy || !client.canOperate)
                        .accessibilityIdentifier("forge.mergeRun.start")
                } else if pick.refusal == nil, let setCheckCommand {
                    Button("Set a check command") { setCheckCommand(scope.machineId, scope.project) }
                        .buttonStyle(StripTextButtonStyle(prominent: true))
                        .accessibilityIdentifier("forge.mergeRun.command")
                }
                Button("Clear") { model.clear() }
                    .buttonStyle(StripTextButtonStyle(prominent: false))
                    .accessibilityIdentifier("forge.mergeRun.clear")
            }
        } else if let notice = model.notice {
            // Every pick moved on: the strip still says why the selection emptied.
            strip { sentence(notice, failed: false) } actions: {
                Button("Dismiss") { model.clear() }
                    .buttonStyle(StripTextButtonStyle(prominent: true))
                    .accessibilityIdentifier("forge.mergeRun.dismissNotice")
            }
        }
    }

    /// A problem first, then a notice said once, then why Verify refused, then the pick itself.
    @ViewBuilder private func pickLine(_ pick: ForgeMergeRunReply.Pick) -> some View {
        if let problem = model.problem { sentence(problem, failed: true) }
        else if let notice = model.notice { sentence(notice, failed: false) }
        else if let refusal = pick.refusal { sentence(refusal, failed: true) }
        else { sentence(pick.sentence, failed: false) }
    }

    @ViewBuilder private func runLine(_ run: ForgeMergeRunReply.Run) -> some View {
        if let since = run.since, model.problem == nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                sentence("\(run.sentence) · \(Elapsed.words(since: since, now: context.date))", failed: false)
            }
        } else {
            sentence(model.problem ?? run.sentence, failed: model.problem != nil)
        }
    }

    private func sentence(_ text: String, failed: Bool) -> some View {
        Text(text)
            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
            .foregroundStyle(failed ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
            .lineLimit(2).monospacedDigit()
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("forge.mergeRun.sentence")
    }

    /// The sentence, then its words: beside it when they fit, else on their own line at the end.
    private func strip<Line: View, Actions: View>(@ViewBuilder _ line: () -> Line, @ViewBuilder actions: () -> Actions) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: AceDesign.Space.related) { line(); HStack(spacing: AceTheme.Spacing.none) { actions() }.fixedSize() }
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                line()
                HStack(spacing: AceTheme.Spacing.none) { actions() }.fixedSize().frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.stripBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        .aceGlass(in: AceDesign.Shape.container)
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.bottom, AceDesign.Space.tight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("forge.mergeRun")
    }

    /// Writes need View and act; the log and a pull request's page open on any phone.
    private func allowed(_ action: ForgeMergeRunReply.Action) -> Bool {
        switch action.kind {
        case "log", "open", "dismiss": true
        case "command": setCheckCommand != nil
        default: client.canOperate
        }
    }

    private func take(_ action: ForgeMergeRunReply.Action, run: ForgeMergeRunReply.Run) {
        switch action.kind {
        case "log": logRun = LogRun(id: run.id)
        case "open":
            if let pr = action.pr {
                open(ForgeRoute(kind: .pull, machineId: scope.machineId, project: scope.project, number: pr, repository: action.repository))
            }
        case "command": setCheckCommand?(scope.machineId, scope.project)
        default: Task { await model.act(client, project: scope.project, action, run: run) }
        }
    }
}
