import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceDir = path.join(__dirname, "src");
const distDir = path.join(__dirname, "dist");
const clientEntry = path.join(sourceDir, "client.tsx");
const stylesheetEntry = path.join(sourceDir, "styles.css");
const stylesheetPath = path.join(distDir, "styles.css");

let buildInFlight = null;
let lastBuiltAt = 0;

async function collectSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
}

async function getNewestSourceMtime() {
  const files = await collectSourceFiles(sourceDir);
  const relevantFiles = files.filter((file) => /\.(css|ts|tsx)$/.test(path.relative(sourceDir, file)));
  const stats = await Promise.all(relevantFiles.map((file) => fs.stat(file)));
  return stats.reduce((latest, stat) => Math.max(latest, stat.mtimeMs), 0);
}

export async function buildClient(force = false) {
  if (buildInFlight) {
    return buildInFlight;
  }

  buildInFlight = (async () => {
    const newestSourceMtime = await getNewestSourceMtime();

    if (!force && newestSourceMtime <= lastBuiltAt) {
      return;
    }

    await fs.mkdir(distDir, { recursive: true });

    await esbuild.build({
      entryPoints: [clientEntry],
      outdir: distDir,
      bundle: true,
      target: ["es2020"],
      format: "esm",
      platform: "browser",
      entryNames: "[name]",
      minify: process.env.NODE_ENV === "production",
      sourcemap: process.env.NODE_ENV === "production" ? false : "inline",
      logLevel: "silent",
    });

    await fs.copyFile(stylesheetEntry, stylesheetPath);
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
