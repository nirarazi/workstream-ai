import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "../../core/pipeline.js";

describe("Pipeline.stop during the first poll", () => {
  it("doesn't start polling once that poll finishes", async () => {
    const pipeline = new Pipeline({} as any, {} as any, {} as any, {} as any, undefined, { messaging: { pollInterval: 3600 } } as any);
    let finishFirstPoll!: () => void;
    vi.spyOn(pipeline, "processOnce").mockImplementation(
      () => new Promise((resolve) => { finishFirstPoll = () => resolve({ processed: 0, classified: 0, errors: 0 }); }),
    );

    const started = pipeline.start();
    pipeline.stop(); // e.g. a settings save during the catch-up after launch
    finishFirstPoll();
    await started;

    expect(pipeline.isPolling()).toBe(false);
    pipeline.stop();
  });
});
