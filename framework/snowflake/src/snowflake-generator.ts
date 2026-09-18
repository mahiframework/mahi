import { CACHE_TOKEN, type CacheManager } from "@mahiframework/cache";
import type { Application } from "@mahiframework/core";
import { SequentialIdentifierResolver } from "./identifier-resolvers/sequential-identifier-resolver.js";
import { CacheSequenceResolver } from "./sequence-resolvers/cache-sequence-resolver.js";
import { FileSequenceResolver } from "./sequence-resolvers/file-sequence-resolver.js";
import { MemorySequenceResolver } from "./sequence-resolvers/memory-sequence-resolver.js";
import { defaultSnowflakeConfig, type SnowflakeConfig } from "./snowflake-config.js";
import { SEQUENTIAL_IDENTIFIER_TOKEN } from "./tokens.js";
import { Snowflake } from "./snowflake.js";

/**
 * Applies `snowflake` config to the static `Snowflake` generator on first
 * `id()` call, so `Snowflake.configureSignature()` can still run from a
 * provider's `register()` (before any ID is generated), matching
 * php-snowflake's `SnowflakeGenerator`.
 */
export class SnowflakeGenerator {
  protected booted = false;

  constructor(protected app: Application) {}

  async id(group: string): Promise<bigint> {
    this.boot();

    return Snowflake.id(group);
  }

  boot(): void {
    if (this.booted) {
      return;
    }

    this.booted = true;

    const config = this.app.config.get<SnowflakeConfig>("snowflake") ?? defaultSnowflakeConfig();

    if (config.testing) {
      const resolver = this.app.has(SEQUENTIAL_IDENTIFIER_TOKEN)
        ? this.app.make<SequentialIdentifierResolver>(SEQUENTIAL_IDENTIFIER_TOKEN)
        : new SequentialIdentifierResolver();
      Snowflake.identifierResolver(resolver);
    }

    if (config.sequencing.resolver === "cache") {
      const manager = this.app.make<CacheManager>(CACHE_TOKEN);
      Snowflake.sequenceResolver(
        new CacheSequenceResolver(manager.store(config.sequencing.store), config.sequencing.prefix),
      );
    } else if (config.sequencing.resolver === "file") {
      Snowflake.sequenceResolver(
        new FileSequenceResolver(config.sequencing.file ?? "storage/snowflake-sequence.json"),
      );
    } else if (config.sequencing.resolver === "memory") {
      Snowflake.sequenceResolver(new MemorySequenceResolver());
    }

    Snowflake.configure(config.constants.epoch, config.constants.cluster, config.constants.worker);
  }
}
