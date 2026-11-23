import SwiftUI

/// The Review step: exactly what publishing would upload, checked on the machine before anything
/// leaves it. A bot shows what it shares (its task and routines), what it asks for (apps, skills,
/// plugins) and what it may do (its declared effects, ADR 0200 §3.4); a skill or plugin shows its
/// files, what was left home and what the privacy pass found. Next confirms what is shown: the
/// machine makes the draft and runs ace's scan on it.
struct MarketPublishReview: View {
    let model: ClientModel
    @Bindable var flow: MarketPublishFlow
    @State private var problem: MarketRefusal?
    @State private var reading = false

    var body: some View {
        List {
            if let problem {
                Section {
                    ProblemRow(problem.message, detail: problem.reason, id: "market.publish.review.problem",
                               disabled: flow.working) { Task { await again() } }
                }
                .insetRowBackground()
            }
            if let check = flow.check {
                if let bot = check.bot { botSections(bot) } else { fileSections(check) }
                findingsSection(check)
            } else if reading {
                Section { SkeletonRows(count: 4, label: "Checking what would upload").listRowInsets(EdgeInsets()) }
            }
        }
        .insetGroupedList()
        .navigationTitle(flow.item?.title ?? "Review")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { foot }
        .task { if flow.check == nil { await read() } }
    }

    private var foot: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            if let blocking = flow.check?.blockingText {
                Text(blocking).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
            }
            Button(flow.working ? "Checking its files…" : "Next") { Task { await makeDraft() } }
                .buttonStyle(.primaryAction)
                .disabled(flow.check == nil || (flow.check?.blocking ?? 0) > 0 || flow.working)
                .accessibilityIdentifier("market.publish.review.next")
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.related)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AceDesign.Surface.background)
    }

    @ViewBuilder private func fileSections(_ check: MarketPublishCheck) -> some View {
        Section {
            ForEach(check.files, id: \.path) { file in
                if file.binary {
                    Toggle(isOn: binding(file.path)) {
                        InsetRow(file.path, icon: .file, subtitle: "\(file.sizeText) · Not text, uploads only if ticked")
                    }
                    .accessibilityIdentifier("market.publish.binary.\(file.path)")
                } else {
                    InsetRow(file.path, icon: .fileText, value: file.sizeText)
                }
            }
        } header: { InsetHeader("Uploads · \(check.filesText)") }
        .insetRowBackground()
        if !check.leftOut.isEmpty {
            Section {
                ForEach(check.leftOut, id: \.path) { InsetRow($0.path, icon: .eyeSlash, value: $0.why) }
            } header: { InsetHeader("Stays on your machine") }
            .insetRowBackground()
        }
    }

    @ViewBuilder private func botSections(_ bot: MarketPublishCheck.Bot) -> some View {
        Section {
            Text(bot.task).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
        } header: { InsetHeader("Task") }
        .insetRowBackground()
        if !bot.routines.isEmpty {
            Section {
                ForEach(bot.routines) { routine in
                    Toggle(isOn: routineBinding(routine.index)) {
                        InsetRow(routine.name, icon: .clock, subtitle: "\(routine.schedule) · \(routine.instruction)")
                    }
                    .accessibilityIdentifier("market.publish.routine.\(routine.index)")
                }
            } header: { InsetHeader("Routines it shares") }
            .insetRowBackground()
        }
        if !bot.effects.isEmpty {
            Section {
                ForEach(bot.effects, id: \.self) { effect in
                    InsetRow(effect.words, icon: .shield,
                             subtitle: effect.asksEachTime ? "\(effect.why) · Asks you each time" : effect.why)
                }
            } header: { InsetHeader("What it may do") }
            .insetRowBackground()
        }
        if !bot.apps.isEmpty || !bot.skills.isEmpty || !bot.plugins.isEmpty {
            Section {
                ForEach(bot.apps, id: \.label) { app in
                    InsetRow(app.label, icon: .plug, subtitle: app.required ? app.why : "\(app.why) · Optional")
                }
                if !bot.skills.isEmpty { InsetRow("Skills", icon: .lightning, subtitle: bot.skills.joined(separator: ", ")) }
                if !bot.plugins.isEmpty { InsetRow("Plugins", icon: .puzzlePiece, subtitle: bot.plugins.joined(separator: ", ")) }
            } header: { InsetHeader("What it asks for") }
            .insetRowBackground()
        }
        if !bot.leftOut.isEmpty {
            Section {
                ForEach(bot.leftOut, id: \.self) { line in
                    Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            } header: { InsetHeader("Left out") }
            .insetRowBackground()
        }
    }

    @ViewBuilder private func findingsSection(_ check: MarketPublishCheck) -> some View {
        if !check.findings.isEmpty {
            Section {
                ForEach(check.findings) { finding in
                    VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                        Text(finding.sentence).aceFont(AceDesign.TextRole.rowTitle)
                            .foregroundStyle(finding.blocking ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(finding.where).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                    .padding(.vertical, AceDesign.Space.tight)
                }
            } header: { InsetHeader("Public once published") } footer: {
                Text("Next confirms these may be public.")
            }
            .insetRowBackground()
        }
    }

    private func binding(_ path: String) -> Binding<Bool> {
        Binding(get: { flow.binaries.contains(path) },
                set: { on in if on { flow.binaries.insert(path) } else { flow.binaries.remove(path) } })
    }

    private func routineBinding(_ index: Int) -> Binding<Bool> {
        Binding(get: { flow.routines.contains(index) },
                set: { on in if on { flow.routines.insert(index) } else { flow.routines.remove(index) } })
    }

    private func read() async {
        guard let item = flow.item else { return }
        reading = true
        defer { reading = false }
        do {
            let check = try await model.marketPublishCheck(item)
            flow.check = check
            flow.routines = Set(check.bot?.routines.map(\.index) ?? [])
            problem = nil
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }

    /// A refusal that says to look again reads the check again; anything else retries the draft.
    private func again() async {
        if flow.check == nil || problem?.code == "expired" {
            flow.check = nil
            await read()
        } else {
            await makeDraft()
        }
    }

    private func makeDraft() async {
        guard let item = flow.item, let check = flow.check, !flow.working else { return }
        flow.working = true
        defer { flow.working = false }
        do {
            let draft = try await model.marketPublishDraft(
                item, version: flow.draft?.version ?? item.version, check: check, binaries: Array(flow.binaries),
                routines: check.bot == nil ? nil : flow.routines.sorted(), draft: flow.draft?.id ?? item.draft)
            flow.draft = draft
            problem = nil
            flow.path.append(.checks)
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}

/// ace's checks on the draft's files: what passed, and what to fix before it can be published.
struct MarketPublishChecks: View {
    let flow: MarketPublishFlow

    var body: some View {
        List {
            if let draft = flow.draft {
                Section {
                    ForEach(draft.checks) { check in
                        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
                            AceIcon(check.verdict == "block" ? .warningCircle : .checkCircle, size: AceDesign.Size.icon, relativeTo: .body)
                                .foregroundStyle(check.verdict == "block" ? AceTheme.StatusText.failed : AceTheme.StatusText.done)
                                .accessibilityLabel(check.verdict == "block" ? "To fix" : "Passed")
                            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                                Text(check.sentence).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                ForEach(check.found, id: \.self) { found in
                                    Text(found).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        .padding(.vertical, AceDesign.Space.tight)
                    }
                } header: { InsetHeader("\(draft.version) · \(draft.filesText)") } footer: {
                    Text(draft.verdictText)
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .navigationTitle("ace's checks")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            Button("Next") { flow.path.append(.describe) }
                .buttonStyle(.primaryAction)
                .disabled(flow.draft == nil || flow.draft?.scanning == true || (flow.draft?.failing ?? 0) > 0)
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AceDesign.Surface.background)
                .accessibilityIdentifier("market.publish.checks.next")
        }
    }
}
