# Multi-factor authentication

`@mahiframework/mfa` answers *"has this user recently proved a second
factor?"*. It ships TOTP, emailed one-time codes and recovery codes, and
the driver seam third-party factors plug into.

```ts
import { requireMfa } from "@mahiframework/mfa";

await requireMfa();                    // any recent verification
await requireMfa("change_password");   // verified FOR THIS ACTION
```

Not installed by default. An app adds it:

```bash
npm install @mahiframework/mfa
```

...then lists the provider in `config/app.ts` **after**
`AuthServiceProvider` and **before** `HttpServiceProvider`:

```ts
AuthServiceProvider,
MfaServiceProvider,     // ← here
AuthorizationServiceProvider,
// ...
HttpServiceProvider,
```

Both constraints are real. `MfaServiceProvider.register()` resolves
`AUTH_TOKEN`, and its per-request pipe has to be collected before routes
are. Get the second one wrong and every `requireMfa()` throws
`MissingMfaContextError` naming that exact cause, rather than failing
silently.

This is the *step-up* layer. [Authentication](../authentication/) answers
"who is this", [Authorization](../authorization/) answers "may they do
this", and MFA answers "did they prove it was really them, recently".

## Configuration

`config/mfa.ts` returns an `MfaConfig`:

```ts
import type { MfaConfig } from "@mahiframework/mfa";

export function mfaConfig(): MfaConfig {
  return {
    // Which factors users may choose, in preference order. Listing a
    // driver here is what makes it available.
    drivers: ["totp", "recovery"],

    intentExpiresInMinutes: 10,        // time to COMPLETE a challenge
    verificationExpiresInMinutes: 15,  // how long the proof stays good
    maxAttempts: 5,
    whenUnenrolled: "deny",
    bindToSession: true,

    totp: { issuer: "Acme", digits: 6, period: 30, window: 1 },
    email: { expiresInMinutes: 10, throttleSeconds: 60 },
    recovery: { count: 8 },
  };
}
```

`email` is deliberately absent from that `drivers` list. It is a
*weaker* factor than TOTP — mailbox compromise is the common
account-takeover vector — so treating it as equivalent should be an
explicit choice, not a default.

### The two expiry windows

They answer different questions and neither can do both:

| | Bounds | Set when |
| --- | --- | --- |
| `intentExpiresInMinutes` | How long the user has to **complete** the challenge | Intent creation |
| `verificationExpiresInMinutes` | How long the **proof** authorizes actions (the sudo window) | Verification |

The second is set at verification rather than creation on purpose: a
user who took nine minutes to find their phone should still get the full
sudo window, and one who verified instantly should not get extra.

## Guarding an action

Three surfaces, and which to reach for is a real decision.

### Route middleware, for a whole endpoint

```ts
import { authenticate } from "@mahiframework/auth";
import { ensureMfa } from "@mahiframework/mfa";

router
  .post("/account/password", UpdatePasswordController)
  .middleware(authenticate(), ensureMfa("change_password"));
```

**Prefer this** where the check applies to the whole route. Two reasons:
the guard is visible in the route table, which is worth real money when
auditing what protects an endpoint; and a pipe cannot be mis-awaited.

Place it *after* `authenticate()`, since it reads the user that
middleware resolves into the ambient auth scope.

### Inline, for a conditional check

```ts
import { requireMfa, mfaVerified } from "@mahiframework/mfa";

async handle(request: Request) {
  if (request.input("amount") > 10_000) {
    await requireMfa("billing.payout");
  }
  // ...
}
```

`mfaVerified()` is the non-throwing counterpart, for rendering UI:

```ts
return HttpResponse.json({
  requiresVerification: !(await mfaVerified("billing.payout")),
});
```

> ### ⚠️ `requireMfa()` must be awaited
>
> It returns a promise, so a forgotten `await` does not fail — the
> rejection never reaches the handler and **execution continues past an
> unverified check**. That is an auth bypass.
>
> ```ts
> requireMfa("change_password");        // ❌ floats; guards nothing
> await requireMfa("change_password");  // ✅
> ```
>
> This repo enables `@typescript-eslint/no-floating-promises` for exactly
> this class of bug. Keep it on in your app, or prefer `ensureMfa()`.

### The facade

`Mfa` groups the whole API, and is what enrollment and verification
endpoints use:

```ts
import { Mfa } from "@mahiframework/mfa";

await Mfa.available(userId);            // ["totp", "recovery"]
await Mfa.createIntent({ userId, purpose: "change_password" });
await Mfa.challenge(intent, "email");
await Mfa.verify(intent, code);
```

## Purposes

A `purpose` scopes a verification to what it was for. The matching rule
is **asymmetric**:

- `requireMfa()` — satisfied by **any** live verified intent, whatever
  purpose it carries.
- `requireMfa("change_password")` — satisfied **only** by an intent whose
  purpose is exactly `change_password`.

So specific rolls *up* to generic, and generic does not roll *down* to
specific.

That asymmetry is the point. Rolling specific up is safe: the user proved
a factor more recently and more deliberately than a bare check asks for,
so re-prompting is friction with no security gain. Rolling generic down
is not safe: it is exactly the case `requireMfa("billing.payout")` exists
to prevent, where a routine step-up at login silently authorizes a payout
an hour later.

Omit purposes entirely and you get one global sudo window, which is
Laravel's password-confirmation behaviour. Add them where an action is
sensitive enough to deserve its own.

## Users who have not enrolled

`whenUnenrolled` decides what happens when a guarded action is reached by
someone with nothing enrolled:

| | Behaviour | Use when |
| --- | --- | --- |
| `"deny"` *(default)* | 403 | Enrollment is mandatory and enforced elsewhere |
| `"challenge"` | 403 with `mfa_enrollment_required` | Progressive rollout; route them to enrollment |
| `"allow"` | Passes | MFA is genuinely optional |

Overridable per call:

```ts
await requireMfa("billing.payout", { whenUnenrolled: "challenge" });
```

> **`"allow"` is partly attacker-reachable.** A user who can delete their
> own enrollment *without* passing MFA downgrades themselves to
> unenrolled and bypasses every `allow` check. **Guard enrollment
> mutation itself**, resolved against the enrollment state as it was
> before the mutation.

Note that `mfaVerified()` does **not** apply this policy. It answers the
question asked — "did they verify?" — so a UI reading it never shows a
padlock for a user who was merely waved through.

## Error payloads

Every denial is an `HttpError` subclass carrying a machine-readable
`details`, so a client can drive a method picker rather than printing a
string:

| Condition | Status | `details.code` | Payload |
| --- | --- | --- | --- |
| Not authenticated | 401 | — | — |
| Enrolled, unverified | 403 | `mfa_required` | `purpose`, `available` |
| Verified, different purpose | 403 | `mfa_required` | `purpose`, `available` |
| Unenrolled, `"challenge"` | 403 | `mfa_enrollment_required` | `purpose`, `enrollable` |
| Intent locked | 403 | `mfa_locked` | `purpose` |

```json
{
  "message": "Multi-factor verification is required.",
  "details": { "code": "mfa_required", "purpose": "billing.payout", "available": ["totp", "email"] }
}
```

Row three only arises for a *named* purpose; a generic check is satisfied
by any verified intent. When it does, the client should say "verify again
for this action" rather than "you are not verified", which is why
`purpose` is on the payload.

## The drivers

### `totp`

RFC 6238, hand-rolled on `node:crypto` — no dependency. Enrollment is
**two steps**:

```ts
const totp = Mfa.use("totp") as TotpDriver;

// 1. Mint a secret. Writes an UNCONFIRMED row; the user is not yet enrolled.
const { methodId, secret, uri } = await totp.enroll(userId, user.email);
// Render `uri` as a QR code, show `secret` for manual entry.

// 2. Prove a code before it counts.
const ok = await totp.confirm(userId, methodId, submittedCode);
```

The second step is not ceremony. Without it, a user whose authenticator
scanned a stale QR has a method that can never produce a valid code — and
under `whenUnenrolled: "deny"` that locks them out of an account the
broken enrollment appears to protect.

The secret is stored AES-GCM encrypted (not hashed — verification must
recompute the code), with the user id bound in as AAD so a row moved
between users fails to decrypt rather than silently working.

QR rendering is **not** included. `uri` is a string; encode it with
whatever your client already has.

**Replay defense.** A TOTP code is valid for its whole period, so the
driver records the accepted time step and refuses to reuse it. Without
that, one captured code is replayable for up to three periods — a
90-second bearer token rather than a second factor. This means a
successful TOTP verify performs a write.

`algorithm` defaults to `SHA1` and should usually stay there: Google
Authenticator and others assume SHA1 regardless of what the URI says, so
enrolling with SHA-256 produces an app whose codes the server will never
accept, with no diagnostic.

### `email`

Piggybacks the user's email column (configurable via `email.column`).
Enrollment is **implicit** — a user with an address needs no setup.

The code is **minted and returned, never sent**. This package has no mail
dependency; delivery is yours:

```ts
const result = await Mfa.challenge(intent, "email");

if (result.status === "issued") {
  try {
    await Mail.send(new MfaCodeMail(address, result.code, result.expiresAt));
  } catch (error) {
    // Delete the challenge so a failed send doesn't start the throttle
    // window and lock the user out over your own outage.
    await MfaChallenge.delete(/* ... */);
    throw error;
  }
}
```

> **Never `Mail.queue()` a code.** A queued message is written to `jobs`
> in plaintext, and to `failed_jobs` indefinitely if delivery fails. To
> defer, queue a job carrying the **user id** that mints the code inside
> `handle()` and sends immediately. See [Mail](../mail/).

`throttleSeconds` is per-**mailbox** and complements the per-IP
`throttle()` middleware on the route rather than replacing it: an
attacker rotating IPs to flood one inbox defeats the middleware and not
this.

**The magic link is off by default.** `email: { link: true }` adds a
click-through URL. A code must be typed back into the session that
requested it, so it proves possession of the mailbox *and* the session; a
link is clickable from anywhere, so a phished click yields a verified
intent and the session binding cannot hold. Turn it on knowing that.

### `recovery`

Single-use codes, the way back in when the phone is gone:

```ts
const codes = await (Mfa.use("recovery") as RecoveryDriver).generate(userId);
// Show these ONCE. Only hashes are stored afterwards.
```

Hashed with SHA-256 rather than argon2: a 20-byte random code has no
low-entropy keyspace for a slow hash to protect. Regenerating replaces
the whole set, used or not.

## Session binding

By default a verification is bound to the session or token that performed
it, so a second concurrent session for the same user cannot consume a
verification it never performed.

The binding is capability-probed off the active guard —
`SessionGuard.sessionId()` or `TokenGuard.currentTokenId()` — rather than
looked up by guard name, because guards are named by the app. A guard
exposing neither yields no binding, and matching degrades to user-only
rather than failing.

Set `bindToSession: false` to turn it off, which is occasionally what you
want (a desktop client completing a step-up begun on mobile) and usually
not.

## Writing a driver

```ts
import type { MfaDriver } from "@mahiframework/mfa";

export class SmsDriver implements MfaDriver {
  readonly name = "sms";

  async enrolled(userId: string): Promise<boolean> { /* ... */ }
  async challenge(context): Promise<ChallengeResult> { /* ... */ }
  async verify(context): Promise<VerifyResult> { /* ... */ }
}
```

Register it from a provider listed after `MfaServiceProvider`, and add
its name to `config.drivers`:

```ts
this.app.make<MfaManager>(MFA_TOKEN).extend("sms", () => new SmsDriver(/* ... */));
```

Drivers are **stateless singletons** shared across every concurrent
request, so never memoize per-attempt state on one. Everything arrives in
the context argument.

Run the shipped contract against it. A driver can satisfy the TypeScript
interface and still break every guarantee that matters — that a wrong
code *returns* `invalid-code` rather than throwing, that a code is
single-use:

```ts
import { mfaDriverContract } from "@mahiframework/mfa";

for (const testCase of mfaDriverContract({ /* ... */ })) {
  it(testCase.name, () => testCase.run());
}
```

All three built-ins pass the same cases, which is what stops them
drifting into subtly different factors behind one interface.

## Garbage collection

Every read path enforces expiry, so a stale row is never honoured — but
nothing deletes them either. Schedule the sweep:

```ts
schedule.command("mfa:gc").daily();
```

## Gotchas

- **`requireMfa()` must be awaited.** A floating call guards nothing.
- **Provider order matters.** After `AuthServiceProvider`, before
  `HttpServiceProvider`.
- **TOTP enrollment is two steps.** `enroll()` alone leaves the user
  unenrolled.
- **Generic does not satisfy a named purpose.** Deliberate; see above.
- **`Mfa.challenge()` returns the code, it does not send it.** Delivery
  is the app's.
- **Never queue a rendered code email.** Queue the intent, mint in the
  worker.
- **`mfaVerified()` ignores `whenUnenrolled`.** It reports verification,
  not permission.
- **Recovery codes are shown once.** There is no way to read them back.
