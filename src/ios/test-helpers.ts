import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tempRepo } from "../coding/test-helpers.js";
import type { OperationDeps } from "./operations.js";
import type { RemoteBuildHost, RemoteProjectSettings } from "../remote/settings.js";
import { repoHome } from "../team/state.js";

export function png(width: number, height: number, alpha = false): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; buffer[25] = alpha ? 6 : 2;
  return buffer;
}

export const XCODEGEN_SPEC = `name: Acme
options:
  deploymentTarget:
    iOS: "17.0"
settings:
  base:
    MARKETING_VERSION: "1.2.0"
    CURRENT_PROJECT_VERSION: "7"
targets:
  Acme:
    type: application
    platform: iOS
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.acme.app
        DEVELOPMENT_TEAM: ABCDE12345
        CODE_SIGN_STYLE: Automatic
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        TARGETED_DEVICE_FAMILY: "1"
        INFOPLIST_KEY_NSCameraUsageDescription: "Scan receipts"
    info:
      path: Acme/Info.plist
      properties:
        CFBundleShortVersionString: "$(MARKETING_VERSION)"
        CFBundleVersion: "$(CURRENT_PROJECT_VERSION)"
        ITSAppUsesNonExemptEncryption: false
  AcmeTests:
    type: bundle.unit-test
    platform: iOS
  AcmeUITests:
    type: bundle.ui-testing
    platform: iOS
schemes:
  Acme:
    build:
      targets:
        Acme: all
    test:
      targets: [AcmeTests]
`;

const ICON_CONTENTS = JSON.stringify({ images: [{ idiom: "universal", platform: "ios", size: "1024x1024", filename: "icon.png" }], info: { version: 1, author: "xcode" } });

export function pbxproj(version = "2.0", build = "41"): string {
  const settings = (name: string, extra: string) => `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "com.acme.pbx${name}";\n${extra}`;
  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tobjects = {

/* Begin PBXNativeTarget section */
\t\t13A1B2C3D4E5F60718293A01 /* PbxApp */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = 13A1B2C3D4E5F60718293B01 /* Build configuration list for PBXNativeTarget "PbxApp" */;
\t\t\tname = PbxApp;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
\t\t13A1B2C3D4E5F60718293A02 /* PbxAppTests */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = 13A1B2C3D4E5F60718293B02 /* Build configuration list for PBXNativeTarget "PbxAppTests" */;
\t\t\tname = PbxAppTests;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t13A1B2C3D4E5F60718293C01 /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tbuildConfigurationList = 13A1B2C3D4E5F60718293B03 /* Build configuration list for PBXProject "PbxApp" */;
\t\t};
/* End PBXProject section */

/* Begin XCBuildConfiguration section */
\t\t13A1B2C3D4E5F60718293D01 /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${settings("Debug", `\t\t\t\tMARKETING_VERSION = ${version};\n\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n`)}\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t13A1B2C3D4E5F60718293D02 /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${settings("", `\t\t\t\tMARKETING_VERSION = ${version};\n\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.4;\n\t\t\t\tDEVELOPMENT_TEAM = ZZZZZ99999;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n`)}\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t13A1B2C3D4E5F60718293D03 /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "com.acme.pbxtests";
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t13A1B2C3D4E5F60718293D04 /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tSDKROOT = iphoneos;
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t13A1B2C3D4E5F60718293B01 /* Build configuration list for PBXNativeTarget "PbxApp" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t13A1B2C3D4E5F60718293D01 /* Debug */,
\t\t\t\t13A1B2C3D4E5F60718293D02 /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t13A1B2C3D4E5F60718293B02 /* Build configuration list for PBXNativeTarget "PbxAppTests" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t13A1B2C3D4E5F60718293D03 /* Release */,
\t\t\t);
\t\t};
\t\t13A1B2C3D4E5F60718293B03 /* Build configuration list for PBXProject "PbxApp" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t13A1B2C3D4E5F60718293D04 /* Release */,
\t\t\t);
\t\t};
/* End XCConfigurationList section */
\t};
}
`;
}

/** A complete, healthy XcodeGen app. Individual tests delete or overwrite files to create problems. */
export function healthyApp(): Record<string, string | Buffer> {
  return {
    "project.yml": XCODEGEN_SPEC,
    "Acme/AcmeApp.swift": "import SwiftUI\n@main struct AcmeApp: App { var body: some Scene { WindowGroup { Text(\"Hi\") } } }\n",
    "Acme/Assets.xcassets/AppIcon.appiconset/Contents.json": ICON_CONTENTS,
    "Acme/Assets.xcassets/AppIcon.appiconset/icon.png": png(1024, 1024),
  };
}

export interface IosRepo { root: string; parent: string; data: string; cleanup: () => Promise<void> }

export async function iosRepo(files: Record<string, string | Buffer>): Promise<IosRepo> {
  const { root, parent } = await tempRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-team-ios-data-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return { root, parent, data, cleanup: async () => { const options = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }; await rm(parent, options); await rm(data, options); } };
}

/** Point per-repo state at a temp directory for the duration of a test. */
export async function withData<T>(repo: IosRepo, body: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENT_TEAM_DATA_DIR;
  process.env.AGENT_TEAM_DATA_DIR = repo.data;
  try { return await body(); }
  finally { if (previous === undefined) delete process.env.AGENT_TEAM_DATA_DIR; else process.env.AGENT_TEAM_DATA_DIR = previous; }
}

export const host: RemoteBuildHost = { enabled: true, target: "build-mac", root: ".agent-team-builder" };
export const noProject: RemoteProjectSettings = { setupCommand: "", secrets: {} };

export function baseDeps(repo: IosRepo, run: OperationDeps["run"], extra: Partial<OperationDeps> = {}): OperationDeps {
  return {
    repo: repo.root, host, project: noProject,
    settings: { permissions: { signing: false, upload: false } },
    state: { settings: { permissions: { signing: false, upload: false } }, steps: {} },
    run, uploadSource: async () => undefined, downloadAttachments: async () => undefined,
    newId: () => "job1", newNonce: () => "NONCE", ...extra,
  };
}
export { repoHome };
