import type { SocialiteToken, SocialiteUser } from "../socialite-user.js";

/**
 * A `SocialiteUser` for tests, so an app can exercise its callback
 * controller without an OAuth round trip.
 *
 * A free function rather than Socialite's `Two\User::fake()` static,
 * because `SocialiteUser` is an interface and an interface carries no
 * statics — and because this is where test helpers live in this repo.
 *
 *   Socialite.swap({ driver: () => ({ user: async () => fakeSocialiteUser({ email: "a@b.test" }) }) });
 */
export function fakeSocialiteUser<TRaw = Record<string, unknown>>(
  overrides: Partial<SocialiteUser<TRaw>> = {},
): SocialiteUser<TRaw> {
  const token: SocialiteToken = {
    token: "fake-token",
    refreshToken: "fake-refresh-token",
    expiresIn: 3600,
    approvedScopes: [],
    ...overrides.token,
  };

  return {
    id: "123456789",
    nickname: "testuser",
    name: "Test User",
    email: "test@example.com",
    avatar: "https://example.com/avatar.jpg",
    raw: (overrides.raw ?? {}) as TRaw,
    ...overrides,
    token,
  };
}
