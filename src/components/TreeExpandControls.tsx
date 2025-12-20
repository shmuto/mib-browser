import { ChevronsDown, ChevronsUp } from 'lucide-react';

interface TreeExpandControlsProps {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  compactMode: boolean;
  onToggleCompactMode: () => void;
}

export default function TreeExpandControls({
  onExpandAll,
  onCollapseAll,
  compactMode,
  onToggleCompactMode
}: TreeExpandControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onExpandAll}
        className="px-3 py-1.5 text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors flex items-center gap-1.5"
        title="Expand All"
      >
        <ChevronsDown size={14} />
        <span>Expand All</span>
      </button>

      <button
        onClick={onCollapseAll}
        className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded transition-colors flex items-center gap-1.5"
        title="Collapse All"
      >
        <ChevronsUp size={14} />
        <span>Collapse All</span>
      </button>

      <div className="ml-2 flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={compactMode}
            onChange={onToggleCompactMode}
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
          />
          <span className="text-xs text-gray-700">Compact View</span>
        </label>
      </div>
    </div>
  );
}
