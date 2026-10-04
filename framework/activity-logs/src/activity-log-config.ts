/** The two shipped `type` values. An app may use any other string. */
export const RESOURCE_TYPE = "resource";
export const SECURITY_TYPE = "security";

/** How much of a model to record. */
export type CaptureMode = "none" | "columns" | "full";

/** The CRUD actions a tracked model can produce. */
export type ResourceAction = "created" | "updated" | "deleted" | "soft_deleted" | "restored";

export const RESOURCE_ACTIONS: readonly ResourceAction[] = [
  "created",
  "updated",
  "deleted",
  "soft_deleted",
  "restored",
];

export interface ResourceCapture {
  /** Default `"columns"`: names without values is the safe default. */
  capture?: CaptureMode;
  /** Which actions to record. Defaults to all five. */
  actions?: ResourceAction[];
  /** Attribute names to mask, on top of the model's own `hidden`. */
  mask?: string[];
  /** Only consider these attributes. Applied before masking. */
  only?: string[];
  /** Ignore these attributes. Applied before masking. */
  except?: string[];
}

export interface SecurityConfig {
  /** Default true. */
  enabled?: boolean;
  /** Which actions to record, or `"all"` (the default). */
  actions?: string[] | "all";
  /**
   * The user model's morph alias, used as `model_type` on security rows.
   * Defaults to `"User"`, which is what `create-mahi`'s template sets.
   */
  userType?: string;
  /** The attribute holding a user's key. Defaults to `"id"`. */
  userKey?: string;
  /**
   * The column holding a user's email address, watched for the
   * `email_changed` action. Defaults to `"email"`, matching
   * `PasswordBroker`'s configurable `identifierColumn`.
   */
  emailColumn?: string;
}

export interface ActivityLogConfig {
  /** Master switch. `false` and nothing is ever written. */
  enabled?: boolean;
  /**
   * Which models produce `resource` rows, keyed by MORPH ALIAS (the
   * string `Model.morphAlias()` returns), not by class.
   *
   * Keyed by string because a `config/*.ts` file is loaded before
   * `app.bootstrap()` and importing a model there pulls the ORM into
   * config-load time. It is also the same token the row stores, so the
   * listener's lookup is one property read on a string it already has.
   *
   * The cost is that a typo is silent. `activity-logs:check` exists to
   * catch it.
   */
  resources?: Record<string, ResourceCapture | CaptureMode>;
  security?: SecurityConfig;
  /** Attribute names masked everywhere, on top of each model's `hidden`. */
  mask?: string[];
  /** Replacement for a masked value. */
  maskWith?: string;
  /** Hard cap on serialised `data`, in bytes. */
  maxDataBytes?: number;
  /** Hard cap on `message`, in characters. */
  maxMessageLength?: number;
  /**
   * Ambient data merged into `data.context`, or `false` to disable.
   *
   * A thunk rather than a value because it is read per row. The default
   * reads `ip`, `user_agent` and `impersonator_id` out of `Context`, which
   * this package's own pipe seeds per request. Replace it to carry a
   * tenant, a trace id, or anything else.
   */
  context?: (() => Record<string, unknown> | undefined) | false;
  /**
   * Fail the operation when a log write fails. Default `false`.
   *
   * Off by default because an audit row is important but not more
   * important than the thing it audits: a listener that throws fails the
   * `save()` that dispatched it. Turn it on only under a regime where an
   * unloggable action genuinely must not proceed.
   */
  throwOnFailure?: boolean;
  /** Database connection for the `activity_logs` table. Defaults to the app's. */
  connection?: string;
}

/** A `ResourceCapture` with every option resolved. */
export interface ResolvedResource {
  capture: CaptureMode;
  actions: ReadonlySet<ResourceAction>;
  mask: ReadonlySet<string>;
  only: ReadonlySet<string> | null;
  except: ReadonlySet<string>;
}

/** An `ActivityLogConfig` with every option resolved. */
export interface ResolvedConfig {
  enabled: boolean;
  resources: Map<string, ResolvedResource>;
  security: {
    enabled: boolean;
    actions: ReadonlySet<string> | "all";
    userType: string;
    userKey: string;
    emailColumn: string;
  };
  mask: ReadonlySet<string>;
  maskWith: string;
  maxDataBytes: number;
  maxMessageLength: number;
  context: (() => Record<string, unknown> | undefined) | null;
  throwOnFailure: boolean;
  connection: string | undefined;
}

export const DEFAULT_MASK = ["password", "password_confirmation", "secret", "token"];

/**
 * Normalise a config block once, at provider boot.
 *
 * Resolved up front rather than per event so the hot path reads a struct
 * of `Set`s instead of re-deriving defaults and re-scanning arrays on
 * every model write.
 *
 * Masking is case-insensitive throughout: every name is lowercased here
 * and compared lowercased later, so a `Password` column is masked by a
 * `password` rule. A security filter that a capitalisation defeats is not
 * a security filter.
 */
export function resolveConfig(config: ActivityLogConfig = {}): ResolvedConfig {
  const resources = new Map<string, ResolvedResource>();

  for (const [alias, entry] of Object.entries(config.resources ?? {})) {
    resources.set(alias, resolveResource(entry));
  }

  const security = config.security ?? {};

  return {
    enabled: config.enabled ?? true,
    resources,
    security: {
      enabled: security.enabled ?? true,
      actions:
        security.actions === undefined || security.actions === "all"
          ? "all"
          : new Set(security.actions),
      userType: security.userType ?? "User",
      userKey: security.userKey ?? "id",
      emailColumn: security.emailColumn ?? "email",
    },
    mask: lowercased(config.mask ?? DEFAULT_MASK),
    maskWith: config.maskWith ?? "[masked]",
    maxDataBytes: config.maxDataBytes ?? 64 * 1024,
    maxMessageLength: config.maxMessageLength ?? 255,
    context: config.context === false ? null : (config.context ?? null),
    throwOnFailure: config.throwOnFailure ?? false,
    connection: config.connection,
  };
}

/**
 * A bare string is shorthand for `{ capture: mode }`, because
 * `Post: "full"` is the common case and `Post: { capture: "full" }` is
 * noise.
 */
function resolveResource(entry: ResourceCapture | CaptureMode): ResolvedResource {
  const resource: ResourceCapture = typeof entry === "string" ? { capture: entry } : entry;

  return {
    // "columns" rather than "full": recording which fields moved is
    // useful and safe, recording their values is useful and not, so the
    // dangerous one should be the deliberate choice.
    capture: resource.capture ?? "columns",
    actions: new Set(resource.actions ?? RESOURCE_ACTIONS),
    mask: lowercased(resource.mask ?? []),
    only: resource.only === undefined ? null : lowercased(resource.only),
    except: lowercased(resource.except ?? []),
  };
}

function lowercased(names: string[]): ReadonlySet<string> {
  return new Set(names.map((name) => name.toLowerCase()));
}
