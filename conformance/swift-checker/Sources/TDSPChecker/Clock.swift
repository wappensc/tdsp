// The clock of CTL-45: a pair [ms, counter], and the algorithm by which a device of the creator
// forms its own clock and the clock of each decision, written from the text of CTL-45.

public struct Clock: Comparable, Hashable, CustomStringConvertible {
    public static let maxMs: Int64 = (1 << 48) - 1
    public static let maxCounter: Int64 = 65_535
    /// The span of CTL-45: 24 hours.
    public static let span: Int64 = 86_400_000

    public var ms: Int64
    public var counter: Int64

    public init(_ ms: Int64, _ counter: Int64) {
        self.ms = ms
        self.counter = counter
    }

    public static let zero = Clock(0, 0)

    /// "One clock is greater than another when its ms is, or both ms are equal and its counter is."
    public static func < (a: Clock, b: Clock) -> Bool {
        a.ms != b.ms ? a.ms < b.ms : a.counter < b.counter
    }

    public var description: String { "[\(ms), \(counter)]" }

    var json: JSONValue { .array([.number(String(ms)), .number(String(counter))]) }

    /// A clock as §4.3 reads it: an array of exactly two JSON integers, `ms` from 0 to 2^48 − 1
    /// and `counter` from 0 to 65 535, written without sign, fraction or exponent.
    static func read(_ value: JSONValue) -> Clock? {
        guard let items = value.arrayValue, items.count == 2,
              let ms = items[0].plainUnsigned, let counter = items[1].plainUnsigned,
              ms <= UInt64(maxMs), counter <= UInt64(maxCounter) else { return nil }
        return Clock(Int64(ms), Int64(counter))
    }

    /// next(c): the counter on, carrying into the ms; none at the end of the range.
    public func next() -> Clock? {
        if counter < Clock.maxCounter { return Clock(ms, counter + 1) }
        if ms < Clock.maxMs { return Clock(ms + 1, 0) }
        return nil
    }

    /// wall = [min(max(floor(now), 0), MAX_MS), 0]
    public static func wall(_ now: Double) -> Clock {
        let floored = now.rounded(.down)
        if floored <= 0 { return Clock(0, 0) }
        if floored >= Double(maxMs) { return Clock(maxMs, 0) }
        return Clock(Int64(floored), 0)
    }

    /// cap = [min(wall.ms + SPAN, MAX_MS), MAX_COUNTER]: the end of the span.
    public static func cap(_ now: Double) -> Clock {
        Clock(min(wall(now).ms + span, maxMs), maxCounter)
    }
}

/// A device of the creator's own clock, `own`, under CTL-45.
public struct OwnClock {
    public var own: Clock

    public init(_ own: Clock) { self.own = own }

    /// raise(c): own ← max(own, min(c, cap)) — restoring and merging.
    public mutating func raise(_ c: Clock, now: Double) {
        own = max(own, min(c, Clock.cap(now)))
    }

    /// A decision on one target: its clock, or nil where it must be refused (own unchanged).
    /// `held` are the clocks of the registers the device holds on the target.
    public mutating func decide(now: Double, held: [Clock]) -> Clock? {
        let wall = Clock.wall(now)
        var candidates: [Clock?] = [wall, own.next()]
        candidates += held.map { $0.next() }
        var clock = Clock.zero
        for c in candidates {
            guard let c else { return nil }  // none ∈ C: refuse
            clock = max(clock, c)
        }
        // own ← max(wall, next(own), min(clock, cap)); next(own) exists, or C held none.
        own = max(wall, own.next()!, min(clock, Clock.cap(now)))
        return clock
    }
}
