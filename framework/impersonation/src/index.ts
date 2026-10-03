export { ImpersonationManager } from "./impersonation-manager.js";
export type {
  ImpersonationGate,
  ImpersonationHook,
  StartImpersonationOptions,
} from "./impersonation-manager.js";

export {
  ImpersonationServiceProvider,
  IMPERSONATION_TOKEN,
} from "./impersonation-service-provider.js";
export { Impersonation } from "./impersonation-facade.js";

export type { ImpersonationConfig, ImpersonationRoutesConfig } from "./impersonation-config.js";

export { ImpersonationDeniedError, ImpersonatorMissingError } from "./errors.js";
export type { ImpersonationDenialReason } from "./errors.js";

export { ImpersonationStarted, ImpersonationFinished } from "./impersonation-events.js";

export { ImpersonationLink } from "./models/impersonation-link.js";
export type { ImpersonationRecord } from "./models/impersonation-link.js";

export { StartImpersonationController } from "./http/start-impersonation.controller.js";
export { StopImpersonationController } from "./http/stop-impersonation.controller.js";

export { ImpersonationGcCommand } from "./commands/impersonation-gc.js";
