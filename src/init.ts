import fs from "node:fs/promises";
import path from "node:path";

export interface InitializeProjectOptions {
  directory?: string;
  name?: string;
  repository?: string;
}

export interface InitializedProject {
  rootDir: string;
  name: string;
  files: string[];
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function projectManifest(name: string, repository?: string): string {
  const manifest = {
    name,
    entry: "main.js",
    outDir: "dist",
    canvas: {
      width: 400,
      height: 400,
    },
    assets: {
      maxTextureSize: 256,
      maxMeshTriangles: 25_000,
      textureQuality: "high",
      maxBundleBytes: 75_000_000,
      audioQuality: "source",
    },
    ...(repository
      ? {
          publish: {
            repository,
            branch: "main",
            chunks: "auto",
          },
        }
      : {}),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function starterSource(name: string): string {
  return `const projectName = ${JSON.stringify(name)};

setup = function() {
    frameRate(60);
};

draw = function() {
    background(18, 23, 32);
    const pulse = 34 + 5 * Math.sin(millis() * 0.003);
    noStroke();
    fill(101, 194, 255);
    ellipse(200, 170, pulse * 2, pulse * 2);
    fill(240);
    textAlign(CENTER, CENTER);
    textSize(22);
    text(projectName, 200, 245);
    fill(150, 160, 175);
    textSize(13);
    text("Built with KAP+", 200, 274);
};
`;
}

function projectReadme(name: string, hasRepository: boolean): string {
  return `# ${name}

Created with KAP+.

## Develop

\`\`\`bash
npx kapplus install-browser
npx kapplus dev
npx kapplus check
npx kapplus build
\`\`\`

The dev command watches your modules and assets and previews them in Khan's
actual sandbox. Use \`--preview local\` for the local compatibility preview.

Import supported assets directly from \`main.js\`:

\`\`\`js
import model from "./model.obj";
import binaryModel from "./model.glb";
import texture from "./texture.png";
import sound from "./sound.mp3";
\`\`\`

${hasRepository
    ? `## Publish

Authenticate GitHub with \`gh auth login\`, then run:

\`\`\`bash
npx kapplus publish
\`\`\`

This prints the Khan-ready program without creating a Khan Academy program.
Pass \`--khan\` for explicit automated Khan publication.
`
    : `## Publish

Add a public GitHub chunk repository to \`kapplus.json\`:

\`\`\`json
"publish": {
  "repository": "YOUR_GITHUB_USER/kapplus-publish",
  "branch": "main",
  "chunks": "auto"
}
\`\`\`

Then authenticate GitHub with \`gh auth login\` and run \`npx kapplus publish\` to
print the Khan-ready program. Pass \`--khan\` only when you want KAP+ to create
the Khan Academy program for you.
`}
`;
}

export async function initializeProject(
  options: InitializeProjectOptions = {},
): Promise<InitializedProject> {
  const rootDir = path.resolve(options.directory || ".");
  const name = (options.name || path.basename(rootDir)).trim();
  if (!name) throw new Error("Project name cannot be empty.");
  const repository = options.repository?.trim();
  if (repository && !REPOSITORY.test(repository)) {
    throw new Error("--repository must use the form OWNER/REPOSITORY.");
  }

  const entries: Array<[string, string]> = [
    ["kapplus.json", projectManifest(name, repository)],
    ["main.js", starterSource(name)],
    ["README.md", projectReadme(name, Boolean(repository))],
    [".gitignore", "dist/\n.kapplus/\n"],
  ];
  await fs.mkdir(rootDir, { recursive: true });
  const collisions: string[] = [];
  for (const [relativePath] of entries) {
    try {
      await fs.access(path.join(rootDir, relativePath));
      collisions.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `KAP+ init would overwrite existing files in ${rootDir}: ${collisions.join(", ")}`,
    );
  }

  const created: string[] = [];
  try {
    for (const [relativePath, contents] of entries) {
      await fs.writeFile(path.join(rootDir, relativePath), contents, { flag: "wx" });
      created.push(relativePath);
    }
  } catch (error) {
    await Promise.all(created.map((relativePath) =>
      fs.rm(path.join(rootDir, relativePath), { force: true }),
    ));
    throw error;
  }
  return { rootDir, name, files: entries.map(([relativePath]) => relativePath) };
}
