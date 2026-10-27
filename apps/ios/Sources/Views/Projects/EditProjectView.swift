import PhotosUI
import SwiftUI

/// Edit project, as the web's dialog: name, icon, what new threads start with, the check
/// command, the browser profile and the notes, saved together on the machine so every device
/// shows them. The folder is never renamed or touched. The bridge decides what changed.
struct EditProjectView: View {
    enum Ending { case cancelled, saved, removed }
    let model: ClientModel
    let project: NativeProject
    let done: (Ending) -> Void

    @State private var name: String
    @State private var icon: ProjectIconDraft
    @State private var iconTouched = false
    @State private var defaults: [String: ServiceValue]
    @State private var notes: [NoteDraft]
    @State private var options: ProjectOptions?
    @State private var optionsProblem: String?
    @State private var saving = false
    @State private var problem: String?
    @State private var removing = false
    @State private var photo: PhotosPickerItem?
    @State private var imageProblem: String?
    @State private var initials = ""

    struct NoteDraft: Identifiable, Equatable { let id = UUID(); var saved: String?; var text: String }

    init(model: ClientModel, project: NativeProject, done: @escaping (Ending) -> Void) {
        self.model = model
        self.project = project
        self.done = done
        _name = State(initialValue: project.name)
        _icon = State(initialValue: ProjectIconDraft(project: project))
        _defaults = State(initialValue: project.defaults)
        _notes = State(initialValue: project.notes.map { NoteDraft(saved: $0.id, text: $0.text) })
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("project.edit.name")
            } footer: { Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption) }
            .insetRowBackground()
            iconSection
            if let options {
                ProjectDefaultsSections(options: options, defaults: $defaults)
            } else {
                Section {
                    if let optionsProblem {
                        ServiceProblem(message: optionsProblem)
                        Button("Retry") { Task { await readOptions() } }
                    } else {
                        // The rows' own shape while the machine answers, so nothing jumps when they fill in.
                        ForEach(["Model", "Access", "Worktree", "Base branch"], id: \.self) { title in
                            LabeledContent(title) { Text("Inherit") }.redacted(reason: .placeholder)
                        }
                        .accessibilityHidden(true)
                    }
                } header: { InsetHeader("New threads") }
                .insetRowBackground()
            }
            notesSection
            Section {
                Button("Remove project…", role: .destructive) { removing = true }.accessibilityIdentifier("project.edit.remove")
            }
            .insetRowBackground()
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .smoothChange(icon.mode)
        .smoothChange(options == nil)
        .smoothChange(notes.map(\.id))
        .smoothChange(problem)
        .sensoryFeedback(.selection, trigger: icon.glyph)
        .sensoryFeedback(.error, trigger: problem) { _, now in now != nil }
        .disabled(saving)
        .navigationTitle("Edit project").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { done(.cancelled) } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else {
                    Button("Save") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("project.edit.save")
                }
            }
        }
        .projectRemoval(model: model, project: project, isPresented: $removing) { done(.removed) }
        .task { await readOptions() }
        .task(id: name) { initials = await model.projectInitials(name) ?? initials }
        .onChange(of: photo) { _, item in if let item { Task { await pick(item) } } }
    }

    // MARK: Icon

    @ViewBuilder private var iconSection: some View {
        Section {
            HStack(spacing: AceTheme.Spacing.md) {
                ProjectIconPreview(initials: initials, glyph: options?.choices.glyphs.first { $0.id == icon.glyph }?.icon, icon: icon)
                Picker("Icon", selection: Binding(get: { icon.mode }, set: { icon.mode = $0; iconTouched = true; imageProblem = nil })) {
                    Text("Auto").tag(ProjectIconDraft.Mode.auto)
                    Text("Initials").tag(ProjectIconDraft.Mode.initials)
                    Text("Icon").tag(ProjectIconDraft.Mode.glyph)
                    Text("Image").tag(ProjectIconDraft.Mode.image)
                }
                .pickerStyle(.segmented).labelsHidden()
                .accessibilityIdentifier("project.edit.iconMode")
            }
            if icon.mode == .initials || icon.mode == .glyph, let colours = options?.choices.colours {
                Picker("Colour", selection: Binding(get: { icon.color ?? "" }, set: { icon.color = $0.isEmpty ? nil : $0; iconTouched = true })) {
                    Text("Project colour").tag("")
                    ForEach(colours) { Text($0.label).tag($0.id) }
                }
                .accessibilityIdentifier("project.edit.colour")
            }
            if icon.mode == .glyph, let glyphs = options?.choices.glyphs {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: AceTheme.Spacing.xs), count: 6), spacing: AceTheme.Spacing.xs) {
                    ForEach(glyphs) { glyph in
                        let chosen = icon.glyph == glyph.id
                        Button { icon.glyph = glyph.id; iconTouched = true } label: {
                            Group {
                                if let name = AceIcon.Name(rawValue: glyph.icon) { AceIcon(name, size: 19) } else { Text(glyph.label.prefix(1)) }
                            }
                            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                            .background(chosen ? AceTheme.Colours.foreground.opacity(0.12) : .clear, in: Capsule())
                            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(glyph.label)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                    }
                }
                .padding(.vertical, AceTheme.Spacing.xs)
            }
            if icon.mode == .image {
                PhotosPicker(selection: $photo, matching: .images) { Text(icon.image == nil ? "Choose image…" : "Replace image…") }
                    .accessibilityIdentifier("project.edit.image")
                if let imageProblem { ServiceProblem(message: imageProblem) }
            }
        } header: { InsetHeader("Icon") } footer: {
            Text(icon.mode == .auto ? "Shows the project's own favicon when it has one, else its initials." : "Rows show the mark in quiet ink; the colour shows on the larger mark.")
        }
        .insetRowBackground()
    }

    private func pick(_ item: PhotosPickerItem) async {
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { imageProblem = "ace couldn't read that image. Try another one."; return }
        guard let icon = await Task.detached(priority: .userInitiated, operation: { ProjectBadgeImage.dataURL(from: data) }).value else {
            imageProblem = "ace couldn't use that image. Try another one."; return
        }
        imageProblem = nil
        self.icon.image = icon
        self.icon.mode = .image
        iconTouched = true
    }

    // MARK: Notes

    @ViewBuilder private var notesSection: some View {
        Section {
            ForEach($notes) { $note in
                HStack(alignment: .firstTextBaseline) {
                    TextField("Note", text: $note.text, axis: .vertical).lineLimit(1...6)
                    Button { notes.removeAll { $0.id == note.id } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityLabel("Remove note")
                }
            }
            Button("Add note") { notes.append(NoteDraft(saved: nil, text: "")) }
                .disabled(notes.count >= 50)
                .accessibilityIdentifier("project.edit.addNote")
        } header: { InsetHeader("Notes") } footer: { Text("Facts every agent in the project reads. Editing one makes it yours; clearing one removes it.") }
        .insetRowBackground()
    }

    // MARK: Saving

    private func readOptions() async {
        optionsProblem = nil
        do { options = try await model.projectOptions(project) }
        catch { optionsProblem = error.localizedDescription }
    }

    private func save() async {
        saving = true; problem = nil
        defer { saving = false }
        var draft: [String: Any] = ["name": name]
        if iconTouched { draft["icon"] = icon.json }
        if defaults != project.defaults, let encoded = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(ServiceValue.object(defaults))) {
            draft["defaults"] = encoded
        }
        let saved = project.notes.map { [$0.id, $0.text] }
        if notes.map({ [$0.saved ?? "", $0.text] }) != saved.map({ [$0[0], $0[1]] }) {
            draft["notes"] = notes.map { note -> [String: Any] in
                var value: [String: Any] = ["text": note.text]
                // An edited note becomes the person's, under the same id.
                if let id = note.saved { value["id"] = id }
                return value
            }
        }
        let outcome = await model.saveProject(project, draft: draft)
        if outcome.ok { done(.saved) } else { problem = outcome.message ?? "Couldn't save. Try again." }
    }
}

/// The new-thread defaults, check command and browser profile: each row starts at Inherit,
/// which leaves the machine's own setting in charge.
private struct ProjectDefaultsSections: View {
    let options: ProjectOptions
    @Binding var defaults: [String: ServiceValue]

    var body: some View {
        Section {
            Picker("Model", selection: modelBinding) {
                Text("Inherit").tag("")
                ForEach(options.models) { Text($0.label).tag($0.key) }
            }
            .accessibilityIdentifier("project.edit.model")
            Picker("Access", selection: string("access")) {
                Text("Inherit").tag("")
                ForEach(options.choices.access) { Text($0.label).tag($0.tag) }
            }
            .accessibilityIdentifier("project.edit.access")
            Picker("Worktree", selection: worktreeBinding) {
                Text("Inherit").tag("")
                Text("On").tag("on")
                Text("Off").tag("off")
            }
            .accessibilityIdentifier("project.edit.worktree")
            if options.git {
                Picker("Base branch", selection: string("baseBranch")) {
                    Text("Inherit").tag("")
                    ForEach(branchChoices, id: \.self) { Text($0).tag($0) }
                }
                .accessibilityIdentifier("project.edit.base")
            }
        } header: { InsetHeader("New threads") } footer: {
            if options.modelsFailed { Text("Couldn't list this machine's models. The saved one is kept.") }
        }
        .insetRowBackground()
        Section {
            TextField("Check command", text: string("checkCommand"), prompt: Text("The project's check script"))
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .body)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("project.edit.check")
        } header: { InsetHeader("Pull requests") } footer: { Text("Verify runs this against pull requests. Empty uses the project's own check script.") }
        .insetRowBackground()
        Section {
            Picker("Profile", selection: string("browserProfileScope")) {
                ForEach(options.choices.browserProfiles) { Text($0.label).tag($0.tag) }
            }
            .accessibilityIdentifier("project.edit.browser")
        } header: { InsetHeader("Browser") } footer: {
            Text("\(options.choices.browserProfiles.first { $0.tag == text("browserProfileScope") }?.note ?? "") Applies to browsers opened after you save.")
        }
        .insetRowBackground()
    }

    private func text(_ key: String) -> String { if case .string(let value) = defaults[key] { value } else { "" } }
    private func string(_ key: String) -> Binding<String> {
        Binding(get: { text(key) }, set: { value in
            if value.trimmingCharacters(in: .whitespaces).isEmpty { defaults[key] = nil } else { defaults[key] = .string(value) }
        })
    }
    private var branchChoices: [String] {
        let saved = text("baseBranch")
        return saved.isEmpty || options.branches.contains(saved) ? options.branches : [saved] + options.branches
    }
    private var modelBinding: Binding<String> {
        Binding(get: {
            let provider = text("provider"), model = text("model")
            return provider.isEmpty || model.isEmpty ? "" : "\(provider)\n\(model)"
        }, set: { key in
            let parts = key.split(separator: "\n", maxSplits: 1).map(String.init)
            if parts.count == 2 { defaults["provider"] = .string(parts[0]); defaults["model"] = .string(parts[1]) }
            else { defaults["provider"] = nil; defaults["model"] = nil }
        })
    }
    private var worktreeBinding: Binding<String> {
        Binding(get: {
            if case .bool(let on) = defaults["worktree"] { on ? "on" : "off" } else { "" }
        }, set: { value in defaults["worktree"] = value.isEmpty ? nil : .bool(value == "on") })
    }
}

/// The editor's live mark: the chosen image, glyph or initials on the quiet fill.
private struct ProjectIconPreview: View {
    let initials: String
    let glyph: String?
    let icon: ProjectIconDraft
    @State private var image: UIImage?
    var body: some View {
        RoundedRectangle(cornerRadius: AceTheme.Radii.small, style: .continuous)
            .fill(AceTheme.Colours.background)
            .overlay {
                if icon.mode == .image, let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if icon.mode == .glyph, let glyph = glyph.flatMap(AceIcon.Name.init(rawValue:)) {
                    AceIcon(glyph, size: 20).foregroundStyle(AceTheme.Colours.foreground)
                } else {
                    Text(initials).font(.system(size: 15, weight: .semibold)).foregroundStyle(AceTheme.Colours.foreground)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.small, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: AceTheme.Radii.small, style: .continuous).strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border) }
            .frame(width: 40, height: 40)
            .accessibilityHidden(true)
            .task(id: icon.image) { image = icon.image.flatMap(ProjectBadgeImage.decode) }
    }
}
