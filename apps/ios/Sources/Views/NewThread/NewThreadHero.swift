import SwiftUI

/// "What should we build in ace?", centred: the question muted, the project at full ink with a
/// dotted underline. The project is a menu of the machine's projects, recent first, with the
/// full searchable list and Add project behind it.
struct NewThreadHero: View {
    let projects: [ComposeProject]
    let selected: ComposeProject?
    let canAdd: Bool
    let choose: (String) -> Void
    let allProjects: () -> Void
    let addProject: () -> Void
    /// How many projects the menu lists before "All projects".
    private static let shown = 6

    var body: some View {
        Menu {
            Section {
                ForEach(projects.prefix(Self.shown)) { project in
                    Button { choose(project.id) } label: {
                        if project.id == selected?.id { Label(project.name, ace: .check) } else { Text(project.name) }
                    }
                    .accessibilityIdentifier("project.\(project.id)")
                }
            }
            Button("All projects", ace: .magnifyingGlass, action: allProjects)
                .accessibilityIdentifier("newThread.allProjects")
            if canAdd {
                Button("Add project", ace: .plus, action: addProject)
                    .accessibilityIdentifier("projects.add")
            }
        } label: {
            question
                .aceFont(NewThreadStyle.hero, relativeTo: .title)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected.map { "Project, \($0.name)" } ?? "Choose a project")
        .accessibilityIdentifier("newThread.project")
    }

    private var question: Text {
        let muted = AceTheme.Colours.mutedForeground
        let project = Text(selected?.name ?? "a project")
            .foregroundStyle(selected == nil ? muted : AceTheme.Colours.foreground)
            .underline(pattern: .dot, color: AceTheme.Colours.decoration)
        return Text("What should we build in ").foregroundStyle(muted) + project + Text("?").foregroundStyle(muted)
    }
}
