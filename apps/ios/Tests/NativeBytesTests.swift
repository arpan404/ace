import Foundation
import JavaScriptCore
import Testing
import zlib
@testable import Ace

/// The bridge's native byte functions, called from real JavaScriptCore the way the client calls them.
@Suite struct NativeBytesTests {
    let context: JSContext

    init() throws {
        context = try #require(JSContext())
        context.setObject(NativeBytes.functions(), forKeyedSubscript: "bytes" as NSString)
    }

    func evaluate(_ script: String) -> JSValue? {
        let value = context.evaluateScript(script)
        return context.exception == nil ? value : nil
    }
    /// `data` as a Uint8Array subarray that starts three bytes into a larger buffer.
    func offsetArray(_ name: String, _ data: Data) {
        let numbers = ([7, 7, 7] + [UInt8](data) + [7]).map(String.init).joined(separator: ",")
        context.evaluateScript("var \(name) = new Uint8Array([\(numbers)]).subarray(3, \(data.count + 3));")
    }

    @Test func gzipFromTheDaemonExpandsToItsExactBytesFromAnOffsetView() throws {
        let text = String(repeating: "export const value = 'ü';\n", count: 20_000)
        offsetArray("packed", try compress(Data(text.utf8), windowBits: 31))
        let decoded = evaluate("bytes.decode(bytes.inflate(packed, 'gzip'), 'utf-8', true)")?.toString()
        #expect(decoded == text)
    }

    @Test func rawDeflateFromTheRelayExpands() throws {
        offsetArray("packed", try compress(Data("{\"type\":\"events\"}".utf8), windowBits: -15))
        #expect(evaluate("bytes.decode(bytes.inflate(packed, 'deflate-raw'), 'utf-8', true)")?.toString() == "{\"type\":\"events\"}")
    }

    @Test func corruptTruncatedOrPaddedInputIsRefused() throws {
        let packed = try compress(Data(String(repeating: "abc", count: 5000).utf8), windowBits: 31)
        var corrupt = packed
        corrupt[corrupt.count - 6] ^= 0xff
        offsetArray("corrupt", corrupt)
        offsetArray("truncated", packed.prefix(packed.count - 10))
        offsetArray("padded", packed + Data([1, 2, 3]))
        #expect(evaluate("bytes.inflate(corrupt, 'gzip') === null")?.toBool() == true)
        #expect(evaluate("bytes.inflate(truncated, 'gzip') === null")?.toBool() == true)
        #expect(evaluate("bytes.inflate(padded, 'gzip') === null")?.toBool() == true)
        #expect(evaluate("bytes.inflate(new Uint8Array([1, 2, 3]), 'brotli') === null")?.toBool() == true)
    }

    @Test func aSmallInputThatWouldExpandPastTheCeilingIsRefused() throws {
        let bomb = try compress(Data(count: NativeBytes.inflateCeiling + 1), windowBits: 31)
        #expect(bomb.count < 64 * 1024)
        offsetArray("bomb", bomb)
        #expect(evaluate("bytes.inflate(bomb, 'gzip') === null")?.toBool() == true)
    }

    @Test func textRoundTripsAsUTF8ThroughTypedArrays() {
        let encoded = evaluate("var e = bytes.encode('héllo 🌍'); [e instanceof Uint8Array, e.length, Array.from(e).join(',')].join(' ')")
        #expect(encoded?.toString() == "true 11 104,195,169,108,108,111,32,240,159,140,141")
        #expect(evaluate("bytes.decode(e.subarray(1, 3), 'utf-8', true)")?.toString() == "é")
        #expect(evaluate("bytes.decode(new Uint8Array(0), 'utf-8', true)")?.toString() == "")
    }

    @Test func invalidUTF8ThrowsOnlyWhenFatal() {
        #expect(evaluate("bytes.decode(new Uint8Array([104, 255]), 'utf-8', false)")?.toString() == "h\u{FFFD}")
        context.evaluateScript("bytes.decode(new Uint8Array([104, 255]), 'utf-8', true)")
        #expect(context.exception != nil)
    }
}

/// zlib-compressed `data`: gzip for window bits 31, raw deflate for -15.
private func compress(_ data: Data, windowBits: Int32) throws -> Data {
    var stream = z_stream()
    try #require(deflateInit2_(&stream, 6, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK)
    defer { deflateEnd(&stream) }
    var input = [UInt8](data)
    var output = [UInt8](repeating: 0, count: Int(deflateBound(&stream, uLong(input.count))))
    let status = input.withUnsafeMutableBufferPointer { source in
        output.withUnsafeMutableBufferPointer { target in
            stream.next_in = source.baseAddress
            stream.avail_in = uInt(source.count)
            stream.next_out = target.baseAddress
            stream.avail_out = uInt(target.count)
            return deflate(&stream, Z_FINISH)
        }
    }
    try #require(status == Z_STREAM_END)
    return Data(output.prefix(Int(stream.total_out)))
}
