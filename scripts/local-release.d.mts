export interface ReleaseLayout {
  homeDir: string;
  releasesDir: string;
  currentLink: string;
  envFile: string;
  dataDir: string;
  workspaceDir: string;
  lockDir: string;
  binPath: string;
  systemdUnitPath: string;
}

export interface InstalledRelease {
  releaseId: string;
  dir: string;
  version: string;
  createdAt: string;
  mtimeMs: number;
  isCurrent: boolean;
}

export function resolvePackageRoot(): string;
export function resolveReleaseLayout(homeOverride?: string): ReleaseLayout;
export function formatReleaseId(version: string, now?: Date, gitShortSha?: string): string;
export function buildServicePath(currentPath?: string, nodeBin?: string): string;
export function buildWrapperScript(layout: ReleaseLayout, nodeBin?: string): string;
export function buildSystemdUnit(
  layout: ReleaseLayout,
  options?: { nodeBin?: string; env?: Record<string, string | undefined> },
): string;
export function getCurrentReleaseId(layout: ReleaseLayout): string | null;
export function listInstalledReleases(layout: ReleaseLayout): InstalledRelease[];
export function pruneOldReleases(layout: ReleaseLayout, keepCount?: number): string[];
export function swapCurrentSymlink(layout: ReleaseLayout, releaseDir: string): void;
export function releaseLocal(options?: {
  devRoot?: string;
  gatewayHome?: string;
  skipTests?: boolean;
  skipCheck?: boolean;
  noRestart?: boolean;
  noSystemd?: boolean;
  keep?: number;
  nodeBin?: string;
}): Promise<{ releaseId: string; releaseDir: string; layout: ReleaseLayout }>;
export function rollbackLocal(
  targetReleaseId?: string,
  options?: {
    gatewayHome?: string;
    skipCheck?: boolean;
    noRestart?: boolean;
    noSystemd?: boolean;
    nodeBin?: string;
  },
): Promise<InstalledRelease>;
export function parseCliArgs(argv: string[]): {
  flags: {
    skipTests: boolean;
    skipCheck: boolean;
    noRestart: boolean;
    noSystemd: boolean;
    keep: number;
  };
  positionals: string[];
};
