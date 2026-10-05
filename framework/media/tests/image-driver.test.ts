import { describe, expect, it } from "vitest";
import { Application } from "@mahiframework/core";
import { FakeImageDriver, scaleDown } from "../src/image/fake-image-driver.js";
import { ImageManager } from "../src/image/image-manager.js";
import { imageDriverContract } from "../src/image/testing/image-driver-contract.js";
import { NoImageDriverError } from "../src/errors.js";
import * as bytes from "./__fixtures__/bytes.js";

describe("imageDriverContract against FakeImageDriver", () => {
  // The fake has to pass the same contract a real driver does, otherwise
  // every modifier test above is written against behaviour no real
  // driver is held to. This is what keeps the fake honest.
  const cases = imageDriverContract(() => new FakeImageDriver(1000, 800), {
    image: () => bytes.PNG,
    width: 1000,
    height: 800,
    formats: ["png", "jpg", "webp"],
  });

  it("ships a non-trivial number of cases", () => {
    // A contract that silently generated nothing would pass vacuously.
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const testCase of cases) {
    it(testCase.name, () => testCase.run());
  }
});

describe("imageDriverContract with unsupported ops", () => {
  // A driver that cannot do everything is legitimate; one that pretends
  // to is not. Declaring `unsupported` swaps the behavioural assertions
  // for honesty assertions.
  const cases = imageDriverContract(() => new FakeImageDriver(400, 300).without("rotate"), {
    image: () => bytes.PNG,
    width: 400,
    height: 300,
    unsupported: ["rotate"],
  });

  for (const testCase of cases) {
    it(testCase.name, () => testCase.run());
  }
});

describe("the contract catches a dishonest driver", () => {
  it("fails a driver whose supports() disagrees with apply()", async () => {
    // The failure mode the contract exists for: `supports()` says yes,
    // `apply()` quietly does nothing.
    const lying = new FakeImageDriver(100, 100).without("crop");

    const cases = imageDriverContract(() => lying, {
      image: () => bytes.PNG,
      width: 100,
      height: 100,
      // Not declared as unsupported, so the contract expects it to work.
    });

    const honesty = cases.find((entry) => entry.name.includes("agrees with itself"));

    await expect(honesty?.run()).rejects.toThrow(/supports\("crop"\) returned false/);
  });

  it("fails a driver that enlarges on scaleDown", async () => {
    class Enlarging extends FakeImageDriver {
      override async apply(
        image: Parameters<FakeImageDriver["apply"]>[0],
        op: Parameters<FakeImageDriver["apply"]>[1],
      ) {
        if (op.type === "scaleDown") {
          // A plain resize rather than a scale-down, which is the most
          // likely way a real driver gets this wrong.
          return super.apply(image, { type: "crop", width: 4000, height: 3200, x: 0, y: 0 });
        }

        return super.apply(image, op);
      }
    }

    const cases = imageDriverContract(() => new Enlarging(1000, 800), {
      image: () => bytes.PNG,
      width: 1000,
      height: 800,
    });

    const noEnlarge = cases.find((entry) => entry.name.includes("never enlarges"));

    await expect(noEnlarge?.run()).rejects.toThrow(/enlarged the image/);
  });
});

describe("scaleDown geometry", () => {
  it.each([
    [1000, 800, 500, undefined, 500, 400],
    [1000, 800, undefined, 400, 500, 400],
    [1000, 800, 500, 500, 500, 400],
    [200, 200, 4000, 4000, 200, 200],
    [1000, 1000, 1, 1, 1, 1],
  ])(
    "%ix%i bounded by %sx%s gives %ix%i",
    (width, height, maxWidth, maxHeight, wantWidth, wantHeight) => {
      expect(scaleDown(width, height, maxWidth, maxHeight)).toEqual({
        width: wantWidth,
        height: wantHeight,
      });
    },
  );

  it("never rounds a dimension to zero", () => {
    // A 1-pixel-tall result is useless but valid; a 0-pixel one is an
    // invalid image every encoder rejects.
    expect(scaleDown(1000, 10, 5, undefined).height).toBe(1);
  });
});

describe("FakeImageDriver", () => {
  it("refuses a handle from another driver", async () => {
    // Handles are opaque AND driver-specific. No type can catch a
    // foreign one, so the driver must — guessing would corrupt state.
    const driver = new FakeImageDriver();

    await expect(driver.dimensions({ __image: "from somewhere else" })).rejects.toThrow(
      /handle it did not create/,
    );
  });

  it("throws on bytes that are not an image", async () => {
    await expect(new FakeImageDriver().read(new Uint8Array())).rejects.toThrow();
    await expect(new FakeImageDriver().read(bytes.PDF)).rejects.toThrow(/application\/pdf/);
  });

  it("records encode calls for assertion", async () => {
    const driver = new FakeImageDriver();
    const image = await driver.read(bytes.PNG);

    await driver.encode(image, { format: "webp", quality: 70 });

    expect(driver.encoded).toEqual([{ format: "webp", quality: 70 }]);
  });

  it("resets its recordings", async () => {
    const driver = new FakeImageDriver();
    const image = await driver.read(bytes.PNG);

    await driver.apply(image, { type: "rotate", degrees: 90 });
    driver.reset();

    expect(driver.applied).toEqual([]);
    driver.assertNotApplied("rotate");
  });

  it("fails its own assertions honestly", async () => {
    const driver = new FakeImageDriver();

    expect(() => driver.assertApplied("crop")).toThrow(/was applied/);

    const image = await driver.read(bytes.PNG);
    await driver.apply(image, { type: "crop", width: 1, height: 1, x: 0, y: 0 });

    expect(() => driver.assertNotApplied("crop")).toThrow(/no "crop" op/);
    expect(() => driver.assertSequence(["rotate"])).toThrow(/op sequence/);
  });
});

describe("ImageManager", () => {
  it("throws an actionable error when no driver is configured", () => {
    const manager = new ImageManager(new Application(), null);

    expect(() => manager.getDefaultDriver()).toThrow(NoImageDriverError);
    expect(manager.configured()).toBe(false);
  });

  it("reports configured only once the named driver is registered", () => {
    // Config naming a driver whose package was never installed is a
    // real misconfiguration, and `configured()` must not claim
    // otherwise.
    const manager = new ImageManager(new Application(), "sharp");

    expect(manager.configured()).toBe(false);

    manager.extend("sharp", () => new FakeImageDriver());

    expect(manager.configured()).toBe(true);
  });

  it("resolves the configured driver", () => {
    const manager = new ImageManager(new Application(), "fake");
    const driver = new FakeImageDriver();

    manager.extend("fake", () => driver);

    expect(manager.driver()).toBe(driver);
  });

  it("caches the resolved driver", () => {
    const manager = new ImageManager(new Application(), "fake");
    let built = 0;

    manager.extend("fake", () => {
      built += 1;

      return new FakeImageDriver();
    });

    manager.driver();
    manager.driver();

    expect(built).toBe(1);
  });
});
