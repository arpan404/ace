import SwiftUI

/// Create or edit an automation: what it does, where and on which model, and when it runs, with
/// a bar at the foot saying when it will run next and Save. The form is the web's own
/// (`bridge/automation-form.ts`): the bridge fills it, words its schedule, checks every field
/// and saves it; this draws native controls and hands their values over.
struct AutomationEditor: View {
    let model: ClientModel
    /// The automation being edited; nil makes a new one.
    let editing: AutomationListRow?
    let saved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var form: AutomationFormValues?
    /// New automation's starting points, kept from the form's opening: a preview of the form
    /// describes it again without them.
    @State private var ideas: [AutomationIdea] = []
    @State private var view: AutomationFormView?
    @State private var choices: AutomationFormView.Choices?
    @State private var pick: AutomationPick?
    @State private var pickChanged = false
    /// Fields the person changed: their problems show as they type. All show after a Save.
    @State private var touched: Set<String> = []
    @State private var attempted = false
    /// Fields changed since the bridge last checked the form: their old problem is stale.
    @State private var unchecked: Set<String> = []
    @State private var saving = false
    @State private var problem: String?
    @State private var failedPreviewChange: [String: Any]?
    @State private var retrySave = false
    @State private var choosingModel = false
    @State private var sequence = 0
    @State private var savedCount = 0
    /// A new automation's id, made once when the editor opens: Save sent again after a lost
    /// reply names the same automation, which the bridge counts as saved instead of a second.
    @State private var newId = "auto-\(UUID().uuidString.lowercased())"
    private var zone: String { TimeZone.current.identifier }
    private var motion: Animation { .default }

    init(model: ClientModel, editing: AutomationListRow?, saved: @escaping (String) -> Void) {
        self.model = model
        self.editing = editing
        self.saved = saved
    }

    var body: some View {
        Group {
            if let form = Binding($form) {
                List {
                    ideasSection(form.wrappedValue)
                    about(form)
                    agentSection(form)
                    if let view, let choices {
                        AutomationWhenSection(form: form, view: view, choices: choices, error: error,
                                              touch: { touched.insert($0) }, change: { change in Task { await preview(change) } })
                    }
                    if !model.canOperate {
                        Section { ViewOnlyNote(message: "View only. To save automations from this phone, pair it again with View and act.") }
                            .insetRowBackground()
                    }
                }
                .insetGroupedList()
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom) { footer }
                .transition(.opacity)
            } else if let problem {
                VStack {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await open() } }.buttonStyle(.textAction())
                }.padding(AceDesign.Space.margin)
            } else {
                SkeletonPage(label: "Opening the automation")
                    .transition(.opacity)
            }
        }
        .animation(motion, value: form == nil)
        .background(AceDesign.Surface.background)
        .navigationTitle(editing == nil ? "New automation" : "Edit automation").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("automation.cancel") }
        }
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(isPresented: $choosingModel) {
            AutomationModelSheet(compose: model.compose, pick: Binding(get: { pick }, set: { pick = $0; pickChanged = true }),
                                 reload: { model.composeAction(["kind": "agents"]) },
                                 star: { model.composeAction(["kind": "favorite", "key": $0]) })
        }
        .task { await open() }
        // Typing waits a moment before the bridge reads the form again.
        .task(id: form) {
            guard form != nil else { return }
            try? await Task.sleep(for: .milliseconds(150))
            if !Task.isCancelled { await preview(nil) }
        }
        .onChange(of: accessKey) { _, _ in sendChoice() }
        // A new automation starts in the first project once the projects arrive.
        .onChange(of: model.compose.projects.first?.path) { _, path in
            if let path, form?.workspace.isEmpty == true { form?.workspace = path }
        }
        .onDisappear { model.composeAction(["kind": "close"]) }
    }

    // MARK: Sections

    private func about(_ form: Binding<AutomationFormValues>) -> some View {
        Section {
            field("title") {
                TextField("Name", text: touching(form.title, "title")).font(AceDesign.Typeface.body)
                    .accessibilityIdentifier("automation.title")
            }
            field("prompt") {
                TextField("What should the agent do?", text: touching(form.prompt, "prompt"), axis: .vertical).lineLimit(3...12)
                    .accessibilityIdentifier("automation.prompt")
            }
        }
        .insetRowBackground()
    }

    private func agentSection(_ form: Binding<AutomationFormValues>) -> some View {
        Section {
            field("workspace") {
                Picker("Project", selection: touching(form.workspace, "workspace")) {
                    if form.wrappedValue.workspace.isEmpty { Text("Choose a project").tag("") }
                    if !model.compose.projects.contains(where: { $0.path == form.wrappedValue.workspace }), !form.wrappedValue.workspace.isEmpty {
                        Text(form.wrappedValue.workspace).tag(form.wrappedValue.workspace)
                    }
                    ForEach(model.compose.projects) { project in Text(project.name).tag(project.path) }
                }
                .accessibilityIdentifier("automation.project")
            }
            Button { choosingModel = true } label: {
                HStack {
                    Text("Model").foregroundStyle(AceDesign.Ink.primary)
                    Spacer()
                    if let pick { ProviderMark(provider: pick.provider, size: AceDesign.Size.icon, quiet: true) }
                    Text(modelLabel).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold))
                        .foregroundStyle(AceDesign.Ink.muted)
                }
                .frame(minHeight: AceDesign.Size.tap).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("automation.model")
            if let efforts = chosenModel?.efforts, efforts.count > 1 {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text("Effort").font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                    CapsuleSegments<String>(efforts.map { (id: $0.id, label: $0.label) },
                                    selection: pick?.effort ?? chosenModel?.defaultEffort, idPrefix: "automation.effort") { effort in
                        pick?.effort = effort
                        pickChanged = true
                    }
                }
                .padding(.vertical, AceDesign.Space.tight)
            }
            if let access = model.compose.access, access.provider == pick?.provider, !access.choices.isEmpty {
                // Unset follows the project's (else the machine's) default, as it is saved: the
                // picker says "Default" for it rather than a mode that would never be stored.
                Picker("Access", selection: Binding(get: { form.wrappedValue.access ?? "" },
                                                    set: { form.wrappedValue.access = $0.isEmpty ? nil : $0 })) {
                    Text(form.wrappedValue.access == nil ? "Default · \(defaultAccessLabel(access))" : "Default").tag("")
                    ForEach(access.choices) { choice in Text(choice.label).tag(choice.mode) }
                }
                .accessibilityIdentifier("automation.access")
                if let note = access.problem ?? access.stricter ?? access.choices.first(where: { $0.mode == (form.wrappedValue.access ?? access.selected) })?.description {
                    Text(note).font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                }
            }
            Toggle("Run in a worktree", isOn: form.worktree).toggleStyle(.systemSwitch)
                .accessibilityIdentifier("automation.worktree")
        } header: { InsetHeader("Project and model") }
        .insetRowBackground()
    }

    /// The bar at the foot: when it runs (or what to fix), and Save.
    private var footer: some View {
        HStack(spacing: AceDesign.Space.row) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if let shown = shownProblem {
                    Text(shown).foregroundStyle(attempted || problem != nil ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                        .accessibilityIdentifier("automation.problem")
                } else {
                    Text(view?.summary ?? "").foregroundStyle(AceDesign.Ink.primary)
                        .accessibilityIdentifier("automation.summary")
                    if let line = view?.line, !line.isEmpty {
                        Text(line).foregroundStyle(AceDesign.Ink.muted).accessibilityIdentifier("automation.upcoming")
                    }
                }
            }
            .font(AceDesign.Typeface.meta)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentTransition(.opacity)
            .animation(motion, value: shownProblem)
            if problem != nil {
                Button("Retry") { Task { if retrySave { await save() } else { await preview(failedPreviewChange) } } }.buttonStyle(.textAction())
            }
            Button { Task { await save() } } label: {
                Text(saving ? "Saving…" : "Save").fontWeight(.semibold)
                    .padding(.horizontal, AceDesign.Space.margin).frame(minHeight: AceDesign.Size.tap)
            }
            .modifier(PlainGlassButton())
            .disabled(saving || !model.canOperate || form == nil)
            .accessibilityIdentifier("automation.save")
        }
        .padding(.leading, AceDesign.Space.margin)
        .padding(.trailing, AceDesign.Space.tight)
        .padding(.vertical, AceDesign.Space.tight)
        // Plain system glass, so the rows passing under it never read through the words.
        .floatingGlass()
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.tight)
    }

    @ViewBuilder private func field<Content: View>(_ name: String, @ViewBuilder _ content: () -> Content) -> some View {
        content()
        if let message = error(name) {
            Text(message).font(AceDesign.Typeface.meta)
                .foregroundStyle(AceTheme.StatusText.failed)
                .transition(.opacity)
        }
    }

    /// A field's binding that marks it changed, so its problem shows from then on.
    private func touching(_ value: Binding<String>, _ name: String) -> Binding<String> {
        Binding(get: { value.wrappedValue }, set: { value.wrappedValue = $0; touched.insert(name); unchecked.insert(name) })
    }

    // MARK: Derived

    private func error(_ name: String) -> String? {
        guard attempted || touched.contains(name), !unchecked.contains(name) else { return nil }
        return view?.errors?[name]
    }
    private var shownProblem: String? {
        if let problem { return problem }
        return attempted ? view?.problem : nil
    }
    private var chosenModel: ComposeAgent.Model? {
        guard let pick else { return nil }
        let models = model.compose.agentsRead.agents.first { $0.provider == pick.provider }?.models ?? []
        return models.first { $0.key == pick.key && (pick.account == nil || $0.account == pick.account) } ?? models.first { $0.key == pick.key }
    }
    private var modelLabel: String {
        if let chosenModel { return chosenModel.label }
        if let stored = editing?.model { return stored }
        if let agent = editing?.agent { return "\(agent) default" }
        return model.compose.agentsState == "ready" ? "Default" : "Reading…"
    }
    /// The mode an unset access runs at, as the bridge worked it out for this project and model.
    private func defaultAccessLabel(_ access: ComposeAccess) -> String {
        access.label ?? access.choices.first { $0.mode == access.selected }?.label ?? "the project's"
    }
    private var accessKey: String {
        [form?.workspace, pick?.provider, pick?.key, pick?.account, form?.access].map { $0 ?? "" }.joined(separator: "\u{0}")
    }

    /// A new automation's starting points while nothing is written yet: one fills the form.
    @ViewBuilder private func ideasSection(_ current: AutomationFormValues) -> some View {
        if editing == nil, current.prompt.isEmpty, !ideas.isEmpty {
            Section {
                ForEach(ideas) { idea in
                    Button {
                        withAnimation(motion) {
                            // The idea keeps the project already chosen; a blank one takes the first.
                            var chosen = idea.form
                            if let workspace = form?.workspace, !workspace.isEmpty { chosen.workspace = workspace }
                            else if chosen.workspace.isEmpty, let first = model.compose.projects.first { chosen.workspace = first.path }
                            form = chosen
                        }
                        Task { await preview(nil) }
                    } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(idea.prompt).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                            Text(idea.label).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                        .padding(.vertical, AceDesign.Space.tight)
                    }
                    .accessibilityIdentifier("automation.idea.\(idea.label)")
                }
            } header: { InsetHeader("Start from an idea") }
            .insetRowBackground()
        }
    }

    // MARK: Bridge

    private func open() async {
        problem = nil
        model.composeAction(["kind": "open"])
        var request: [String: Any] = ["type": "automations.form.open", "zone": zone]
        if let editing { request["automation"] = editing.automation.any }
        else if let first = model.compose.projects.first { request["workspace"] = first.path }
        do {
            let reply = try await model.service(request, as: AutomationFormView.self)
            guard reply.ok, reply.form != nil else { problem = reply.error ?? "Couldn't open this automation."; return }
            withAnimation(motion) {
                view = reply
                ideas = reply.ideas ?? []
                choices = reply.choices
                pick = reply.pick
                form = reply.form
                // A new automation starts in the first project, whenever the projects arrived.
                if form?.workspace.isEmpty == true, let first = model.compose.projects.first { form?.workspace = first.path }
            }
            sendChoice()
        } catch { problem = error.localizedDescription }
    }

    /// The form described again, after `change` when a control made one.
    private func preview(_ change: [String: Any]?) async {
        guard let form else { return }
        sequence += 1
        let mine = sequence
        var request: [String: Any] = ["type": "automations.form.preview", "form": form.json]
        if let change { request["change"] = change }
        let reply: AutomationFormView
        do {
            reply = try await model.service(request, as: AutomationFormView.self)
            guard mine == sequence else { return }
            guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Couldn't check this automation.") }
            problem = nil; failedPreviewChange = nil; retrySave = false
        } catch {
            if mine == sequence && !Task.isCancelled {
                failedPreviewChange = change; retrySave = false; problem = error.localizedDescription
            }
            return
        }
        if reply.form == self.form || change != nil { unchecked = [] }
        withAnimation(motion) {
            view = reply
            if let next = reply.form, next != form, change != nil { self.form = next }
        }
    }

    /// New thread's access rules for this project and model, read by the bridge (`compose.access`).
    private func sendChoice() {
        var choice: [String: Any] = ["kind": "choice"]
        if let workspace = form?.workspace, !workspace.isEmpty { choice["workspaceId"] = workspace }
        if let pick {
            choice["provider"] = pick.provider; choice["model"] = pick.key
            if let account = pick.account { choice["account"] = account }
        }
        if let access = form?.access { choice["access"] = access }
        model.composeAction(choice)
    }

    private func save() async {
        guard let form, !saving else { return }
        saving = true
        defer { saving = false }
        attempted = true
        problem = nil
        await preview(nil)
        if problem != nil || view?.problem != nil { return }
        var request: [String: Any] = ["type": "automations.save", "form": form.json, "id": newId]
        if pickChanged, let pick { request["pick"] = pick.json }
        if let editing {
            request["previous"] = editing.automation.any
            if let revision = editing.revision { request["revision"] = revision }
        }
        do {
            let reply = try await model.service(request, as: AutomationWrite.self)
            guard reply.ok, let id = reply.id else { retrySave = true; problem = reply.error ?? "Couldn't save this automation. Try again."; return }
            savedCount += 1
            saved(id)
            dismiss()
        } catch { retrySave = true; problem = error.localizedDescription }
    }
}

/// A capsule button on plain system glass (iOS 26), the bordered capsule before it.
struct PlainGlassButton: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) { content.buttonStyle(.glass).buttonBorderShape(.capsule) }
        else { content.buttonStyle(.bordered).buttonBorderShape(.capsule) }
    }
}
