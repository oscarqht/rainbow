import { test } from "node:test";
import assert from "node:assert/strict";
import { OptimisticLibrary } from "../src/lib/optimistic-library";
import type { Library } from "../src/lib/types";

const initial: Library = { rootId: "root", assetsId: "assets", unsortedId: "unsorted", collections: [], bookmarks: [], syncedAt: "" };
const named = (name: string) => (library: Library): Library => ({ ...library, collections: [...library.collections, { id: name, name, parentId: "root", order: 0, view: "grid" }] });

for (const fail of [false, true]) test(`queued actions remain optimistic when an earlier save ${fail ? "fails" : "succeeds"}`, async () => {
  let visible = initial;
  const cached: Library[] = [];
  const queue = new OptimisticLibrary(async (next, confirmed) => { visible = next; if (confirmed) cached.push(confirmed); });
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const first = queue.enqueue(visible, { apply: named("first"), save: async base => { await waiting; if (fail) throw new Error("save failed"); return named("first")(base); } });
  const failure = fail ? assert.rejects(first, /save failed/) : first;
  let secondStarted = false;
  let finishSecond!: () => void;
  const secondWaiting = new Promise<void>(resolve => { finishSecond = resolve; });
  const second = queue.enqueue(visible, { apply: named("second"), save: async base => { secondStarted = true; await secondWaiting; return named("second")(base); } });
  assert.deepEqual(visible.collections.map(c => c.id), ["first", "second"]);
  assert.equal(secondStarted, false);
  assert.equal(queue.busy, true);
  finish();
  await failure;
  assert.ok(visible.collections.some(c => c.id === "second"));
  assert.equal(cached[0].collections.some(c => c.id === "second"), false);
  finishSecond();
  await second;
  assert.deepEqual(visible.collections.map(c => c.id), fail ? ["second"] : ["first", "second"]);
  assert.equal(queue.busy, false);
});

test("a queued edit uses the confirmed ID and metadata of a newly created item", async () => {
  let visible = initial;
  let id = "pending";
  const queue = new OptimisticLibrary(async next => { visible = next; });
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const create = queue.enqueue(visible, { apply: named(id), save: async base => { await waiting; id = "drive-id"; return named(id)(base); } });
  const edit = queue.enqueue(visible, {
    apply: base => ({ ...base, collections: base.collections.map(c => c.id === id ? { ...c, name: "edited" } : c) }),
    save: async base => {
      assert.equal(base.collections[0].id, "drive-id");
      return { ...base, collections: base.collections.map(c => ({ ...c, name: "edited" })) };
    },
  });
  assert.equal(visible.collections[0].id, "pending");
  assert.equal(visible.collections[0].name, "edited");
  finish();
  await Promise.all([create, edit]);
  assert.equal(visible.collections[0].name, "edited");
});
