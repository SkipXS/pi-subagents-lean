import { describe, expect, it } from "vitest";
import { FifoConcurrencyScheduler } from "../../src/agents/concurrency-scheduler.js";

type Entry = { id: string; kind: string };

const entry = (id: string): Entry => ({ id, kind: id });

describe("FifoConcurrencyScheduler", () => {
  it("keeps accepted work FIFO while reserving released slots", () => {
    const scheduler = new FifoConcurrencyScheduler<Entry>(1);
    expect(scheduler.decide()).toBe("running");
    expect(scheduler.shouldQueue()).toBe(false);
    scheduler.acquire();

    scheduler.enqueue(entry("second"));
    scheduler.enqueue(entry("third"));
    expect(scheduler.decide()).toBe("queued");
    expect(scheduler.shouldQueue()).toBe(true);

    expect(scheduler.release().map((item) => item.id)).toEqual(["second"]);
    expect(scheduler.runningCount).toBe(1);
    expect(scheduler.queuedCount).toBe(1);

    expect(scheduler.release().map((item) => item.id)).toEqual(["third"]);
    expect(scheduler.runningCount).toBe(1);
    expect(scheduler.queuedCount).toBe(0);
  });

  it("skips cancelled or stale entries without consuming capacity", () => {
    const scheduler = new FifoConcurrencyScheduler<Entry>(1);
    scheduler.acquire();
    scheduler.enqueue(entry("cancelled"));
    scheduler.enqueue(entry("ready"));
    expect(scheduler.removeWhere((item) => item.id === "cancelled").map((item) => item.id)).toEqual(["cancelled"]);

    expect(scheduler.release().map((item) => item.id)).toEqual(["ready"]);
    expect(scheduler.runningCount).toBe(1);
  });

  it("starts queued work when the limit expands and normalizes invalid limits", () => {
    const scheduler = new FifoConcurrencyScheduler<Entry>(0);
    expect(scheduler.limitCount).toBe(1);
    scheduler.acquire();
    scheduler.enqueue(entry("second"));
    scheduler.enqueue(entry("third"));

    expect(scheduler.setLimit(3).map((item) => item.id)).toEqual(["second", "third"]);
    expect(scheduler.limitCount).toBe(3);
    expect(scheduler.runningCount).toBe(3);
    expect(scheduler.queuedCount).toBe(0);
  });
});
