import { useState, useCallback } from 'react';
import { X, AlertCircle, CheckCircle, AlertTriangle, Info, ChevronDown, ChevronUp } from 'lucide-react';

export interface Notification {
  id: string;
  type: 'error' | 'warning' | 'success' | 'info';
  title: string;
  details?: string[];
  timestamp: number;
}

interface NotificationPanelProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}

export default function NotificationPanel({ notifications, onDismiss, onClearAll }: NotificationPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (notifications.length === 0) return null;

  const errorCount = notifications.filter(n => n.type === 'error').length;
  const warningCount = notifications.filter(n => n.type === 'warning').length;

  const getIcon = (type: Notification['type']) => {
    switch (type) {
      case 'error':
        return <AlertCircle size={16} className="text-red-500 flex-shrink-0" />;
      case 'warning':
        return <AlertTriangle size={16} className="text-amber-500 flex-shrink-0" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-500 flex-shrink-0" />;
      case 'info':
        return <Info size={16} className="text-blue-500 flex-shrink-0" />;
    }
  };

  const getBgColor = (type: Notification['type']) => {
    switch (type) {
      case 'error':
        return 'bg-red-50 border-red-200';
      case 'warning':
        return 'bg-amber-50 border-amber-200';
      case 'success':
        return 'bg-green-50 border-green-200';
      case 'info':
        return 'bg-blue-50 border-blue-200';
    }
  };

  return (
    <div className="bg-white border-b border-gray-200 shadow-sm">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-gray-50"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">
            Notifications
          </span>
          <div className="flex items-center gap-2">
            {errorCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded-full">
                {errorCount} error{errorCount > 1 ? 's' : ''}
              </span>
            )}
            {warningCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                {warningCount} warning{warningCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClearAll();
            }}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 hover:bg-gray-100 rounded"
          >
            Clear all
          </button>
          {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </div>
      </div>

      {/* Notification List */}
      {!isCollapsed && (
        <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto">
          {notifications.map((notification) => (
            <div
              key={notification.id}
              className={`flex items-start gap-2 p-2 rounded border ${getBgColor(notification.type)}`}
            >
              {getIcon(notification.type)}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">
                  {notification.title}
                </div>
                {notification.details && notification.details.length > 0 && (
                  <div className="mt-1 text-xs text-gray-600 space-y-0.5">
                    {notification.details.map((detail, i) => (
                      <div key={i} className="truncate" title={detail}>
                        • {detail}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-1 text-xs text-gray-400">
                  {new Date(notification.timestamp).toLocaleTimeString()}
                </div>
              </div>
              <button
                onClick={() => onDismiss(notification.id)}
                className="p-1 hover:bg-gray-200 rounded flex-shrink-0"
              >
                <X size={14} className="text-gray-500" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Hook for managing notifications
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const addNotification = useCallback((
    type: Notification['type'],
    title: string,
    details?: string[]
  ) => {
    const notification: Notification = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      title,
      details,
      timestamp: Date.now(),
    };
    setNotifications(prev => [notification, ...prev]);
    return notification.id;
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return {
    notifications,
    addNotification,
    dismissNotification,
    clearAllNotifications,
  };
}
