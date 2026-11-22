import SwiftUI

/// Whose profile a section is on and the machine to ask: what the sections that act (Task's
/// history and package line, Routines, Library's search and past work) need beyond what the
/// profile read. The sheet sets it once over its list; a section without it shows the profile's
/// own preview and nothing to act on.
struct SpadeProfileScope {
    let client: ClientModel
    let agent: String
    /// The bot's name, for the words the sections say.
    let name: String
    /// The machine it runs on, where a Marketplace review says it installs.
    let machine: String
}

extension EnvironmentValues {
    @Entry var spadeProfileScope: SpadeProfileScope? = nil
}
