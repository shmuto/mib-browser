import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import {
  sanitizePackageUrl,
  resolvePackageDirFromModuleId,
  readPackageLicense,
  collectLicensesFromPackageJson,
  formatLicensesText,
} from '../scripts/third-party-licenses.mjs';

const projectRoot = path.resolve(import.meta.dir, '..');
const nodeModulesDir = path.join(projectRoot, 'node_modules');

describe('sanitizePackageUrl', () => {
  test('normalizes standard and git repository URLs', () => {
    expect(sanitizePackageUrl('https://lucide.dev')).toBe('https://lucide.dev/');
    expect(sanitizePackageUrl('git+https://github.com/facebook/react.git')).toBe(
      'https://github.com/facebook/react',
    );
    expect(sanitizePackageUrl('git://github.com/example/repo.git')).toBe(
      'https://github.com/example/repo',
    );
    expect(sanitizePackageUrl('timolins/react-hot-toast')).toBe(
      'https://github.com/timolins/react-hot-toast',
    );
    expect(sanitizePackageUrl('github:owner/repo')).toBe('https://github.com/owner/repo');
    expect(
      sanitizePackageUrl({
        type: 'git',
        url: 'https://github.com/tailwindlabs/tailwindcss.git#v3',
      }),
    ).toBe('https://github.com/tailwindlabs/tailwindcss');
  });

  test('rejects unsafe URL schemes and invalid values', () => {
    expect(sanitizePackageUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizePackageUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(sanitizePackageUrl('file:///etc/passwd')).toBeUndefined();
    expect(sanitizePackageUrl('')).toBeUndefined();
    expect(sanitizePackageUrl(null)).toBeUndefined();
    expect(sanitizePackageUrl(undefined)).toBeUndefined();
  });
});

describe('resolvePackageDirFromModuleId', () => {
  test('resolves enclosing package directories inside node_modules', () => {
    const reactEntry = path.join(nodeModulesDir, 'react', 'index.js') + '?commonjs-exports';
    expect(resolvePackageDirFromModuleId(reactEntry, nodeModulesDir)).toBe(
      path.join(nodeModulesDir, 'react'),
    );

    const lucideEntry = path.join(nodeModulesDir, 'lucide-react', 'dist', 'esm', 'lucide-react.mjs');
    expect(resolvePackageDirFromModuleId(lucideEntry, nodeModulesDir)).toBe(
      path.join(nodeModulesDir, 'lucide-react'),
    );
  });

  test('ignores virtual modules and paths outside node_modules', () => {
    expect(resolvePackageDirFromModuleId('\0commonjsHelpers.js', nodeModulesDir)).toBeNull();
    expect(
      resolvePackageDirFromModuleId(path.join(projectRoot, 'src', 'App.tsx'), nodeModulesDir),
    ).toBeNull();
    expect(
      resolvePackageDirFromModuleId(path.join(nodeModulesDir, '..', 'package.json'), nodeModulesDir),
    ).toBeNull();
  });
});

describe('readPackageLicense', () => {
  test('refuses to read packages outside node_modules', () => {
    expect(() => readPackageLicense(projectRoot, nodeModulesDir)).toThrow(
      /outside node_modules/i,
    );
  });

  test('reads license metadata and text for an installed package', () => {
    const entry = readPackageLicense(path.join(nodeModulesDir, 'lucide-react'), nodeModulesDir);
    expect(entry.name).toBe('lucide-react');
    expect(entry.license).toBe('ISC');
    expect(entry.licenseText).toContain('ISC License');
    expect(entry.licenseText).toContain('Feather');
    expect(entry.repository).toBe('https://lucide.dev/');
  });
});

describe('collectLicensesFromPackageJson', () => {
  test('collects all bundled runtime dependencies plus tailwindcss without dev tools', () => {
    const entries = collectLicensesFromPackageJson(projectRoot, ['tailwindcss']);
    const names = entries.map((e) => e.name);

    expect(names).toEqual([
      'goober',
      'lucide-react',
      'react',
      'react-dom',
      'react-hot-toast',
      'scheduler',
      'tailwindcss',
    ]);

    expect(names).not.toContain('react-icons');
    expect(names).not.toContain('vite');
    expect(names).not.toContain('typescript');

    for (const entry of entries) {
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.license.length).toBeGreaterThan(0);
      expect(entry.licenseText.length).toBeGreaterThan(50);
    }
  });
});

describe('formatLicensesText', () => {
  test('formats entries with headers, optional homepage, and optional notice', () => {
    const text = formatLicensesText([
      {
        name: 'example-lib',
        version: '1.2.3',
        license: 'MIT',
        repository: 'https://example.com/lib',
        licenseText: 'MIT License text',
        noticeText: 'Additional notice',
      },
    ]);

    expect(text).toContain('THIRD-PARTY SOFTWARE NOTICES AND INFORMATION');
    expect(text).toContain('example-lib (1.2.3)');
    expect(text).toContain('License: MIT');
    expect(text).toContain('Homepage: https://example.com/lib');
    expect(text).toContain('MIT License text');
    expect(text).toContain('--- NOTICE ---');
    expect(text).toContain('Additional notice');
  });
});
