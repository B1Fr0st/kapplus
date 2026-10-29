import { describe, expect, it } from "vitest";
import {
  describeKhanSaveResponse,
  isNewKhanProgramUrl,
  isKnownKhanConsoleNoise,
  isPublishedKhanProgramUrl,
  normalizeKhanUrl,
  uniqueNonEmpty,
} from "../src/browser-session.js";

describe("normalizeKhanUrl", () => {
  it("uses the blank ProcessingJS program by default", () => {
    expect(normalizeKhanUrl()).toBe(
      "https://www.khanacademy.org/computer-programming/new/pjs",
    );
  });

  it("allows Khan Academy program URLs", () => {
    expect(
      normalizeKhanUrl(
        "https://www.khanacademy.org/computer-programming/example/123456",
      ),
    ).toContain("/computer-programming/example/123456");
  });

  it("rejects non-Khan and insecure URLs", () => {
    expect(() => normalizeKhanUrl("https://example.com")).toThrow();
    expect(() => normalizeKhanUrl("http://www.khanacademy.org/foo")).toThrow();
  });
});

describe("isKnownKhanConsoleNoise", () => {
  it("ignores Khan-owned CSP failures without hiding application errors", () => {
    expect(isKnownKhanConsoleNoise(
      "Loading the script 'https://www.googletagmanager.com/gtm.js?id=x' violates the following Content Security Policy directive",
    )).toBe(true);
    expect(isKnownKhanConsoleNoise(
      "Refused font because it violates the following Content Security Policy directive font-src data",
    )).toBe(true);
    expect(isKnownKhanConsoleNoise("Uncaught TypeError: texture.image is not a function")).toBe(false);
  });
});

describe("describeKhanSaveResponse", () => {
  it("turns oversized save responses into an actionable error", () => {
    expect(describeKhanSaveResponse(413, "Payload Too Large", "")).toContain("too large");
    expect(describeKhanSaveResponse(500, "Server Error", "Request Entity Too Large"))
      .toContain("too large");
  });

  it("reports GraphQL create-program errors and ignores success", () => {
    expect(
      describeKhanSaveResponse(
        200,
        "OK",
        JSON.stringify({ data: { createProgram: { error: { code: "PROGRAM_TOO_LARGE" } } } }),
      ),
    ).toContain("PROGRAM_TOO_LARGE");
    expect(describeKhanSaveResponse(200, "OK", JSON.stringify({ data: { createProgram: {} } })))
      .toBeNull();
  });
});

describe("uniqueNonEmpty", () => {
  it("trims, removes blank strings, and preserves unique order", () => {
    expect(uniqueNonEmpty([" hello ", "", "hello", "world"])).toEqual([
      "hello",
      "world",
    ]);
  });
});

describe("Khan program URL classification", () => {
  it("only recognizes the blank editor as a new program", () => {
    expect(isNewKhanProgramUrl("https://www.khanacademy.org/computer-programming/new/pjs")).toBe(true);
    expect(isNewKhanProgramUrl("https://www.khanacademy.org/computer-programming/demo/12345")).toBe(false);
  });

  it("recognizes saved program URLs with numeric identifiers", () => {
    expect(isPublishedKhanProgramUrl("https://www.khanacademy.org/computer-programming/demo/12345")).toBe(true);
    expect(isPublishedKhanProgramUrl("https://www.khanacademy.org/computer-programming/new/pjs")).toBe(false);
  });
});
