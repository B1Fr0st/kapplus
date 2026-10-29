import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/init.js";
import { compileProject } from "../src/compiler.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-init-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("kapplus init", () => {
  it("creates a project that compiles immediately", async () => {
    const parent = await temporaryRoot();
    const project = path.join(parent, "my-game");
    const initialized = await initializeProject({ directory: project, name: "My Game" });

    expect(initialized.files).toEqual(["kapplus.json", "main.js", "README.md", ".gitignore"]);
    const manifest = JSON.parse(await fs.readFile(path.join(project, "kapplus.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "My Game",
      entry: "main.js",
      assets: { textureQuality: "high", audioQuality: "source" },
    });
    expect(manifest).not.toHaveProperty("publish");
    const compiled = await compileProject(path.join(project, "kapplus.json"));
    expect(compiled.khanProgram).toContain("draw=");
    expect(compiled.assets).toHaveLength(0);
  });

  it("adds an optional publish repository", async () => {
    const parent = await temporaryRoot();
    const project = path.join(parent, "published-game");
    await initializeProject({
      directory: project,
      repository: "example/kapplus-publish",
    });
    const manifest = JSON.parse(await fs.readFile(path.join(project, "kapplus.json"), "utf8"));
    expect(manifest.publish).toEqual({
      repository: "example/kapplus-publish",
      branch: "main",
      chunks: "auto",
    });
  });

  it("refuses to overwrite project files", async () => {
    const project = await temporaryRoot();
    const mainPath = path.join(project, "main.js");
    await fs.writeFile(mainPath, "user code\n");

    await expect(initializeProject({ directory: project })).rejects.toThrow(
      /would overwrite existing files.*main\.js/,
    );
    expect(await fs.readFile(mainPath, "utf8")).toBe("user code\n");
    await expect(fs.access(path.join(project, "kapplus.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates publish repository syntax before writing files", async () => {
    const project = path.join(await temporaryRoot(), "bad-repository");
    await expect(initializeProject({ directory: project, repository: "not-a-repository" }))
      .rejects.toThrow("OWNER/REPOSITORY");
    await expect(fs.access(path.join(project, "kapplus.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
