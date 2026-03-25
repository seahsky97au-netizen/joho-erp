'use client';

import * as React from 'react';
import { AdminMobileDrawer } from './admin-mobile-drawer';
import { AdminDesktopSidebar } from './admin-desktop-sidebar';
import { TopNavigationBar } from './top-navigation-bar';
import { PermissionProvider } from './permission-provider';
import { MobileAppBar } from '@joho-erp/ui';
import { useIsMobileOrTablet } from '@joho-erp/ui';
import { UserButton } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { Button } from '@joho-erp/ui';
import type { SerializableUser } from '@/types/user';

export function AdminLayoutWrapper({
  children,
  locale,
  title,
  user,
}: {
  children: React.ReactNode;
  locale: string;
  title?: string;
  user: SerializableUser;
}) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const isMobileOrTablet = useIsMobileOrTablet();
  const t = useTranslations('common');

  return (
    <PermissionProvider>
      {isMobileOrTablet ? (
        <>
          <MobileAppBar
            title={title}
            onMenuClick={() => setDrawerOpen(true)}
            rightActions={
              <>
                <Button variant="ghost" size="icon" aria-label={t('aria.notifications')}>
                  <Bell className="h-5 w-5" />
                </Button>
                <UserButton />
              </>
            }
          />
          <AdminMobileDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            locale={locale}
            user={user}
          />
          <main>{children}</main>
        </>
      ) : (
        <>
          {/* Top Navigation Bar - Desktop Only */}
          <TopNavigationBar />

          {/* Sidebar - Desktop Only */}
          <AdminDesktopSidebar
            locale={locale}
            onCollapsedChange={setSidebarCollapsed}
          />

          {/* Main Content Area with top nav spacing */}
          <main
            className="transition-all duration-300 pt-16"
            style={{ marginLeft: sidebarCollapsed ? '80px' : '280px' }}
          >
            {children}
          </main>
        </>
      )}
    </PermissionProvider>
  );
}
