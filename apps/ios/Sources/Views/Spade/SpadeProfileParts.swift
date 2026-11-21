import SwiftUI

/// Details: what the bot is for (its task, which opens to edit), the model and machine it runs
/// with, and its routines with when each runs.
struct SpadeProfileDetails<Editor: View>: View {
    let profile: SpadeProfile
    let retry: () -> Void
    @ViewBuilder let edit: (String) -> Editor

    var body: some View {
        let details = profile.details
        Section("Task") {
            NavigationLink { edit(details.task) } label: {
                Text(details.task.isEmpty ? "What this bot is for, in your words" : details.task)
                    .aceFont(AceDesign.TextRole.message)
                    .foregroundStyle(details.task.isEmpty ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                    .lineLimit(8)
            }
            .accessibilityIdentifier("spade.profile.task")
        }
        Section("Runs with") {
            LabeledContent("Model", value: details.model)
            LabeledContent("Machine", value: details.machine)
        }
        Section("Routines") {
            SpadeProfileRows(part: details.routines, none: "\(profile.name) has no routines yet.",
                             failed: "Couldn't read the routines.", retry: retry) { routine in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(routine.name).aceFont(AceDesign.TextRole.rowTitle)
                    Text(routine.line)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(routine.failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// Library: what the bot keeps. Spade's own starts with what every bot knows about the person;
/// then its notes, its pages, the files at the top of its workspace and its skills.
struct SpadeProfileLibrary: View {
    let library: SpadeProfile.Library
    let name: String
    let retry: () -> Void

    var body: some View {
        if let about = library.about {
            Section("About you") {
                SpadeProfileRows(part: about, none: "Nothing about you yet.",
                                 failed: "Couldn't read what Spade knows about you.", retry: retry) { note in
                    Text(note).aceFont(AceDesign.TextRole.message)
                }
            }
        }
        Section("Notes") {
            SpadeProfileRows(part: library.notes, none: "\(name) hasn't noted anything yet.",
                             failed: "Couldn't read the notes.", retry: retry) { note in
                Text(note).aceFont(AceDesign.TextRole.message)
            }
        }
        Section("Pages") {
            SpadeProfileRows(part: library.pages, none: "\(name) hasn't written any pages yet.",
                             failed: "Couldn't read the pages.", retry: retry) { page in
                Label(page.title, ace: .fileText)
            }
        }
        Section("Files") {
            SpadeProfileRows(part: library.files, none: "\(name) hasn't kept any files yet.",
                             failed: "Couldn't read the files.", retry: retry) { file in
                LabeledContent {
                    if let at = file.at {
                        Text(Date(timeIntervalSince1970: at / 1000), format: .relative(presentation: .named))
                            .aceFont(AceDesign.TextRole.meta)
                    }
                } label: {
                    Label(file.name, ace: file.folder ? .folder : .file)
                }
            }
        }
        Section("Skills") {
            SpadeProfileRows(part: library.skills, none: "\(name) hasn't used a skill yet.",
                             failed: "Couldn't read the skills.", retry: retry) { skill in
                LabeledContent { Text(skill.word).aceFont(AceDesign.TextRole.meta) } label: {
                    Label(skill.name, ace: .stack)
                }
            }
        }
    }
}

/// Computer: what the bot drives. One line for its state, the surfaces it has used (the ones
/// in use now marked), and the services it keeps running.
struct SpadeProfileComputer: View {
    let computer: SpadeProfile.Computer
    let retry: () -> Void

    var body: some View {
        Section {
            Text(computer.line)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
                .accessibilityIdentifier("spade.profile.computer")
            ForEach(computer.surfaces, id: \.self) { surface in
                LabeledContent {
                    if surface.live {
                        Text("In use").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Status.working)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(surface.name).aceFont(AceDesign.TextRole.rowTitle)
                        if let line = surface.line {
                            Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                        }
                    }
                }
            }
        }
        // Services show once the bot has started one, or when they couldn't be read.
        if computer.services.failed || !computer.services.items.isEmpty {
            Section("Services") {
                SpadeProfileRows(part: computer.services, none: "", failed: "Couldn't read the services.",
                                 retry: retry) { service in
                    LabeledContent(service.name) {
                        Text(service.words)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(service.running ? AceDesign.Status.working : AceDesign.Ink.muted)
                    }
                }
            }
        }
    }
}

/// A part with nothing in it, or one Spade couldn't read.
struct SpadeProfileNone: View {
    let text: String
    var failed = false
    var body: some View {
        Text(text)
            .aceFont(AceDesign.TextRole.meta)
            .foregroundStyle(failed ? AceTheme.StatusText.failed : AceDesign.Ink.subtle)
    }
}

/// A list's rows: its items and how many more stay on the computer, one line when there are
/// none, or that it couldn't be read, with Try again.
struct SpadeProfileRows<Item: Decodable & Equatable & Sendable & Hashable, Row: View>: View {
    let part: SpadeProfile.Part<Item>
    let none: String
    let failed: String
    let retry: () -> Void
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        if part.failed {
            HStack {
                SpadeProfileNone(text: failed, failed: true)
                Spacer(minLength: AceDesign.Space.related)
                Button("Try again", action: retry)
                    .aceFont(AceDesign.TextRole.meta)
                    .accessibilityIdentifier("spade.profile.retry")
            }
        } else {
            if part.items.isEmpty { SpadeProfileNone(text: none) }
            // By place: two notes may say the same thing.
            ForEach(Array(part.items.enumerated()), id: \.offset) { row($0.element) }
            if part.more > 0 { SpadeProfileNone(text: "\(part.more) more on the computer") }
        }
    }
}
