// A small Yjs replica, for the `fromUpdates` digest vectors only: it applies updates in
// encoding version 1, holds what lacks its predecessors as Appendix A's "Missing predecessors"
// row says, projects the text as its "Plain-text projection" row says, and reports what it
// deleted. Insertion follows the normative reference (Yjs 13.6.33 `Item.integrate`, YATA);
// every struct is kept split into units of length one, which orders as Yjs's merged items do.
//
// It is no engine: no splitting into pieces, no encoding of updates, no garbage collection.

final class YUnit {
    enum Content {
        case char(UInt16)
        case type(ref: UInt64, name: String?)
        case other
    }

    let id: YID
    let origin: YID?
    let rightOrigin: YID?
    /// The list the unit sits in; nil for a GC unit, which sits in none.
    let list: YReplica.ListKey?
    let content: Content
    var deleted: Bool

    init(id: YID, origin: YID?, rightOrigin: YID?, list: YReplica.ListKey?, content: Content, deleted: Bool) {
        self.id = id
        self.origin = origin
        self.rightOrigin = rightOrigin
        self.list = list
        self.content = content
        self.deleted = deleted
    }
}

struct YReplica {
    struct ListKey: Hashable {
        var parent: YParent
        var sub: String?
    }

    private(set) var units: [YID: YUnit] = [:]
    /// Per client, the clock after the last struct applied (the state vector, Appendix A).
    private(set) var state: [UInt64: UInt64] = [:]
    private var lists: [ListKey: [YID]] = [:]
    private var pendingStructs: [YStruct] = []
    private var pendingDeletes: [(client: UInt64, clock: UInt64, end: UInt64)] = []

    func clock(of client: UInt64) -> UInt64 { state[client] ?? 0 }

    func holds(_ id: YID) -> Bool { id.clock < clock(of: id.client) }

    mutating func apply(_ bytes: [UInt8]) throws {
        let update = try Yjs.readUpdate(bytes)
        pendingStructs += update.structs
        for (client, ranges) in update.deleteSet {
            for r in ranges where r.length > 0 { pendingDeletes.append((client, r.clock, r.clock + r.length)) }
        }
        settle()
    }

    /// Integrates every held struct whose predecessors have arrived, and applies every held
    /// delete range as far as the replica holds its client's items, until nothing changes.
    private mutating func settle() {
        var progress = true
        while progress {
            progress = false
            var rest: [YStruct] = []
            for st in pendingStructs.sorted(by: { ($0.id.client, $0.id.clock) < ($1.id.client, $1.id.clock) }) {
                switch readiness(st) {
                case .duplicate: progress = true
                case .missing: rest.append(st)
                case .ready(let offset): integrate(st, offset: offset); progress = true
                }
            }
            pendingStructs = rest
            var held: [(client: UInt64, clock: UInt64, end: UInt64)] = []
            for d in pendingDeletes {
                let s = clock(of: d.client)
                if d.clock < s {
                    delete(client: d.client, from: d.clock, to: min(d.end, s))
                    progress = true
                    if s < d.end { held.append((d.client, s, d.end)) }
                } else {
                    held.append(d)
                }
            }
            pendingDeletes = held
        }
    }

    private enum Readiness { case duplicate, missing, ready(offset: UInt64) }

    private func readiness(_ st: YStruct) -> Readiness {
        let id = st.id
        let s = clock(of: id.client)
        if id.clock + st.length <= s { return .duplicate }
        if id.clock > s { return .missing }  // a struct of its client before it has not arrived
        if case .skip = st { return .duplicate }
        if case .item(let item) = st {
            if let o = item.origin, !holds(o) { return .missing }
            if let r = item.rightOrigin, !holds(r) { return .missing }
            if case .item(let p)? = item.parent, !holds(p) { return .missing }
        }
        return .ready(offset: s - id.clock)
    }

    private mutating func integrate(_ st: YStruct, offset: UInt64) {
        let id = st.id
        let start = id.clock + offset
        let end = id.clock + st.length
        state[id.client] = end
        guard case .item(let item) = st, let list = resolveList(item) else {
            // A GC struct, or an item whose parent is gone: deleted, in no list.
            for k in start..<end {
                let uid = YID(client: id.client, clock: k)
                units[uid] = YUnit(id: uid, origin: nil, rightOrigin: nil, list: nil, content: .other, deleted: true)
            }
            return
        }
        let parentDeleted: Bool = {
            if case .item(let p) = list.parent { return units[p]?.deleted ?? true }
            return false
        }()
        for k in start..<end {
            let uid = YID(client: id.client, clock: k)
            let origin = k == id.clock ? item.origin : YID(client: id.client, clock: k - 1)
            let content: YUnit.Content
            var deleted = false
            switch item.content {
            case .string(let codeUnits): content = .char(codeUnits[Int(k - id.clock)])
            case .type(let ref, let name): content = .type(ref: ref, name: name)
            case .deleted: content = .other; deleted = true
            default: content = .other
            }
            let unit = YUnit(id: uid, origin: origin, rightOrigin: item.rightOrigin, list: list, content: content, deleted: deleted)
            units[uid] = unit
            insert(unit, into: list)
            if parentDeleted { markDeleted(unit) }
        }
    }

    /// The list an item goes into: its parent and key, or its origin's or right origin's.
    private func resolveList(_ item: YItem) -> ListKey? {
        let left = item.origin.flatMap { units[$0] }
        let right = item.rightOrigin.flatMap { units[$0] }
        if let l = left, l.list == nil { return nil }   // next to a GC: Yjs makes it a GC
        if let r = right, r.list == nil { return nil }
        switch item.parent {
        case .root(let name)?: return ListKey(parent: .root(name), sub: item.parentSub)
        case .item(let p)?:
            guard let parent = units[p], case .type = parent.content else { return nil }
            return ListKey(parent: .item(p), sub: item.parentSub)
        case nil: return left?.list ?? right?.list
        }
    }

    /// YATA as Yjs 13.6.33 `Item.integrate` runs it, on a list of units.
    private mutating func insert(_ unit: YUnit, into key: ListKey) {
        var list = lists[key] ?? []
        var leftIndex: Int? = unit.origin.flatMap { o in list.firstIndex(of: o) }
        let rightIndex = unit.rightOrigin.flatMap { r in list.firstIndex(of: r) } ?? list.count
        var conflicting = Set<YID>()
        var beforeOrigin = Set<YID>()
        var i = leftIndex.map { $0 + 1 } ?? 0
        while i < list.count, i != rightIndex {
            let o = units[list[i]]!
            beforeOrigin.insert(o.id)
            conflicting.insert(o.id)
            if o.origin == unit.origin {
                if o.id.client < unit.id.client {
                    leftIndex = i
                    conflicting.removeAll()
                } else if o.rightOrigin == unit.rightOrigin {
                    break
                }
            } else if let oo = o.origin, beforeOrigin.contains(oo) {
                if !conflicting.contains(oo) {
                    leftIndex = i
                    conflicting.removeAll()
                }
            } else {
                break
            }
            i += 1
        }
        let at = leftIndex.map { $0 + 1 } ?? 0
        list.insert(unit.id, at: at)
        lists[key] = list
        if key.sub != nil {
            // A map entry: the last of its key holds, every other is deleted.
            if at + 1 < list.count {
                markDeleted(unit)
            } else if at > 0, let previous = units[list[at - 1]] {
                markDeleted(previous)
            }
        }
    }

    private mutating func delete(client: UInt64, from: UInt64, to: UInt64) {
        var k = from
        while k < to {
            if let u = units[YID(client: client, clock: k)] { markDeleted(u) }
            k += 1
        }
    }

    /// Deletes a unit; a deleted type deletes what it holds (Yjs `ContentType.delete`).
    private mutating func markDeleted(_ unit: YUnit) {
        if unit.deleted { return }
        unit.deleted = true
        if case .type = unit.content {
            for (key, ids) in lists where key.parent == .item(unit.id) {
                for id in ids { if let u = units[id] { markDeleted(u) } }
            }
        }
    }

    /// What the replica deleted, by client, as merged ranges [clock, length].
    var deleted: [UInt64: [(clock: UInt64, length: UInt64)]] {
        var out: [UInt64: [(clock: UInt64, length: UInt64)]] = [:]
        for (id, u) in units where u.deleted { out[id.client, default: []].append((id.clock, 1)) }
        return out.mapValues { Yjs.normalize($0) }
    }

    /// Appendix A's plain-text projection, with YJS-4: each child of `content` is a paragraph
    /// whose text is that of the Y.XmlTexts it holds directly (or its own, if it is one),
    /// joined by a single "\n".
    var projection: String {
        func live(_ key: ListKey) -> [YUnit] { (lists[key] ?? []).compactMap { units[$0] }.filter { !$0.deleted } }
        func text(of id: YID) -> [UInt16] {
            live(ListKey(parent: .item(id), sub: nil)).compactMap { u in
                if case .char(let c) = u.content { return c }
                return nil
            }
        }
        var paragraphs: [[UInt16]] = []
        for child in live(ListKey(parent: .root("content"), sub: nil)) {
            guard case .type(let ref, _) = child.content else { continue }
            if ref == 6 {
                paragraphs.append(text(of: child.id))
            } else {
                var t: [UInt16] = []
                for grandchild in live(ListKey(parent: .item(child.id), sub: nil)) {
                    if case .type(6, _) = grandchild.content { t += text(of: grandchild.id) }
                }
                paragraphs.append(t)
            }
        }
        let joined = paragraphs.enumerated().flatMap { i, p in i == 0 ? p : [0x0A] + p }
        return String(decoding: joined, as: UTF16.self)
    }
}
