/**
 * Loads `.env` (via dotenv) and validates `process.env` against a Zod
 * schema supplied by the application. Fails fast (throws) on boot if
 * required variables are missing or malformed, rather than surfacing
 * cryptic errors deep inside the app later.
 */

import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import type { z } from "zod";

// `z.ZodType` without type arguments, which is what Zod 4 asks for here:
// `ZodTypeAny` still exists but only in Zod's `compat` module, marked
// `@deprecated Use z.ZodType (without generics) instead`.
export interface LoadEnvOptions<TSchema extends z.ZodType> {
  schema: TSchema;
  /** Path to the base .env file. Defaults to ".env" in the current working directory. */
  path?: string;
  /**
   * The active environment name, used to load `.env.{environment}` (e.g.
   * `.env.production`) on top of the base file. Defaults to
   * `APP_ENV ?? NODE_ENV`.
   */
  environment?: string;
}

export function loadEnv<TSchema extends z.ZodType>(
  options: LoadEnvOptions<TSchema>,
): z.infer<TSchema> {
  const path = options.path ?? ".env";
  const environment = options.environment ?? process.env.APP_ENV ?? process.env.NODE_ENV;

  // Load in increasing order of specificity, each overriding the last, so a
  // machine-/environment-specific file wins over the shared base:
  //   .env  ->  .env.local  ->  .env.{environment}  ->  .env.{environment}.local
  // (`.env.local` is skipped under a `test` environment, matching the
  // dotenv/Vite convention where local overrides must not perturb tests.)
  const candidates = [path];

  if (environment !== "test") {
    candidates.push(`${path}.local`);
  }

  if (environment) {
    candidates.push(`${path}.${environment}`, `${path}.${environment}.local`);
  }

  // Variables set in the REAL environment (shell, CI, Docker, the
  // orchestrator injecting a secret) must win over every committed file.
  // That is the whole point of 12-factor config. So the files override each
  // other but never a key that was already present before we started. We
  // snapshot those keys up front and let dotenv `override` freely, then
  // restore the real values afterwards.
  const realEnvValues = new Map<string, string>();

  for (const key of Object.keys(process.env)) {
    const value = process.env[key];

    if (value !== undefined) {
      realEnvValues.set(key, value);
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override: true });
    }
  }

  for (const [key, value] of realEnvValues) {
    process.env[key] = value;
  }

  const result = options.schema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
