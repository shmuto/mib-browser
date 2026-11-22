import { useEffect, useState } from 'react';
import { ExternalLink, Scale, X } from 'lucide-react';

interface ThirdPartyLicenseEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
  licenseText: string;
  noticeText?: string;
}

interface LicensesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function isSafeHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isLicenseEntry(value: unknown): value is ThirdPartyLicenseEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.version === 'string' &&
    typeof entry.license === 'string' &&
    typeof entry.licenseText === 'string' &&
    (entry.repository === undefined || typeof entry.repository === 'string') &&
    (entry.noticeText === undefined || typeof entry.noticeText === 'string')
  );
}

// Module-level cache so reopening the modal does not re-fetch the static file
let cachedLicenses: ThirdPartyLicenseEntry[] | null = null;

export default function LicensesModal({ isOpen, onClose }: LicensesModalProps) {
  const [licenses, setLicenses] = useState<ThirdPartyLicenseEntry[] | null>(cachedLicenses);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rawTextUrl = `${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`;

  // Close on ESC key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch generated license notices on first open
  useEffect(() => {
    if (!isOpen || cachedLicenses !== null) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`${import.meta.env.BASE_URL}third-party-licenses.json`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!Array.isArray(data) || !data.every(isLicenseEntry)) {
          throw new Error('Unexpected license manifest format');
        }
        cachedLicenses = data;
        setLicenses(data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load license notices');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={handleBackgroundClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="licenses-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <Scale size={20} className="text-gray-600" />
            <div>
              <h2 id="licenses-modal-title" className="text-lg font-semibold text-gray-800">
                Open Source Licenses
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Third-party libraries bundled in this application
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded transition-colors"
            title="Close"
            aria-label="Close"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {loading && (
            <p className="text-sm text-gray-500 text-center py-8">Loading license notices...</p>
          )}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-4">
              Could not load license notices ({error}). You can view the raw text file directly:{' '}
              <a
                href={rawTextUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                THIRD-PARTY-LICENSES.txt
              </a>
            </div>
          )}

          {licenses &&
            licenses.map((entry) => (
              <section
                key={`${entry.name}@${entry.version}`}
                className="border border-gray-200 rounded-lg overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-800">{entry.name}</h3>
                    <span className="text-xs text-gray-500 font-mono">v{entry.version}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium">
                      {entry.license}
                    </span>
                  </div>
                  {isSafeHttpUrl(entry.repository) && (
                    <a
                      href={entry.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      <span>Project</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <pre className="text-xs font-mono bg-white p-4 text-gray-700 whitespace-pre-wrap break-words">
                  {entry.licenseText}
                </pre>
                {entry.noticeText && (
                  <div className="border-t border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs font-semibold text-gray-600 mb-2">NOTICE</p>
                    <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap break-words">
                      {entry.noticeText}
                    </pre>
                  </div>
                )}
              </section>
            ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex items-center justify-between gap-4">
          <a
            href={rawTextUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 hover:underline"
          >
            <span>THIRD-PARTY-LICENSES.txt</span>
            <ExternalLink size={12} />
          </a>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
