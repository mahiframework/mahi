import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { Dialect } from "../schema/dialect.js";
import type { DatabaseDriver } from "./driver.js";
import { errorTranslatingDialect } from "./error-translating-dialect.js";

const { Pool } = pg;

/**
 * Postgres type OIDs whose default node-postgres parser this driver
 * replaces. See `KEEP_AS_STRING` below for why each is here.
 */
const OID = {
  int8: 20,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
} as const;

/**
 * Date/time OIDs returned to the framework as **raw strings** rather
 * than node-postgres's default JS `Date`.
 *
 * The default parsing is lossy in exactly the way that breaks
 * timestamps: `timestamp without time zone` has no offset, so
 * node-postgres interprets it in the **process's local timezone**, a
 * row stored as `07:31:37` UTC reads back as `2026-09-01T23:31:37Z`
 * under `TZ=Asia/Shanghai`, and saving it again persists the shift.
 * A `Date` also breaks `DateTimeCast`, which parses ISO *strings*, and
 * changes what `JSON.stringify(model)` emits versus SQLite.
 *
 * Keeping the wire text means every engine hands the cast layer the
 * same thing: a string. `normalizeTimestamp()` then puts the two
 * spellings Postgres uses (`2026-09-02 07:31:37`, and `+00` for
 * `timestamptz`) into the ISO form the rest of the framework uses.
 */
const KEEP_AS_STRING: readonly number[] = [OID.date, OID.time, OID.timestamp, OID.timestamptz];

/**
 * Normalises Postgres's date/time text into the ISO-8601 UTC spelling
 * the framework stores everywhere else (`2026-09-02T07:31:37.499Z`).
 *
 * Postgres returns `timestamp` as `2026-09-02 07:31:37.499` (no zone,
 * the framework only ever writes UTC into these columns, so it is read
 * back as UTC) and `timestamptz` as `2026-09-02 07:31:37.499+00`
 * (already normalised to UTC by the session's `TimeZone`, which
 * `connect()` pins). `date` and `time` are left alone: they carry no
 * zone and no time-of-day respectively, so there is nothing to
 * normalise and rewriting them would only lose information.
 */
function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  // Offset-carrying (timestamptz): "+00", "+00:00", "-05" or a "Z".
  const offset = /(Z|[+-]\d{2}(:?\d{2})?)$/.exec(trimmed);

  if (offset) {
    const withoutOffset = trimmed.slice(0, trimmed.length - offset[0].length);
    const sign =
      offset[0] === "Z" ? "+00:00" : offset[0].length === 3 ? `${offset[0]}:00` : offset[0];

    return new Date(`${withoutOffset.replace(" ", "T")}${sign}`).toISOString();
  }

  // No offset (timestamp without time zone), read as UTC.
  return new Date(`${trimmed.replace(" ", "T")}Z`).toISOString();
}

/**
 * The `types` config handed to the pool: keeps date/time columns as
 * normalised ISO strings, and reads `int8` as a `bigint`.
 *
 * node-postgres returns `int8` as a **string** by default, precisely
 * because it does not fit a JS number. `BigInt()` on that text is exact,
 * where `Number()` would round `440463260157395208` to `...200` — a
 * different row, silently.
 *
 * Matches SQLite, where a column declared 64-bit reads back as a
 * `bigint` regardless of how small the value in it happens to be. The
 * type is a property of the column, not of the row, so a `bigserial`
 * holding `1` is still `1n`; anything else would make a model's id type
 * depend on how many rows had been inserted before it.
 */
function typeParsers(): pg.CustomTypesConfig {
  return {
    getTypeParser: ((oid: number, format?: any) => {
      if (KEEP_AS_STRING.includes(oid)) {
        return oid === OID.timestamp || oid === OID.timestamptz
          ? (value: string) => (value === null ? value : normalizeTimestamp(value))
          : (value: string) => value;
      }

      if (oid === OID.int8) {
        return (value: string) => (value === null ? value : BigInt(value));
      }

      return (pg.types.getTypeParser as any)(oid, format);
    }) as pg.CustomTypesConfig["getTypeParser"],
  };
}

export interface PostgresConnectionConfig {
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  /** Schema search path (Postgres `search_path`). Defaults to "public". */
  searchPath?: string;
  /** SSL config passed to node-postgres (`false`, `true`, or an object). */
  ssl?: boolean | Record<string, unknown>;
  /** Max pooled connections. Defaults to node-postgres's default (10). */
  max?: number;
  /**
   * Extra node-postgres pool options passed through verbatim. Anything set
   * here overrides the mapped fields above.
   */
  options?: Record<string, unknown>;
}

/**
 * PostgreSQL connection backed by a node-postgres (`pg`) pool and Kysely's
 * `PostgresDialect`. Like MySQL this is genuinely async and implements
 * `Connectable`: `connect()` opens a real connection at boot (setting the
 * `search_path` if configured) so a bad DSN fails fast, and `disconnect()`
 * drains the pool.
 *
 * ## Value handling
 *
 * The pool installs custom type parsers (see `typeParsers()`) so
 * date/time columns arrive as normalised ISO-8601 UTC **strings**
 * rather than `Date`s built in the process's local timezone, and
 * `bigint` primary keys arrive as numbers when they fit one. Both exist
 * to make a row read identically on Postgres, MySQL and SQLite; see
 * `KEEP_AS_STRING` and `typeParsers()` for the specifics.
 *
 * Callers can replace them wholesale by passing their own `types` in
 * `options`, which is merged last.
 */
export class PostgresDriver<DB = any> implements DatabaseDriver<DB> {
  readonly dialect: Dialect = "postgres";
  readonly kysely: Kysely<DB>;
  private readonly pool: InstanceType<typeof Pool>;

  constructor(config: PostgresConnectionConfig) {
    this.pool = new Pool({
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 5432,
      database: config.database,
      user: config.username ?? "postgres",
      password: config.password ?? "",
      types: typeParsers(),
      // `timezone=UTC` pins the session zone for EVERY pooled
      // connection, which is what makes `timestamptz` text
      // deterministic: Postgres renders it in the session zone, so
      // without this the offset suffix would follow the server's
      // configuration and differ between deployments. Set through the
      // startup `options` string rather than a `SET` in `connect()`
      // because the pool opens connections lazily and continuously.
      // A one-off `SET` would only reach the first one.
      options: [
        ...(config.searchPath ? [`-c search_path=${config.searchPath}`] : []),
        "-c timezone=UTC",
      ].join(" "),
      ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
      ...(config.max ? { max: config.max } : {}),
      ...(config.options ?? {}),
    });

    this.kysely = new Kysely<DB>({
      dialect: errorTranslatingDialect(new PostgresDialect({ pool: this.pool }), "postgres"),
    });
  }

  async connect(): Promise<void> {
    await sql`SELECT 1`.execute(this.kysely);
  }

  async disconnect(): Promise<void> {
    await this.kysely.destroy();
  }
}
