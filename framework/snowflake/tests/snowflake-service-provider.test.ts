import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { CacheServiceProvider } from "@mahiframework/cache";
import { SequentialIdentifierResolver } from "../src/identifier-resolvers/sequential-identifier-resolver.js";
import { CacheSequenceResolver } from "../src/sequence-resolvers/cache-sequence-resolver.js";
import { defaultSnowflakeConfig } from "../src/snowflake-config.js";
import { SnowflakeGenerator } from "../src/snowflake-generator.js";
import { SnowflakeServiceProvider } from "../src/snowflake-service-provider.js";
import { Snowflake } from "../src/snowflake.js";
import { SEQUENTIAL_IDENTIFIER_TOKEN, SNOWFLAKE_TOKEN } from "../src/tokens.js";

describe("SnowflakeServiceProvider", () => {
  beforeEach(() => Snowflake.reset());
  afterEach(() => {
    clearCurrentApp();
    Snowflake.reset();
  });

  it("registers a SnowflakeGenerator singleton and applies default config on first id()", async () => {
    const app = new Application();
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();
    setCurrentApp(app);

    const generator = app.make<SnowflakeGenerator>(SNOWFLAKE_TOKEN);
    expect(generator).toBeInstanceOf(SnowflakeGenerator);

    const id = await generator.id("Widget");
    expect(String(id)).toMatch(/^\d{17,19}$/);
    expect(Snowflake.parse(id).cluster).toBe(1);
    expect(Snowflake.parse(id).worker).toBe(1);
  });

  it("swaps in SequentialIdentifierResolver when testing is true", async () => {
    const app = new Application();
    app.config.set("snowflake", { ...defaultSnowflakeConfig(), testing: true });
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();
    setCurrentApp(app);

    const generator = app.make<SnowflakeGenerator>(SNOWFLAKE_TOKEN);
    expect(await generator.id("User")).toBe(9000000000000000001n);
    expect(await generator.id("User")).toBe(9000000000000000002n);
    expect(await generator.id("Post")).toBe(9000000000000000001n);
  });

  it("leaves the memory sequence resolver when sequencing.resolver is null", async () => {
    const app = new Application();
    app.config.set("snowflake", defaultSnowflakeConfig());
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();
    setCurrentApp(app);

    await app.make<SnowflakeGenerator>(SNOWFLAKE_TOKEN).id("User");
    expect(String(await Snowflake.id())).toMatch(/^\d+$/);
  });

  it("auto-registers a CacheSequenceResolver when sequencing.resolver is cache", async () => {
    const app = new Application();
    app.config.set("cache", { default: "array", stores: { array: {} } });
    app.config.set("snowflake", {
      ...defaultSnowflakeConfig(),
      sequencing: { resolver: "cache" as const, prefix: "sf:" },
    });
    app.register(CacheServiceProvider);
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();
    setCurrentApp(app);

    await app.make<SnowflakeGenerator>(SNOWFLAKE_TOKEN).id("User");

    const resolver = (Snowflake as unknown as { sequenceResolverValue: unknown })
      .sequenceResolverValue;
    expect(resolver).toBeInstanceOf(CacheSequenceResolver);
  });

  it("binds SequentialIdentifierResolver as a singleton that reset() can clear", async () => {
    const app = new Application();
    app.config.set("snowflake", { ...defaultSnowflakeConfig(), testing: true });
    app.register(SnowflakeServiceProvider);
    await app.bootstrap();

    const resolver = app.make<SequentialIdentifierResolver>(SEQUENTIAL_IDENTIFIER_TOKEN);
    resolver.identifier(0, 0, "User");
    resolver.reset();
    expect(String(resolver.identifier(0, 0, "User"))).toBe("9000000000000000001");
  });
});
