import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENGINES, EngineHarness, engineAvailable } from "../support/drivers.js";
import { Model } from "../../src/model.js";
import { morphToMany, morphedByMany } from "../../src/relations.js";
import type { MorphToMany, MorphedByMany } from "../../src/markers.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * Polymorphic many-to-many writes on every engine, the last of X8's named
 * gaps, together with `detach([])`.
 *
 * `morph-to-many.test.ts` covers the behaviour thoroughly but hardcodes
 * SQLite, and a shared polymorphic pivot is exactly where engines diverge:
 * every read and write carries an extra discriminant predicate, so a
 * missing `taggable_type` filter returns another model's rows rather than
 * erroring. On SQLite the ids are usually text and collide rarely; on
 * MySQL/Postgres with integer keys, post 1 and video 1 share a key value
 * and a dropped discriminant silently crosses them.
 *
 * `detach([])` is here because it is the sharpest failure mode in the
 * whole relationship-write surface: "detach nothing" and "detach
 * everything" differ by one early return (`deletePivotRows`), and
 * confusing them destroys data silently rather than erroring. It is
 * asserted per engine because it is a guard, and a guard that only exists
 * on the engine you develop against is not a guard.
 */
for (const engine of ENGINES) {
  const available = await engineAvailable(engine);
  const suite = available ? describe : describe.skip;

  suite(`morph pivots (${engine.name})`, () => {
    let h: EngineHarness;

    interface TagAttributes {
      id: number;
      name: string;
      posts: MorphedByMany<Post>;
      videos: MorphedByMany<Video>;
    }

    interface PostAttributes {
      id: number;
      title: string;
      tags: MorphToMany<Tag>;
      tagsWithPivot: MorphToMany<Tag>;
    }

    interface VideoAttributes {
      id: number;
      url: string;
      tags: MorphToMany<Tag>;
    }

    class Tag extends Model<TagAttributes>()({
      table: "morph_tags",
      primaryKey: "id",
      timestamps: false,
    }) {
      static override relationships = {
        posts: morphedByMany(() => Post, {
          pivotTable: "morph_taggables",
          morphType: "taggable_type",
          morphId: "taggable_id",
          foreignPivotKey: "tag_id",
          type: "post",
        }),
        videos: morphedByMany(() => Video, {
          pivotTable: "morph_taggables",
          morphType: "taggable_type",
          morphId: "taggable_id",
          foreignPivotKey: "tag_id",
          type: "video",
        }),
      };
    }

    class Post extends Model<PostAttributes>()({
      table: "morph_posts",
      primaryKey: "id",
      timestamps: false,
    }) {
      static override relationships = {
        tags: morphToMany(() => Tag, {
          pivotTable: "morph_taggables",
          morphType: "taggable_type",
          morphId: "taggable_id",
          relatedPivotKey: "tag_id",
          type: "post",
        }),
        tagsWithPivot: morphToMany(() => Tag, {
          pivotTable: "morph_taggables",
          morphType: "taggable_type",
          morphId: "taggable_id",
          relatedPivotKey: "tag_id",
          type: "post",
          withPivot: ["weight"],
        }),
      };
    }

    class Video extends Model<VideoAttributes>()({
      table: "morph_videos",
      primaryKey: "id",
      timestamps: false,
    }) {
      static override relationships = {
        tags: morphToMany(() => Tag, {
          pivotTable: "morph_taggables",
          morphType: "taggable_type",
          morphId: "taggable_id",
          relatedPivotKey: "tag_id",
          type: "video",
        }),
      };
    }

    beforeAll(async () => {
      h = await EngineHarness.start(engine, "morph-pivots");

      await h.create("morph_tags", (t: Blueprint) => {
        t.increments("id");
        t.string("name");
      });
      await h.create("morph_posts", (t: Blueprint) => {
        t.increments("id");
        t.string("title");
      });
      await h.create("morph_videos", (t: Blueprint) => {
        t.increments("id");
        t.string("url");
      });
      await h.create("morph_taggables", (t: Blueprint) => {
        t.increments("id");
        t.unsignedBigInteger("tag_id");
        t.string("taggable_type");
        t.unsignedBigInteger("taggable_id");
        t.integer("weight").nullable();
      });
    });

    afterEach(async () => {
      await h.truncate();
    });

    afterAll(async () => {
      await h?.stop();
    });

    /** A post, a video and two tags, with ids that deliberately collide. */
    async function seed() {
      const post = await Post.create({ title: "Post" } as never);
      const video = await Video.create({ url: "https://example.com/v" } as never);
      const red = await Tag.create({ name: "red" } as never);
      const blue = await Tag.create({ name: "blue" } as never);

      return { post, video, red, blue };
    }

    it("keeps two owners' pivot rows apart when their keys collide", async () => {
      // The reason the discriminant exists. With `increments()` on separate
      // tables, the first post and the first video both get id 1, so a
      // query that forgets `taggable_type` returns the other's tags and
      // looks perfectly healthy.
      const { post, video, red, blue } = await seed();

      expect(post.id).toBe(video.id);

      await (post as any).relations.tags().attach([red.id]);
      await (video as any).relations.tags().attach([blue.id]);

      const postTags = (await (post as any).relations.tags().get()).toArray();
      const videoTags = (await (video as any).relations.tags().get()).toArray();

      expect(postTags.map((t: any) => t.name)).toEqual(["red"]);
      expect(videoTags.map((t: any) => t.name)).toEqual(["blue"]);
    });

    it("detaches only the matching morph type", async () => {
      const { post, video, red } = await seed();

      await (post as any).relations.tags().attach([red.id]);
      await (video as any).relations.tags().attach([red.id]);

      const removed = await (post as any).relations.tags().detach([red.id]);

      expect(removed).toBe(1);
      expect((await (post as any).relations.tags().get()).toArray()).toHaveLength(0);
      // The video keeps its row, same tag, same key, different type.
      expect((await (video as any).relations.tags().get()).toArray()).toHaveLength(1);
    });

    it("reads the same pivot back through morphedByMany", async () => {
      const { post, video, red } = await seed();

      await (post as any).relations.tags().attach([red.id]);
      await (video as any).relations.tags().attach([red.id]);

      const tagged = await Tag.find(red.id);
      const posts = (await (tagged as any).relations.posts().get()).toArray();
      const videos = (await (tagged as any).relations.videos().get()).toArray();

      expect(posts).toHaveLength(1);
      expect(videos).toHaveLength(1);
      expect(posts[0].title).toBe("Post");
      expect(videos[0].url).toBe("https://example.com/v");
    });

    it("syncs within one morph type without touching another", async () => {
      const { post, video, red, blue } = await seed();

      await (post as any).relations.tags().attach([red.id]);
      await (video as any).relations.tags().attach([red.id, blue.id]);

      await (post as any).relations.tags().sync([blue.id]);

      expect(
        (await (post as any).relations.tags().get()).toArray().map((t: any) => t.name),
      ).toEqual(["blue"]);
      // The video's two rows are untouched.
      expect((await (video as any).relations.tags().get()).toArray()).toHaveLength(2);
    });

    it("toggles within one morph type", async () => {
      const { post, video, red, blue } = await seed();

      await (post as any).relations.tags().attach([red.id]);
      await (video as any).relations.tags().attach([red.id]);

      const result = await (post as any).relations.tags().toggle([red.id, blue.id]);

      // Both sides through `Number`: an auto-increment key is a `bigint`
      // (it is 64-bit on every engine), and `toggle()` echoes back the
      // ids it was handed, so this compares values rather than types.
      expect(result.detached.map(Number)).toEqual([red.id].map(Number));
      expect(result.attached.map(Number)).toEqual([blue.id].map(Number));
      expect((await (video as any).relations.tags().get()).toArray()).toHaveLength(1);
    });

    it("carries pivot columns on a morph pivot", async () => {
      const { post, red } = await seed();

      await (post as any).relations.tagsWithPivot().attach([red.id], { weight: 7 });

      const tags = (await (post as any).relations.tagsWithPivot().get()).toArray();

      expect(tags).toHaveLength(1);
      expect(Number(tags[0].pivot.weight)).toBe(7);
    });

    it("updateExistingPivot() scopes to the morph type", async () => {
      const { post, video, red } = await seed();

      await (post as any).relations.tagsWithPivot().attach([red.id], { weight: 1 });
      await (video as any).relations.tags().attach([red.id]);

      const updated = await (post as any).relations
        .tagsWithPivot()
        .updateExistingPivot(red.id, { weight: 9 });

      expect(updated).toBe(1);

      const tags = (await (post as any).relations.tagsWithPivot().get()).toArray();
      expect(Number(tags[0].pivot.weight)).toBe(9);
    });

    describe("detach([]) is not detach-all", () => {
      it("removes nothing when given an empty array", async () => {
        // One early return in `deletePivotRows` separates "detach nothing"
        // from "detach everything". If it regressed, this silently wipes
        // the pivot table, no error, no failing write, just missing rows
        // discovered later.
        const { post, red, blue } = await seed();

        await (post as any).relations.tags().attach([red.id, blue.id]);

        const removed = await (post as any).relations.tags().detach([]);

        expect(removed).toBe(0);
        expect((await (post as any).relations.tags().get()).toArray()).toHaveLength(2);
      });

      it("removes everything when given no argument at all", async () => {
        // The other side of the same distinction: `undefined` DOES mean
        // all. Asserted alongside so the pair cannot drift into agreeing.
        const { post, red, blue } = await seed();

        await (post as any).relations.tags().attach([red.id, blue.id]);

        const removed = await (post as any).relations.tags().detach();

        expect(removed).toBe(2);
        expect((await (post as any).relations.tags().get()).toArray()).toHaveLength(0);
      });

      it("leaves another owner's rows alone when detaching all", async () => {
        const { post, video, red } = await seed();

        await (post as any).relations.tags().attach([red.id]);
        await (video as any).relations.tags().attach([red.id]);

        await (post as any).relations.tags().detach();

        expect((await (video as any).relations.tags().get()).toArray()).toHaveLength(1);
      });
    });
  });
}
