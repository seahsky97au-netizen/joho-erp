'use client';

import * as React from 'react';
import { UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Home, Package, ShoppingBag, User } from 'lucide-react';
import { LanguageSwitcher } from '@joho-erp/ui';
import { CartButton, CartButtonStyles, MiniCartDrawer } from './mini-cart';


interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function CustomerDesktopNav({ locale }: { locale: string }) {
  const t = useTranslations('navigation');
  const tCommon = useTranslations('common');
  const pathname = usePathname();
  const [isCartOpen, setIsCartOpen] = React.useState(false);

  // Cart removed from navItems - now in right section
  const navItems: NavItem[] = [
    { href: `/${locale}`, labelKey: 'home', icon: Home },
    { href: `/${locale}/products`, labelKey: 'products', icon: Package },
    { href: `/${locale}/orders`, labelKey: 'myOrders', icon: ShoppingBag },
    { href: `/${locale}/profile`, labelKey: 'profile', icon: User },
  ];

  const isActive = (href: string) => {
    if (href === `/${locale}`) {
      return pathname === `/${locale}` || pathname === `/${locale}/`;
    }
    return pathname?.startsWith(href);
  };

  return (
    <>
      {/* Animation styles */}
      <CartButtonStyles />

      {/* Grain texture overlay */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.015]">
        <div className="absolute inset-0 bg-noise" />
      </div>

      {/* Main navigation bar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-gradient-to-b from-white via-white to-white/98 backdrop-blur-sm border-b border-neutral-200/60 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-6 lg:px-12">
          <div className="flex items-center justify-between h-20">
            {/* Logo section */}
            <Link
              href={`/${locale}`}
              className="flex items-center gap-3 group transition-all duration-300"
            >
              <Image
                src="/logo.png"
                alt={tCommon('brand')}
                width={48}
                height={48}
                className="rounded-xl shadow-md group-hover:shadow-lg transition-all duration-300 group-hover:scale-105"
              />

              <div className="flex flex-col">
                <span className="text-xl font-semibold tracking-tight text-neutral-900 group-hover:text-primary transition-colors duration-300">
                  Joho Foods
                </span>
                <span className="text-xs tracking-wider uppercase text-neutral-500 font-medium">
                  {t('tagline')}
                </span>
              </div>
            </Link>

            
            {/* Navigation items - centered */}
            <div className="hidden xl:flex items-center gap-2">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`
                      group relative px-6 py-3 rounded-lg font-medium text-sm
                      transition-all duration-300 ease-out
                      ${active
                        ? 'text-white'
                        : 'text-neutral-700 hover:text-neutral-900'
                      }
                    `}
                  >
                    {/* Active background */}
                    {active && (
                      <div className="absolute inset-0 bg-gradient-to-br from-primary to-primary/90 rounded-lg shadow-md" />
                    )}

                    {/* Hover background */}
                    {!active && (
                      <div className="absolute inset-0 bg-neutral-100 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                    )}

                    {/* Content */}
                    <div className="relative flex items-center gap-2">
                      <Icon className={`w-4 h-4 transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110'}`} />
                      <span className="tracking-wide">{t(item.labelKey)}</span>
                    </div>

                    {/* Active indicator line */}
                    {active && (
                      <div className="absolute -bottom-[17px] left-1/2 -translate-x-1/2 w-12 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
                    )}
                  </Link>
                );
              })}
            </div>

            {/* Compact nav for smaller desktops */}
            <div className="flex xl:hidden items-center gap-2">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`
                      group relative p-3 rounded-lg
                      transition-all duration-300 ease-out
                      ${active
                        ? 'text-white bg-gradient-to-br from-primary to-primary/90 shadow-md'
                        : 'text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100'
                      }
                    `}
                    title={t(item.labelKey)}
                  >
                    <div className="relative">
                      <Icon className={`w-5 h-5 transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110'}`} />
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Right section - Cart + User controls */}
            <div className="flex items-center gap-3">
              {/* Cart Button - Prominent position */}
              <CartButton
                onClick={() => setIsCartOpen(true)}
                className="hidden md:flex"
              />

              <div className="hidden md:block">
                <LanguageSwitcher />
              </div>

              <div className="h-10 w-px bg-neutral-200" />

              <div className="relative">
                {/* Glow effect on hover */}
                <div className="absolute inset-0 bg-primary rounded-full opacity-0 hover:opacity-20 blur-xl transition-opacity duration-500" />
                <UserButton
                  afterSignOutUrl={`/${locale}/sign-in`}
                  appearance={{
                    elements: {
                      avatarBox: 'w-10 h-10 ring-2 ring-neutral-200 hover:ring-primary transition-all duration-300',
                    },
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Bottom gradient line for depth */}
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neutral-300 to-transparent opacity-50" />
      </nav>

      {/* Spacer to prevent content from going under fixed nav */}
      <div className="h-20" />

      {/* Mini Cart Drawer */}
      <MiniCartDrawer
        open={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        locale={locale}
      />
    </>
  );
}
