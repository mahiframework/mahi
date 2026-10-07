import { Application, loadEnv } from "@mahiframework/core";
import { envSchema } from "../config/env.js";
import { databaseConfig } from "../config/database.js";
import { httpConfig } from "../config/http.js";
import { cacheConfig } from "../config/cache.js";
import { storageConfig } from "../config/storage.js";
import { loggingConfig } from "../config/logging.js";
import { queueConfig } from "../config/queue.js";
import { scheduleConfig } from "../config/schedule.js";
import { authConfig } from "../config/auth.js";
import { broadcastingConfig } from "../config/broadcasting.js";
import { redisConfig } from "../config/redis.js";
import { mailConfig } from "../config/mail.js";
import { providers } from "../config/app.js";

/**
 * Builds and boots the application: validate the environment, populate
 * the config repository, register providers, then run the two-stage
 * `register()`/`boot()` lifecycle.
 *
 * Shared by every entrypoint, `bin/console.ts` (the CLI, and therefore
 * `./artisan`), `bin/server.ts` (production HTTP), and the test suite via
 * `createTestApplication(bootstrap)`. Keeping it in one function is what
 * makes a test run against the same wiring as production.
 */
export async function bootstrap(): Promise<Application> {
  const env = loadEnv({ schema: envSchema });

  const app = new Application();
  app.useEnvironment(env.NODE_ENV);
  app.instance("env", env);

  app.config.set("database", databaseConfig(env));
  app.config.set("http", httpConfig(env));
  app.config.set("cache", cacheConfig(env));
  app.config.set("storage", storageConfig());
  app.config.set("logging", loggingConfig());
  app.config.set("queue", queueConfig(env));
  app.config.set("schedule", scheduleConfig());
  app.config.set("auth", authConfig(env));
  app.config.set("broadcasting", broadcastingConfig(env));
  app.config.set("redis", redisConfig(env));
  app.config.set("mail", mailConfig(env));

  for (const providerClass of providers) {
    app.register(providerClass);
  }

  await app.bootstrap();

  return app;
}
