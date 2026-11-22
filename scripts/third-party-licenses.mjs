import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalizes a package.json homepage or repository field into a safe http(s) URL.
 * Returns undefined for missing values or unsafe schemes (e.g. javascript:, file:).
 *
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function sanitizePackageUrl(raw) {
  let candidate = '';

  if (typeof raw === 'string') {
    candidate = raw.trim();
  } else if (raw && typeof raw === 'object' && typeof raw.url === 'string') {
    candidate = raw.url.trim();
  }

  if (!candidate) return undefined;

  // Handle npm repository shorthand forms: "owner/repo", "github:owner/repo"
  if (/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    candidate = `https://github.com/${candidate.slice('github:'.length)}`;
  } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    candidate = `https://github.com/${candidate}`;
  }

  // Strip common git URL prefixes/suffixes
  candidate = candidate.replace(/^git\+/, '');
  if (candidate.startsWith('git://')) {
    candidate = `https://${candidate.slice('git://'.length)}`;
  }
  candidate = candidate.replace(/\.git(#.*)?$/, '');

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether `targetPath` is strictly inside `rootDir` after symlink resolution.
 *
 * @param {string} targetPath
 * @param {string} rootDir
 * @returns {boolean}
 */
function isWithinRealDir(targetPath, rootDir) {
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realTarget = fs.realpathSync(targetPath);
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Walks upward from a bundled module ID to find its enclosing package directory
 * inside `node_modules`. Ignores virtual modules, query suffixes, and files
 * outside `node_modules`.
 *
 * @param {string} moduleId
 * @param {string} nodeModulesDir
 * @returns {string | null}
 */
export function resolvePackageDirFromModuleId(moduleId, nodeModulesDir) {
  if (!moduleId || moduleId.startsWith('\0')) return null;

  const cleanId = moduleId.split('?')[0].split('#')[0];
  if (!path.isAbsolute(cleanId)) return null;

  const normalizedNodeModules = path.resolve(nodeModulesDir);
  if (!isWithinRealDir(cleanId, normalizedNodeModules)) return null;

  let currentDir = fs.existsSync(cleanId) && fs.statSync(cleanId).isDirectory()
    ? cleanId
    : path.dirname(cleanId);

  while (isWithinRealDir(currentDir, normalizedNodeModules) && currentDir !== normalizedNodeModules) {
    const pkgJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        // Skip internal ESM/CJS marker package.json files like { "type": "module" }
        if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
          return currentDir;
        }
      } catch {
        // Keep walking upward if malformed
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return null;
}

/**
 * Reads a matching text file (e.g. LICENSE or NOTICE) directly inside `packageDir`.
 * Only reads regular files residing within `nodeModulesDir`.
 *
 * @param {string} packageDir
 * @param {string} nodeModulesDir
 * @param {RegExp} pattern
 * @returns {string | undefined}
 */
function readPackageNoticeFile(packageDir, nodeModulesDir, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(packageDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const matched = entries
    .filter((entry) => pattern.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

  for (const fileName of matched) {
    const filePath = path.join(packageDir, fileName);
    if (!isWithinRealDir(filePath, nodeModulesDir)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    } catch {
      // Try next candidate
    }
  }

  return undefined;
}

/**
 * Reads license metadata and full license text for a single package directory.
 * Never executes any code from the package — reads JSON and text files only.
 *
 * @param {string} packageDir
 * @param {string} nodeModulesDir
 */
export function readPackageLicense(packageDir, nodeModulesDir) {
  if (!isWithinRealDir(packageDir, nodeModulesDir)) {
    throw new Error(`Refusing to read package outside node_modules: ${packageDir}`);
  }

  const pkgJsonPath = path.join(packageDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const name = typeof pkg.name === 'string' ? pkg.name : path.basename(packageDir);
  const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  const license = typeof pkg.license === 'string'
    ? pkg.license
    : pkg.license && typeof pkg.license.type === 'string'
      ? pkg.license.type
      : 'UNKNOWN';

  const repository = sanitizePackageUrl(pkg.homepage) ?? sanitizePackageUrl(pkg.repository);
  const licenseText = readPackageNoticeFile(packageDir, nodeModulesDir, /^licen[cs]e(\.(txt|md))?$/i);
  const noticeText = readPackageNoticeFile(packageDir, nodeModulesDir, /^notice(\.(txt|md))?$/i);

  if (!licenseText) {
    throw new Error(`Missing LICENSE file for bundled package "${name}@${version}" in ${packageDir}`);
  }

  return {
    name,
    version,
    license,
    ...(repository ? { repository } : {}),
    licenseText,
    ...(noticeText ? { noticeText } : {}),
  };
}

/**
 * Resolves a package name from `nodeModulesDir` (supporting scoped packages).
 *
 * @param {string} packageName
 * @param {string} nodeModulesDir
 * @returns {string | null}
 */
function resolveInstalledPackageDir(packageName, nodeModulesDir) {
  const candidate = path.resolve(nodeModulesDir, ...packageName.split('/'));
  if (!isWithinRealDir(candidate, nodeModulesDir)) return null;
  if (!fs.existsSync(path.join(candidate, 'package.json'))) return null;
  return candidate;
}

/**
 * Collects license entries from a set of package directories, deduplicated by name@version
 * and sorted alphabetically.
 *
 * @param {Iterable<string>} packageDirs
 * @param {string} nodeModulesDir
 */
export function collectLicensesFromDirs(packageDirs, nodeModulesDir) {
  const seen = new Map();

  for (const dir of packageDirs) {
    if (!dir || !isWithinRealDir(dir, nodeModulesDir)) continue;
    const entry = readPackageLicense(dir, nodeModulesDir);
    const key = `${entry.name}@${entry.version}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  return Array.from(seen.values()).sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * Checks whether a package appears to ship runtime JS code (as opposed to types-only
 * packages like `csstype` that do not end up in the browser bundle).
 *
 * Packages without an explicit entry field still resolve to `index.js` by default
 * (e.g. `scheduler` used by `react-dom`), so that file counts as an entrypoint too.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string} pkgDir
 * @returns {boolean}
 */
function hasRuntimeEntrypoint(pkg, pkgDir) {
  if (pkg.main || pkg.module || pkg.browser || pkg.exports) return true;
  return fs.existsSync(path.join(pkgDir, 'index.js'));
}

/**
 * Collects runtime dependency licenses starting from root package.json `dependencies`
 * plus any explicitly listed extra packages (e.g. `tailwindcss`).
 * Used by the dev server where no Rollup bundle graph exists yet.
 *
 * @param {string} projectRoot
 * @param {string[]} [extraPackages]
 */
export function collectLicensesFromPackageJson(projectRoot, extraPackages = []) {
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const queue = Object.keys(rootPkg.dependencies ?? {});
  const visitedNames = new Set();
  const packageDirs = new Set();

  // Packages that are only build-time CJS env helpers and never survive bundling
  const ignoredTransitive = new Set(['loose-envify', 'js-tokens']);

  while (queue.length > 0) {
    const pkgName = queue.shift();
    if (!pkgName || visitedNames.has(pkgName) || ignoredTransitive.has(pkgName)) continue;
    visitedNames.add(pkgName);

    const pkgDir = resolveInstalledPackageDir(pkgName, nodeModulesDir);
    if (!pkgDir) continue;

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (hasRuntimeEntrypoint(pkg, pkgDir)) {
      packageDirs.add(pkgDir);
    }

    for (const depName of Object.keys(pkg.dependencies ?? {})) {
      if (!visitedNames.has(depName)) {
        queue.push(depName);
      }
    }
  }

  for (const extraName of extraPackages) {
    const pkgDir = resolveInstalledPackageDir(extraName, nodeModulesDir);
    if (pkgDir) {
      packageDirs.add(pkgDir);
    }
  }

  return collectLicensesFromDirs(packageDirs, nodeModulesDir);
}

/**
 * Formats collected license entries into a human-readable THIRD-PARTY-LICENSES.txt file.
 *
 * @param {Array<{name: string, version: string, license: string, repository?: string, licenseText: string, noticeText?: string}>} entries
 * @returns {string}
 */
export function formatLicensesText(entries) {
  const header = [
    'THIRD-PARTY SOFTWARE NOTICES AND INFORMATION',
    '',
    'This application incorporates the following open-source software.',
    '',
  ].join('\n');

  const separator = '='.repeat(80);
  const body = entries
    .map((entry) => {
      const lines = [
        separator,
        `${entry.name} (${entry.version})`,
        `License: ${entry.license}`,
      ];
      if (entry.repository) {
        lines.push(`Homepage: ${entry.repository}`);
      }
      lines.push('', entry.licenseText);
      if (entry.noticeText) {
        lines.push('', '--- NOTICE ---', '', entry.noticeText);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return `${header}\n${body}\n`;
}

/**
 * Vite plugin that collects third-party licenses directly from local `node_modules`
 * without adding any external build dependency.
 *
 * - On build: inspects Rollup's actual bundled module IDs (+ `extraPackages`) and
 *   emits both `THIRD-PARTY-LICENSES.txt` and `third-party-licenses.json` into `dist/`.
 * - On dev server: serves the same two endpoints dynamically from `package.json`.
 *
 * @param {{ extraPackages?: string[] }} [options]
 */
export function thirdPartyLicensesPlugin(options = {}) {
  const extraPackages = options.extraPackages ?? ['tailwindcss'];
  let projectRoot = process.cwd();
  let base = '/';

  return {
    name: 'third-party-licenses',

    configResolved(config) {
      projectRoot = config.root;
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        const jsonPath = `${base}third-party-licenses.json`;
        const txtPath = `${base}THIRD-PARTY-LICENSES.txt`;

        if (pathname !== jsonPath && pathname !== txtPath) {
          next();
          return;
        }

        try {
          const entries = collectLicensesFromPackageJson(projectRoot, extraPackages);
          if (pathname === jsonPath) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(entries, null, 2));
          } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(formatLicensesText(entries));
          }
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(error instanceof Error ? error.message : 'Failed to collect licenses');
        }
      });
    },

    generateBundle(_outputOptions, bundle) {
      const nodeModulesDir = path.join(projectRoot, 'node_modules');
      const packageDirs = new Set();

      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk' || !item.modules) continue;
        for (const moduleId of Object.keys(item.modules)) {
          const pkgDir = resolvePackageDirFromModuleId(moduleId, nodeModulesDir);
          if (pkgDir) {
            packageDirs.add(pkgDir);
          }
        }
      }

      for (const extraName of extraPackages) {
        const pkgDir = resolveInstalledPackageDir(extraName, nodeModulesDir);
        if (pkgDir) {
          packageDirs.add(pkgDir);
        }
      }

      const entries = collectLicensesFromDirs(packageDirs, nodeModulesDir);

      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.json',
        source: JSON.stringify(entries, null, 2) + '\n',
      });

      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-LICENSES.txt',
        source: formatLicensesText(entries),
      });
    },
  };
}
