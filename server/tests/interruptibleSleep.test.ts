import { describe, expect, it, vi } from "vitest";
import { createInterruptibleSleeper } from "../workers/interruptibleSleep";

describe("interruptible worker sleep", () => {
  it("wakes immediately during shutdown and remains reusable", async () => {
    vi.useFakeTimers();
    const sleeper = createInterruptibleSleeper();
    const first = sleeper.sleep(60_000);
    sleeper.interrupt();
    await expect(first).resolves.toBeUndefined();

    const second = sleeper.sleep(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
