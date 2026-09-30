export { DatabaseManager } from "./database-manager.js";
export type { DatabaseConfig, ConnectionConfig } from "./database-manager.js";

export type { DatabaseDriver } from "./drivers/driver.js";
export type { Dialect, SchemaGrammar } from "./schema/dialect.js";
export { dialectOf } from "./drivers/dialect-registry.js";
export { SqliteDriver } from "./drivers/sqlite-driver.js";
export type { SqliteConnectionConfig } from "./drivers/sqlite-driver.js";
export { MysqlDriver } from "./drivers/mysql-driver.js";
export type { MysqlConnectionConfig } from "./drivers/mysql-driver.js";
export { PostgresDriver } from "./drivers/postgres-driver.js";
export type { PostgresConnectionConfig } from "./drivers/postgres-driver.js";

export {
  QueryException,
  UniqueConstraintViolationException,
  ForeignKeyConstraintViolationException,
  NotNullConstraintViolationException,
  LostConnectionException,
  translateDatabaseError,
} from "./exceptions.js";
export type { QueryContext } from "./exceptions.js";

export { MigrationRunner } from "./migrator.js";
export type {
  Migration,
  MigrationStatus,
  MigrationSource,
  RegisteredMigration,
  UpOptions,
  RollbackOptions,
} from "./migrator.js";

export { Schema } from "./schema/schema-facade.js";
export { DB } from "./db-facade.js";
export { SchemaBuilder } from "./schema/schema-builder.js";
export { Blueprint } from "./schema/blueprint.js";
export { ColumnDefinition } from "./schema/column-definition.js";
export { ForeignKeyDefinition } from "./schema/foreign-key-definition.js";
export { IndexExpression, indexExpression } from "./schema/types.js";
export type { IndexOptions, IndexMethod, IndexColumn } from "./schema/types.js";

export {
  Model,
  BaseModel,
  ModelNotFoundError,
  MassAssignmentError,
  RelationNotLoadedError,
} from "./model.js";
export type {
  Model as ModelType,
  ModelInstance,
  ModelAttributes,
  WritableAttributes,
  ModelConfig,
  ModelStatics,
  ModelClass,
  AnyModelClass,
  ModelResource,
  ModelTypeError,
  ReservedKeys,
  Attributes,
  Key,
  Loaded,
  DefaultBuilder,
  BuilderFor,
} from "./model.js";
export type { LoadedRelationValues, RelationBuildersFor, RelationAccessors } from "./model.js";

// Markers + accessors (the declared-shape surface).
export type {
  BelongsTo,
  HasOne,
  HasMany,
  BelongsToMany,
  HasOneThrough,
  HasManyThrough,
  MorphTo,
  MorphOne,
  MorphMany,
  MorphToMany,
  MorphedByMany,
  Computed,
  ColumnKeys,
  RelationKeys,
  ComputedKeys,
  ResolvedAttributes,
  RelationMarkers,
  LoadedValueOf,
  RelationMarker,
  RelationKind,
  // Exported so a downstream package's declaration emit can NAME the
  // phantom that `ModelInstance` carries, without it, `tsc` on a
  // consuming package fails with TS2742 ("cannot be named without a
  // reference to .../markers.js").
  HasAttributes,
  AttributesOf,
} from "./markers.js";
export { accessor } from "./accessors.js";
export type { AccessorDefinition } from "./accessors.js";
export type { KeyStrategy, KeyStrategyContext, ResolvedKeyType } from "./key-strategy.js";
export { uuidKeyStrategy, resolveKeyType } from "./key-strategy.js";

export { Relation, ClassMorphViolationError } from "./morph-map.js";
export type { MorphMap, MorphMapEntry } from "./morph-map.js";

export { MorphToBuilder } from "./morph-to-builder.js";
export type { MorphConstraints } from "./morph-to-builder.js";

export type {
  AttachIds,
  BelongsToManyWrites,
  BelongsToWrites,
  HasManyWrites,
  PivotAttributes,
  RelatedKey,
  RelationWritesFor,
  SyncResult,
  ToggleResult,
} from "./relationship-writes.js";

export { PIVOT_PREFIX } from "./pivot.js";
export { Seeder } from "./seeder.js";

export {
  ModelObserver,
  ModelLifecycleEvent,
  ModelRetrieved,
  ModelCreating,
  ModelCreated,
  ModelUpdating,
  ModelUpdated,
  ModelSaving,
  ModelSaved,
  ModelDeleting,
  ModelDeleted,
  ModelRestoring,
  ModelRestored,
} from "./model-events.js";
export type {
  ModelEventName,
  ModelEventPayload,
  ModelEventListener,
  ModelObserverClass,
  DispatchesEventsMap,
} from "./model-events.js";

export { QueryBuilder, JoinClause } from "./query-builder.js";
export type {
  WhereOperator,
  SubqueryFactory,
  Subquery,
  WhereNode,
  SqlBinding,
} from "./query-builder.js";

export { normalizeBinding, normalizeBindings } from "./bindings.js";
export type { Bindable } from "./bindings.js";

export { Expression } from "./expression.js";

export {
  belongsTo,
  hasOne,
  hasMany,
  belongsToMany,
  hasOneThrough,
  hasManyThrough,
  morphTo,
  morphOne,
  morphMany,
  morphToMany,
  morphedByMany,
} from "./relations.js";
export type {
  BelongsToOptions,
  HasManyOptions,
  HasOneOptions,
  BelongsToManyOptions,
  MorphToOptions,
  MorphManyOptions,
  MorphOneOptions,
  MorphToManyOptions,
  MorphedByManyOptions,
  HasManyThroughOptions,
  HasOneThroughOptions,
  RelationDefinition,
  RelationDefinitions,
  RelationHelperDefinition,
  Relationships,
  RelatedRowOf,
  EagerLoadResult,
  NestedEagerLoadResult,
  RelationPath,
  MaxRelationPathDepth,
  RelationValueOf,
  MorphTargetOf,
  MorphToKeys,
  ModelLike,
} from "./relations.js";

export { EloquentBuilder } from "./eloquent-builder.js";
export type { Hydrated } from "./eloquent-builder.js";
export { loadMany } from "./eager-loading.js";
export { MorphToSpec } from "./eager-load-tree.js";
export type { EagerLoadNode, EagerLoadRequest, EagerLoadTree } from "./eager-load-tree.js";

export {
  Cast,
  IntegerCast,
  FloatCast,
  StringCast,
  BooleanCast,
  ArrayCast,
  JsonCast,
  json,
  DateTimeCast,
  decimal,
  enumCast,
} from "./casts.js";
export type { Casts, ModelTypeOf, DbTypeOf } from "./casts.js";

export { Factory } from "./factory.js";
export type { FactoryState, FactoryCallback } from "./factory.js";

export type { GlobalScope } from "./global-scope.js";
export { SoftDeleteScope } from "./soft-deletes.js";

export { paginate } from "./pagination/length-aware-paginator.js";
export type { LengthAwarePaginationResult } from "./pagination/length-aware-paginator.js";
export { simplePaginate } from "./pagination/simple-paginator.js";
export type { SimplePaginationResult } from "./pagination/simple-paginator.js";
export { cursorPaginate } from "./pagination/cursor-paginator.js";
export type {
  CursorPaginateOptions,
  CursorPaginationResult,
} from "./pagination/cursor-paginator.js";

export { transaction } from "./transaction.js";
export {
  afterCommit,
  afterCommitOn,
  afterRollback,
  afterRollbackOn,
  getActiveTransaction,
  getActiveTransactionScope,
  getInnermostTransactionScope,
  inTransaction,
  runInTransactionContext,
} from "./transaction-context.js";
export type { DeferredCallback, TransactionScope } from "./transaction-context.js";

export {
  DatabaseServiceProvider,
  DATABASE_TOKEN,
  SCHEMA_TOKEN,
  MODEL_REGISTRY_TOKEN,
} from "./database-service-provider.js";
export { ModelRegistry } from "./model-registry.js";
export type { SerializableModelClass } from "./model-registry.js";
export { registerValidationPresenceResolver } from "./validation-presence.js";

import "./provider-hooks.js";
