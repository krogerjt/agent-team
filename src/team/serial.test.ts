import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize } from "./serial.js";

test("serialize runs same-key jobs one at a time in order and survives failures", async () => {
  const order: string[] = [];
  const job = (name: string, ms: number, fail = false) => serialize("k", async () => {
    order.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`end ${name}`);
    if (fail) throw new Error(name);
  });
  const results = await Promise.allSettled([job("a", 20), job("b", 1, true), job("c", 1)]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("serialize lets different keys overlap", async () => {
  let active = 0;
  let peak = 0;
  const job = (key: string) => serialize(key, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  });
  await Promise.all([job("x"), job("y")]);
  assert.equal(peak, 2);
});
