import { app } from "@mahiframework/core";
import type { KeyStrategy, KeyStrategyContext } from "@mahiframework/database";
import { SnowflakeGenerator } from "./snowflake-generator.js";
import { SNOWFLAKE_TOKEN } from "./tokens.js";

/**
 * A `KeyStrategy` that assigns a Snowflake ID on create when the primary
 * key is missing, the redesign replacement for the old `HasSnowflake`
 * `Model.use()` extension. Pass it as a model's `keyType`:
 *
 *   interface WidgetAttributes { id: bigint; name: string; }
 *
 *   class Widget extends Model<WidgetAttributes>()({
 *     table: "widgets",
 *     primaryKey: "id",
 *     keyType: snowflake(),
 *   }) {}
 *
 *   const row = await Widget.create({ name: "Sprocket" });
 *   row.id; // 9348975348573485734n
 *
 * The key is a 64-bit integer, so the column must be a `bigInteger()`
 * primary key, never an auto-increment one. Declare the attribute as
 * `bigint` to match; the model config rejects a `string` or `number`
 * primary key against this strategy.
 *
 * An explicit `id` on the insert payload always wins. The per-model
 * sequence group is the model's class name (`context.modelName`),
 * matching the old `newUniqueId()`'s `this.name`.
 */
export function snowflake(): KeyStrategy<bigint> {
  return {
    type: "bigint",
    generate(context: KeyStrategyContext): Promise<bigint> {
      return nextSnowflakeId(context.modelName);
    },
  };
}

async function nextSnowflakeId(group: string): Promise<bigint> {
  return app().make<SnowflakeGenerator>(SNOWFLAKE_TOKEN).id(group);
}
