import Foundation

struct BridgeFragment: Decodable, Sendable {
    let id: String
    let index: Int
    let last: Bool
    let data: String
}

/// One acknowledged transfer at a time; fragments never expose a partially updated row.
struct BridgeFrames {
    private var transferId: String?
    private var nextIndex = 0
    private var assembly = Data()

    mutating func decode(_ data: Data) throws -> [BridgePatch] {
        do {
            guard data.count <= 32768 else { throw FrameError.budget }
            let patches = try JSONDecoder().decode([BridgePatch].self, from: data)
            guard patches.count <= 32 else { throw FrameError.budget }
            var result: [BridgePatch] = []
            for patch in patches {
                if case .fragment(let fragment) = patch {
                    if transferId == nil {
                        guard fragment.index == 0 else { throw FrameError.order }
                        transferId = fragment.id
                    }
                    // SDK reassembly admits 64 MiB UTF-16, independently of its 2 MiB
                    // physical frames. Allow UTF-8 expansion, duplicated DTO identities
                    // and a separately retained scope ID. No capacity is preallocated.
                    guard transferId == fragment.id, nextIndex == fragment.index,
                          fragment.data.utf8.count <= 24576,
                          let bytes = Data(base64Encoded: fragment.data), bytes.count <= 18432,
                          assembly.count + bytes.count <= 512 * 1024 * 1024 else { throw FrameError.budget }
                    assembly.append(bytes)
                    nextIndex += 1
                    if fragment.last {
                        let assembled = try JSONDecoder().decode(BridgePatch.self, from: assembly)
                        if case .fragment = assembled { throw FrameError.order }
                        result.append(assembled)
                        reset()
                    }
                } else {
                    guard transferId == nil else { throw FrameError.order }
                    result.append(patch)
                }
            }
            return result
        } catch { reset(); throw error }
    }
    private mutating func reset() { transferId = nil; nextIndex = 0; assembly = Data() }
}
private enum FrameError: Error { case budget, order }

/// Decodes a runtime's frames on the thread that emits them, so the main thread only applies the
/// result. One frame is in flight at a time; the lock only guards against misuse.
final class FrameDecoder: @unchecked Sendable {
    private let lock = NSLock()
    private var frames = BridgeFrames()
    /// The frame's complete patches, or nil when it could not be read (the assembly resets).
    func decode(_ data: Data) -> [BridgePatch]? {
        lock.withLock { HostTrace.measure("host.decodeFrame", bytes: data.count) { try? frames.decode(data) } }
    }
}
