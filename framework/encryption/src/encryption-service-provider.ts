import { ServiceProvider, SIGNER_TOKEN } from "@mahiframework/core";
import { Encrypter } from "./encrypter.js";
import { Hasher, type HasherOptions } from "./hasher.js";
import { Signer } from "./signer.js";
import { deriveKey, parseAppKey, parsePreviousAppKeys } from "./app-key.js";
import { KeyGenerateCommand } from "./commands/key-generate.js";

export const ENCRYPTER_TOKEN = "encrypter";
export const HASHER_TOKEN = "hasher";

// Canonical definition in `@mahiframework/core`'s `well-known-tokens`
// (resolved cross-package by `http`, `storage` and `broadcasting`);
// re-exported so this package's public API is unchanged.
export { SIGNER_TOKEN };

type EncryptionEnv = { APP_KEY: string | undefined; APP_PREVIOUS_KEYS?: string };

/**
 * Registers `Encrypter`, `Hasher`, and `Signer` singletons. `Encrypter`
 * and `Signer` each get their own key, HKDF-derived from the single
 * `APP_KEY` env var (see `app-key.ts`) rather than sharing the raw key
 * directly, a compromised signing key doesn't also expose encrypted
 * data. No ordering dependency on any other provider.
 *
 * If `APP_PREVIOUS_KEYS` is set (comma-separated, same format as
 * `APP_KEY`), each previous key is HKDF-derived the same way and passed
 * to `Encrypter`/`Signer` as decrypt/verify-only fallbacks. See
 * `key:generate --force` and each class's own docstring for the key
 * rotation model.
 */
export class EncryptionServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(ENCRYPTER_TOKEN, (app) => {
      const env = app.make<EncryptionEnv>("env");
      const masterKey = parseAppKey(env.APP_KEY);
      const previousMasterKeys = parsePreviousAppKeys(env.APP_PREVIOUS_KEYS);

      return new Encrypter(
        deriveKey(masterKey, "encryption"),
        previousMasterKeys.map((key) => deriveKey(key, "encryption")),
      );
    });

    // `hashing` config is optional, the base app ships no such file, so
    // an absent namespace yields an empty options object and the Hasher
    // uses argon2's defaults (with argon2id still pinned explicitly).
    this.app.singleton(
      HASHER_TOKEN,
      (app) => new Hasher(app.config.get<HasherOptions>("hashing", {})),
    );

    this.app.singleton(SIGNER_TOKEN, (app) => {
      const env = app.make<EncryptionEnv>("env");
      const masterKey = parseAppKey(env.APP_KEY);
      const previousMasterKeys = parsePreviousAppKeys(env.APP_PREVIOUS_KEYS);

      return new Signer(
        deriveKey(masterKey, "signing"),
        previousMasterKeys.map((key) => deriveKey(key, "signing")),
      );
    });
  }

  commands() {
    return [KeyGenerateCommand];
  }
}
