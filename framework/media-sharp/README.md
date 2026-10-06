# @mahiframework/media-sharp

Media (sharp) — a sharp/libvips image driver for Mahi's media package.

Part of the [Mahi](https://github.com/mahiframework/mahi) framework.

`@mahiframework/media` ships the modifier contracts and no image
library, so an application that stores documents pays for no native
build. This is the package that makes `resizeDown()` and friends
actually do something.

```bash
npm install @mahiframework/media-sharp sharp
```

```ts
// config/app.ts — either side of MediaServiceProvider works
import { MediaSharpServiceProvider } from "@mahiframework/media-sharp";

// config/media.ts
export default {
  image: { default: "sharp" },
  sharp: { limitInputPixels: 50_000_000 },
};
```

`sharp` is an **optional peer dependency** — 19 MB and 25
platform-specific packages — loaded on first use.

Three things worth knowing before you rely on it: a modifier chain costs
one libvips pass per operation rather than one for the chain (the trade
that makes chained geometry correct), animated images are refused rather
than silently flattened, and `sharpModifier()` chains are not portable
to another driver.

See the [documentation](https://github.com/mahiframework/mahi/tree/main/docs/media#the-sharp-driver).
