export { SharpImageDriver, frameCount, isAnimated } from "./sharp-image-driver.js";
export type { SharpConfig } from "./sharp-image-driver.js";

export { MediaSharpServiceProvider } from "./media-sharp-service-provider.js";

export { AnimatedImageError } from "./errors.js";

// The escape hatch, plus the handful of named transformations worth
// shipping: things libvips does well that the five generic ops cannot
// express. Driver-specific by construction — see `sharpModifier`.
export { sharpModifier, blur, extend, grayscale, sharpen, tint, trim } from "./sharp-modifier.js";
export type { SharpTransform } from "./sharp-modifier.js";

// Exported for an application that wants to reach sharp through the same
// optional-peer load this driver uses, rather than importing it directly
// and hard-coding the dependency.
export { loadSharp } from "./sharp-loader.js";
export type { SharpModule, SharpPipeline } from "./sharp-loader.js";
