# Extending package models

A package that owns a table also owns a model for it:
`@mahiframework/mfa` has `MfaMethod`, an RBAC package has `Role` and
`Permission`. Those models work for most applications and not for all
of them, so a package should let an application take one over.

In Laravel this is a config key and a string class name, resolved
through the autoloader:

```php
$model = config('permission.models.role');
$role  = $model::find($id);
```

TypeScript has no class-name registry to resolve a string against, so
that exact shape does not port. It also does not need to. Most of what
`config('...')::find()` buys in PHP, Mahi already has in the type
system, and the part that remains is one small piece of wiring.

There are two separate questions, and they are answered independently.
You will often want only the first.

| You want to | You need |
|---|---|
| Add methods, scopes, accessors, casts | **A subclass.** Nothing else. |
| Add columns to the package's table | A subclass + [`Extended<>`](#adding-columns) |
| Make the *package itself* use your class | A [registry swap](#swapping-the-class-the-package-uses) |

## Subclassing is the whole mechanism

Mahi's static finders are this-polymorphic. `find()`, `query()`,
`create()`, `all()` and the rest are declared with a polymorphic `this`,
so they return *the class you called them on*, not the class that
declared them:

```ts
import { MfaMethod } from "@mahiframework/mfa";

export class AppMfaMethod extends MfaMethod {
  nickname(): string {
    return this.label ?? this.driver;
  }

  static confirmed() {
    return this.query().whereNotNull("confirmed_at");
  }
}

const method = await AppMfaMethod.find(id);   // AppMfaMethod | undefined
method?.nickname();                            // ✅

const all = await AppMfaMethod.confirmed().get();  // Collection<AppMfaMethod>
```

This is the piece Laravel cannot do and therefore has to solve with
config. `Parent::find()` in PHP returns a `Parent`, so a package must be
told which class to instantiate. Here the subclass is simply itself.

A subclass inherits the parent's `table`, `primaryKey`, `casts`,
`hidden` and relationships, and shares its rows. What it does **not**
share is per-class state, which is the right default:

- **Global scopes** added to the subclass do not apply to the parent.
- **Observers and `on()` listeners** are keyed by class identity, so a
  subclass does not inherit the parent's and vice versa.
- **Casts** declared on the subclass do not affect the parent.

```ts
export class AppMfaMethod extends MfaMethod {
  static override boot(): void {
    this.on("creating", (method) => { /* this model only */ });
  }
}
```

> `static boot()` is the one-time per-class hook. You do not call
> `super.boot()`; see [Models](../models/#shared-behaviour).

## Adding columns

Add the column to the database with a migration in **your** application,
then tell the type system about it by merging into the package's
exported attributes interface:

```ts
// src/models/app-role.ts
import { Cast, type Extended } from "@mahiframework/database";
import { DateTime } from "@mahiframework/datetime";
import { Role } from "@mahiframework/rbac";

declare module "@mahiframework/rbac" {
  interface RoleAttributes {
    tenant_id: string;
    archived_at: Extended<DateTime | null>;
  }
}

export class AppRole extends Role {
  static override casts = {
    ...Role.casts,
    archived_at: Cast.datetime(),
  };

  get isArchived(): boolean {
    return this.archived_at !== null;
  }
}
```

The merge is global: it widens `RoleAttributes` for every consumer in
the program, including the package. That is what makes
`role.tenant_id` type-check, and it is also why the column must really
exist in the table.

### `Extended<>` and why `tenant_id` does not need it

A `string` column needs no cast, so it is declared bare.

A `DateTime`, `boolean` or JSON column *does* need one, and this is
where merging into someone else's model gets awkward. The rule that
demands `Cast.datetime()` is checked against the configuration object
passed to `Model<A>()({ … })` — and for a package model, that call is in
the package's source:

```
rbac/src/models/role.ts(18,51): error TS2345: Argument of type
  '{ table: "roles"; primaryKey: "id"; timestamps: false; }' is not
  assignable to parameter of type '{ … } &
  ModelTypeError<"DateTime column needs a Cast.datetime(): archived_at">'.
  Property '[MODEL_TYPE_ERROR]' is missing …
```

The error is correct that a cast is needed, but it fires at a line you
cannot edit, for a column that file has never heard of. Declaring the
cast on your subclass does not silence it, because the lint is checking
the *parent's* config.

`Extended<>` marks the column as "added by the application", which
exempts it from that check and moves responsibility for the cast to the
subclass — the only place that can carry it.

`Extended<>` is erased everywhere else. The column reads and writes as
its declared type, and is castable, fillable, hidden and queryable like
any other:

```ts
const role = await AppRole.findOrFail(id);
role.archived_at;   // DateTime | null
role.tenant_id;     // string
role.isArchived;    // boolean

await AppRole.query().whereNull("archived_at").get();
```

> **The cast is still required.** `Extended<>` suppresses the compiler's
> reminder, not the consequence. Without
> `casts = { ...Role.casts, archived_at: Cast.datetime() }` the type says
> `DateTime` while the driver hands back a `string`, and
> `role.archived_at.addDays(1)` throws *not a function* at runtime. This
> is the failure the lint exists to prevent, so having opted out of it,
> declare the cast.

One known rough edge: the lenient `ModelType | DbType` write union is
derived from the casts in a model's *config*, and your cast is on the
subclass static, so an `Extended<>` column accepts only its model-side
type on write. Pass a `DateTime`, not an ISO string.

## Swapping the class the package uses

Everything above affects code *you* write. If you only ever query
`AppRole` yourself, you are done.

Swapping is for when the **package's own** reads and writes must produce
your class — because you added a `NOT NULL` column it has to populate,
or your subclass has a global scope that must apply to the package's
queries too.

### For package authors

Reference your models through one mutable object, not through direct
imports:

```ts
// src/models/registry.ts
export interface RbacModels {
  role: typeof Role;
  permission: typeof Permission;
  rolePermission: typeof RolePermission;
  modelRole: typeof ModelRole;
}

export const rbacModels: RbacModels = {
  role: Role,
  permission: Permission,
  rolePermission: RolePermission,
  modelRole: ModelRole,
};

/** Point one or more tables at an application-provided subclass. */
export function useRbacModels(overrides: Partial<RbacModels>): void {
  Object.assign(rbacModels, overrides);
}
```

Then read through it everywhere, including from relation thunks:

```ts
export class Role extends Model<RoleAttributes>()({ … }) {
  static override relationships = {
    permissions: belongsToMany(() => rbacModels.permission, { … }),
  };
}

export class RbacManager {
  async findRole(id: string): Promise<Role | undefined> {
    return rbacModels.role.find(id);       // not `Role.find(id)`
  }
}
```

Two details carry their weight here.

**Type the entries `typeof Role`, not `AnyModelClass`.** `AnyModelClass`
is `typeof BaseModel`, which has no attribute type, so every static on
it degrades to `any` and the package loses column checking on its own
tables — all of this would compile:

```ts
await model.create({ utter: "nonsense" });
await model.query().where("nmae", "=", "typo").get();
```

`typeof Role` keeps those as errors, and additionally makes "must be a
subclass of `Role`" a compile-time guarantee rather than a runtime
surprise.

**Relation thunks are why this is a registry and not a config key.**
`static relationships` is evaluated when the module loads; configuration
is read later. A thunk closing over `rbacModels` resolves at `with()`
time, so a swap registered afterwards is still picked up. A config value
read by the manager cannot reach the thunk at all, which means
`with("permissions")` would keep returning the package's class.

### For applications

Register the swap in a provider's `register()`, before anything queries:

```ts
import { ServiceProvider } from "@mahiframework/core";
import { useRbacModels } from "@mahiframework/rbac";
import { AppRole } from "../models/app-role.js";

export class RbacOverrideServiceProvider extends ServiceProvider {
  register(): void {
    useRbacModels({ role: AppRole });
  }
}
```

List it after the package's own provider in `config/app.ts`. From then
on the package's queries, writes and eagerly-loaded relations all
produce `AppRole`.

## Why not a config key?

`@mahiframework/auth` does take model classes in configuration
(`auth.providers.users.model`, `auth.verification.model`), and that is
right for *that* case: the User model belongs to the application, auth
merely needs to be pointed at it.

Extending a package's *own* model is the other direction, and config is
a poor fit for it:

- It cannot reach relation thunks, as above.
- It is typed `AnyModelClass`, which erases the package's type safety.
- It puts a model import in `config/*.ts`, which loads before
  `app.bootstrap()`. `@mahiframework/activity-logs` keys its config by
  morph-alias string specifically to avoid pulling the ORM into
  config-load time.

A registry has none of those problems, and a provider is already the
place where a package's wiring is adjusted.

## Replacing a model outright

You cannot. A swapped class must be a *subclass* — a model redeclared
from scratch over the same table is rejected:

```ts
class MyRole extends Model<MyRoleAttributes>()({ table: "roles", … }) {}

useRbacModels({ role: MyRole });
//             ^^^^ Type 'typeof MyRole' is not assignable to 'typeof Role'
```

This is deliberate. The package holds `Role`-typed references
throughout, and a lookalike that happened to omit a column the package
writes would fail at runtime instead. Subclassing keeps the parent's
guarantees and lets you add to them.

## Gotchas

**The merge is program-wide.** `declare module` widens the interface for
every consumer, the package included. Keep the merge in one file next to
the subclass so it is findable.

**Instances of the parent are not instances of the subclass.** If some
code path still calls `Role.find()` directly, it returns a `Role`, and
`role instanceof AppRole` is `false`. This is exactly what swapping the
registry fixes.

**Observers do not inherit.** Registered on the parent, they do not fire
for the subclass. Register them on whichever class is actually in use —
after a swap, that is yours.

**Swap in `register()`, not `boot()`.** Another provider's `register()`
may resolve a service that queries immediately.

## See also

- [Models](../models/): attributes, casts, the proxy, model events
- [Relationships](../relationships/): relation thunks and eager loading
- [Service providers](../providers/): `register()` vs `boot()`
