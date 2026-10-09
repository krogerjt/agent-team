/** Shared typed results for the iOS release capability. Every operation returns data, never prose-only output. */

export type FindingStatus = "passed" | "failed" | "pending" | "blocked";

export interface Finding {
  id: string;
  title: string;
  status: FindingStatus;
  detail: string;
  /** Exactly what the user (or agent) should do to resolve a failed/pending/blocked item. */
  remedy?: string;
  /** True when the user must supply the value; never invented by the agent. */
  needsUserInput?: boolean;
}

export interface IosTarget {
  name: string;
  productType: "application" | "unit-test" | "ui-test" | "other";
  /** iOS, macOS, tvOS, watchOS or visionOS when the project says so. */
  platform?: string;
  bundleId?: string;
  marketingVersion?: string;
  buildNumber?: string;
  deploymentTarget?: string;
  infoPlist?: string;
  entitlements?: string;
  deviceFamily?: string;
  codeSignStyle?: string;
  developmentTeam?: string;
  /** Where the version values were found, so a bump edits the same source. */
  versionSource?: "project.yml" | "pbxproj" | "info-plist" | "xcconfig";
}

export interface IosDiscovery {
  root: string;
  /** Verified facts read from files. */
  facts: Record<string, string | string[] | boolean | undefined>;
  container?: { kind: "workspace" | "project"; path: string };
  xcodeGenSpec?: string;
  xcodeGenProjectName?: string;
  needsXcodeGen: boolean;
  targets: IosTarget[];
  appTarget?: IosTarget;
  schemes: string[];
  testTargets: { unit: string[]; ui: string[] };
  assetCatalogs: string[];
  appIcon: { catalog?: string; setName?: string; hasMarketing1024: boolean; missing: string[] };
  metadataFiles: { privacyPolicy?: string; support?: string; appStoreMetadata?: string; releaseNotes?: string; exportCompliance?: string; reviewNotes?: string; screenshotsDir?: string };
  privacyManifest?: string;
  usageDescriptions: string[];
  /** Capability usage inferred from source, used for privacy templates. */
  detectedBehaviors: string[];
  /** True when non-test source uses an API Apple requires a privacy-manifest reason for. */
  requiredReasonApis: boolean;
  warnings: Finding[];
  blockers: Finding[];
  missing: Finding[];
}

export interface RunContext {
  /** Exact worktree identity a run used. */
  root: string;
  commit?: string;
  dirty: boolean;
  /** SHA-256 of tracked diff + untracked file list; changes whenever the tree changes. */
  treeHash: string;
  at: string;
}

export type OperationName = "generate-project" | "build-simulator" | "test-simulator" | "build-release" | "install-device" | "archive" | "export" | "upload";
export type FailureClass =
  | "environment" | "xcode-version" | "missing-tool" | "signing-identity" | "provisioning" | "account-team"
  | "build-cache-locked" | "credentials-missing" | "authentication" | "compile-error" | "test-failure" | "duplicate-build" | "network"
  | "permission-denied" | "verification" | "timeout" | "unknown";

export interface OperationResult {
  operation: OperationName;
  /** "success" only when the command exited 0 AND its expected output was verified. */
  status: "success" | "failed" | "blocked" | "dry-run";
  verified: boolean;
  summary: string;
  failureClass?: FailureClass;
  /** Concrete next step for a failed or blocked result. */
  remedy?: string;
  /** Commands that would run / did run, with secrets shown only as references. */
  commands: string[];
  output?: string;
  outputs?: { archivePath?: string; exportPath?: string; ipaPath?: string; uploadId?: string; xcresult?: string; artifacts?: string[] };
  testSummary?: { passed?: number; failed?: number; skipped?: number; total?: number; raw?: string };
  context?: RunContext;
  durationMs?: number;
}

export type StepId = "discover" | "readiness" | "prepare" | "generate-project" | "build-simulator" | "test-simulator" | "audit" | "build-release" | "install-device" | "archive" | "export" | "upload" | "submit";
export type StepStatus = "pending" | "passed" | "failed" | "blocked" | "skipped" | "manual";

export interface StepRecord {
  step: StepId;
  status: StepStatus;
  at: string;
  summary: string;
  blockers?: Array<{ id: string; remedy: string; kind: "user-input" | "environment" | "code" }>;
  /** Test scope for test-simulator records. */
  scope?: string;
  /** Tree hash the step passed against; a later tree change makes it stale. */
  treeHash?: string;
}

export interface ReleasePermissions { signing: boolean; upload: boolean }

export interface AppStoreConnectKeyRef {
  /** Names of secrets in the Agent Team Build Keychain; the values never leave the Mac. */
  keyIdSecret: string;
  issuerIdSecret: string;
  privateKeySecret: string;
}
