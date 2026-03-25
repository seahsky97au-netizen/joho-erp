'use client';

import { Search, X, TrendingUp, FileText, Users, ShoppingBag } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface QuickSearchProps {
  onClose: () => void;
}

export function QuickSearch({ onClose }: QuickSearchProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const t = useTranslations('quickSearch');

  const quickActions = [
    { id: 1, label: t('actions.newCustomer'), icon: Users, path: '/customers/new' },
    { id: 2, label: t('actions.newOrder'), icon: ShoppingBag, path: '/orders/new' },
    { id: 3, label: t('actions.viewAnalytics'), icon: TrendingUp, path: '/analytics' },
    { id: 4, label: t('actions.inventoryReport'), icon: FileText, path: '/reports/inventory' },
  ];

  useEffect(() => {
    // Focus input on mount
    inputRef.current?.focus();

    // Handle keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleAction = (path: string) => {
    router.push(path);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] animate-in fade-in-0 duration-200">
      <div className="flex items-start justify-center pt-20 px-4">
        <div className="w-full max-w-2xl bg-popover border border-border rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 fade-in-0 duration-200">
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-4 border-b border-border">
            <Search className="w-5 h-5 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder={t('placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground text-base"
            />
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search Results / Quick Actions */}
          <div className="max-h-[500px] overflow-y-auto">
            {!searchQuery && (
              <>
                {/* Quick Actions */}
                <div className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('quickActions')}
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {quickActions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          onClick={() => handleAction(action.path)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border hover:bg-muted hover:border-primary/50 transition-all text-left group"
                        >
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                            <Icon className="w-4 h-4 text-primary" />
                          </div>
                          <span className="text-sm font-medium text-foreground">{action.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* Search Results (when typing) */}
            {searchQuery && (
              <div className="px-4 py-3">
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t('noResults')} &ldquo;{searchQuery}&rdquo;
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center justify-between">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">↑</kbd>
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">↓</kbd>
                <span>{t('hints.navigate')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">↵</kbd>
                <span>{t('hints.select')}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono">esc</kbd>
              <span>{t('hints.close')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
