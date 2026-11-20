import Foundation

/// A bot's profile as the bridge reads it (`bridge/spade-profile.ts`): Details, Library and
/// Computer. A part Spade couldn't read is nil, and the sheet says so where it would be.
struct SpadeProfile: Decodable, Equatable, Sendable {
    struct Routine: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String
        let failed: Bool
    }
    struct Details: Decodable, Equatable, Sendable {
        let task: String
        let model: String
        let machine: String
        let routines: [Routine]?
    }
    struct Page: Decodable, Equatable, Sendable, Hashable {
        let title: String
        let topic: String
    }
    struct File: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let folder: Bool
        /// When it was last written, in ms.
        let at: Double?
    }
    struct Skill: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let word: String
    }
    struct Library: Decodable, Equatable, Sendable {
        /// What every bot knows about the person: Spade's own Library only.
        let about: [String]?
        let notes: [String]?
        let pages: [Page]?
        let files: [File]?
        let skills: [Skill]?
    }
    struct Surface: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String?
        let live: Bool
    }
    struct Service: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let words: String
        let running: Bool
    }
    struct Computer: Decodable, Equatable, Sendable {
        let line: String
        let surfaces: [Surface]
        let services: [Service]?
    }

    let id: String
    let name: String
    let face: SpadeModel.Face
    let details: Details
    let library: Library
    let computer: Computer
}

/// What `spade.profile` answers: the profile, or why it couldn't be read.
struct SpadeProfileAnswer: Decodable, Sendable {
    let ok: Bool
    let profile: SpadeProfile?
    let title: String?
    let message: String?
    var problem: String? {
        SpadeOutcome(ok: ok, title: title, message: message).problem
    }
}
