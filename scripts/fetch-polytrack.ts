/**
 * Downloads the official PolyTrack 0.6.3 build into vendor/ and verifies every
 * file against the committed manifest (size + SHA-256). Files are stored
 * byte-for-byte as served; nothing is modified.
 *
 *   node dist/scripts/fetch-polytrack.js                    download missing files, verify all
 *   node dist/scripts/fetch-polytrack.js --write-manifest   (maintainers) record hashes into the manifest
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GAME_DIR, MANIFEST_PATH, type Manifest, type ManifestFile } from "../src/polytrack/local/paths.js";

const CONCURRENCY = 4;
const writeManifest = process.argv.includes("--write-manifest");

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function processFile(manifest: Manifest, entry: ManifestFile): Promise<{ entry: ManifestFile; downloaded: boolean }> {
  const target = join(GAME_DIR, entry.path);
  let data: Uint8Array | null = existsSync(target) ? new Uint8Array(await readFile(target)) : null;
  let downloaded = false;

  if (data === null || (entry.sha256 !== undefined && sha256(data) !== entry.sha256)) {
    data = await download(manifest.baseUrl + entry.path);
    downloaded = true;
  }

  const hash = sha256(data);
  if (!writeManifest) {
    if (entry.sha256 === undefined) throw new Error(`Manifest has no hash for ${entry.path}; run with --write-manifest`);
    if (hash !== entry.sha256 || data.byteLength !== entry.size) {
      throw new Error(
        `${entry.path}: upstream file differs from the pinned 0.6.3 manifest ` +
          `(expected ${entry.size} B ${entry.sha256}, got ${data.byteLength} B ${hash})`,
      );
    }
  }
  if (downloaded) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  return { entry: { path: entry.path, size: data.byteLength, sha256: hash }, downloaded };
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  console.log(`PolyTrack ${manifest.version} from ${manifest.baseUrl}`);
  console.log(`Target: ${GAME_DIR}`);

  const results: ManifestFile[] = new Array(manifest.files.length);
  let next = 0;
  let fetched = 0;
  let bytes = 0;
  async function worker(): Promise<void> {
    while (next < manifest.files.length) {
      const i = next++;
      const { entry, downloaded } = await processFile(manifest, manifest.files[i]!);
      results[i] = entry;
      bytes += entry.size ?? 0;
      if (downloaded) {
        fetched++;
        console.log(`  fetched ${entry.path} (${entry.size} B)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (writeManifest) {
    await writeFile(MANIFEST_PATH, JSON.stringify({ ...manifest, files: results }, null, 2) + "\n");
    console.log(`Manifest updated: ${MANIFEST_PATH}`);
  }
  console.log(`OK: ${results.length} files verified (${(bytes / 1024 / 1024).toFixed(1)} MiB), ${fetched} downloaded.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
