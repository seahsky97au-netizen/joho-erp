import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import createMiddleware from 'next-intl/middleware';
import { locales } from './i18n/request';
import { NextResponse } from 'next/server';

const intlMiddleware = createMiddleware({
  locales,
  defaultLocale: 'en',
  localePrefix: 'always',
});

// Define public routes that don't require authentication
// Include both localized and non-localized paths to handle Clerk's default redirects
const isPublicRoute = createRouteMatcher([
  '/', // Root path - redirects to default locale
  '/en', // Localized home pages
  '/zh-TW',
  '/zh-CN',
  '/:locale/sign-in(.*)',
  '/:locale/sign-up(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  // Onboarding is semi-public (requires Clerk auth but not customer registration)
  '/:locale/onboarding(.*)',
  '/api/webhooks/(.*)', // Webhook endpoints use their own auth (svix)
]);

// Define patterns that should bypass i18n processing
// These are internal Clerk routes, API routes, and other non-localized paths
const isBypassRoute = (pathname: string) => {
  return (
    pathname.startsWith('/clerk_') ||
    pathname.startsWith('/__clerk') ||
    pathname.includes('/.clerk') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/trpc/')
  );
};

export default clerkMiddleware(async (auth, req) => {
  const pathname = req.nextUrl.pathname;

  // Handle routes that should bypass i18n middleware
  if (isBypassRoute(pathname)) {
    // Still apply auth protection if needed
    if (!isPublicRoute(req)) {
      await auth.protect();
    }

    return NextResponse.next();
  }

  // Apply internationalization middleware FIRST to handle locale routing
  // This ensures locale is properly extracted before auth checks
  const intlResponse = intlMiddleware(req);

  // Then check auth protection
  if (!isPublicRoute(req)) {
    await auth.protect();
  }

  return intlResponse;
});

export const config = {
  // Match all pathnames except for
  // - … if they have a file extension
  // - … if they are in the _next directory
  matcher: ['/((?!.+\\.[\\w]+$|_next).*)', '/', '/(api|trpc)(.*)'],
};
