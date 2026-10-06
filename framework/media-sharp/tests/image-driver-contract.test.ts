import { describe, expect, it } from "vitest";
import { imageDriverContract } from "@mahiframework/media";
import { SharpImageDriver } from "../src/sharp-image-driver.js";
import { png } from "./__fixtures__/images.js";

/**
 * The contract from `@mahiframework/media`, run against real encoded
 * images. Three lines of wiring, which is the entire point of shipping
 * it: `FakeImageDriver` passes the same cases, so the fake and this
 * driver are held to one set of guarantees rather than drifting into two
 * abstractions behind one interface.
 *
 * No `unsupported` list — this driver implements all five ops, so the
 * contract's honest-failure cases do not apply here. `supports()` is
 * still a membership test rather than `() => true`, so an op added to
 * `media` tomorrow reports false until implemented.
 */
describe("imageDriverContract against SharpImageDriver", () => {
  const cases = imageDriverContract(() => new SharpImageDriver(), {
    image: () => png(1000, 800),
    width: 1000,
    height: 800,
    // `avif` beyond the default three: it is the format whose quality
    // scale differs most, so an encoder misconfiguration shows up here.
    formats: ["png", "jpg", "webp", "avif"],
  });

  it("ships a non-trivial number of cases", () => {
    // A contract that silently generated nothing would pass vacuously.
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const testCase of cases) {
    it(testCase.name, () => testCase.run());
  }
});
