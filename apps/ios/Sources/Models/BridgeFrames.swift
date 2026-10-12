import Foundation

struct BridgeFragment: Decodable, Sendable {
    let id: String
    let index: Int
    let last: Bool
    let bytes: [UInt8]
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
                    guard transferId == fragment.id, nextIndex == fragment.index,
                          fragment.bytes.count <= 4096,
                          assembly.count + fragment.bytes.count <= 8 * 1024 * 1024 else { throw FrameError.budget }
                    assembly.append(contentsOf: fragment.bytes)
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
