import type { Plugin } from 'vite';

export interface ThirdPartyLicenseEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
  licenseText: string;
  noticeText?: string;
}

export interface ThirdPartyLicensesPluginOptions {
  extraPackages?: string[];
}

export function sanitizePackageUrl(raw: unknown): string | undefined;
export function resolvePackageDirFromModuleId(moduleId: string, nodeModulesDir: string): string | null;
export function readPackageLicense(packageDir: string, nodeModulesDir: string): ThirdPartyLicenseEntry;
export function collectLicensesFromDirs(
  packageDirs: Iterable<string>,
  nodeModulesDir: string,
): ThirdPartyLicenseEntry[];
export function collectLicensesFromPackageJson(
  projectRoot: string,
  extraPackages?: string[],
): ThirdPartyLicenseEntry[];
export function formatLicensesText(entries: ThirdPartyLicenseEntry[]): string;
export function thirdPartyLicensesPlugin(options?: ThirdPartyLicensesPluginOptions): Plugin;
