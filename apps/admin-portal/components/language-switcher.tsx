'use client';

import { Languages, Check } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, usePathname } from 'next/navigation';

const languages = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'zh-TW', name: '繁體中文', flag: '🇹🇼' },
  { code: 'zh-CN', name: '简体中文', flag: '🇨🇳' },
];

export function LanguageSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');

  const currentLanguage = languages.find((lang) => lang.code === locale) || languages[0];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLanguageChange = (langCode: string) => {
    const newPathname = pathname.replace(`/${locale}`, `/${langCode}`);
    router.push(newPathname);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        aria-label={t('aria.changeLanguage')}
      >
        <Languages className="w-5 h-5" />
        <span className="hidden lg:inline-block text-sm font-medium">
          {currentLanguage.flag}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-12 w-56 bg-popover border border-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in-0 duration-200 z-50">
          {/* Header */}
          <div className="px-4 py-2.5 border-b border-border bg-muted/30">
            <h3 className="font-semibold text-sm">{t('selectLanguage')}</h3>
          </div>

          {/* Language Options */}
          <div className="py-1">
            {languages.map((language) => {
              const isActive = language.code === locale;
              return (
                <button
                  key={language.code}
                  onClick={() => handleLanguageChange(language.code)}
                  className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted/50 transition-colors ${
                    isActive ? 'bg-primary/5' : ''
                  }`}
                >
                  <span className="text-xl">{language.flag}</span>
                  <span className="flex-1 text-left text-sm font-medium text-foreground">
                    {language.name}
                  </span>
                  {isActive && (
                    <Check className="w-4 h-4 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
