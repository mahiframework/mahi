import type { Kysely } from "kysely";
import { ColumnDefinition } from "./column-definition.js";
import type { Dialect } from "./dialect.js";
import { ForeignKeyDefinition } from "./foreign-key-definition.js";
import { grammarFor } from "./grammars/index.js";
import { createIndexName } from "./index-name.js";
import {
  asColumnList,
  asIndexOptions,
  type BlueprintMode,
  type IndexCommand,
  type IndexKind,
  type IndexOptions,
} from "./types.js";

/**
 * Fractional-second digits given to a `time`/`dateTime`/`timestamp`
 * column when the caller doesn't name one.
 *
 * Milliseconds, which is **not** Laravel's default (it uses 0, whole
 * seconds). The reason is consistency across this framework's own
 * engines: SQLite stores timestamps as text and keeps whatever it is
 * given, and the framework stamps `created_at`/`updated_at` with
 * millisecond precision. A `timestamp(0)` column on MySQL/Postgres
 * would round that away, so the same `create()` produced a value that
 * round-tripped exactly on SQLite and lost its milliseconds on the
 * other two, the kind of difference that only shows up in production.
 *
 * 3 rather than 6 because milliseconds are what a JS `Date`/`DateTime`
 * can represent; the extra microsecond digits MySQL and Postgres can
 * store would always be zero.
 */
export const DEFAULT_TEMPORAL_PRECISION = 3;

/**
 * Laravel-shaped table blueprint. Collects column/index/command
 * definitions, then compiles them to Kysely schema-builder calls on
 * `execute()`.
 */
export class Blueprint {
  readonly columns: ColumnDefinition[] = [];
  readonly indexes: IndexCommand[] = [];
  readonly foreignKeys: ForeignKeyDefinition[] = [];
  readonly droppedColumns: string[] = [];
  readonly renameColumns: { from: string; to: string }[] = [];
  readonly droppedIndexes: string[] = [];
  readonly dropPrimaries: { name?: string }[] = [];
  readonly dropForeigns: string[] = [];
  renameTo?: string;

  constructor(
    public readonly table: string,
    public readonly mode: BlueprintMode,
  ) {}

  async execute(db: Kysely<any>, dialect: Dialect): Promise<void> {
    const grammar = grammarFor(dialect);

    if (this.mode === "create") {
      await grammar.compileCreate(db, this);
    } else {
      await grammar.compileAlter(db, this);
    }
  }

  id(column = "id"): ColumnDefinition {
    return this.bigIncrements(column);
  }

  increments(column = "id"): ColumnDefinition {
    return this.integerIncrements(column);
  }

  integerIncrements(column = "id"): ColumnDefinition {
    return this.autoIncrementing(column, "increments");
  }

  tinyIncrements(column = "id"): ColumnDefinition {
    return this.autoIncrementing(column, "tinyIncrements");
  }

  smallIncrements(column = "id"): ColumnDefinition {
    return this.autoIncrementing(column, "smallIncrements");
  }

  mediumIncrements(column = "id"): ColumnDefinition {
    return this.autoIncrementing(column, "mediumIncrements");
  }

  bigIncrements(column = "id"): ColumnDefinition {
    return this.autoIncrementing(column, "bigIncrements");
  }

  string(column: string, length = 255): ColumnDefinition {
    const def = this.addColumn(column, "string");
    def.length = length;

    return def;
  }

  char(column: string, length = 255): ColumnDefinition {
    const def = this.addColumn(column, "char");
    def.length = length;

    return def;
  }

  text(column: string): ColumnDefinition {
    return this.addColumn(column, "text");
  }

  mediumText(column: string): ColumnDefinition {
    return this.addColumn(column, "mediumText");
  }

  longText(column: string): ColumnDefinition {
    return this.addColumn(column, "longText");
  }

  tinyText(column: string): ColumnDefinition {
    return this.addColumn(column, "tinyText");
  }

  integer(column: string): ColumnDefinition {
    return this.addColumn(column, "integer");
  }

  tinyInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "tinyInteger");
  }

  smallInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "smallInteger");
  }

  mediumInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "mediumInteger");
  }

  bigInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "bigInteger");
  }

  unsignedInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "unsignedInteger").unsigned();
  }

  unsignedTinyInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "unsignedTinyInteger").unsigned();
  }

  unsignedSmallInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "unsignedSmallInteger").unsigned();
  }

  unsignedMediumInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "unsignedMediumInteger").unsigned();
  }

  unsignedBigInteger(column: string): ColumnDefinition {
    return this.addColumn(column, "unsignedBigInteger").unsigned();
  }

  boolean(column: string): ColumnDefinition {
    return this.addColumn(column, "boolean");
  }

  float(column: string, _precision?: number): ColumnDefinition {
    return this.addColumn(column, "float");
  }

  double(column: string, _total?: number, _places?: number): ColumnDefinition {
    return this.addColumn(column, "double");
  }

  decimal(column: string, total = 8, places = 2): ColumnDefinition {
    const def = this.addColumn(column, "decimal");
    def.total = total;
    def.places = places;

    return def;
  }

  date(column: string): ColumnDefinition {
    return this.addColumn(column, "date");
  }

  dateTime(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "dateTime"), precision);
  }

  dateTimeTz(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "dateTimeTz"), precision);
  }

  time(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "time"), precision);
  }

  timeTz(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "timeTz"), precision);
  }

  /**
   * A timestamp column. `precision` is the number of fractional-second
   * digits kept. See `DEFAULT_TEMPORAL_PRECISION` for why it defaults
   * to milliseconds rather than Laravel's whole seconds. Pass `0` for
   * second resolution.
   */
  timestamp(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "timestamp"), precision);
  }

  timestampTz(column: string, precision?: number): ColumnDefinition {
    return this.withPrecision(this.addColumn(column, "timestampTz"), precision);
  }

  private withPrecision(def: ColumnDefinition, precision?: number): ColumnDefinition {
    def.precision = precision ?? DEFAULT_TEMPORAL_PRECISION;

    return def;
  }

  year(column: string): ColumnDefinition {
    return this.addColumn(column, "year");
  }

  json(column: string): ColumnDefinition {
    return this.addColumn(column, "json");
  }

  jsonb(column: string): ColumnDefinition {
    return this.addColumn(column, "jsonb");
  }

  uuid(column: string): ColumnDefinition {
    return this.addColumn(column, "uuid");
  }

  ulid(column: string): ColumnDefinition {
    return this.addColumn(column, "ulid");
  }

  binary(column: string): ColumnDefinition {
    return this.addColumn(column, "binary");
  }

  enum(column: string, allowed: string[]): ColumnDefinition {
    const def = this.addColumn(column, "enum");
    def.allowed = allowed;

    return def;
  }

  foreignId(column: string): ColumnDefinition {
    return this.unsignedBigInteger(column);
  }

  ipAddress(column: string): ColumnDefinition {
    return this.addColumn(column, "ipAddress");
  }

  macAddress(column: string): ColumnDefinition {
    return this.addColumn(column, "macAddress");
  }

  rememberToken(): ColumnDefinition {
    return this.string("remember_token", 100).nullable();
  }

  timestamps(precision?: number): void {
    this.nullableTimestamps(precision);
  }

  timestampsTz(precision?: number): void {
    this.timestampTz("created_at", precision).nullable();
    this.timestampTz("updated_at", precision).nullable();
  }

  datetimes(precision?: number): void {
    this.timestamps(precision);
  }

  nullableTimestamps(precision?: number): void {
    this.timestamp("created_at", precision).nullable();
    this.timestamp("updated_at", precision).nullable();
  }

  softDeletes(column = "deleted_at", precision?: number): ColumnDefinition {
    return this.timestamp(column, precision).nullable();
  }

  softDeletesTz(column = "deleted_at", precision?: number): ColumnDefinition {
    return this.timestampTz(column, precision).nullable();
  }

  softDeletesDatetime(column = "deleted_at", precision?: number): ColumnDefinition {
    return this.dateTime(column, precision).nullable();
  }

  morphs(name: string, indexName?: string): void {
    this.string(`${name}_type`);
    this.unsignedBigInteger(`${name}_id`);
    this.index([`${name}_type`, `${name}_id`], indexName);
  }

  nullableMorphs(name: string, indexName?: string): void {
    this.string(`${name}_type`).nullable();
    this.unsignedBigInteger(`${name}_id`).nullable();
    this.index([`${name}_type`, `${name}_id`], indexName);
  }

  uuidMorphs(name: string, indexName?: string): void {
    this.string(`${name}_type`);
    this.uuid(`${name}_id`);
    this.index([`${name}_type`, `${name}_id`], indexName);
  }

  ulidMorphs(name: string, indexName?: string): void {
    this.string(`${name}_type`);
    this.ulid(`${name}_id`);
    this.index([`${name}_type`, `${name}_id`], indexName);
  }

  numericMorphs(name: string, indexName?: string): void {
    this.string(`${name}_type`);
    this.unsignedBigInteger(`${name}_id`);
    this.index([`${name}_type`, `${name}_id`], indexName);
  }

  /**
   * Composite primary key constraint.
   *
   * Takes a name and nothing else, unlike `unique()`/`index()`: a
   * `PRIMARY KEY` is a table constraint rather than a free-standing
   * index, so it cannot be partial, cannot pick a method, and cannot
   * carry an operator class. Accepting `IndexOptions` here would
   * advertise capabilities that do not exist.
   */
  primary(columns: string | string[], name?: string): this {
    return this.indexCommand("primary", columns, { name });
  }

  /**
   * Unique index over `columns`.
   *
   * The second argument is either the index name or an `IndexOptions`
   * object, so the two spellings that make a *nullable* column unique
   * are reachable:
   *
   *   // at most one non-null, unlimited nulls
   *   table.unique("torrent_id", { where: "torrent_id is not null" });
   *
   *   // nulls collide like any other value (Postgres 15+)
   *   table.unique("torrent_id", { nullsNotDistinct: true });
   */
  unique(columns: string | string[], options?: string | IndexOptions): this {
    return this.indexCommand("unique", columns, asIndexOptions(options));
  }

  /**
   * Non-unique index over `columns`.
   *
   *   table.index("criteria", { using: "gin" });
   *   table.index("title", { using: "gin", opclass: { title: "gin_trgm_ops" } });
   */
  index(columns: string | string[], options?: string | IndexOptions): this {
    return this.indexCommand("index", columns, asIndexOptions(options));
  }

  /**
   * MySQL `FULLTEXT` index. **Throws on SQLite and Postgres.**
   *
   * Deliberately MySQL-only rather than emulated: MySQL's is an index
   * over existing columns, while Postgres full-text needs a stored
   * `tsvector` column to index, so they are not the same concept. The
   * Postgres spelling is a generated column plus a GIN index, see
   * `storedAs()` and `index(..., { using: "gin" })`.
   */
  fullText(columns: string | string[], name?: string): this {
    return this.indexCommand("fullText", columns, { name });
  }

  spatialIndex(columns: string | string[], name?: string): this {
    return this.indexCommand("spatialIndex", columns, { name });
  }

  foreign(columns: string | string[], name?: string): ForeignKeyDefinition {
    const fk = new ForeignKeyDefinition(asColumnList(columns), name);
    this.foreignKeys.push(fk);

    return fk;
  }

  dropColumn(...columns: (string | string[])[]): this {
    this.droppedColumns.push(...columns.flat());

    return this;
  }

  dropColumns(...columns: (string | string[])[]): this {
    return this.dropColumn(...columns);
  }

  renameColumn(from: string, to: string): this {
    this.renameColumns.push({ from, to });

    return this;
  }

  dropIndex(index: string | string[]): this {
    this.droppedIndexes.push(
      Array.isArray(index) ? createIndexName(this.table, "index", index) : index,
    );

    return this;
  }

  dropUnique(index: string | string[]): this {
    this.droppedIndexes.push(
      Array.isArray(index) ? createIndexName(this.table, "unique", index) : index,
    );

    return this;
  }

  dropPrimary(index?: string | string[]): this {
    const name = Array.isArray(index) ? createIndexName(this.table, "primary", index) : index;
    this.dropPrimaries.push({ name });

    return this;
  }

  dropForeign(index: string | string[]): this {
    this.dropForeigns.push(
      Array.isArray(index) ? createIndexName(this.table, "foreign", index) : index,
    );

    return this;
  }

  dropTimestamps(): this {
    return this.dropColumn("created_at", "updated_at");
  }

  dropSoftDeletes(column = "deleted_at"): this {
    return this.dropColumn(column);
  }

  dropMorphs(name: string, indexName?: string): this {
    this.dropIndex(indexName ?? [`${name}_type`, `${name}_id`]);

    return this.dropColumn(`${name}_type`, `${name}_id`);
  }

  dropRememberToken(): this {
    return this.dropColumn("remember_token");
  }

  rename(to: string): this {
    this.renameTo = to;

    return this;
  }

  private addColumn(name: string, laravelType: string): ColumnDefinition {
    const def = new ColumnDefinition(name, laravelType);
    this.columns.push(def);

    return def;
  }

  private autoIncrementing(column: string, laravelType: string): ColumnDefinition {
    const def = this.addColumn(column, laravelType);
    def.autoIncrementFlag = true;
    def.primaryFlag = true;
    def.unsignedFlag = true;

    return def;
  }

  private indexCommand(kind: IndexKind, columns: string | string[], options: IndexOptions): this {
    this.indexes.push({ ...options, kind, columns: asColumnList(columns) });

    return this;
  }
}
