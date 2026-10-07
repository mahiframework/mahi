/**
 * `JSON.stringify` that survives a `bigint`.
 *
 * `JSON.stringify` throws on one, and the scaffolded `User` keys on a
 * auto-increment id, so a `user_id` inside a captured payload is a `bigint` in a
 * default application. Copied from `DatabaseChannel`, which hit the same
 * thing writing notification payloads.
 */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

export interface CappedPayload {
  data: Record<string, unknown> | null;
  truncated: boolean;
}

/**
 * Enforce `maxDataBytes` on a payload, degrading loudly rather than
 * quietly.
 *
 * A `full`-capture model with a `text` body column produces a payload
 * carrying that body twice, from and to. On MySQL `text` is `LONGTEXT`-
 * sized, so an app with a 2 MB markdown column would write 4 MB per edit
 * into the audit table and nothing would stop it.
 *
 * On overflow the payload is REPLACED by a marker, not trimmed. Per-value
 * truncation was the alternative and is worse: it yields a payload that
 * looks complete and is not, whereas this one announces its own failure.
 * The keys survive because *which* fields changed is the part that
 * degrades usefully.
 */
export function capPayload(data: Record<string, unknown> | null, maxBytes: number): CappedPayload {
  if (data === null) {
    return { data: null, truncated: false };
  }

  const encoded = stringify(data);

  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) {
    return { data, truncated: false };
  }

  return {
    data: {
      truncated: true,
      reason: "max_data_bytes",
      keys: Object.keys(data),
    },
    truncated: true,
  };
}

/**
 * Trim a message to the column width.
 *
 * Truncated rather than rejected, and rather than left to the database.
 * MySQL in non-strict mode truncates silently while SQLite ignores the
 * length entirely, so deferring would make the behaviour engine-dependent
 * in the least useful direction. Failing the enclosing `save()` over a
 * cosmetically long message is not proportionate either. Doing it here is
 * consistent everywhere and visible in the stored value.
 */
export function capMessage(message: string | null, maxLength: number): string | null {
  if (message === null || message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, Math.max(0, maxLength - 1))}…`;
}
