// The profile yjs-paragraphs/1 (Appendix A) as far as a checker needs it: reading Yjs update
// encoding version 1 without applying it ("Reading without applying"), its state vector, and
// the encoding of what a replica deleted ("What a replica deleted").
//
// The layout follows the normative reference Appendix A names, Yjs 13.6.33, with lib0 0.2.118 as
// Yjs reads it, which Appendix A names as informative (`readClientsStructRefs`,
// `readItemContent` and the content readers, `readDeleteSet`, `readStateVector`, lib0's
// `readVarUint`, `readVarInt`, `readVarString`, `readAny`) — and the
// rows of Appendix A, which add bounds: no integer above 2^53 − 1 or longer than 8 bytes, no
// client's structs and no delete range ending beyond 2^53 − 1, no nesting beyond 32.

public struct YID: Hashable, CustomStringConvertible {
    public var client: UInt64
    public var clock: UInt64
    public var description: String { "(\(client), \(clock))" }
}

enum YParent: Hashable {
    /// A top-level type, by name (`parentYKey`).
    case root(String)
    /// The type an item holds, by that item's id.
    case item(YID)
}

enum YContent {
    case deleted(UInt64)
    case json(count: UInt64)
    case binary
    /// A string, as the UTF-16 code units that its clocks count.
    case string([UInt16])
    case embed
    case format
    /// A shared type: its type ref (0 YArray … 6 YXmlText) and, for an element or a hook, its name.
    case type(ref: UInt64, name: String?)
    case any(count: UInt64)
    case doc

    var length: UInt64 {
        switch self {
        case .deleted(let n), .json(let n), .any(let n): return n
        case .string(let units): return UInt64(units.count)
        default: return 1
        }
    }
}

struct YItem {
    var id: YID
    var origin: YID?
    var rightOrigin: YID?
    /// nil when the item copies its parent from its origin or right origin.
    var parent: YParent?
    var parentSub: String?
    var content: YContent
}

enum YStruct {
    case gc(YID, length: UInt64)
    case skip(YID, length: UInt64)
    case item(YItem)

    var id: YID {
        switch self {
        case .gc(let id, _), .skip(let id, _): return id
        case .item(let item): return item.id
        }
    }

    var length: UInt64 {
        switch self {
        case .gc(_, let n), .skip(_, let n): return n
        case .item(let item): return item.content.length
        }
    }
}

struct YUpdate {
    var structs: [YStruct]
    /// Per client, its ranges [clock, length] as written.
    var deleteSet: [(client: UInt64, ranges: [(clock: UInt64, length: UInt64)])]
}

struct YjsError: Error, CustomStringConvertible {
    let description: String
}

struct YjsReader {
    /// Appendix A: a variable-length integer above 2^53 − 1, or longer than 8 bytes, is not read.
    static let maxSafe: UInt64 = (1 << 53) - 1
    static let maxVarintBytes = 8
    /// Appendix A: an `Any` value nests at most 32 arrays and objects, the outermost level 1.
    static let maxAnyDepth = 32

    let bytes: [UInt8]
    var pos = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    var atEnd: Bool { pos == bytes.count }

    mutating func byte() throws -> UInt8 {
        guard pos < bytes.count else { throw YjsError(description: "runs past the end") }
        defer { pos += 1 }
        return bytes[pos]
    }

    /// lib0's variable-length unsigned integer: 7 bits per byte, least significant first, the
    /// high bit set on every byte but the last.
    mutating func varUint() throws -> UInt64 {
        var value: UInt64 = 0
        var shift: UInt64 = 0
        var length = 0
        while true {
            length += 1
            guard length <= YjsReader.maxVarintBytes else { throw YjsError(description: "a variable-length integer longer than 8 bytes") }
            let b = try byte()
            let bits = UInt64(b & 0x7F)
            if bits != 0 {
                guard shift < 53, bits <= (maxSafeShifted(shift)) else {
                    throw YjsError(description: "a variable-length integer above 2^53 − 1")
                }
                value += bits << shift
                guard value <= YjsReader.maxSafe else { throw YjsError(description: "a variable-length integer above 2^53 − 1") }
            }
            if b < 0x80 { return value }
            shift += 7
        }
    }

    private func maxSafeShifted(_ shift: UInt64) -> UInt64 { YjsReader.maxSafe >> shift }

    /// lib0's variable-length signed integer: the first byte carries 6 bits, the sign (0x40)
    /// and the continuation bit (0x80), every further byte 7 bits.
    mutating func varInt() throws -> Int64 {
        let first = try byte()
        var value = UInt64(first & 0x3F)
        let negative = first & 0x40 != 0
        if first & 0x80 != 0 {
            var shift: UInt64 = 6
            var length = 1
            while true {
                length += 1
                guard length <= YjsReader.maxVarintBytes else { throw YjsError(description: "a variable-length integer longer than 8 bytes") }
                let b = try byte()
                let bits = UInt64(b & 0x7F)
                if bits != 0 {
                    guard shift < 53, bits <= maxSafeShifted(shift) else {
                        throw YjsError(description: "a variable-length integer above 2^53 − 1")
                    }
                    value += bits << shift
                    guard value <= YjsReader.maxSafe else { throw YjsError(description: "a variable-length integer above 2^53 − 1") }
                }
                if b < 0x80 { break }
                shift += 7
            }
        }
        return negative ? -Int64(value) : Int64(value)
    }

    mutating func take(_ n: UInt64) throws -> ArraySlice<UInt8> {
        guard n <= UInt64(bytes.count - pos) else { throw YjsError(description: "a length that runs past the end") }
        defer { pos += Int(n) }
        return bytes[pos..<pos + Int(n)]
    }

    mutating func varString() throws -> String {
        let n = try varUint()
        guard let s = UTF8Text.string(try take(n)) else { throw YjsError(description: "a string that is not UTF-8") }
        return s
    }

    mutating func id() throws -> YID { YID(client: try varUint(), clock: try varUint()) }

    /// JSON content, as Yjs reads it with `JSON.parse`.
    mutating func json() throws {
        let text = try varString()
        do { _ = try JSONParser.parse(Array(text.utf8), options: .yjsContent) } catch {
            throw YjsError(description: "JSON content that does not parse")
        }
    }

    /// lib0's `readAny`: a tag from 127 down to 116, then its value. `depth` counts the arrays
    /// and objects around it; the recursion is bounded by the nesting limit.
    mutating func any(depth: Int = 0) throws {
        let tag = try byte()
        if tag == 118 || tag == 117, depth >= YjsReader.maxAnyDepth {
            throw YjsError(description: "an Any value nested more than 32 levels")
        }
        switch tag {
        case 127, 126, 121, 120: return  // undefined, null, false, true
        case 125: _ = try varInt()
        case 124: _ = try take(4)  // float32
        case 123: _ = try take(8)  // float64
        case 122: _ = try take(8)  // bigint64
        case 119: _ = try varString()
        case 118:  // object
            let n = try varUint()
            var i: UInt64 = 0
            while i < n { _ = try varString(); try any(depth: depth + 1); i += 1 }
        case 117:  // array
            let n = try varUint()
            var i: UInt64 = 0
            while i < n { try any(depth: depth + 1); i += 1 }
        case 116: _ = try take(try varUint())  // Uint8Array
        default: throw YjsError(description: "a tag of an Any value the encoding does not define: \(tag)")
        }
    }

    /// Item content by the low five bits of the info byte (Yjs `contentRefs`, 1 to 9).
    mutating func content(_ kind: UInt8) throws -> YContent {
        switch kind {
        case 1: return .deleted(try varUint())
        case 2:
            let n = try varUint()
            var i: UInt64 = 0
            while i < n {
                let text = try varString()
                // Yjs writes `undefined` as the string "undefined", which it does not parse.
                if text != "undefined" {
                    do { _ = try JSONParser.parse(Array(text.utf8), options: .yjsContent) } catch {
                        throw YjsError(description: "JSON content that does not parse")
                    }
                }
                i += 1
            }
            return .json(count: n)
        case 3: _ = try take(try varUint()); return .binary
        case 4: return .string(Array(try varString().utf16))
        case 5: try json(); return .embed
        case 6: _ = try varString(); try json(); return .format
        case 7:
            let ref = try varUint()
            switch ref {
            case 3, 5: return .type(ref: ref, name: try varString())  // YXmlElement, YXmlHook: a name
            case 0, 1, 2, 4, 6: return .type(ref: ref, name: nil)
            default: throw YjsError(description: "a tag of a shared type the encoding does not define: \(ref)")
            }
        case 8:
            let n = try varUint()
            var i: UInt64 = 0
            while i < n { try any(); i += 1 }
            return .any(count: n)
        case 9: _ = try varString(); try any(); return .doc
        default: throw YjsError(description: "a struct whose content kind the encoding does not define: \(kind)")
        }
    }

    /// Appendix A: a clock plus a length, an end, is at most 2^53 − 1. Both are at most 2^53 − 1
    /// already, so the subtraction cannot wrap.
    static func end(_ clock: UInt64, _ length: UInt64, of what: String) throws -> UInt64 {
        guard length <= maxSafe - clock else { throw YjsError(description: "\(what) ending beyond 2^53 − 1") }
        return clock + length
    }

    /// The structs of an update (Yjs `readClientsStructRefs`).
    mutating func structs() throws -> [YStruct] {
        var out: [YStruct] = []
        let clients = try varUint()
        var c: UInt64 = 0
        while c < clients {
            let count = try varUint()
            let client = try varUint()
            var clock = try varUint()
            var s: UInt64 = 0
            while s < count {
                let info = try byte()
                let id = YID(client: client, clock: clock)
                let st: YStruct
                switch info & 0x1F {
                case 0: st = .gc(id, length: try varUint())
                // A skip is the info byte 10 itself; kind 10 with a high bit set is no content kind.
                case 10 where info == 10: st = .skip(id, length: try varUint())
                default:
                    let origin = info & 0x80 != 0 ? try self.id() : nil
                    let rightOrigin = info & 0x40 != 0 ? try self.id() : nil
                    let copiesParent = info & 0xC0 != 0
                    var parent: YParent?
                    var parentSub: String?
                    if !copiesParent {
                        // `readParentInfo`: 1 names a top-level type by its key, anything else an item.
                        parent = try varUint() == 1 ? .root(try varString()) : .item(try self.id())
                        if info & 0x20 != 0 { parentSub = try varString() }
                    }
                    let content = try self.content(info & 0x1F)
                    st = .item(YItem(id: id, origin: origin, rightOrigin: rightOrigin, parent: parent, parentSub: parentSub, content: content))
                }
                // Appendix A: the clock of the first struct plus the lengths so far, at most 2^53 − 1.
                clock = try YjsReader.end(clock, st.length, of: "a client's structs")
                out.append(st)
                s += 1
            }
            c += 1
        }
        return out
    }

    /// A delete set (Yjs `readDeleteSet`, encoding version 1).
    mutating func deleteSet() throws -> [(client: UInt64, ranges: [(clock: UInt64, length: UInt64)])] {
        var out: [(client: UInt64, ranges: [(clock: UInt64, length: UInt64)])] = []
        let clients = try varUint()
        var c: UInt64 = 0
        while c < clients {
            let client = try varUint()
            let n = try varUint()
            var ranges: [(clock: UInt64, length: UInt64)] = []
            var i: UInt64 = 0
            while i < n {
                let range = (clock: try varUint(), length: try varUint())
                _ = try YjsReader.end(range.clock, range.length, of: "a delete range")
                ranges.append(range)
                i += 1
            }
            out.append((client, ranges))
            c += 1
        }
        return out
    }
}

public enum Yjs {
    /// Reads `bytes` as exactly one update: every struct with its content, then the delete set,
    /// and no byte after it (Appendix A, "Reading without applying"; §4.4).
    static func readUpdate(_ bytes: [UInt8]) throws -> YUpdate {
        var r = YjsReader(bytes)
        let structs = try r.structs()
        let ds = try r.deleteSet()
        guard r.atEnd else { throw YjsError(description: "a byte after a complete update") }
        return YUpdate(structs: structs, deleteSet: ds)
    }

    /// Reads `bytes` as exactly one state vector, with no byte after it.
    static func readStateVector(_ bytes: [UInt8]) throws -> [(client: UInt64, clock: UInt64)] {
        var r = YjsReader(bytes)
        let n = try r.varUint()
        var out: [(client: UInt64, clock: UInt64)] = []
        var i: UInt64 = 0
        while i < n { out.append((try r.varUint(), try r.varUint())); i += 1 }
        guard r.atEnd else { throw YjsError(description: "a byte after a complete state vector") }
        return out
    }

    static func writeVarUint(_ v: UInt64, into out: inout [UInt8]) {
        var v = v
        while v >= 0x80 {
            out.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        out.append(UInt8(v))
    }

    /// Ranges [clock, length] sorted ascending and merged where they overlap or touch.
    static func normalize(_ ranges: [(clock: UInt64, length: UInt64)]) -> [(clock: UInt64, length: UInt64)] {
        let sorted = ranges.filter { $0.length > 0 }.sorted { $0.clock < $1.clock }
        var out: [(clock: UInt64, length: UInt64)] = []
        for r in sorted {
            if let last = out.last, r.clock <= last.clock + last.length {
                let end = max(last.clock + last.length, r.clock + r.length)
                out[out.count - 1].length = end - last.clock
            } else {
                out.append(r)
            }
        }
        return out
    }

    /// "What a replica deleted": `00` for no structs, the number of clients, and for each
    /// client in descending order of its id its id, the number of its ranges and each range's
    /// clock and length, ascending and merged. With `within`, each client's ranges cut at that
    /// client's clock in the state vector, and a client without ranges left out.
    public static func deletionEncoding(_ deleted: [UInt64: [(clock: UInt64, length: UInt64)]],
                                        within: [UInt64: UInt64]? = nil) -> [UInt8] {
        var clients: [(UInt64, [(clock: UInt64, length: UInt64)])] = []
        for (client, ranges) in deleted {
            var rs = normalize(ranges)
            if let within {
                let limit = within[client] ?? 0
                rs = rs.compactMap { r in
                    guard r.clock < limit else { return nil }
                    return (r.clock, min(r.clock + r.length, limit) - r.clock)
                }
            }
            if !rs.isEmpty { clients.append((client, rs)) }
        }
        clients.sort { $0.0 > $1.0 }
        var out: [UInt8] = [0]
        writeVarUint(UInt64(clients.count), into: &out)
        for (client, ranges) in clients {
            writeVarUint(client, into: &out)
            writeVarUint(UInt64(ranges.count), into: &out)
            for r in ranges {
                writeVarUint(r.clock, into: &out)
                writeVarUint(r.length, into: &out)
            }
        }
        return out
    }
}
