import { z } from "zod";

/**
 * The app's environment contract. `loadEnv()` validates `process.env`
 * against this at boot and fails fast with every problem listed at once,
 * rather than surfacing an `undefined` deep inside a request weeks later.
 *
 * Add your own keys here as the app grows. A key that isn't in this
 * schema isn't on the typed `Env` object, which is the point.
 */
/**
 * A boolean env var, parsed the way people actually write them.
 *
 * NOT `z.coerce.boolean()`, which is `Boolean(value)`. That makes the
 * string `"false"` come out `true`, so `FLAG=false` would silently enable
 * the thing it was meant to disable.
 */
const boolish = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true" || value === "1");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8000),
  APP_URL: z.string().default("http://localhost:8000"),

  /** Which configured connection to use (`sqlite` | `mysql` | `pgsql`). */
  DB_CONNECTION: z.enum(["sqlite", "mysql", "pgsql"]).default("sqlite"),

  /** SQLite: path relative to the app root, resolved against `process.cwd()`. */
  DB_FILENAME: z.string().default("database/database.sqlite"),

  /** MySQL / PostgreSQL connection details (unused when DB_CONNECTION=sqlite). */
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().optional(),
  DB_DATABASE: z.string().default("mahi"),
  DB_USERNAME: z.string().optional(),
  DB_PASSWORD: z.string().optional(),

  /** Which cache store `Cache` uses by default (`array` | `file` | `redis`). */
  CACHE_STORE: z.enum(["array", "file", "redis"]).default("array"),

  /** Which queue connection dispatches use (`sync` | `database` | `redis`). */
  QUEUE_CONNECTION: z.enum(["sync", "database", "redis"]).default("sync"),

  /** Comma-separated list of origins allowed to call this API. */
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  /**
   * Comma-separated proxy addresses or CIDR blocks whose
   * `X-Forwarded-*` headers this app will believe, the load balancer,
   * ingress controller, or CDN directly in front of it.
   *
   * Leave it EMPTY when nothing is in front (the default). `request.ip()`
   * is then the socket peer, which is correct.
   *
   * Set it when you deploy behind a proxy, or the app sees the proxy's
   * address as every client's: rate limits become global, and
   * `X-Forwarded-Proto` is ignored, so `secure()` is false and every
   * generated link (password reset, email verification) goes out as
   * `http://`.
   *
   * `*` trusts whatever opened the socket. Correct only when the app is
   * genuinely unreachable except through a proxy that OVERWRITES
   * `X-Forwarded-For`, most managed load balancers on a private
   * network. On a directly reachable host it means no trust boundary at
   * all. Prefer the actual CIDR (`10.0.0.0/8`) when you know it.
   */
  TRUSTED_PROXIES: z.string().default(""),

  /**
   * Comma-separated hostnames this app will answer on. Leave empty to
   * derive it from `APP_URL`; set to `*` to disable host checking.
   *
   * The `Host` header is client-supplied and the URL generator prefers
   * the live request's host, so without this an attacker sends
   * `Host: evil.example` to "forgot password" and the victim receives a
   * genuine, valid signed link pointing at the attacker's server.
   */
  TRUSTED_HOSTS: z.string().default(""),

  /** Max request body size in bytes for JSON/urlencoded. Default 1 MiB. */
  BODY_LIMIT_BYTES: z.coerce.number().optional(),

  /** Max request body size in bytes for multipart uploads. Default 10 MiB. */
  BODY_LIMIT_MULTIPART_BYTES: z.coerce.number().optional(),

  /**
   * Send as `X-Health-Secret` to see real failure messages from
   * `GET /health` in production. Optional: without it, messages there are
   * always redacted to "Check failed". Which is the safe default, since
   * the endpoint is usually reachable from wherever probes it.
   */
  HEALTH_SECRET: z.string().optional(),

  /**
   * Set by `./artisan key:generate`. Optional here (not `.default()`) so a
   * missing key fails loudly inside `EncryptionServiceProvider` with an
   * actionable message instead of silently encrypting under a fixed key.
   */
  APP_KEY: z.string().optional(),
  APP_PREVIOUS_KEYS: z.string().optional(),

  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  /**
   * Whether the scaffolded auth controllers send their emails. Off hands
   * delivery back to you without deleting the controller. See
   * `config/auth.ts`'s `notifications`.
   */
  AUTH_SEND_RESET_EMAIL: boolish(true),
  AUTH_SEND_VERIFY_EMAIL: boolish(true),

  MAIL_MAILER: z.string().default("log"),
  MAIL_FROM_ADDRESS: z.string().default("hello@example.com"),
  MAIL_FROM_NAME: z.string().default("Mahi"),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /**
   * Refuse to send unless the connection is encrypted.
   *
   * Defaults to off so a local MailHog/Mailpit on 1025 works out of the
   * box. Turn it on for any real relay: without it, STARTTLS is merely
   * opportunistic and a server that stops offering it downgrades you to
   * plaintext silently.
   */
  SMTP_REQUIRE_TLS: boolish(false),
});

export type Env = z.infer<typeof envSchema>;
