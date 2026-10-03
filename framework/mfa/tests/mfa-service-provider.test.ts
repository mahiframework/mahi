import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, AUTH_TOKEN, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { ENCRYPTER_TOKEN, HASHER_TOKEN, SIGNER_TOKEN } from "@mahiframework/encryption";
import type { HttpPipe, Request as HttpRequest, ResponseInput } from "@mahiframework/http";
import { MfaServiceProvider } from "../src/mfa-service-provider.js";
import { MfaManager } from "../src/mfa-manager.js";
import { MFA_TOKEN } from "../src/tokens.js";
import { TotpDriver } from "../src/drivers/totp-driver.js";
import { EmailDriver } from "../src/drivers/email-driver.js";
import { RecoveryDriver } from "../src/drivers/recovery-driver.js";
import { MfaGcCommand } from "../src/commands/mfa-gc.js";
import { currentMfaState } from "../src/mfa-context.js";
import { testEncrypter, testHasher, testSigner } from "./__fixtures__/test-database.js";

/**
 * `HttpPipe` is a union of a function and a `{ handle }` object, so a
 * collected pipe is not directly callable. The provider only ever
 * returns the function form; this narrows once rather than casting at
 * every call site, and fails loudly if that ever changes.
 */
function asFn(
  pipe: HttpPipe | undefined,
): (request: HttpRequest, next: (request: HttpRequest) => Promise<ResponseInput>) => unknown {
  if (typeof pipe !== "function") {
    throw new Error("expected the provider to contribute a function pipe");
  }

  return pipe;
}

describe("MfaServiceProvider", () => {
  let app: Application;

  /** The tokens the provider's factories resolve, and nothing more. */
  function boot(config: Record<string, unknown> = { drivers: ["totp", "email", "recovery"] }) {
    app = new Application();
    app.config.set("mfa", config);
    app.instance(ENCRYPTER_TOKEN, testEncrypter());
    app.instance(HASHER_TOKEN, testHasher());
    app.instance(SIGNER_TOKEN, testSigner());
    app.instance(AUTH_TOKEN, {
      userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
      guard: () => ({ sessionId: () => "session-from-guard" }),
      getDefaultDriver: () => "web",
    });
    setCurrentApp(app);

    const provider = new MfaServiceProvider(app);
    provider.register();

    return provider;
  }

  beforeEach(() => {
    boot();
  });

  afterEach(() => clearCurrentApp());

  it("binds MFA_TOKEN to an MfaManager", () => {
    expect(app.make(MFA_TOKEN)).toBeInstanceOf(MfaManager);
  });

  it("binds it as a singleton", () => {
    expect(app.make(MFA_TOKEN)).toBe(app.make(MFA_TOKEN));
  });

  it("registers all three built-in drivers", () => {
    const manager = app.make<MfaManager>(MFA_TOKEN);

    expect(manager.use("totp")).toBeInstanceOf(TotpDriver);
    expect(manager.use("email")).toBeInstanceOf(EmailDriver);
    expect(manager.use("recovery")).toBeInstanceOf(RecoveryDriver);
  });

  it("registers drivers the app has not listed, but does not expose them", () => {
    // Registration is cheap and unconditional; `config.drivers` is the
    // switch. Without the second half, enabling a factor would be a
    // provider edit rather than a config change.
    boot({ drivers: ["totp"] });
    const manager = app.make<MfaManager>(MFA_TOKEN);

    expect(manager.use("totp")).toBeInstanceOf(TotpDriver);
    expect(() => manager.use("email")).toThrow(/not registered/);
  });

  it("does not construct a driver until it is resolved", () => {
    // Lazy, so an app listing the provider but never touching MFA pays
    // nothing, and no key material is read at boot.
    const manager = app.make<MfaManager>(MFA_TOKEN);

    expect(manager.isResolved("totp")).toBe(false);

    manager.use("totp");

    expect(manager.isResolved("totp")).toBe(true);
  });

  it("contributes four migrations with stable names", () => {
    const names = boot()
      .migrationSources()
      .map((source) => source.name);

    expect(names).toEqual([
      "0001_create_mfa_methods_table",
      "0002_create_mfa_intents_table",
      "0003_create_mfa_challenges_table",
      "0004_create_mfa_recovery_codes_table",
    ]);
  });

  it("contributes the mfa:gc command", () => {
    expect(boot().commands()).toEqual([MfaGcCommand]);
  });

  describe("middleware", () => {
    it("opens an MFA scope carrying the request and the derived binding", async () => {
      const [pipe] = boot().middleware();
      const request = {} as never;
      let seen: ReturnType<typeof currentMfaState> = null;

      await asFn(pipe)(request, async () => {
        seen = currentMfaState();

        return new Response("ok");
      });

      expect(seen).not.toBeNull();
      expect(seen!.binding).toBe("session-from-guard");
      expect(seen!.request).toBe(request);
    });

    it("degrades to a null binding when the guard exposes none", async () => {
      boot();
      app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
        guard: () => ({}),
        getDefaultDriver: () => "web",
      });

      const [pipe] = new MfaServiceProvider(app).middleware();
      let binding: string | null | undefined;

      await asFn(pipe)({} as never, async () => {
        binding = currentMfaState()!.binding;

        return new Response("ok");
      });

      expect(binding).toBeNull();
    });

    it("does not fail the request when the binding cannot be derived at all", async () => {
      // A guard that throws is a misconfiguration, but it must not take
      // down every request; MFA degrades to user-only matching.
      boot();
      app.instance(AUTH_TOKEN, {
        userProvider: () => ({ retrieveById: async (id: string) => ({ id }) }),
        guard: () => {
          throw new Error("boom");
        },
        getDefaultDriver: () => "web",
      });

      const [pipe] = new MfaServiceProvider(app).middleware();
      const response = (await asFn(pipe)({} as never, async () => new Response("ok"))) as Response;

      expect(response.status).toBe(200);
    });
  });

  it("fails loudly when config/mfa.ts is missing", () => {
    const bare = new Application();
    bare.instance(ENCRYPTER_TOKEN, testEncrypter());
    setCurrentApp(bare);
    new MfaServiceProvider(bare).register();

    // `config.require()`, not `get()`: a missing MFA config is a
    // misconfiguration, and defaulting it would silently disable every
    // guard in the app.
    expect(() => bare.make(MFA_TOKEN)).toThrow();
  });
});
