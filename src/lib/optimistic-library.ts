import type { Library } from "./types";

type Change = {
  apply: (library: Library) => Library;
  save: (library: Library) => Promise<Library>;
};
type Job = Change & { resolve: () => void; reject: (error: unknown) => void };

// Serialize durable writes while replaying every outstanding change in the UI.
export class OptimisticLibrary {
  private confirmed!: Library;
  private changes: Job[] = [];
  private running = false;
  get busy() { return this.changes.length > 0; }
  constructor(private publish: (visible: Library, confirmed?: Library) => Promise<void>) {}

  enqueue(library: Library, change: Change): Promise<void> {
    if (!this.busy) this.confirmed = library;
    return new Promise<void>((resolve, reject) => {
      this.changes.push({ ...change, resolve, reject });
      void this.publish(this.visible());
      if (!this.running) void this.drain();
    });
  }

  private visible() { return this.changes.reduce((library, change) => change.apply(library), this.confirmed); }
  private async drain() {
    this.running = true;
    while (this.changes.length) {
      const change = this.changes[0];
      let failed = false;
      let failure: unknown;
      try { this.confirmed = await change.save(this.confirmed); }
      catch (error) { failed = true; failure = error; }
      // Removing just this intent rolls it back without losing later changes.
      this.changes.shift();
      await this.publish(this.visible(), this.confirmed);
      if (failed) change.reject(failure); else change.resolve();
    }
    this.running = false;
  }
}
