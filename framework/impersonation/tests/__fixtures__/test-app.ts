import { Application, CACHE_TOKEN, setCurrentApp } from "@mahiframework/core";
import { HASHER_TOKEN, Hasher, SIGNER_TOKEN, Signer } from "@mahiframework/encryption";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  Model,
  SCHEMA_TOKEN,
  Schema,
  SqliteDriver,
} from "@mahiframework/database";
import {
  AuthServiceProvider,
  authenticate,
  AUTH_TOKEN,
  type AuthManager,
} from "@mahiframework/auth";
import { HttpKernel, HttpResponse, type Request, type Router } from "@mahiframework/http";
import { ImpersonationServiceProvider } from "../../src/impersonation-service-provider.js";
import { IMPERSONATION_TOKEN } from "../../src/tokens.js";
import type { ImpersonationManager } from "../../src/impersonation-manager.js";
import type { ImpersonationConfig } from "../../src/impersonation-config.js";
import createImpersonationsTable from "../../src/migrations/0001_create_impersonations_table.js";

export interface UserAttributes {
  id: string;
  email: string;
  password: string;
  superadmin: number;
}

/** Stand-in for the app-owned `User` model. */
export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
}) {}

/**
 * Adds the routes the suites drive, on top of the real provider, so route
 * registration itself is exercised rather than stubbed.
 *
 * `/login` stands in for the app's own login endpoint; everything after it
 * goes through the package's real start/stop routes where the config
 * enables them.
 */
class HarnessProvider extends ImpersonationServiceProvider {
  override routes(router: Router): void {
    super.routes(router);

    router.post("/login", async (request: Request) => {
      const auth = this.app.make<AuthManager>(AUTH_TOKEN);
      await auth.login(request, String(request.input("id")), {
        remember: request.input("remember") === true,
      });

      return HttpResponse.json({ ok: true });
    });

    router
      .get("/me", async (request: Request) => {
        const impersonation = this.app.make<ImpersonationManager>(IMPERSONATION_TOKEN);
        const record = await impersonation.current(request);

        return HttpResponse.json({
          user: request.user() ?? null,
          impersonating: record !== null,
          depth: record?.depth ?? 0,
          impersonator: (await impersonation.impersonator<UserAttributes>(request))?.id ?? null,
          root: (await impersonation.rootImpersonator<UserAttributes>(request))?.id ?? null,
        });
      })
      .middleware(authenticate("session"));
  }
}

export interface Harness {
  app: Application;
  kernel: HttpKernel;
  impersonation: ImpersonationManager;
  auth: AuthManager;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface HarnessOptions {
  impersonation?: ImpersonationConfig;
  /** Minutes an ordinary session lasts. Default 120. */
  lifetimeMinutes?: number;
  /** Minutes a remembered session lasts. Default 400 days. */
  rememberMinutes?: number;
  /** Extra providers, registered after the impersonation provider. */
  withEvents?: boolean;
}

/**
 * Boot a real container: sqlite, a real `AuthServiceProvider` resolving a
 * real `SessionGuard` through config, and the impersonation provider.
 *
 * Framework-package style, no `@mahiframework/testing` dependency.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const app = new Application();
  setCurrentApp(app);

  const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
  database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, database);
  app.bind(SCHEMA_TOKEN, () => database.schema());

  app.instance(HASHER_TOKEN, new Hasher());
  app.instance(SIGNER_TOKEN, new Signer(Buffer.alloc(32, 7)));
  app.instance(CACHE_TOKEN, { store: () => ({}) });

  app.config.set("auth", {
    default: "session",
    guards: {
      session: {
        driver: "session",
        provider: "users",
        store: "database",
        cookie: "session",
        lifetimeMinutes: options.lifetimeMinutes ?? 120,
        ...(options.rememberMinutes === undefined
          ? {}
          : { rememberMinutes: options.rememberMinutes }),
        // Plain HTTP in tests, as in local development.
        secure: false,
      },
    },
    providers: { users: { driver: "database", model: User } },
  });

  if (options.impersonation !== undefined) {
    app.config.set("impersonation", options.impersonation);
  }

  // The `sessions` table, created here rather than imported from
  // `@mahiframework/auth`: that package exports only its barrel, so its
  // migration module isn't reachable, and duplicating four columns is
  // cheaper than widening its public surface for a test.
  await Schema.create("sessions", (table) => {
    table.string("id").primary();
    table.string("user_id").index();
    table.timestamp("expires_at").index();
    table.timestamp("created_at");
    table.timestamp("last_active_at");
  });

  await createImpersonationsTable.up();

  await Schema.create("users", (table) => {
    table.string("id").primary();
    table.string("email").unique();
    table.string("password");
    table.integer("superadmin").default(0);
  });

  const auth = new AuthServiceProvider(app);
  const impersonationProvider = new HarnessProvider(app);

  // `getProviders()` is what the kernel walks to collect `routes()`.
  (app as unknown as { providers: unknown[] }).providers = [auth, impersonationProvider];
  auth.register();
  impersonationProvider.register();

  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();

  return {
    app,
    kernel,
    auth: app.make<AuthManager>(AUTH_TOKEN),
    impersonation: app.make<ImpersonationManager>(IMPERSONATION_TOKEN),
    request: async (path, init) => kernel.raw().request(path, init),
  };
}

export async function makeUser(id: string, superadmin = false): Promise<UserAttributes> {
  await User.create({
    id,
    email: `${id}@example.com`,
    password: "x",
    superadmin: superadmin ? 1 : 0,
  });

  return { id, email: `${id}@example.com`, password: "x", superadmin: superadmin ? 1 : 0 };
}

/**
 * Run `action` and return the error it threw.
 *
 * Preferable to `.catch((e) => e as T)`, which types as `void | T` because
 * the success path contributes `void`, and then needs a cast at every
 * property access.
 */
export async function captureError<T = Error>(action: Promise<unknown>): Promise<T> {
  try {
    await action;
  } catch (error) {
    return error as T;
  }

  throw new Error("Expected the action to throw, but it resolved.");
}

/** Pull one cookie's value out of a `Set-Cookie` response header. */
export function cookieFrom(response: Response, name = "session"): string | null {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);

    if (match?.[1] !== undefined) {
      return decodeURIComponent(match[1]);
    }
  }

  return null;
}

export function maxAgeFrom(response: Response, name = "session"): number | null {
  const header = response.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
  const match = header === undefined ? null : /Max-Age=(\d+)/.exec(header);

  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * A tiny cookie-jarred client, so a suite can drive login → start → stop
 * the way a browser would. The point of the end-to-end tests is that the
 * cookie actually round-trips, so the jar must be real.
 */
export class Client {
  private cookie: string | null = null;

  constructor(private readonly harness: Harness) {}

  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);

    if (this.cookie !== null) {
      headers.set("Cookie", `session=${this.cookie}`);
    }

    const response = await this.harness.request(path, { ...init, headers });
    const issued = cookieFrom(response);

    if (issued !== null) {
      this.cookie = issued;
    }

    return response;
  }

  json(path: string, init: RequestInit = {}): Promise<Response> {
    return this.send(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }
}
