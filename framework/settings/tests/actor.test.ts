import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithAuth } from "@mahiframework/auth";
import { DB } from "@mahiframework/database";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.cleanup());

/** The `edited_by_user_id` stored for a setting. */
async function actorFor(key: string): Promise<string | null> {
  const row = await DB.table("settings").where("key", key).first();

  return (row as { edited_by_user_id: string | null }).edited_by_user_id;
}

describe("outside a request scope", () => {
  it("writes with a null actor rather than throwing", async () => {
    // THE most important behaviour in this package for CLI commands,
    // seeders and queue workers. `Auth.user()` and `Auth.userOrNull()`
    // both throw `MissingAuthContextError` with no auth scope —
    // `userOrNull()` included, deliberately — so reaching for either
    // would make every write outside a request fail. The registry reads
    // `currentAuthState()`, the only non-throwing primitive.
    await harness.registry.set("app_name", "From a worker");

    expect(await actorFor("app_name")).toBeNull();
    expect(await harness.registry.get("app_name")).toBe("From a worker");
  });
});

describe("inside a request scope", () => {
  it("attributes the write to the authenticated user", async () => {
    const user = await makeUser();

    await runWithAuth({ user, guard: "web" }, async () => {
      await harness.registry.set("app_name", "From a request");
    });

    expect(await actorFor("app_name")).toBe(String(user.id));
  });

  it("stores a null actor for an authenticated-scope-but-no-user request", async () => {
    // The shape `AuthServiceProvider` opens for every request, so a
    // public route can write a setting without the scope being mistaken
    // for a user.
    await runWithAuth({ user: null, guard: null }, async () => {
      await harness.registry.set("app_name", "Anonymous");
    });

    expect(await actorFor("app_name")).toBeNull();
  });

  it("prefers getKey() so a model with a non-id primary key still resolves", async () => {
    // `getKey()` is right even when the primary key is not named `id`,
    // which is exactly this package's own model.
    const user = { getKey: () => 987n, id: "ignored" };

    await runWithAuth({ user, guard: "web" }, async () => {
      await harness.registry.set("app_name", "x");
    });

    expect(await actorFor("app_name")).toBe("987");
  });

  it("falls back to id for a non-model user", async () => {
    // A token-guard adapter or a stub, which has no `getKey()`.
    await runWithAuth({ user: { id: 42 }, guard: "api" }, async () => {
      await harness.registry.set("app_name", "x");
    });

    expect(await actorFor("app_name")).toBe("42");
  });

  it("stores null rather than throwing for a user with no usable key", async () => {
    // A missing attribution is a weaker failure than a rejected write,
    // and the setting change should still land.
    await runWithAuth({ user: { name: "keyless" }, guard: "web" }, async () => {
      await harness.registry.set("app_name", "x");
    });

    expect(await actorFor("app_name")).toBeNull();
  });
});

describe("the explicit editedBy argument", () => {
  it("treats an explicit null as deliberately unattributed, overriding the scope", async () => {
    // `undefined` and `null` are NOT the same thing: a command running
    // inside a request scope that means "this was not a user action"
    // must be able to say so.
    const user = await makeUser();

    await runWithAuth({ user, guard: "web" }, async () => {
      await harness.registry.set("app_name", "System change", null);
    });

    expect(await actorFor("app_name")).toBeNull();
  });

  it("accepts a model, overriding the scope", async () => {
    const acting = await makeUser();
    const other = await makeUser();

    await runWithAuth({ user: acting, guard: "web" }, async () => {
      await harness.registry.set("app_name", "On behalf of", other);
    });

    expect(await actorFor("app_name")).toBe(String(other.id));
  });

  it("accepts a bare key", async () => {
    await harness.registry.set("app_name", "x", 12345n);

    expect(await actorFor("app_name")).toBe("12345");
  });

  it("records the actor on every setting in a batch", async () => {
    const user = await makeUser();

    await harness.registry.setMany({ app_name: "A", import_batch_size: 5 }, user);

    expect(await actorFor("app_name")).toBe(String(user.id));
    expect(await actorFor("import_batch_size")).toBe(String(user.id));
  });

  it("updates the actor when an existing setting is changed by someone else", async () => {
    const first = await makeUser();
    const second = await makeUser();

    await harness.registry.set("app_name", "First", first);
    await harness.registry.set("app_name", "Second", second);

    expect(await actorFor("app_name")).toBe(String(second.id));
  });
});
