'use client';

import * as React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useTranslations } from 'next-intl';

export function CustomerMobileHeader({ locale }: { locale: string }) {
  const t = useTranslations('navigation');
  const tCommon = useTranslations('common');

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-neutral-200/60 shadow-sm pt-[env(safe-area-inset-top)]">
      <div className="flex items-center justify-center h-14 px-4">
        <Link
          href={`/${locale}`}
          className="flex items-center gap-2 group transition-all duration-300"
        >
          <Image
            src="/logo.png"
            alt={tCommon('brand')}
            width={36}
            height={36}
            className="rounded-lg shadow-sm group-hover:shadow-md transition-all duration-300"
          />
          <div className="flex flex-col">
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              Joho Foods
            </span>
            <span className="text-[10px] tracking-wider uppercase text-neutral-500 font-medium leading-tight">
              {t('tagline')}
            </span>
          </div>
        </Link>
      </div>
    </header>
  );
}
