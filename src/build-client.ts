import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const sourceDir = join(process.cwd(), "src");
const distDir = join(process.cwd(), "dist");
const clientEntry = join(sourceDir, "client.tsx");
const stylesheetEntry = join(sourceDir, "styles.css");
const stylesheetPath = join(distDir, "styles.css");

let buildInFlight: Promise<void> | null = null;
let lastBuiltAt = 0;

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
}

async function getNewestSourceMtime(): Promise<number> {
  const files = await collectSourceFiles(sourceDir);
  const relevantFiles = files.filter((file) =>
    /\.(css|ts|tsx)$/.test(relative(sourceDir, file)),
  );

  const stats = await Promise.all(relevantFiles.map((file) => Bun.file(file).stat()));

  return stats.reduce((latest, stat) => Math.max(latest, stat.mtimeMs), 0);
}

export async function buildClient(force = false): Promise<void> {
  if (buildInFlight) {
    return buildInFlight;
  }

  buildInFlight = (async () => {
    const newestSourceMtime = await getNewestSourceMtime();

    if (!force && newestSourceMtime <= lastBuiltAt) {
      return;
    }

    const result = await Bun.build({
      entrypoints: [clientEntry],
      outdir: distDir,
      target: "browser",
      format: "esm",
      naming: {
        entry: "[name].js",
      },
      minify: process.env.NODE_ENV === "production",
      sourcemap: process.env.NODE_ENV === "production" ? "none" : "inline",
    });

    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join("\n");
      throw new Error(`Client build failed:\n${messages}`);
    }

    await Bun.write(stylesheetPath, Bun.file(stylesheetEntry));
    lastBuiltAt = Date.now();
  })();

  try {
    await buildInFlight;
  } finally {
    buildInFlight = null;
  }
}

export function getClientBuildVersion() {
  return lastBuiltAt;
}
