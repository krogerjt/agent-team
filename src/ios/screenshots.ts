import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pngInfo } from "./discovery.js";
import { RELEASE_DIR, SCREENSHOT_CLASSES } from "./prepare.js";
import { runsDir } from "./store.js";

export interface CollectedScreenshot { name: string; source: string; target?: string; width: number; height: number; screenshotClass?: string; skipped?: string }
export interface CollectResult { dryRun: boolean; attachmentsDir?: string; collected: CollectedScreenshot[]; message: string }

interface ManifestEntry { testIdentifier?: string; attachments?: Array<{ exportedFileName?: string; suggestedHumanReadableName?: string }> }

/** "01-decks_0_6F2C...UUID.png" -> "01-decks" (Xcode appends an index and a UUID to attachment names). */
export function humanName(suggested: string): string {
  const withoutExtension = suggested.replace(/\.[A-Za-z0-9]+$/, "");
  return withoutExtension.replace(/_\d+_[0-9A-Fa-f-]{36}$/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function newestAttachmentFolder(repo: string): Promise<string | undefined> {
  const base = path.join(runsDir(repo), "artifacts");
  let best: { dir: string; time: number } | undefined;
  for (const entry of await readdir(base).catch(() => [] as string[])) {
    const dir = path.join(base, entry, "attachments");
    const info = await stat(path.join(dir, "manifest.json")).catch(() => undefined);
    if (info && (!best || info.mtimeMs > best.time)) best = { dir, time: info.mtimeMs };
  }
  return best?.dir;
}

/**
 * Turn the screenshots a UI test run attached into App Store-ready files: opaque PNGs, sorted into
 * release/screenshots/<class>/ by exact pixel size. Anything that matches no accepted size is reported, not guessed at.
 */
export async function collectScreenshots(repo: string, root: string, options: { dryRun: boolean; attachmentsDir?: string }): Promise<CollectResult> {
  const dir = options.attachmentsDir ?? await newestAttachmentFolder(repo);
  if (!dir) return { dryRun: options.dryRun, collected: [], message: "No downloaded UI-test attachments were found. Run: test-simulator with captureScreenshots on an App Store-size simulator first." };
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as ManifestEntry[];
  const items = manifest.flatMap((entry) => entry.attachments ?? []).filter((item) => item.exportedFileName && /\.(png|jpe?g)$/i.test(item.exportedFileName));
  const named = items.map((item) => ({ file: item.exportedFileName!, name: humanName(item.suggestedHumanReadableName ?? item.exportedFileName!) })).sort((a, b) => a.name.localeCompare(b.name));
  const collected: CollectedScreenshot[] = [];
  const perClass = new Map<string, number>();
  for (const item of named) {
    const source = path.join(dir, item.file);
    const original = await readFile(source).catch(() => undefined);
    if (!original) { collected.push({ name: item.name, source, width: 0, height: 0, skipped: "file was not downloaded" }); continue; }
    const meta = await sharp(original).metadata();
    const width = meta.width ?? 0, height = meta.height ?? 0;
    const screenshotClass = SCREENSHOT_CLASSES.find((entry) => entry.accepted.some((size) => size.width === width && size.height === height));
    if (!screenshotClass) { collected.push({ name: item.name, source, width, height, skipped: `${width}×${height} is not an accepted App Store screenshot size` }); continue; }
    const count = (perClass.get(screenshotClass.id) ?? 0) + 1;
    perClass.set(screenshotClass.id, count);
    if (count > screenshotClass.max) { collected.push({ name: item.name, source, width, height, screenshotClass: screenshotClass.id, skipped: `more than ${screenshotClass.max} screenshots for ${screenshotClass.label}` }); continue; }
    const target = `${RELEASE_DIR}/screenshots/${screenshotClass.folder}/${item.name}.png`;
    if (!options.dryRun) {
      // Flatten onto white and drop the alpha channel: App Store Connect rejects transparency.
      const opaque = await sharp(original).flatten({ background: "#ffffff" }).removeAlpha().png().toBuffer();
      const check = pngInfo(opaque);
      if (!check || check.alpha || check.width !== width || check.height !== height) throw new Error(`Could not produce an opaque ${width}×${height} PNG for ${item.name}.`);
      await mkdir(path.dirname(path.join(root, target)), { recursive: true });
      await writeFile(path.join(root, target), opaque);
    }
    collected.push({ name: item.name, source, target, width, height, screenshotClass: screenshotClass.id });
  }
  const ok = collected.filter((entry) => entry.target).length;
  return { dryRun: options.dryRun, attachmentsDir: dir, collected, message: `${options.dryRun ? "Would write" : "Wrote"} ${ok} screenshot(s)${collected.length - ok ? `; ${collected.length - ok} skipped (see reasons)` : ""}.` };
}
