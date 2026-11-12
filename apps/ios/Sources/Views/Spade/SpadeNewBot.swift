import SwiftUI

/// A new bot on this machine (ADR 0126), as the web's New bot form: its name, what it is for
/// (its instructions), the model it runs on from the person's endpoints, and its face's colour.
/// Making it opens its conversation. A failure keeps everything typed, with why; when the answer
/// was lost Spade may have made it, so the words stay under the bridge's note and nothing is sent
/// again on its own.
struct SpadeNewBot: View {
    let model: ClientModel
    let made: (SpadeModel.Opened) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var task = ""
    @State private var choice = ""
    @State private var colour = "slate"
    @State private var models: SpadeModels?
    @State private var saving = false
    @State private var problem: String?

    private var ready: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !choice.isEmpty && !saving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("spade.new.name")
                    TextField("What it's for", text: $task, axis: .vertical)
                        .lineLimit(3...8)
                        .accessibilityIdentifier("spade.new.task")
                } footer: { Text("Its instructions, in your words. You can change them later.") }
                modelSection
                if let colours = models?.colors, !colours.isEmpty {
                    Section { swatches(colours) } header: { InsetHeader("Face") }
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("spade.new.problem") }
                }
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Making…" : "Make", action: create).disabled(!ready)
                        .accessibilityIdentifier("spade.new.make")
                }
            }
            .task { await read() }
        }
        .interactiveDismissDisabled(saving || !name.isEmpty || !task.isEmpty)
    }

    @ViewBuilder private var modelSection: some View {
        Section {
            if let models, models.ok, let choices = models.choices {
                if choices.isEmpty {
                    Text("Add an endpoint with a key in Settings › Spade first.").foregroundStyle(AceDesign.Ink.muted)
                } else {
                    Picker("Model", selection: $choice) {
                        ForEach(choices) { Text($0.label).tag($0.ref) }
                    }
                    .accessibilityIdentifier("spade.new.model")
                }
            } else if let models, !models.ok {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(models.words ?? "Couldn't read your endpoints.").foregroundStyle(AceDesign.Ink.muted)
                    Button("Try again") { Task { await read() } }.buttonStyle(.textAction(.prominent))
                }
            } else {
                SkeletonBar(width: 180, height: 15)
            }
        } header: { InsetHeader("Model") }
    }

    private func swatches(_ colours: [SpadeModels.Colour]) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            ForEach(colours) { each in
                Button { colour = each.id } label: {
                    Circle().fill(Color(hexString: each.fill) ?? AceTheme.Colours.fill)
                        .frame(width: AceDesign.Size.swatch, height: AceDesign.Size.swatch)
                        .overlay(Circle().stroke(AceDesign.Ink.primary, lineWidth: colour == each.id ? 2 : 0).padding(-3))
                        .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(each.id.capitalized)
                .accessibilityAddTraits(colour == each.id ? .isSelected : [])
            }
        }
    }

    private func read() async {
        let read = await model.spadeModels()
        models = read
        if choice.isEmpty, let first = read.choices?.first { choice = first.ref }
    }

    private func create() {
        guard ready else { return }
        saving = true
        problem = nil
        Task {
            let outcome = await model.spadeRequest(
                ["type": "spade.create", "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                 "task": task.trimmingCharacters(in: .whitespacesAndNewlines), "model": choice, "color": colour],
                failing: "Couldn't make the bot")
            saving = false
            if outcome.ok, let agentId = outcome.agentId, let conversationId = outcome.conversationId {
                made(SpadeModel.Opened(agentId: agentId, conversationId: conversationId))
            } else {
                problem = outcome.words
            }
        }
    }
}

extension SpadeModels {
    /// Why the read failed, in the person's words.
    var words: String? {
        let said = [title, message].compactMap(\.self).filter { !$0.isEmpty }
        return said.isEmpty ? nil : said.joined(separator: ". ")
    }
}
