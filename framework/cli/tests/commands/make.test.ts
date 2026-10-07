import { mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application } from "@mahiframework/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MakeModelCommand } from "../../src/commands/make/make-model.js";
import { MakeEventCommand } from "../../src/commands/make/make-event.js";
import { MakeListenerCommand } from "../../src/commands/make/make-listener.js";
import { MakeJobCommand } from "../../src/commands/make/make-job.js";
import { MakeSeederCommand } from "../../src/commands/make/make-seeder.js";
import { MakeFactoryCommand } from "../../src/commands/make/make-factory.js";
import { MakePolicyCommand } from "../../src/commands/make/make-policy.js";
import { MakeResourceCommand } from "../../src/commands/make/make-resource.js";
import { MakeRequestCommand } from "../../src/commands/make/make-request.js";
import { MakeControllerCommand } from "../../src/commands/make/make-controller.js";
import { MakeMiddlewareCommand } from "../../src/commands/make/make-middleware.js";
import { MakeCommandCommand } from "../../src/commands/make/make-command.js";
import { MakeNotificationCommand } from "../../src/commands/make/make-notification.js";
import { MakeMailCommand } from "../../src/commands/make/make-mail.js";
import { MakeTestCommand } from "../../src/commands/make/make-test.js";
import { MakeMigrationCommand } from "../../src/commands/make-migration.js";
import { MakeProviderCommand } from "../../src/commands/make-provider.js";
import { toClassName, FileExistsError } from "../../src/commands/make/scaffold.js";

describe("toClassName()", () => {
  it("studly-cases the name", () => {
    expect(toClassName("create-post")).toBe("CreatePost");
    expect(toClassName("post")).toBe("Post");
  });

  it("appends the suffix unless already present", () => {
    expect(toClassName("post", "Resource")).toBe("PostResource");
    expect(toClassName("post-resource", "Resource")).toBe("PostResource");
    expect(toClassName("PostResource", "Resource")).toBe("PostResource");
  });
});

describe("make:* generators", () => {
  let dir: string;
  const app = new Application();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "make-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function read(file: string): Promise<string> {
    return readFile(path.join(dir, file), "utf8");
  }

  it("make:model writes a model with the right class name and table", async () => {
    await new MakeModelCommand(app).handle("post", { dir });
    const contents = await read("post.model.ts");
    expect(contents).toContain("export class Post extends Model<PostAttributes>()({");
    expect(contents).toContain('table: "posts",');
    expect(contents).toContain('primaryKey: "id",');
    expect(contents).toContain("export interface PostAttributes");
  });

  it("make:model pluralises the table name properly (not naive +s)", async () => {
    await new MakeModelCommand(app).handle("category", { dir });
    const contents = await read("category.model.ts");
    expect(contents).toContain('table: "categories",');
    expect(contents).not.toContain("categorys");
  });

  it("make:model defaults to an auto-increment numeric id", async () => {
    await new MakeModelCommand(app).handle("post", { dir });
    const contents = await read("post.model.ts");
    expect(contents).toContain("id: number;");
    expect(contents).not.toContain("incrementing = false");
    expect(contents).not.toContain("keyType:");
  });

  it("make:model --uuid uses a client-generated string key", async () => {
    await new MakeModelCommand(app).handle("post", { dir, uuid: true });
    const contents = await read("post.model.ts");
    expect(contents).toContain("id: string;");
    expect(contents).toContain('keyType: "uuid",');
    expect(contents).not.toContain("incrementing");
    expect(contents).not.toContain("randomUUID()");
  });

  it("make:model --uuidv7 uses a client-generated time-ordered UUID key", async () => {
    await new MakeModelCommand(app).handle("post", { dir, uuidv7: true });
    const contents = await read("post.model.ts");
    expect(contents).toContain("id: string;");
    expect(contents).toContain('keyType: "uuidv7",');
    expect(contents).not.toContain("incrementing");
  });

  it("make:model rejects both --uuid and --uuidv7", async () => {
    await expect(
      new MakeModelCommand(app).handle("post", { dir, uuid: true, uuidv7: true }),
    ).rejects.toThrow(/only one/);
  });

  it("make:event writes an Event subclass", async () => {
    await new MakeEventCommand(app).handle("post-created", { dir });
    const contents = await read("post-created.event.ts");
    expect(contents).toContain("export class PostCreated extends AbstractEvent");
  });

  it("make:listener writes a Listener implementation that imports AbstractEvent", async () => {
    await new MakeListenerCommand(app).handle("log-post-created", { dir });
    const contents = await read("log-post-created.listener.ts");
    expect(contents).toContain("export class LogPostCreated implements Listener");
    // @mahiframework/events exports `AbstractEvent`, not `Event`; importing the
    // latter would not compile.
    expect(contents).toContain(
      'import type { AbstractEvent, Listener } from "@mahiframework/events";',
    );
    expect(contents).not.toMatch(/import type \{ Event,/);
  });

  it("make:job appends the Job suffix and extends Job", async () => {
    await new MakeJobCommand(app).handle("send-email", { dir });
    const contents = await read("send-email.job.ts");
    expect(contents).toContain("export class SendEmailJob extends Job");
  });

  it("make:seeder appends the Seeder suffix", async () => {
    await new MakeSeederCommand(app).handle("database", { dir });
    const contents = await read("database.ts");
    expect(contents).toContain("export class DatabaseSeeder extends Seeder");
  });

  it("make:factory references the model minus the Factory suffix and never fills id", async () => {
    await new MakeFactoryCommand(app).handle("post", { dir });
    const contents = await read("post-factory.ts");
    expect(contents).toContain("export class PostFactory extends Factory<typeof Post>");
    expect(contents).toContain("protected model = Post;");
    // Filling `id: randomUUID()` would collide with the migration's
    // auto-increment `table.id()` column.
    expect(contents).not.toContain("randomUUID()");
  });

  it("make:policy appends the Policy suffix", async () => {
    await new MakePolicyCommand(app).handle("post", { dir });
    const contents = await read("post.policy.ts");
    expect(contents).toContain("export class PostPolicy extends Policy");
  });

  it("make:resource appends the Resource suffix and a Json interface", async () => {
    await new MakeResourceCommand(app).handle("post", { dir });
    const contents = await read("post.resource.ts");
    expect(contents).toContain("export class PostResource extends Resource");
    expect(contents).toContain("interface PostJson");
  });

  it("make:controller appends the Controller suffix", async () => {
    await new MakeControllerCommand(app).handle("post", { dir });
    const contents = await read("post.controller.ts");
    expect(contents).toContain("export class PostController extends Controller");
  });

  it("make:middleware exports an HttpPipe", async () => {
    await new MakeMiddlewareCommand(app).handle("ensure-admin", { dir });
    const contents = await read("ensure-admin.middleware.ts");
    expect(contents).toContain("HttpPipe");
    expect(contents).toContain("next(request)");
  });

  it("make:command appends the Command suffix and derives a signature", async () => {
    await new MakeCommandCommand(app).handle("send-emails", { dir });
    const contents = await read("send-emails.command.ts");
    expect(contents).toContain("export class SendEmailsCommand extends Command");
    expect(contents).toContain('signature = "send-emails";');
  });

  it("make:notification appends the Notification suffix", async () => {
    await new MakeNotificationCommand(app).handle("invoice-paid", { dir });
    const contents = await read("invoice-paid.notification.ts");
    expect(contents).toContain("export class InvoicePaidNotification extends Notification");
  });

  it("make:mail appends the Mail suffix", async () => {
    await new MakeMailCommand(app).handle("welcome", { dir });
    const contents = await read("welcome.mail.ts");
    expect(contents).toContain("export class WelcomeMail extends Mailable");
  });

  it("make:test writes a vitest file", async () => {
    await new MakeTestCommand(app).handle("todos", { dir });
    const contents = await read("todos.test.ts");
    expect(contents).toContain('describe("Todos"');
    expect(contents).toContain('from "vitest"');
  });

  it("make:provider is kebab-cased in a subdir like every other generator", async () => {
    await new MakeProviderCommand(app).handle("blog", { dir });
    const contents = await read("blog.provider.ts");
    expect(contents).toContain("export class BlogProvider extends ServiceProvider");
  });

  it("make:migration scaffolds a create-table file for create_*_table", async () => {
    await new MakeMigrationCommand(app).handle("create_widgets_table", { dir });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_create_widgets_table.ts"));
    expect(migration).toBeDefined();
    const contents = await read(migration!);
    expect(contents).toContain(
      'import { Schema, type Migration, type Blueprint } from "@mahiframework/database"',
    );
    expect(contents).toContain("async up(): Promise<void>");
    expect(contents).toContain('await Schema.create("widgets"');
    expect(contents).toContain("table.id()");
    expect(contents).toContain("table.timestamps()");
    expect(contents).toContain('await Schema.dropIfExists("widgets")');
    expect(contents).not.toContain("Kysely");
    expect(contents).not.toContain("db.schema");
  });

  it("make:migration for add_x_to_y_table produces an ALTER (Schema.table)", async () => {
    await new MakeMigrationCommand(app).handle("add_slug_to_posts_table", { dir });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_add_slug_to_posts_table.ts"));
    expect(migration).toBeDefined();
    const contents = await read(migration!);
    expect(contents).toContain('await Schema.table("posts"');
    // A `Schema.create` against a placeholder `"..."` table is rejected
    // by the DB and aborts the migrate run.
    expect(contents).not.toContain('Schema.create("..."');
    expect(contents).not.toContain('"..."');
  });

  it("make:migration for an unrecognised name emits an inert stub (no DDL)", async () => {
    await new MakeMigrationCommand(app).handle("do_something", { dir });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_do_something.ts"));
    expect(migration).toBeDefined();
    const contents = await read(migration!);
    expect(contents).not.toContain('"..."');
    // No live DDL, only commented guidance.
    expect(contents).not.toMatch(/^\s*await Schema\./m);
  });

  it("make:migration --create=<table> forces a create migration", async () => {
    await new MakeMigrationCommand(app).handle("some_name", { dir, create: "gadgets" });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_some_name.ts"));
    const contents = await read(migration!);
    expect(contents).toContain('await Schema.create("gadgets"');
  });

  it("make:migration --table=<table> forces an ALTER migration", async () => {
    await new MakeMigrationCommand(app).handle("some_name", { dir, table: "gadgets" });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_some_name.ts"));
    const contents = await read(migration!);
    expect(contents).toContain('await Schema.table("gadgets"');
  });

  it("make:migration --keyType uuid uses a uuid primary key", async () => {
    await new MakeMigrationCommand(app).handle("create_things_table", { dir, keyType: "uuid" });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_create_things_table.ts"));
    const contents = await read(migration!);
    expect(contents).toContain('table.uuid("id").primary();');
    expect(contents).not.toContain("table.id();");
  });

  it("make:migration --keyType uuidv7 uses a uuid primary key too", async () => {
    await new MakeMigrationCommand(app).handle("create_things_table", { dir, keyType: "uuidv7" });
    const names = await readdir(dir);
    const migration = names.find((f) => f.endsWith("_create_things_table.ts"));
    const contents = await read(migration!);
    expect(contents).toContain('table.uuid("id").primary();');
  });

  it("make:request appends the Request suffix with a rules() method", async () => {
    await new MakeRequestCommand(app).handle("create-post", { dir });
    const contents = await read("create-post.request.ts");
    expect(contents).toContain("export class CreatePostRequest extends Request");
    expect(contents).toContain("rules()");
  });

  describe("overwrite protection", () => {
    it("refuses to overwrite an existing file without --force", async () => {
      await new MakeModelCommand(app).handle("post", { dir });
      const before = await read("post.model.ts");

      await expect(new MakeModelCommand(app).handle("post", { dir })).rejects.toBeInstanceOf(
        FileExistsError,
      );

      // The original file is untouched.
      expect(await read("post.model.ts")).toBe(before);
    });

    it("overwrites with --force", async () => {
      const filePath = path.join(dir, "post.model.ts");
      await writeFile(filePath, "// old contents");

      await new MakeModelCommand(app).handle("post", { dir, force: true });

      expect(await read("post.model.ts")).toContain("export class Post extends Model");
    });
  });
});
