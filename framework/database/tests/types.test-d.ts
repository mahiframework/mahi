/**
 * Compile-time assertions for the redesigned model type layer, the half
 * of the contract the runtime tests structurally cannot cover. `tsc` is
 * the assertion; nothing here runs.
 *
 * The guarantees pinned here:
 *  - A model is ONE type: the finder result, the builder terminal, `this`
 *    inside a method, and the declared attribute all agree (cast types
 *    included).
 *  - Relation markers map to their loaded values (`BelongsTo<User>` →
 *    `User | undefined`; `HasMany<Comment>` → `Collection<Comment> | undefined`).
 *  - `with()` narrows the named relations to non-`undefined` (`Loaded`).
 *  - `Key<M>`/`find()` are keyed by the declared primary-key column type.
 *  - The type-lint fires: a boolean column without a cast, and a reserved
 *    key collision, are rejected AT the class declaration.
 *  - Soft-delete instance methods exist only when configured.
 *
 * Each `@ts-expect-error` fails the build if the line beneath it ever
 * starts compiling again.
 */

import { expectTypeOf } from "vitest";
import type { Collection } from "@mahiframework/core";
import type { DateTime } from "@mahiframework/datetime";
import {
  Model,
  Cast,
  accessor,
  belongsTo,
  hasMany,
  belongsToMany,
  hasManyThrough,
  morphTo,
  morphToMany,
} from "../src/index.js";
import type {
  BelongsTo,
  HasMany,
  BelongsToMany,
  HasManyThrough,
  MorphTo,
  MorphToMany,
  Computed,
  Extended,
  Key,
  Loaded,
} from "../src/index.js";
import { EloquentBuilder } from "../src/eloquent-builder.js";
import type { SqlBinding } from "../src/query-builder.js";

interface UserAttributes {
  id: string;
  name: string;
  posts: HasMany<Post>;
}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  keyType: "uuid",
}) {
  static override relationships = {
    posts: hasMany(() => Post, { foreignKey: "user_id" }),
  };

  greet(): string {
    return `hi ${this.name}`;
  }
}

interface PostAttributes {
  id: number;
  user_id: string;
  title: string;
  body: string;
  published: boolean;
  published_at: DateTime | null;
  created_at: DateTime;
  updated_at: DateTime;
  deleted_at: DateTime | null;

  author: BelongsTo<User>;
  comments: HasMany<Comment>;
  tags: BelongsToMany<Tag, { weight: number }>;

  excerpt: Computed<string>;
}

class Post extends Model<PostAttributes>()({
  table: "posts",
  primaryKey: "id",
  softDeletes: true,
  casts: {
    published: Cast.boolean(),
    published_at: Cast.datetime(),
  },
  fillable: ["title", "body", "published"],
  appends: ["excerpt"],
}) {
  static override relationships = {
    author: belongsTo(() => User, { foreignKey: "user_id" }),
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
      withPivot: ["weight"],
    }),
  };

  static override accessors = {
    excerpt: accessor((post: Post) => post.body.slice(0, 120)),
  };

  isLive(): boolean {
    // `this.published` is a boolean AND resolves at runtime through the proxy.
    return this.published && this.published_at !== null;
  }
}

interface CommentAttributes {
  id: number;
  post_id: number;
  user_id: string;
  body: string;
  post: BelongsTo<Post>;
  author: BelongsTo<User>;
}

class Comment extends Model<CommentAttributes>()({ table: "comments", primaryKey: "id" }) {
  static override relationships = {
    post: belongsTo(() => Post, { foreignKey: "post_id" }),
    author: belongsTo(() => User, { foreignKey: "user_id" }),
  };
}

interface TagAttributes {
  id: number;
  name: string;
}

class Tag extends Model<TagAttributes>()({ table: "tags", primaryKey: "id" }) {}

async function oneType() {
  const post = await Post.find(1);
  expectTypeOf(post).toEqualTypeOf<Post | undefined>();

  if (!post) {
    return;
  }

  // Columns as declared (cast types included).
  expectTypeOf(post.published).toEqualTypeOf<boolean>();
  expectTypeOf(post.published_at).toEqualTypeOf<DateTime | null>();
  expectTypeOf(post.title).toEqualTypeOf<string>();

  // Relation loaded values.
  expectTypeOf(post.author).toEqualTypeOf<User | undefined>();
  expectTypeOf(post.comments).toEqualTypeOf<Collection<Comment> | undefined>();

  // Pivot attributes ride on the related instance for a many-to-many.
  expectTypeOf(post.tags).toEqualTypeOf<
    Collection<Tag & { pivot: { weight: number } }> | undefined
  >();

  // Computed accessor.
  expectTypeOf(post.excerpt).toEqualTypeOf<string>();

  // Subclass method survives on the finder result.
  expectTypeOf(post.isLive()).toEqualTypeOf<boolean>();

  // ...and equally on a BUILDER terminal. `query()` is this-polymorphic
  // like the finders, so both entry points hand back the same `Post`
  // rather than a bare derived attribute shape that has lost `isLive`.
  const queried = await Post.query().firstOrFail();
  expectTypeOf(queried).toEqualTypeOf<Post>();
  expectTypeOf(queried.isLive()).toEqualTypeOf<boolean>();

  // Finder returns the subclass instance type, with its own methods.
  const user = await User.find("abc");

  if (user) {
    expectTypeOf(user.greet()).toEqualTypeOf<string>();
  }
}
void oneType;

async function keys() {
  // Post.id is number.
  expectTypeOf<Key<Post>>().toEqualTypeOf<number>();
  await Post.find(1);
  // @ts-expect-error Post.id is a number, not a string
  await Post.find("nope");

  // User.id is string.
  await User.find("abc");
  // @ts-expect-error User.id is a string, not a number
  await User.find(1);
}
void keys;

async function loaded() {
  const post = await Post.query().with("author").firstOrFail();
  // `author` is now non-undefined (the essence of `Loaded<Post, "author">`).
  expectTypeOf(post.author).toEqualTypeOf<User>();
  // ...and the terminal's type IS that narrowing, not merely something
  // shaped like it. `Loaded` is exported, so the equivalence is public.
  expectTypeOf(post).toEqualTypeOf<Loaded<Post, "author">>();
  // `comments` (not loaded) stays optional.
  expectTypeOf(post.comments).toEqualTypeOf<Collection<Comment> | undefined>();

  // A declared relation name is accepted; an undeclared one is rejected.
  await Post.query().with("comments").get();
  // @ts-expect-error no relation named "nope"
  await Post.query().with("nope").get();

  // whereHas name-checks too.
  await Post.query().whereHas("author").get();
  // @ts-expect-error no relation named "nope"
  await Post.query().whereHas("nope").get();
}
void loaded;

async function dotPaths() {
  // A dot path type-checks and narrows the nested relation: the walk steps
  // from `Post`'s `author` to `User`'s own declared relations.
  const post = await Post.query().with("author.posts").firstOrFail();
  expectTypeOf(post.author).toEqualTypeOf<User & { posts: Collection<Post> }>();
  expectTypeOf(post.author.posts).toEqualTypeOf<Collection<Post>>();

  // A to-many head keeps its `Collection` wrapper and narrows the element.
  const withComments = await Post.query().with("comments.author").firstOrFail();
  expectTypeOf(withComments.comments).toEqualTypeOf<Collection<Comment & { author: User }>>();

  // Sibling paths under one head merge into a single value, matching the
  // one query the loader issues for that node.
  const merged = await Post.query().with("comments.author", "comments.post").firstOrFail();
  expectTypeOf(merged.comments).toEqualTypeOf<Collection<Comment & { author: User; post: Post }>>();

  // Every segment is name-checked, not just the head.
  // @ts-expect-error User declares no relation named "nope"
  await Post.query().with("author.nope").get();
  // @ts-expect-error Tag declares no relations, so no path continues through it
  await Post.query().with("tags.anything").get();

  // The depth cap is real: five segments check, a sixth does not.
  await Post.query().with("author.posts.author.posts.author").get();
  // @ts-expect-error exceeds MaxRelationPathDepth (5)
  await Post.query().with("author.posts.author.posts.author.posts").get();
}
void dotPaths;

// A `morphTo` whose targets BOTH declare a relation named `owner`. Without
// an explicit stop the union's shared keys look walkable, so this is the
// fixture that makes the assertion below meaningful.
interface MOwnerAttributes {
  id: number;
  name: string;
}
class MOwner extends Model<MOwnerAttributes>()({ table: "m_owners", primaryKey: "id" }) {}

interface MPostAttributes {
  id: number;
  owner_id: number;
  owner: BelongsTo<MOwner>;
}
class MPost extends Model<MPostAttributes>()({ table: "m_posts", primaryKey: "id" }) {
  static override relationships = {
    owner: belongsTo(() => MOwner, { foreignKey: "owner_id" }),
  };
}

interface MVideoAttributes {
  id: number;
  owner_id: number;
  owner: BelongsTo<MOwner>;
}
class MVideo extends Model<MVideoAttributes>()({ table: "m_videos", primaryKey: "id" }) {
  static override relationships = {
    owner: belongsTo(() => MOwner, { foreignKey: "owner_id" }),
  };
}

interface MNoteAttributes {
  id: number;
  notable_type: string;
  notable_id: number;
  notable: MorphTo<MPost | MVideo>;
}
class MNote extends Model<MNoteAttributes>()({ table: "m_notes", primaryKey: "id" }) {
  static override relationships = {
    notable: morphTo<MPost | MVideo>({
      morphType: "notable_type",
      morphId: "notable_id",
      types: { post: () => MPost, video: () => MVideo },
    }),
  };
}

async function morphToStopsThePath() {
  // A `morphTo` is a leaf for path purposes. Both targets here declare
  // `owner`, so the shared name would otherwise look walkable, but the
  // loader resolves a morph node's children per discriminant and throws
  // on a dot path through one. `morphWith()` is how those nest.
  await MNote.query().with("notable").get();
  // @ts-expect-error a path cannot continue through a morphTo
  await MNote.query().with("notable.owner").get();
}
void morphToStopsThePath;

function builders() {
  expectTypeOf(Post.query()).toMatchTypeOf<EloquentBuilder<any, any, any, any>>();
}
void builders;

async function softDeletes() {
  const post = await Post.findOrFail(1);
  expectTypeOf(post.trashed()).toEqualTypeOf<boolean>();
  await post.restore();
  await post.forceDelete();
  Post.withTrashed();
  Post.onlyTrashed();

  // A non-soft-delete model still exposes `trashed()` (it returns `false`
  // at runtime. The question is meaningful, the answer is "no"), matching
  // Laravel. The config only gates the meaningful cases.
  const user = await User.findOrFail("x");
  expectTypeOf(user.trashed()).toEqualTypeOf<boolean>();
}
void softDeletes;

interface BadBoolean {
  id: string;
  active: boolean; // boolean column with no cast
}
// @ts-expect-error boolean column `active` needs a Cast.boolean()
class BadBooleanModel extends Model<BadBoolean>()({ table: "bad" }) {}
void BadBooleanModel;

interface ReservedCollision {
  id: string;
  save: string; // collides with the reserved instance method `save`
}
// @ts-expect-error column `save` collides with a reserved model member
class ReservedModel extends Model<ReservedCollision>()({ table: "reserved" }) {}
void ReservedModel;

// A boolean column WITH a cast is fine.
interface GoodBoolean {
  id: string;
  active: boolean;
}
class GoodBooleanModel extends Model<GoodBoolean>()({
  table: "good",
  primaryKey: "id",
  casts: { active: Cast.boolean() },
}) {}
void GoodBooleanModel;

interface BadDateTime {
  id: string;
  published_at: DateTime; // DateTime column with no cast
}
// @ts-expect-error DateTime column `published_at` needs a Cast.datetime()
class BadDateTimeModel extends Model<BadDateTime>()({ table: "bad_dt", timestamps: false }) {}
void BadDateTimeModel;

// ...with the cast, fine. Nullable counts too.
class GoodDateTimeModel extends Model<{ id: string; published_at: DateTime | null }>()({
  table: "good_dt",
  primaryKey: "id",
  timestamps: false,
  casts: { published_at: Cast.datetime() },
}) {}
void GoodDateTimeModel;

// The timestamp and soft-delete columns are cast implicitly by the
// factory, so demanding an explicit cast for them would be wrong.
class ImplicitTimestampsModel extends Model<{
  id: string;
  created_at: DateTime;
  updated_at: DateTime;
  deleted_at: DateTime | null;
}>()({ table: "implicit", primaryKey: "id", softDeletes: true }) {}
void ImplicitTimestampsModel;

// ...including when they are renamed.
class RenamedTimestampsModel extends Model<{
  id: string;
  made_at: DateTime;
  touched_at: DateTime;
  archived_at: DateTime | null;
}>()({
  table: "renamed",
  primaryKey: "id",
  timestamps: { createdAt: "made_at", updatedAt: "touched_at" },
  softDeletes: { column: "archived_at" },
}) {}
void RenamedTimestampsModel;

// ---------------------------------------------------------------------
// `Extended<>`: columns an APP merges onto a PACKAGE-owned model.
//
// The cast lint is attached to the `Model<A>()(config)` call, which for
// a package model lives in the package. A merged-in DateTime/boolean
// column would therefore fail the lint at a line the app cannot edit.
// `Extended<>` exempts it; the cast moves to the app's subclass.
// See `docs/extending-models/`.
// ---------------------------------------------------------------------

// Stands in for a package-owned model whose attributes interface the
// app has merged two cast-requiring columns into.
interface PackageOwned {
  id: string;
  name: string;
  archived_at: Extended<DateTime | null>;
  is_default: Extended<boolean>;
}

// No cast declared for either, and the lint stays quiet. Without
// `Extended<>` this is the exact failure `BadDateTimeModel` pins above.
class PackageOwnedModel extends Model<PackageOwned>()({
  table: "package_owned",
  primaryKey: "id",
  timestamps: false,
}) {}
void PackageOwnedModel;

// The marker is erased on read: the instance sees the declared type.
async function extendedUnwrapsOnRead() {
  const row = await PackageOwnedModel.findOrFail("x");
  expectTypeOf(row.archived_at).toEqualTypeOf<DateTime | null>();
  expectTypeOf(row.is_default).toEqualTypeOf<boolean>();
  expectTypeOf(row.name).toEqualTypeOf<string>();
}
void extendedUnwrapsOnRead;

// ...and on write.
async function extendedUnwrapsOnWrite() {
  await PackageOwnedModel.create({
    id: "1",
    name: "admin",
    archived_at: null,
    is_default: true,
  });

  // @ts-expect-error archived_at is DateTime | null, not number
  await PackageOwnedModel.create({ id: "2", name: "a", archived_at: 1, is_default: true });
}
void extendedUnwrapsOnWrite;

// An `Extended<>` column is a real column everywhere else: castable,
// and usable as the primary key / in `fillable` / `hidden`.
class ExtendedIsStillAColumn extends Model<PackageOwned>()({
  table: "package_owned",
  primaryKey: "id",
  timestamps: false,
  casts: { archived_at: Cast.datetime(), is_default: Cast.boolean() },
  fillable: ["name", "archived_at"],
  hidden: ["is_default"],
}) {}
void ExtendedIsStillAColumn;

// The exemption is scoped to `Extended<>` columns only: a plain
// cast-requiring column on the SAME model still fails the lint.
interface MixedExtension {
  id: string;
  archived_at: Extended<DateTime | null>;
  published_at: DateTime | null; // not Extended: still linted
}
// @ts-expect-error DateTime column `published_at` needs a Cast.datetime()
class MixedExtensionModel extends Model<MixedExtension>()({
  table: "mixed",
  primaryKey: "id",
  timestamps: false,
}) {}
void MixedExtensionModel;

// `primaryKey` naming a relation is rejected by `ModelConfig` itself
// (the field is typed `ColumnKeys<A>`), not by a lint rule, so the
// error is a plain assignability one. Pinned here so that if the field's
// type is ever loosened, this starts compiling and fails the build.
interface PkIsRelation {
  id: string;
  author: BelongsTo<User>;
}
class PkIsRelationModel extends Model<PkIsRelation>()({
  table: "pk_rel",
  // @ts-expect-error "author" is a relation key, not a column
  primaryKey: "author",
}) {}
void PkIsRelationModel;

// `keyType` assigns a string, so a numeric primary key is a guaranteed
// runtime mismatch on insert.
// @ts-expect-error keyType "uuid" generates a string but `id` is a number
class NumericUuidModel extends Model<{ id: number }>()({
  table: "num_uuid",
  primaryKey: "id",
  timestamps: false,
  keyType: "uuid",
}) {}
void NumericUuidModel;

// A string key with `uuid` is fine, and so is a numeric key left on the
// auto-increment default.
class StringUuidModel extends Model<{ id: string }>()({
  table: "str_uuid",
  primaryKey: "id",
  timestamps: false,
  keyType: "uuid",
}) {}
void StringUuidModel;

class IncrementingModel extends Model<{ id: number }>()({
  table: "incr",
  primaryKey: "id",
  timestamps: false,
  keyType: "increment",
}) {}
void IncrementingModel;

// `restore()` writes null to the soft-delete column, so it must be nullable.
// @ts-expect-error the soft-delete column `deleted_at` must be nullable
class NonNullableSoftDeleteModel extends Model<{ id: string; deleted_at: DateTime }>()({
  table: "bad_sd",
  primaryKey: "id",
  timestamps: false,
  softDeletes: true,
}) {}
void NonNullableSoftDeleteModel;

interface WrongRel {
  id: string;
  author: BelongsTo<User>;
}
// @ts-expect-error `relationships.author` points at Tag but the marker says BelongsTo<User>
class WrongRelModel extends Model<WrongRel>()({ table: "wr", primaryKey: "id" }) {
  static override relationships = {
    author: belongsTo(() => Tag, { foreignKey: "user_id" }),
  };
}
void WrongRelModel;

// `RelationBuildersFor` intersects each accessor with `RelationWritesFor`,
// so the write API is present exactly where the relation kind supports
// it. These are the assertions that keep `attach()` off a `belongsTo`
// and `associate()` off a pivot. A runtime test cannot see either,
// because neither line would ever be written by a passing test.

interface AuthorAttributes {
  id: string;
  name: string;
}
class Author extends Model<AuthorAttributes>()({
  table: "authors",
  primaryKey: "id",
  keyType: "uuid",
}) {}

interface WCommentAttributes {
  id: string;
  body: string;
  commentable_type: string;
  commentable_id: string;
  commentable: MorphTo<WritablePost | Author>;
}
class WComment extends Model<WCommentAttributes>()({
  table: "comments",
  primaryKey: "id",
  keyType: "uuid",
}) {
  static override relationships = {
    commentable: morphTo<WritablePost | Author>({
      morphType: "commentable_type",
      morphId: "commentable_id",
    }),
  };
}

interface WritablePostAttributes {
  id: string;
  author_id: string;
  title: string;

  author: BelongsTo<Author>;
  comments: HasMany<WComment>;
  tags: BelongsToMany<Tag, { weight: number }>;
  taggables: MorphToMany<Tag>;
  authorTags: HasManyThrough<Tag>;
}

class WritablePost extends Model<WritablePostAttributes>()({
  table: "posts",
  primaryKey: "id",
  keyType: "uuid",
}) {
  static override relationships = {
    author: belongsTo(() => Author, { foreignKey: "author_id" }),
    comments: hasMany(() => WComment, { foreignKey: "commentable_id" }),
    tags: belongsToMany(() => Tag, {
      pivotTable: "post_tag",
      foreignPivotKey: "post_id",
      relatedPivotKey: "tag_id",
      withPivot: ["weight"],
    }),
    taggables: morphToMany(() => Tag, {
      pivotTable: "taggables",
      morphType: "taggable_type",
      morphId: "taggable_id",
      relatedPivotKey: "tag_id",
    }),
    authorTags: hasManyThrough(() => Tag, {
      through: () => Author,
      firstKey: "id",
      secondKey: "author_id",
    }),
  };
}

async function relationWriteSurface(post: WritablePost) {
  // A pivot relation has the many-to-many write API...
  await post.relations.tags().attach("t1");
  await post.relations.tags().attach(["t1", "t2"], { weight: 1 });
  await post.relations.tags().attach({ t1: { weight: 1 } });
  await post.relations.tags().detach();
  await post.relations.tags().sync(["t1"], false);
  await post.relations.tags().syncWithoutDetaching(["t1"]);
  await post.relations.tags().syncWithPivotValues(["t1"], { weight: 2 });
  await post.relations.tags().toggle(["t1"]);
  await post.relations.tags().updateExistingPivot("t1", { weight: 3 });

  // ...and so does a polymorphic one.
  await post.relations.taggables().attach("t1");

  // The read side is untouched by the intersection.
  await post.relations.tags().where("name", "x").get();

  // A belongsTo gets associate/dissociate instead.
  post.relations.author().associate("a1");
  post.relations.author().dissociate();

  // A hasMany gets save/create.
  await post.relations.comments().create({ body: "hi" });
  await post.relations.comments().createMany([{ body: "hi" }]);
}
void relationWriteSurface;

// `sync()`'s result is Laravel's three buckets, so ported code reading
// `result.attached` keeps compiling.
async function syncResultShape(post: WritablePost) {
  const result = await post.relations.tags().sync(["t1"]);
  const attached: SqlBinding[] = result.attached;
  const detached: SqlBinding[] = result.detached;
  const updated: SqlBinding[] = result.updated;
  void attached;
  void detached;
  void updated;

  const toggled = await post.relations.tags().toggle(["t1"]);
  const toggleAttached: SqlBinding[] = toggled.attached;
  void toggleAttached;
}
void syncResultShape;

async function relationWritesAreKindSpecific(post: WritablePost) {
  // @ts-expect-error attach() is a pivot method; `author` is a belongsTo
  post.relations.author().attach("a1");

  // @ts-expect-error associate() is a belongsTo method; `tags` is a pivot
  post.relations.tags().associate("t1");

  // @ts-expect-error a belongsTo has no create()-through-the-relation
  await post.relations.author().create({ name: "Ada" });

  // @ts-expect-error a hasMany is not a pivot
  await post.relations.comments().attach("c1");

  // @ts-expect-error hasManyThrough is read-only (Laravel too)
  await post.relations.authorTags().attach("t1");

  // @ts-expect-error ...and has no create()-through-the-relation either
  await post.relations.authorTags().create({ name: "x" });
}
void relationWritesAreKindSpecific;

// A `morphTo` accessor is a MorphToBuilder, which declares its own
// associate()/dissociate(), instance-only, since a bare key cannot
// supply the discriminant.
async function morphToWrites(comment: WComment, post: WritablePost) {
  comment.relations.commentable().associate(post);
  comment.relations.commentable().dissociate();

  // @ts-expect-error a morphTo cannot be associated by bare key
  comment.relations.commentable().associate("p1");

  // @ts-expect-error a morphTo is not a pivot
  await comment.relations.commentable().attach("p1");
}
void morphToWrites;
