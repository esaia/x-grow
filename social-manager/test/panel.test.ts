import { describe, expect, it } from "vitest";
import { firstLine } from "../src/autoreply/panel";

describe("default auto-reply name", () => {
  it("cuts a long first line at a whole word", () => {
    expect(firstLine("Still designing service slides from scratch every Sunday? 😩")).toBe(
      "Still designing service slides from",
    );
  });
  it("keeps a short first line and skips blank lines", () => {
    expect(firstLine("\n\nComment APP 🚀\nmore")).toBe("Comment APP 🚀");
  });
});
