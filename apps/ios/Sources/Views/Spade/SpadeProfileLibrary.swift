import SwiftUI

/// Library: what the bot keeps. A search over all of it at the top; then Spade's own starts
/// with what every bot knows about the person; then its notes, its pages, its past work, the
/// files at the top of its workspace and its skills. While something is typed, the matches show
/// in those groups instead.
struct SpadeProfileLibrary: View {
    let library: SpadeProfile.Library
    let name: String
    let retry: () -> Void
    @Environment(\.spadeProfileScope) private var scope
    @State private var query = ""

    var body: some View {
        if let scope {
            SpadeLibrarySearchField(query: $query, name: name)
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sections(scope)
            } else {
                SpadeLibraryResults(scope: scope, query: query)
            }
        } else {
            sections(nil)
        }
    }

    @ViewBuilder private func sections(_ scope: SpadeProfileScope?) -> some View {
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
        if let scope { SpadeLibraryPast(scope: scope) }
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
