# Permissions

Roles, permissions, and the cache that keeps checking them cheap. A port
of the ideas in `spatie/laravel-permission`, adapted to this framework's
gate and its lack of traits.

A `Role` holds `Permission`s. Any integer-keyed model holds `Role`s and
inherits their permissions, and may also hold a `Permission` directly.

```ts
import { Permissions } from "@mahiframework/permissions";

await Permissions.createRole("editor");
await Permissions.createPermission("posts.edit");
await Permissions.givePermissionToRole("editor", "posts.edit");

await Permissions.assignRole(user, "editor");

await Permissions.hasPermissionTo(user, "posts.edit"); // true
await Gate.allows("posts.edit"); // true, for the authenticated user
```

## Not installed by default

```sh
npm install @mahiframework/permissions
```

Then add the provider to `config/app.ts`:

```ts
import { PermissionsServiceProvider } from "@mahiframework/permissions";

export const providers: ServiceProviderClass[] = [
  EventsServiceProvider,
  DatabaseServiceProvider,
  // ...
  CacheServiceProvider,
  AuthServiceProvider,
  AuthorizationServiceProvider,
  PermissionsServiceProvider,  // ← here
  // ...
  HttpServiceProvider,

  AppServiceProvider,
];
```

The ordering constraints, all of which are real:

- **After `DatabaseServiceProvider`** — the package owns five tables and
  two models.
- **After `CacheServiceProvider`** — the role/permission map lives in a
  cache store.
- **After `AuthServiceProvider`** — the per-request memo pipe should run
  inside the ambient auth scope, and the default guard is read from
  `auth.default`.
- **Before `HttpServiceProvider`** — so the memo pipe is collected before
  routes are.

`AuthorizationServiceProvider` may come on either side.
`AuthorizationServiceProvider.boot()` walks every registered provider, so
the gate hook is collected whichever order the two appear in.

Then run the migration:

```sh
./artisan migrate
```

## Read this first: two hard limits

**Only integer-keyed models can hold roles.** `model_has_roles.model_id`
is a `bigInteger`, so a model keyed on a uuid or a string cannot be
assigned a role or a permission. Attempting it throws
`UnsupportedAssigneeKeyError` rather than reaching SQL.

This is a deliberate trade and the one place the schema diverges from
`activity_logs` and `notifications`, which use text for their
polymorphic id columns. Those tables are only read back by equality from
code that already knows the type, so text (which holds every key type
losslessly) costs them nothing. Here the column is the local side of a
`morphToMany` pivot, and the relation builder binds the local key *raw* —
a `bigint` against a `varchar` makes Postgres raise `operator does not
exist`. Text would therefore have broken `with("roles")` and
`whereHas("roles", ...)` entirely.

**There are no wildcard permissions.** `posts.*` does not grant
`posts.edit`. Names match exactly, consistent with the gate's own stance
on ability names. A role that should grant breadth gets more permissions
attached to it, which is what roles are for.

Also out of scope: **teams and tenancy**. A role is held globally, not
per-team. The schema and cache keys are shaped so a `scope_type`/
`scope_id` pair would be an additive migration rather than a rewrite, but
nothing today implements it.

## Configuration

Every option has a default, so an app that writes no config at all gets a
working package. To change one, write `config/permissions.ts`:

```ts
import type { PermissionsConfig } from "@mahiframework/permissions";

export function permissionsConfig(): PermissionsConfig {
  return {
    guard: "web",
    cache: {
      key: "mahi.permissions",
      ttlSeconds: 86_400,
    },
    gate: true,
  };
}
```

and wire it in `bin/bootstrap.ts`, before the provider loop:

```ts
app.config.set("permissions", permissionsConfig());
```

| Option | Default | Purpose |
|---|---|---|
| `guard` | `auth.default` | Guard stamped on new roles/permissions, and used by any check that doesn't name one |
| `cache.key` | `"mahi.permissions"` | The single key holding the whole map |
| `cache.store` | the default store | A named cache store |
| `cache.ttlSeconds` | `86400` | Backstop against a missed invalidation |
| `gate` | `true` | Register the `Gate.before()` hook |

## The API

Every method takes the subject explicitly, and every method is `async`.

```ts
// roles and permissions
await Permissions.createRole("editor");
await Permissions.createPermission("posts.edit");
await Permissions.findOrCreateRole("editor");          // idempotent
await Permissions.findRole("editor");                  // throws if absent
await Permissions.deleteRole("editor");                // cascades its pivots

// a role's permissions
await Permissions.givePermissionToRole("editor", ["posts.edit", "posts.view"]);
await Permissions.revokePermissionFromRole("editor", "posts.view");
await Permissions.syncRolePermissions("editor", ["posts.edit"]);

// a subject's roles
await Permissions.assignRole(user, "editor");
await Permissions.removeRole(user, "editor");
await Permissions.syncRoles(user, ["editor", "reviewer"]);

// a subject's direct permissions
await Permissions.givePermissionTo(user, "billing.view");
await Permissions.revokePermissionTo(user, "billing.view");
await Permissions.syncPermissions(user, []);

// checks
await Permissions.hasRole(user, "editor");
await Permissions.hasAnyRole(user, ["editor", "admin"]);
await Permissions.hasAllRoles(user, ["editor", "admin"]);
await Permissions.hasPermissionTo(user, "posts.edit");       // any route
await Permissions.hasDirectPermission(user, "posts.edit");   // direct only
await Permissions.hasAnyPermission(user, ["a", "b"]);
await Permissions.hasAllPermissions(user, ["a", "b"]);

// introspection
await Permissions.getRoleNames(user);            // Set<string>
await Permissions.getAllPermissions(user);       // roles + direct
await Permissions.getPermissionsViaRoles(user);
await Permissions.getDirectPermissions(user);
```

### There is no `HasRoles` trait

spatie's ergonomics come from a trait: `$user->assignRole('admin')`. This
framework has no traits, and no package in it adds behaviour to the app's
`User` model — `mfa`, `impersonation` and `activity-logs` all attach
behaviour through a container singleton and a facade instead. This package
does the same.

The explicit subject also does things a method could not. It works
uniformly on any assignable model, and it works from a `{ type, id }`
descriptor where no model instance exists:

```ts
// In a queue job holding only the ids it was serialised with.
await Permissions.assignRole({ type: "User", id: 9_123_456_789_012_345_678n }, "editor");
```

### A sync of `[]` removes everything

```ts
await Permissions.syncRoles(user, []); // the user now holds no roles
```

Worth stating because the framework's own pivot API does the opposite:
`detach([])` is a deliberate no-op, and only a bare `detach()` clears
everything. So routing `request.input("roles")` through *that* API
silently keeps every role when the input is an empty list. This package
writes pivots directly and means what it says.

### Assignment is idempotent

`assignRole`, `givePermissionTo` and `givePermissionToRole` all skip what
is already held, so calling them twice is safe. That is not free
behaviour: the pivots carry composite primary keys and nothing in the
framework deduplicates a pivot insert, so each of these diffs against the
current state first.

## Guards

Every role and permission is scoped to one of the app's auth guards. An
`api` role cannot satisfy a `web` check, even when both are named
`"admin"`:

```ts
await Permissions.createRole("admin", { guard: "web" });
await Permissions.createRole("admin", { guard: "api" });

await Permissions.assignRole(user, "admin", { guard: "api" });

await Permissions.hasRole(user, "admin", { guard: "api" }); // true
await Permissions.hasRole(user, "admin", { guard: "web" }); // false
```

`guard_name` is **NOT NULL and has no wildcard value**. A single-guard app
never sees it: the guard resolves from `config.guard`, then
`auth.default`. A multi-guard app names it per call.

The reason there is no "applies to every guard" value is the uniqueness
constraint. `(name, guard_name)` is unique, and a nullable column cannot
be made unique portably — every engine treats NULLs as distinct in a
unique index, and the fix (`nullsNotDistinct`) is Postgres 15+ only and
throws outright on SQLite and MySQL. A nullable `guard_name` would
therefore have permitted unlimited duplicate `('admin', NULL)` rows in
development.

An unresolvable guard throws `UnresolvedGuardError` rather than stamping
`""`, which would create a role no check could ever match.

## Gate integration

With `gate: true` (the default), the package registers a `Gate.before()`
hook, so permissions work through the gate with nothing else wired up:

```ts
await Gate.allows("posts.edit");               // consults permissions
await authorize("posts.edit");                 // 403 unless held
route.middleware(authenticate(), can("posts.edit"));
```

Two aspects are worth understanding, because both are deliberate.

**The hook never denies.** It returns `true` when the permission is held
and `null` otherwise — never `false`. A `false` from a `before()` hook
hard-denies and *skips policy resolution entirely*, so denying on a
permission miss would make every policy in the application unreachable.
Abstaining leaves the pipeline intact: policies and `define()`d abilities
still run, and the gate's own default deny still produces `false` at the
end of it.

**The hook abstains whenever the check carries an argument.** This
diverges from spatie, where `Gate::allows('update', $post)` also routes
through the permission check. That behaviour means an app with both a
permission named `update` and a `PostPolicy.update` grants update on
*every* post to anyone holding the permission. Here the two are split
cleanly:

| Check | Resolved by |
|---|---|
| `can("posts.edit")` | permissions, then policies/abilities |
| `can("update", Post, post)` | the policy, only |

A policy that *wants* a permission check asks for one explicitly, next to
the row it concerns:

```ts
export class PostPolicy extends Policy<User, PostTable> {
  delete = requireAuth<User, [PostTable]>(async (user, post) => {
    if (post.user_id === user.id) {
      return true;
    }

    return Permissions.hasPermissionTo(user, "posts.delete.any");
  });
}
```

A non-model user (a token-guard adapter, a plain object) also abstains
rather than throwing. It has no morph alias and no `bigint` key, and a
hook that throws turns every authorization check in the app into a 500.

Hooks run in registration order and the first non-`null` result wins, so
a permission grant beats a later hook that would have denied. That
ordering follows from `config/app.ts`.

## Middleware

```ts
import { permission, role, roleOrPermission } from "@mahiframework/permissions";

group.middleware(authenticate(), role("admin"));
group.middleware(authenticate(), role(["admin", "editor"]));          // any-of
group.middleware(authenticate(), permission("posts.edit"));
group.middleware(
  authenticate(),
  roleOrPermission({ roles: ["admin"], permissions: ["posts.edit"] }),
);
```

`role()` and `permission()` are **any-of**. For all-of, call
`Permissions.hasAllRoles()` in the controller, where the intent is
legible — a route string cannot express the difference, and silently
picking one is how an app ends up with the wrong one.

`roleOrPermission()` exists because stacking `role()` and `permission()`
is an AND: both would have to pass.

Place these **after** `authenticate()`. A guest is denied with **403, not
401**: 401 is not an authorization decision, which is the same stance the
gate takes. A route that should say "log in" carries `authenticate()`,
and that produces the 401 before these pipes run. `Router.middleware()`
throws when called after a route is registered, so getting the order
wrong inside a group is a boot failure rather than a hole.

`can("posts.edit")` from `@mahiframework/authorization` does the same job
as `permission("posts.edit")`. Reach for this one when the gate hook is
disabled, when the check needs a non-default guard, or when the route
should read as a permission check rather than an ability check.

## Eager loading

The package exports two relation factories. Declaring them is opt-in per
model, since the package owns neither the app's models nor its attribute
interfaces:

```ts
import {
  permissionsRelation,
  rolesRelation,
  type Permission,
  type Role,
} from "@mahiframework/permissions";
import type { MorphToMany } from "@mahiframework/database";

export interface UserAttributes {
  id: bigint;
  // ...
  roles: MorphToMany<Role>;
  permissions: MorphToMany<Permission>;
}

export class User extends Model<UserAttributes>()({ /* ... */ }) {
  static override relationships = {
    roles: rolesRelation(),
    permissions: permissionsRelation(),
  };
}
```

That buys the ordinary relation surface:

```ts
await User.query().with("roles.permissions").get();
await User.query().whereHas("roles", (q) => q.where("name", "admin")).get();
await user.load("roles");
```

Two caveats:

- **`permissionsRelation()` loads direct permissions only.** The
  role-inherited ones are two hops through a polymorphic pivot, which the
  ORM cannot express as a single relation.
  `Permissions.getAllPermissions(user)` is the union, and it answers from
  the cached map rather than a join.
- **These are a read convenience.** `Permissions.assignRole()` writes the
  pivot directly, so a collection loaded by `with("roles")` will not
  reflect an assignment made later in the same request. Re-`load()` it if
  that matters.

The inverse ("which users hold this role") cannot ship from the package,
because `morphedByMany` needs the app's own class. Declare it on `Role`'s
side if you want it — and note the `type`-defaulting asymmetry, which the
framework's own comment calls the single easiest thing to get wrong:
`morphToMany`'s `type` names *this* model, `morphedByMany`'s names the
*related* one.

## Caching

One cache entry holds every role, every permission, and which permissions
each role grants. It is read once per process (then per TTL) and every
check answers from it.

What is **not** cached is who holds what. `model_has_roles` scales with
the user table, so caching it under one key would mean one entry growing
without bound, invalidated by every assignment anywhere. Assignments are
a query — two, in parallel, memoised per request.

That memo matters more than it looks. The gate hook fires on *every*
authorization check, so a controller making five `can()` calls would be
ten queries without it. HTTP requests get a memo scope automatically from
the provider's middleware. A job or command that makes several checks can
open one:

```ts
await Permissions.withCache(async () => {
  for (const user of users) {
    await Permissions.hasPermissionTo(user, "posts.edit");
  }
});
```

### Invalidation

The registrar forgets the cache on every write it performs. For writes
that bypass it — a seeder calling `Role.create()`, a migration
backfilling `guard_name`, an admin screen saving through the model — the
package also listens for `ModelCreated`/`ModelUpdated`/`ModelDeleted` and
forgets the cache when the row is a `Role` or a `Permission`.

Unlike `activity-logs`, that listener does **not** swallow errors. A
throw inside a model event fails the caller's `save()`, and that is the
right trade here: a missing audit row is a lost record, but a cache that
still grants a deleted role's permissions is a security failure. Better
the write fails loudly and is retried.

The TTL (24h by default) is the backstop. `@mahiframework/cache` has no
tags, so there is no flush-by-pattern and every key written must be a key
nameable later — which is why there is exactly one. If a write path ever
escapes both the registrar and the listeners, a `null` TTL would make the
stale map permanent.

```sh
./artisan permissions:cache-reset
```

forgets exactly that one key and nothing else. `cache:clear` would take
out the app's entire cache to fix a problem with five tables.

## Commands

| Command | Purpose |
|---|---|
| `permissions:show [--guard=web]` | Every role, its guard, and what it grants |
| `permissions:cache-reset` | Forget the cached map |
| `permissions:check` | Validate stored assignments against models and guards |

`permissions:show` reads the same cached map the checks read, so it shows
what the application currently *believes* rather than what the tables
say — the more useful answer when the suspicion is a stale cache. Follow
with `permissions:cache-reset` to compare.

`permissions:check` exists because two things can rot silently:

1. **A `model_type` naming no model.** Assignment rows store a morph
   alias, and `morphAlias()` falls back to the *table name* when no
   `Relation.morphMap()` entry exists — so renaming a table orphans every
   row that named the old one. The rows stay, the checks stop matching,
   and nothing errors.
2. **A `guard_name` naming no configured guard.** A role created under a
   guard later renamed in `config/auth.ts` can never satisfy a check
   again.

It exits non-zero, so CI can gate on it. Which leads to the
recommendation:

```ts
// src/providers/app.provider.ts
register(): void {
  Relation.enforceMorphMap({
    User: () => User,
    Team: () => Team,
  });
}
```

`enforceMorphMap()` makes an unmapped model's `morphAlias()` throw rather
than falling back to `morphName` or the table name. With it, a renamed
table is a boot failure instead of an authorization system that quietly
stops granting.

## Schema

Five tables, one migration — they are individually meaningless, and a
partial rollback leaving `model_has_roles` pointing at a dropped `roles`
would be worse than either end of it.

```
roles                   id (bigInteger PK), name, guard_name, timestamps
                        unique(name, guard_name)
permissions             identical

role_has_permissions    role_id, permission_id
                        primary(role_id, permission_id)

model_has_roles         role_id, model_type, model_id
                        primary(role_id, model_id, model_type)
                        index(model_id, model_type)

model_has_permissions   permission_id, model_type, model_id
```

The composite primary keys *are* the dedupe mechanism. Foreign keys exist
only on the package-owned side (`role_id`, `permission_id`), with
`cascadeOnDelete`, so deleting a role takes its assignments with it.
`model_id` carries no foreign key at all: `users` is app-owned, so the
framework cannot assume its name, and the column holds the key of any
assignable model.

## Related

- [Authorization](../authorization/) — the gate and policies this hooks into
- [Authentication](../authentication/) — guards, which `guard_name` scopes to
- [Cache](../cache/) — the store the map lives in
- [Relationships](../relationships/) — `morphToMany` and the pivot API
