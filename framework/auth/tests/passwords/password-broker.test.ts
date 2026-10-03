import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@mahiframework/database";
import { Hasher } from "@mahiframework/encryption";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { DatabaseUserProvider } from "../../src/providers/database-user-provider.js";
import { PasswordBroker } from "../../src/passwords/password-broker.js";
import { PasswordResetToken } from "../../src/passwords/password-reset-token.model.js";

interface UserAttributes {
  id: string;
  email: string;
  password: string;
  deleted_at: string | null;
}

type UserTable = UserAttributes;

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
}) {}

describe("PasswordBroker", () => {
  let database: TestDatabase;
  let hasher: Hasher;
  let provider: DatabaseUserProvider<UserTable>;
  let broker: PasswordBroker<UserTable>;

  beforeEach(async () => {
    database = await createTestDatabase();
    hasher = new Hasher();
    provider = new DatabaseUserProvider<UserTable>({ model: User }, hasher);
    broker = new PasswordBroker<UserTable>(provider, hasher);

    await User.create({
      id: "alice",
      email: "alice@example.com",
      password: await hasher.make("old-password"),
      deleted_at: null,
    });
  });

  afterEach(() => database.cleanup());

  describe("sendResetLink", () => {
    it("mints a token and stores its hash (never the plaintext)", async () => {
      const result = await broker.sendResetLink("alice@example.com");

      expect(result.status).toBe("sent");
      const token = result.status === "sent" ? result.token : undefined;
      expect(token).toBeTypeOf("string");

      const row = await PasswordResetToken.find("alice@example.com");
      expect(row).toBeDefined();
      expect(row!.token).not.toBe(token);
      expect(await hasher.check(token!, row!.token)).toBe(true);
    });

    it("returns 'sent' with NO token and writes no row for an unknown email", async () => {
      const result = await broker.sendResetLink("nobody@example.com");

      expect(result).toEqual({ status: "sent", email: "nobody@example.com" });
      await expect(PasswordResetToken.find("nobody@example.com")).resolves.toBeUndefined();
    });

    it("overwrites a previous token so only one reset is live per email", async () => {
      const unthrottled = new PasswordBroker<UserTable>(provider, hasher, { throttleSeconds: 0 });
      await unthrottled.sendResetLink("alice@example.com");
      await unthrottled.sendResetLink("alice@example.com");

      const rows = await PasswordResetToken.query().where("email", "alice@example.com").get();
      expect(rows).toHaveLength(1);
    });

    it("survives two concurrent requests for the same email", async () => {
      // The old delete-then-insert pair let both requests delete and then
      // both insert, and the second insert violated the primary key, a
      // 500 on a password-reset form, reachable by double-clicking.
      const unthrottled = new PasswordBroker<UserTable>(provider, hasher, { throttleSeconds: 0 });

      const results = await Promise.all([
        unthrottled.sendResetLink("alice@example.com"),
        unthrottled.sendResetLink("alice@example.com"),
      ]);

      expect(results.every((result) => result.status === "sent")).toBe(true);
      const rows = await PasswordResetToken.query().where("email", "alice@example.com").get();
      expect(rows).toHaveLength(1);
    });

    describe("throttling", () => {
      // Per-MAILBOX, distinct from the per-client `throttle()` middleware:
      // an attacker rotating IPs to flood a victim's inbox defeats the
      // latter and not this.
      it("refuses a second link within the window", async () => {
        await broker.sendResetLink("alice@example.com");
        await expect(broker.sendResetLink("alice@example.com")).resolves.toEqual({
          status: "throttled",
        });
      });

      it("allows another once the window passes", async () => {
        await broker.sendResetLink("alice@example.com");

        vi.useFakeTimers();
        try {
          vi.setSystemTime(Date.now() + 61_000);
          const again = await broker.sendResetLink("alice@example.com");
          expect(again.status).toBe("sent");
        } finally {
          vi.useRealTimers();
        }
      });

      it("never throttles an unknown address, so it can't be used to enumerate", async () => {
        await broker.sendResetLink("nobody@example.com");
        await expect(broker.sendResetLink("nobody@example.com")).resolves.toEqual({
          status: "sent",
          email: "nobody@example.com",
        });
      });

      it("can be disabled", async () => {
        const open = new PasswordBroker<UserTable>(provider, hasher, { throttleSeconds: 0 });
        await open.sendResetLink("alice@example.com");
        await expect(open.sendResetLink("alice@example.com")).resolves.toMatchObject({
          status: "sent",
        });
      });
    });
  });

  describe("reset", () => {
    async function issue(): Promise<string> {
      const result = await broker.sendResetLink("alice@example.com");

      if (result.status !== "sent" || result.token === undefined) {
        throw new Error("no token");
      }

      return result.token;
    }

    it("changes the password and consumes the token on success", async () => {
      const token = await issue();

      const result = await broker.reset("alice@example.com", token, "new-password");
      expect(result).toEqual({ status: "reset" });

      const user = (await provider.retrieveById("alice"))!;
      expect(await provider.validateCredentials(user, { password: "new-password" })).toBe(true);
      expect(await provider.validateCredentials(user, { password: "old-password" })).toBe(false);

      // Single use.
      await expect(PasswordResetToken.find("alice@example.com")).resolves.toBeUndefined();
    });

    it("rejects a wrong token and leaves the stored row intact", async () => {
      await issue();

      const result = await broker.reset("alice@example.com", "wrong-token", "new-password");
      expect(result).toEqual({ status: "invalid-token" });
      await expect(PasswordResetToken.find("alice@example.com")).resolves.toBeDefined();
    });

    it("rejects when no token exists for the email", async () => {
      const result = await broker.reset("alice@example.com", "anything", "new-password");
      expect(result).toEqual({ status: "invalid-token" });
    });

    it("hashes on the no-token path so timing doesn't leak pending resets", async () => {
      // Otherwise "no pending reset" returns instantly while "wrong
      // token" pays for an argon2 verify (~50-100ms at 64 MiB), a
      // timing oracle, and an unthrottled way to make the server burn
      // CPU.
      const spy = vi.spyOn(hasher, "make");

      await broker.reset("alice@example.com", "anything", "new-password");

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    describe("revocation", () => {
      // Password reset is the account-RECOVERY path: the thing a user
      // does because they believe they're compromised. Leaving the
      // attacker's session and API tokens alive defeats the exercise,
      // and a "remember me" session runs to ~400 days.
      it("destroys every session and token for the user", async () => {
        const destroyForUser = vi.fn(async () => {});
        const revokeAllTokens = vi.fn(async () => {});
        broker.revokesWith({
          sessions: { destroyForUser },
          tokens: { revokeAllTokens },
        });

        const token = await issue();
        await expect(broker.reset("alice@example.com", token, "new-password")).resolves.toEqual({
          status: "reset",
        });

        // The reason rides along so the CurrentDeviceLogout/TokenRevoked
        // events a reset triggers are distinguishable from a user-
        // requested "sign out everywhere". An audit log reporting a reset
        // as a voluntary mass logout describes something that didn't
        // happen.
        expect(destroyForUser).toHaveBeenCalledWith("alice", "password_reset");
        expect(revokeAllTokens).toHaveBeenCalledWith("alice", "password_reset");
      });

      it("revokes nothing when the reset fails", async () => {
        const destroyForUser = vi.fn(async () => {});
        broker.revokesWith({ sessions: { destroyForUser } });

        await issue();
        await broker.reset("alice@example.com", "wrong-token", "new-password");

        expect(destroyForUser).not.toHaveBeenCalled();
      });

      it("still completes the reset when a store cannot revoke by user", async () => {
        // CacheSessionStore throws by design. The password has already
        // changed by this point, so failing the request would tell the
        // user their reset didn't work when it did.
        broker.revokesWith({
          sessions: {
            destroyForUser: async () => {
              throw new Error("cache stores cannot revoke by user");
            },
          },
        });

        const token = await issue();
        await expect(broker.reset("alice@example.com", token, "new-password")).resolves.toEqual({
          status: "reset",
        });
      });

      it("notifies listeners after a successful reset", async () => {
        const listener = vi.fn();
        broker.onPasswordReset(listener);

        const token = await issue();
        await broker.reset("alice@example.com", token, "new-password");

        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ email: "alice@example.com" }),
        );
      });
    });

    it("rejects and deletes an expired token", async () => {
      const shortBroker = new PasswordBroker<UserTable>(provider, hasher, { expiresInMinutes: 60 });
      const result = await shortBroker.sendResetLink("alice@example.com");
      const token = result.status === "sent" ? result.token! : "";

      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61 * 60_000);
        const reset = await shortBroker.reset("alice@example.com", token, "new-password");
        expect(reset).toEqual({ status: "expired-token" });
      } finally {
        vi.useRealTimers();
      }

      await expect(PasswordResetToken.find("alice@example.com")).resolves.toBeUndefined();
    });
  });

  describe("gc", () => {
    it("removes only expired tokens", async () => {
      const shortBroker = new PasswordBroker<UserTable>(provider, hasher, { expiresInMinutes: 60 });
      await shortBroker.sendResetLink("alice@example.com");

      await expect(shortBroker.gc()).resolves.toBe(0);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61 * 60_000);
        await expect(shortBroker.gc()).resolves.toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("throws if the provider cannot update passwords", async () => {
    const readOnly = {
      retrieveById: async () => ({ id: "alice" }) as UserTable,
      retrieveByCredentials: async () => ({ id: "alice" }) as UserTable,
      validateCredentials: async () => true,
    };
    const roBroker = new PasswordBroker<UserTable>(readOnly, hasher);

    const send = await roBroker.sendResetLink("alice@example.com");
    const token = send.status === "sent" ? send.token! : "";

    await expect(roBroker.reset("alice@example.com", token, "x")).rejects.toThrow(
      /does not support updatePassword/,
    );
  });
});
