import { expect, test } from "bun:test";

test("toolchain runs TypeScript tests under Bun", () => {
  expect(typeof Bun.version).toBe("string");
});
