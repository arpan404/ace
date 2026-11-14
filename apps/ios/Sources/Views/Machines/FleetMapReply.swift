import Foundation

/// The bridge's Fleet map (`fleetMap.combine` in `bridge/fleet-map.ts`): every machine and
/// device with its state, how it's reached, its problem and the fixes, and each machine's reach
/// rows. Every word and decision arrives ready; Swift draws the rows and runs the actions.
struct FleetMapReply: Decodable, Equatable {
    struct Line: Decodable, Equatable, Hashable { let label: String; let value: String }
    struct Problem: Decodable, Equatable { let what: String; let why: String }
    /// A question asked before a change that can disconnect something.
    struct Question: Decodable, Equatable { let title: String; let body: String; let confirm: String }
    struct Target: Decodable, Equatable { let machine: String; let deviceId: String }
    /// What a fix does: `open` the machine's page, `retry` its connection, write a `setting` on
    /// a machine, `revoke` a device on every machine it's on, or show a `hint`.
    struct Action: Decodable, Equatable {
        let kind: String
        var machine: String?
        var key: String?
        var value: Bool?
        var devices: [Target]?
        var confirm: Question?
        var text: String?
    }
    struct Fix: Decodable, Equatable, Identifiable { let id: String; let label: String; let primary: Bool; let action: Action }
    struct Row: Decodable, Equatable, Identifiable {
        let id: String
        let kind: String
        let name: String
        let art: String
        let token: String
        let state: String
        let line: String
        let lines: [Line]
        let problem: Problem?
        let fixes: [Fix]
        let machine: String?
    }
    struct ReachAction: Decodable, Equatable { let label: String; let key: String; let value: Bool; let confirm: Question? }
    struct ReachRow: Decodable, Equatable, Identifiable { let id: String; let title: String; let token: String; let words: String; let action: ReachAction? }
    struct Reach: Decodable, Equatable, Identifiable { let id: String; let name: String; let rows: [ReachRow] }

    let summary: String
    let problems: Int
    let rows: [Row]
    let reach: [Reach]

    var machines: [Row] { rows.filter { $0.kind == "machine" } }
    var devices: [Row] { rows.filter { $0.kind == "device" } }
    var needing: [Row] { rows.filter { $0.problem != nil } }

    /// The SF Symbol for a row's art (`MapArt`).
    static func symbol(_ art: String) -> String {
        switch art {
        case "desktop": "desktopcomputer"
        case "server": "server.rack"
        case "phone": "iphone"
        case "tablet": "ipad"
        case "browser": "globe"
        default: "laptopcomputer"
        }
    }
}
