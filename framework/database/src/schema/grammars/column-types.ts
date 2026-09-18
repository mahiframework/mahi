import { sql, type Expression } from "kysely";
import type { ColumnDefinition } from "../column-definition.js";
import type { Dialect } from "../dialect.js";

/**
 * A concrete column type ready for Kysely's `addColumn`. Kysely accepts a
 * `ColumnDataType` string OR a raw SQL expression; we always hand it a raw
 * expression so length/precision/enum spellings pass straight through
 * without Kysely trying to interpret them.
 */
export type CompiledColumnType = Expression<any>;

/**
 * Resolve the Laravel column type (`string`, `bigInteger`, `decimal`, ...)
 * plus its recorded modifiers (`length`, `total`/`places`, `allowed`,
 * `unsignedFlag`, `autoIncrementFlag`) into the concrete DDL type for the
 * target `dialect`.
 *
 * Mirrors the `type*` methods on Laravel's schema grammars. Auto-increment
 * columns are handled here for MySQL/Postgres (they need a specific integer
 * type, `serial`/`bigserial` on PG, plain int on MySQL where the
 * AUTO_INCREMENT modifier is applied separately); SQLite ignores width and
 * uses INTEGER PRIMARY KEY AUTOINCREMENT via the modifier layer.
 */
export function compileColumnType(def: ColumnDefinition, dialect: Dialect): CompiledColumnType {
  const type = resolveTypeString(def, dialect);

  return sql.raw(type);
}

function resolveTypeString(def: ColumnDefinition, dialect: Dialect): string {
  switch (dialect) {
    case "sqlite":
      return sqliteType(def);
    case "mysql":
      return mysqlType(def);
    case "postgres":
      return postgresType(def);
  }
}

// SQLite has storage classes, not real types, width/precision are ignored.
// This preserves the affinities the previous `LARAVEL_TO_SQLITE` map used.
//
// `bigInteger` and friends declare `bigint` rather than `integer`. Both
// take SQLite's INTEGER affinity (any declared type containing "INT"
// does) and store identically, so this changes no bytes on disk — but
// SQLite records the declared spelling verbatim, and it is the only
// signal a driver has that a column is 64-bit. `SqliteDriver` reads it
// back to decide which columns must stay `bigint` in JS rather than
// being narrowed to a lossy `number`. See `bigintColumns()` there.
//
// The auto-incrementing types must NOT follow: only the exact type
// `INTEGER PRIMARY KEY` is a rowid alias, and
// `bigint primary key autoincrement` is rejected outright by SQLite
// ("AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY").
const SQLITE_AFFINITY: Record<string, string> = {
  id: "integer",
  increments: "integer",
  integerIncrements: "integer",
  tinyIncrements: "integer",
  smallIncrements: "integer",
  mediumIncrements: "integer",
  bigIncrements: "integer",
  string: "text",
  char: "text",
  text: "text",
  mediumText: "text",
  longText: "text",
  tinyText: "text",
  integer: "integer",
  tinyInteger: "integer",
  smallInteger: "integer",
  mediumInteger: "integer",
  bigInteger: "bigint",
  unsignedInteger: "integer",
  unsignedTinyInteger: "integer",
  unsignedSmallInteger: "integer",
  unsignedMediumInteger: "integer",
  unsignedBigInteger: "bigint",
  boolean: "integer",
  float: "real",
  double: "real",
  decimal: "numeric",
  date: "text",
  dateTime: "text",
  dateTimeTz: "text",
  time: "text",
  timeTz: "text",
  timestamp: "text",
  timestampTz: "text",
  year: "text",
  json: "text",
  jsonb: "text",
  uuid: "text",
  ulid: "text",
  binary: "blob",
  enum: "text",
  foreignId: "bigint",
  ipAddress: "text",
  macAddress: "text",
  rememberToken: "text",
};

function sqliteType(def: ColumnDefinition): string {
  const mapped = SQLITE_AFFINITY[def.laravelType];

  if (!mapped) {
    throw new Error(`Unknown Blueprint column type "${def.laravelType}" for SQLite.`);
  }

  return mapped;
}

function mysqlEnum(def: ColumnDefinition): string {
  const values = (def.allowed ?? []).map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

  return `enum(${values})`;
}

/**
 * `(n)` for a temporal type's fractional-seconds precision. `Blueprint`
 * fills `precision` in for every temporal column it creates (see
 * `DEFAULT_TEMPORAL_PRECISION`); the `undefined` branch covers a
 * `ColumnDefinition` built directly, where the engine's own default
 * (0, whole seconds) applies.
 */
function fractionalSeconds(def: ColumnDefinition): string {
  return def.precision === undefined ? "" : `(${def.precision})`;
}

function mysqlType(def: ColumnDefinition): string {
  const unsigned = def.unsignedFlag ? " unsigned" : "";
  switch (def.laravelType) {
    case "id":
    case "bigIncrements":
    case "bigInteger":
    case "unsignedBigInteger":
    case "foreignId":
      return `bigint${def.laravelType === "bigInteger" ? unsigned : " unsigned"}`;
    case "increments":
    case "integerIncrements":
    case "integer":
    case "unsignedInteger":
      return `int${def.laravelType === "integer" ? unsigned : def.laravelType === "unsignedInteger" ? " unsigned" : ""}`;
    case "tinyIncrements":
    case "tinyInteger":
    case "unsignedTinyInteger":
      return `tinyint${def.laravelType === "tinyInteger" ? unsigned : def.laravelType === "unsignedTinyInteger" ? " unsigned" : ""}`;
    case "smallIncrements":
    case "smallInteger":
    case "unsignedSmallInteger":
      return `smallint${def.laravelType === "smallInteger" ? unsigned : def.laravelType === "unsignedSmallInteger" ? " unsigned" : ""}`;
    case "mediumIncrements":
    case "mediumInteger":
    case "unsignedMediumInteger":
      return `mediumint${def.laravelType === "mediumInteger" ? unsigned : def.laravelType === "unsignedMediumInteger" ? " unsigned" : ""}`;
    case "boolean":
      return "tinyint(1)";
    case "string":
      return `varchar(${def.length ?? 255})`;
    case "char":
      return `char(${def.length ?? 255})`;
    case "text":
      return "text";
    case "tinyText":
      return "tinytext";
    case "mediumText":
      return "mediumtext";
    case "longText":
      return "longtext";
    case "float":
      return "float";
    case "double":
      return "double";
    case "decimal":
      return `decimal(${def.total ?? 8}, ${def.places ?? 2})`;
    case "date":
      return "date";
    case "dateTime":
    case "dateTimeTz":
      return `datetime${fractionalSeconds(def)}`;
    case "time":
    case "timeTz":
      return `time${fractionalSeconds(def)}`;
    case "timestamp":
    case "timestampTz":
      return `timestamp${fractionalSeconds(def)}`;
    case "year":
      return "year";
    case "json":
    case "jsonb":
      return "json";
    case "uuid":
    case "ulid":
      return "char(36)";
    case "binary":
      return "blob";
    case "enum":
      return mysqlEnum(def);
    case "ipAddress":
      return "varchar(45)";
    case "macAddress":
      return "varchar(17)";
    case "rememberToken":
      return "varchar(100)";
    default:
      throw new Error(`Unknown Blueprint column type "${def.laravelType}" for MySQL.`);
  }
}

function postgresEnum(def: ColumnDefinition): string {
  // Modelled as a varchar rather than a native PG enum type, which
  // would mean owning a separate CREATE TYPE and its migration
  // lifecycle (adding a value to a native enum is its own DDL
  // statement, and removing one is not supported at all). The varchar
  // keeps migrations reversible; the allowed values are enforced by a
  // CHECK constraint the grammar adds alongside the column. See
  // `applyEnumCheck()` in `native-alter-grammar.ts`.
  const longest = (def.allowed ?? []).reduce((max, v) => Math.max(max, v.length), 255);

  return `varchar(${longest})`;
}

function postgresType(def: ColumnDefinition): string {
  switch (def.laravelType) {
    case "id":
    case "bigIncrements":
      return "bigserial";
    case "increments":
    case "integerIncrements":
      return "serial";
    case "tinyIncrements":
    case "smallIncrements":
      return "smallserial";
    case "mediumIncrements":
      return "serial";
    case "bigInteger":
    case "unsignedBigInteger":
    case "foreignId":
      return "bigint";
    case "integer":
    case "unsignedInteger":
    case "mediumInteger":
    case "unsignedMediumInteger":
      return "integer";
    case "tinyInteger":
    case "unsignedTinyInteger":
    case "smallInteger":
    case "unsignedSmallInteger":
      return "smallint";
    case "boolean":
      return "boolean";
    case "string":
      return `varchar(${def.length ?? 255})`;
    case "char":
      return `char(${def.length ?? 255})`;
    case "text":
    case "tinyText":
    case "mediumText":
    case "longText":
      return "text";
    case "float":
      return "real";
    case "double":
      return "double precision";
    case "decimal":
      return `decimal(${def.total ?? 8}, ${def.places ?? 2})`;
    case "date":
      return "date";
    case "dateTime":
      return `timestamp(${def.precision ?? 0}) without time zone`;
    case "dateTimeTz":
      return `timestamp(${def.precision ?? 0}) with time zone`;
    case "time":
      return `time(${def.precision ?? 0}) without time zone`;
    case "timeTz":
      return `time(${def.precision ?? 0}) with time zone`;
    case "timestamp":
      return `timestamp(${def.precision ?? 0}) without time zone`;
    case "timestampTz":
      return `timestamp(${def.precision ?? 0}) with time zone`;
    case "year":
      return "integer";
    case "json":
      return "json";
    case "jsonb":
      return "jsonb";
    case "uuid":
      return "uuid";
    case "ulid":
      return "char(26)";
    case "binary":
      return "bytea";
    case "enum":
      return postgresEnum(def);
    case "ipAddress":
      return "varchar(45)";
    case "macAddress":
      return "varchar(17)";
    case "rememberToken":
      return "varchar(100)";
    default:
      throw new Error(`Unknown Blueprint column type "${def.laravelType}" for PostgreSQL.`);
  }
}
