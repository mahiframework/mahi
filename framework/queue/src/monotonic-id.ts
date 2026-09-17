import { randomBytes } from "node:crypto";

/** Counter width in `rand_a`: 4096 ids per millisecond before we wait. */
const MAX_COUNTER = 0x0fff;

/**
 * The last millisecond an id was issued for, and how many have been
 * issued within it. Module state, so every driver on this process shares
 * one sequence and two drivers cannot mint the same id.
 */
let lastMs = -1;
let counter = 0;

/**
 * A UUIDv7 (RFC 9562): a 48-bit big-endian millisecond timestamp, then
 * the version, then 74 bits of counter and randomness.
 *
 * Unlike v4, **these sort by creation time as plain strings**, which is
 * the entire point of using them here. `pop()` orders by
 * `available_at, id`, and `available_at` is truncated to whole seconds,
 * so every job in a fan-out dispatched within the same second ties on it
 * and `id` alone decides the order. A random v4 therefore made a burst
 * run in an arbitrary order — a publish dispatched A-Z came back
 * shuffled — while this makes the existing tiebreak resolve to insertion
 * order, which is what "FIFO" was always supposed to mean.
 *
 * `randomUUID({ version: 7 })` is not an option: Node accepts the option
 * and ignores it, returning a v4, so the bug would look fixed and not be.
 *
 * Two hazards the spec leaves to the implementation, both handled:
 *
 *   - **Same millisecond.** Randomness alone would reorder ids minted in
 *     the same tick, which is the common case for a fan-out loop. The
 *     12-bit `rand_a` field is a counter instead, giving 4096 ordered
 *     ids per millisecond; beyond that we wait for the clock rather than
 *     wrap, since wrapping would sort the 4097th before the first.
 *   - **A clock that moves backwards.** NTP can step the clock back
 *     mid-run, which would issue an id that sorts before its
 *     predecessor. The last timestamp is held and the counter continues
 *     under it until the real clock catches up, so the sequence never
 *     goes backwards even when the clock does.
 *
 * Ids minted before this existed are v4 and carry no timestamp, so a
 * backlog spanning the upgrade is ordered arbitrarily *relative to* the
 * new ids until it drains. Jobs pushed from here on are ordered among
 * themselves.
 */
export function monotonicUuid(): string {
  let now = Date.now();

  if (now <= lastMs) {
    counter += 1;

    if (counter > MAX_COUNTER) {
      // Busy-wait, deliberately: it is bounded by a single millisecond
      // and only reachable at over 4,096 pushes per millisecond, where
      // yielding to the loop costs more than the spin does.
      do {
        now = Date.now();
      } while (now <= lastMs);

      counter = 0;
    } else {
      now = lastMs;
    }
  } else {
    counter = 0;
  }

  lastMs = now;

  // Random first, then the ordered fields are written over the front of
  // it, so `rand_b` keeps the collision resistance of 62 random bits.
  const bytes = randomBytes(16);

  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt16BE(0x7000 | counter, 6);
  // The RFC 9562 variant marker: `10xx` in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
