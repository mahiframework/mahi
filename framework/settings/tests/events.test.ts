import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { SettingUpdated } from "../src/events/setting-updated.js";
import { createHarness, makeUser, type Harness } from "./__fixtures__/test-app.js";

let harness: Harness;
let fired: SettingUpdated[];

beforeEach(async () => {
  harness = await createHarness();
  fired = [];
  harness.events.listen(SettingUpdated, (event: SettingUpdated) => {
    fired.push(event);
  });
});

afterEach(() => harness.cleanup());

describe("dispatching", () => {
  it("fires once per changed setting with the new and previous values", async () => {
    await harness.registry.set("app_name", "Acme");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.key).toBe("app_name");
    expect(fired[0]?.value).toBe("Acme");
    expect(fired[0]?.previous).toBe("Mahi");
  });

  it("reports the declared default as previous when nothing was stored", async () => {
    // `previous` is the EFFECTIVE old value, so a listener comparing the
    // two sees the real transition rather than a null standing in for
    // "there was no row".
    await harness.registry.set("import_batch_size", 250);

    expect(fired[0]?.previous).toBe(100);
  });

  it("fires one event per setting in a batch", async () => {
    await harness.registry.setMany({ app_name: "A", import_batch_size: 5 });

    expect(fired.map((event) => event.key)).toEqual(["app_name", "import_batch_size"]);
  });

  it("reports each previous value from before the whole batch", async () => {
    await harness.registry.setMany({ app_name: "A", import_batch_size: 5 });

    expect(fired[0]?.previous).toBe("Mahi");
    expect(fired[1]?.previous).toBe(100);
  });

  it("carries the actor", async () => {
    const user = await makeUser();

    await harness.registry.set("app_name", "x", user);

    expect(fired[0]?.editedByUserId).toBe(String(user.id));
  });

  it("fires on forget, carrying the default as the new value", async () => {
    await harness.registry.set("app_name", "Acme");
    fired = [];

    await harness.registry.forget("app_name");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.value).toBe("Mahi");
    expect(fired[0]?.previous).toBe("Acme");
    expect(fired[0]?.editedByUserId).toBeNull();
  });

  it("does not fire on a forget that deleted nothing", async () => {
    await harness.registry.forget("app_name");

    expect(fired).toHaveLength(0);
  });

  it("carries decoded values, not their stored form", async () => {
    const when = DateTime.parse("2026-03-04T05:06:07Z", "UTC");

    await harness.registry.set("maintenance_until", when);

    expect(fired[0]?.value).toBeInstanceOf(DateTime);
  });

  it("fires after the cache is forgotten, so a listener reads the new value", async () => {
    // The ordering a listener depends on: one that reacts by reading the
    // setting back must not race the invalidation.
    let observed: unknown;

    harness.events.listen(SettingUpdated, async () => {
      observed = await harness.registry.get("app_name");
    });

    await harness.registry.set("app_name", "Acme");

    expect(observed).toBe("Acme");
  });
});

describe("when events are unavailable", () => {
  it("writes without dispatching when the dispatcher is not bound", async () => {
    // The package works in an app with no events installed.
    const noEvents = await createHarness({ events: false });

    await noEvents.registry.set("app_name", "Still works");

    expect(await noEvents.registry.get("app_name")).toBe("Still works");

    noEvents.cleanup();
  });

  it("skips the dispatch when events are turned off in config", async () => {
    const disabled = await createHarness({ config: { events: false } });
    const seen: SettingUpdated[] = [];
    disabled.events.listen(SettingUpdated, (event: SettingUpdated) => {
      seen.push(event);
    });

    await disabled.registry.set("app_name", "Quiet");

    expect(seen).toHaveLength(0);
    expect(await disabled.registry.get("app_name")).toBe("Quiet");

    disabled.cleanup();
  });
});
