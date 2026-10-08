import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoHome } from "../team/state.js";
import { serialize } from "../team/serial.js";
import type { AppStoreConnectKeyRef, OperationResult, ReleasePermissions, StepId, StepRecord } from "./types.js";

export interface IosReleaseSettings {
  scheme?: string;
  /** Apple Developer Team ID. A public identifier, not a secret. */
  teamId?: string;
  /** Preferred physical device UDID when several are connected. */
  deviceUdid?: string;
  apiKey?: AppStoreConnectKeyRef;
  /** Signing and upload are separate user-granted permissions. Agents can read these but never write them. */
  permissions: ReleasePermissions;
}

export interface IosReleaseState {
  settings: IosReleaseSettings;
  steps: Partial<Record<StepId, StepRecord>>;
  lastUpload?: { marketingVersion?: string; buildNumber?: string; uploadId?: string; at: string };
  lastArchive?: { archivePath: string; treeHash: string; at: string; id: string };
  lastExport?: { ipaPath: string; exportPath: string; treeHash: string; at: string; id: string };
}

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.:/-]{0,99}$/;
const initial = (): IosReleaseState => ({ settings: { permissions: { signing: false, upload: false } }, steps: {} });

function stateFile(repo: string): string { return path.join(repoHome(repo), "ios-release.json"); }
export function runsDir(repo: string): string { return path.join(repoHome(repo), "ios-runs"); }

export async function readIosState(repo: string): Promise<IosReleaseState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(repo), "utf8")) as Partial<IosReleaseState>;
    return { ...initial(), ...parsed, settings: { ...initial().settings, ...parsed.settings, permissions: { signing: false, upload: false, ...parsed.settings?.permissions } } };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return initial();
    throw error;
  }
}

async function mutate<T>(repo: string, change: (state: IosReleaseState) => T): Promise<T> {
  return serialize(`ios-state:${path.resolve(repo)}`, async () => {
    const state = await readIosState(repo);
    const result = change(state);
    const file = stateFile(repo);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return result;
  });
}

export function validateSettings(input: Partial<IosReleaseSettings>): Partial<IosReleaseSettings> {
  const out: Partial<IosReleaseSettings> = {};
  if (input.scheme !== undefined) { if (!/^[A-Za-z0-9_. -]{1,100}$/.test(input.scheme)) throw new Error("Scheme names may contain letters, digits, spaces, dots, dashes and underscores."); out.scheme = input.scheme; }
  if (input.teamId !== undefined) { if (!/^[A-Z0-9]{10}$/.test(input.teamId)) throw new Error("A Team ID is exactly 10 uppercase letters or digits, as shown in the Apple Developer portal."); out.teamId = input.teamId; }
  if (input.deviceUdid !== undefined) { if (!/^[0-9A-Fa-f-]{20,64}$/.test(input.deviceUdid)) throw new Error("Invalid device UDID."); out.deviceUdid = input.deviceUdid; }
  if (input.apiKey !== undefined) {
    for (const [field, name] of Object.entries(input.apiKey)) if (!SECRET_NAME.test(String(name))) throw new Error(`Invalid Keychain secret name for ${field}. Pass the secret's name, never its value.`);
    out.apiKey = { keyIdSecret: input.apiKey.keyIdSecret, issuerIdSecret: input.apiKey.issuerIdSecret, privateKeySecret: input.apiKey.privateKeySecret };
  }
  return out;
}

/** Called by the user-facing CLI/UI. Agent tools never call this. */
export async function saveIosSettings(repo: string, input: Partial<IosReleaseSettings>): Promise<IosReleaseSettings> {
  const valid = validateSettings(input);
  return mutate(repo, (state) => { state.settings = { ...state.settings, ...valid, permissions: state.settings.permissions }; return state.settings; });
}

/** Called only by the user-facing CLI/UI. Revoking is always allowed. */
export async function setIosPermission(repo: string, permission: keyof ReleasePermissions, granted: boolean): Promise<ReleasePermissions> {
  if (permission !== "signing" && permission !== "upload") throw new Error("Permission must be 'signing' or 'upload'. Submitting for App Review is never automated.");
  return mutate(repo, (state) => { state.settings.permissions[permission] = granted; return { ...state.settings.permissions }; });
}

export async function recordStep(repo: string, record: StepRecord): Promise<void> {
  await mutate(repo, (state) => { state.steps[record.step] = record; });
}

export async function updateIosState(repo: string, change: (state: IosReleaseState) => void): Promise<void> {
  await mutate(repo, change);
}

/** Persist the full result (and the exact worktree context) of one operation; keeps the 30 most recent. */
export async function saveOperationRecord(repo: string, id: string, result: OperationResult): Promise<string> {
  const folder = path.join(runsDir(repo), id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  if (result.output) await writeFile(path.join(folder, "output.log"), result.output, "utf8");
  const names = (await readdir(runsDir(repo))).sort();
  for (const old of names.slice(0, Math.max(0, names.length - 30))) await rm(path.join(runsDir(repo), old), { recursive: true, force: true });
  return folder;
}
