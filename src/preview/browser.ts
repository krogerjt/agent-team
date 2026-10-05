import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { TeamRunState } from "../team/state.js";
import type { PreviewInfo } from "./runtime.js";
import { persistPreview } from "./runtime.js";

export interface BrowserStep { action: "navigate" | "click" | "fill" | "expectText"; path?: string; role?: string; name?: string; value?: string; text?: string }

async function launch(): Promise<Browser> {
  try { return await chromium.launch({ channel: "msedge", headless: true }); }
  catch { return chromium.launch({ channel: "chrome", headless: true }); }
}

export async function inspectPreview(state: TeamRunState, info: PreviewInfo): Promise<{ screenshot: string; structure: string; errors: string[] }> {
  if (!info.url || info.status !== "healthy") throw new Error("Preview is not healthy.");
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 500)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 500)); });
    const response = await page.goto(info.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!response?.ok()) throw new Error(`Preview returned HTTP ${response?.status() ?? "no response"}.`);
    await page.waitForTimeout(500);
    const folder = path.join(state.runDir, "preview");
    await mkdir(folder, { recursive: true });
    const screenshot = path.join(folder, "latest.png");
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    const structure = (await page.ariaSnapshot()).slice(0, 18_000);
    info.screenshot = screenshot;
    info.captureAt = new Date().toISOString();
    info.structure = structure;
    info.browserResults = [{ step: "Open preview", status: "passed", detail: `HTTP ${response.status()}` }, ...errors.map((detail) => ({ step: "Browser console", status: "failed" as const, detail }))];
    await persistPreview(state, info);
    return { screenshot, structure, errors };
  } finally { await browser.close(); }
}

export function pathUrl(base: string, value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) throw new Error("Browser navigation must use a local path.");
  const target = new URL(value, base);
  if (target.origin !== new URL(base).origin) throw new Error("Browser navigation must stay in the local preview.");
  return target.toString();
}

async function perform(page: Page, base: string, step: BrowserStep): Promise<void> {
  if (step.action === "navigate") { await page.goto(pathUrl(base, step.path ?? "/"), { waitUntil: "domcontentloaded", timeout: 15_000 }); return; }
  if (step.action === "expectText") { if (!step.text || !await page.getByText(step.text, { exact: false }).first().isVisible()) throw new Error(`Text not visible: ${step.text}`); return; }
  if (!step.role || !step.name) throw new Error("Browser step needs a role and accessible name.");
  const locator = page.getByRole(step.role as Parameters<Page["getByRole"]>[0], { name: step.name, exact: true }).first();
  if (step.action === "click") { await locator.click({ timeout: 10_000 }); return; }
  if (step.action === "fill") { if (typeof step.value !== "string") throw new Error("Fill step needs a value."); await locator.fill(step.value, { timeout: 10_000 }); return; }
  throw new Error("Unknown browser action.");
}

export async function runBrowserSteps(state: TeamRunState, info: PreviewInfo, steps: BrowserStep[]): Promise<PreviewInfo["browserResults"]> {
  if (!info.url || info.status !== "healthy") throw new Error("Preview is not healthy.");
  if (steps.length > 12) throw new Error("Browser scenarios are limited to 12 steps.");
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(info.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const results = info.browserResults ?? [];
    for (const step of steps) {
      const label = `${step.action} ${step.name ?? step.path ?? step.text ?? ""}`.slice(0, 180);
      try { await perform(page, info.url, step); results.push({ step: label, status: "passed", detail: "Completed" }); }
      catch (error) { results.push({ step: label, status: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : String(error) }); break; }
    }
    info.browserResults = results;
    await persistPreview(state, info);
    return results;
  } finally { await browser.close(); }
}

export async function screenshotData(info: PreviewInfo): Promise<string | undefined> {
  return info.screenshot ? (await readFile(info.screenshot)).toString("base64") : undefined;
}
