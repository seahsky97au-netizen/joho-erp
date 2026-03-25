'use client';

import { X, ShoppingBag } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

interface NotificationsDropdownProps {
  onClose: () => void;
}

export function NotificationsDropdown({ onClose }: NotificationsDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('notifications');

  const notifications: Array<{
    id: number;
    type: string;
    icon: typeof ShoppingBag;
    title: string;
    description: string;
    time: string;
    unread: boolean;
  }> = [];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <div
      ref={dropdownRef}
      className="absolute right-0 top-12 w-96 bg-popover border border-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in-0 duration-200"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">{t('title')}</h3>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
                {unreadCount}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Notifications List */}
      <div className="max-h-[400px] overflow-y-auto">
        {notifications.map((notification) => {
          const Icon = notification.icon;
          return (
            <div
              key={notification.id}
              className={`px-4 py-3 border-b border-border last:border-0 hover:bg-muted/50 transition-colors cursor-pointer ${
                notification.unread ? 'bg-primary/5' : ''
              }`}
            >
              <div className="flex gap-3">
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    notification.type === 'order'
                      ? 'bg-success/10 text-success'
                      : notification.type === 'customer'
                        ? 'bg-info/10 text-info'
                        : notification.type === 'inventory'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-medium text-sm text-foreground line-clamp-1">
                      {notification.title}
                    </p>
                    {notification.unread && (
                      <div className="w-2 h-2 bg-primary rounded-full flex-shrink-0 mt-1" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-1">
                    {notification.description}
                  </p>
                  <p className="text-xs text-muted-foreground">{notification.time}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border bg-muted/30">
        <button className="w-full text-sm font-medium text-primary hover:text-primary/80 transition-colors py-1">
          {t('markAllAsRead')}
        </button>
      </div>
    </div>
  );
}
