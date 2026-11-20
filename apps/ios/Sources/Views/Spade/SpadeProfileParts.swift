import SwiftUI

/// Details: what the bot is for (its task, which opens to edit), the model and machine it runs
/// with, and its routines with when each runs.
struct SpadeProfileDetails<Editor: View>: View {
    let profile: SpadeProfile
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
            if let routines = details.routines {
                if routines.isEmpty { SpadeProfileNone(text: "\(profile.name) has no routines yet.") }
                ForEach(routines, id: \.self) { routine in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(routine.name).aceFont(AceDesign.TextRole.rowTitle)
                        Text(routine.line)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(routine.failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                SpadeProfileNone(text: "Couldn't read the routines.", failed: true)
            }
        }
    }
}

/// Library: what the bot keeps. Spade's own starts with what every bot knows about the person;
/// then its notes, its pages, the files at the top of its workspace and its skills.
struct SpadeProfileLibrary: View {
    let library: SpadeProfile.Library
    let name: String

    var body: some View {
        if let about = library.about {
            textSection("About you", about, none: "Nothing about you yet.")
        }
        textSection("Notes", library.notes, none: "\(name) hasn't noted anything yet.")
        Section("Pages") {
            rows(library.pages, none: "\(name) hasn't written any pages yet.") { page in
                Label(page.title, systemImage: "doc.text")
            }
        }
        Section("Files") {
            rows(library.files, none: "\(name) hasn't kept any files yet.") { file in
                LabeledContent {
                    if let at = file.at {
                        Text(Date(timeIntervalSince1970: at / 1000), format: .relative(presentation: .named))
                            .aceFont(AceDesign.TextRole.meta)
                    }
                } label: {
                    Label(file.name, systemImage: file.folder ? "folder" : "doc")
                }
            }
        }
        Section("Skills") {
            rows(library.skills, none: "\(name) hasn't used a skill yet.") { skill in
                LabeledContent { Text(skill.word).aceFont(AceDesign.TextRole.meta) } label: {
                    Label(skill.name, systemImage: "square.stack")
                }
            }
        }
    }

    private func textSection(_ title: String, _ texts: [String]?, none: String) -> some View {
        Section(title) {
            rows(texts.map { $0.enumerated().map { Note(id: $0.offset, text: $0.element) } }, none: none) { note in
                Text(note.text).aceFont(AceDesign.TextRole.message)
            }
        }
    }

    private struct Note: Hashable {
        let id: Int
        let text: String
    }
}

/// Computer: what the bot drives. One line for its state, the surfaces it has used (the ones
/// in use now marked), and the services it keeps running.
struct SpadeProfileComputer: View {
    let computer: SpadeProfile.Computer

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
        if let services = computer.services, !services.isEmpty {
            Section("Services") {
                ForEach(services, id: \.self) { service in
                    LabeledContent(service.name) {
                        Text(service.words)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(service.running ? AceDesign.Status.working : AceDesign.Ink.muted)
                    }
                }
            }
        } else if computer.services == nil {
            Section("Services") { SpadeProfileNone(text: "Couldn't read the services.", failed: true) }
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

/// A list part's rows: each item, one line when there are none, or that it couldn't be read.
@ViewBuilder private func rows<Item: Hashable, Row: View>(
    _ items: [Item]?, none: String, @ViewBuilder row: @escaping (Item) -> Row
) -> some View {
    if let items {
        if items.isEmpty { SpadeProfileNone(text: none) }
        ForEach(items, id: \.self) { row($0) }
    } else {
        SpadeProfileNone(text: "Couldn't read this.", failed: true)
    }
}
