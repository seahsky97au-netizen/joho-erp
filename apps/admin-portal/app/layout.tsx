import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { TRPCProvider } from './trpc-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { AmplitudeProvider } from '@joho-erp/shared/providers';
import { Toaster } from '@joho-erp/ui';
import type { Metadata } from 'next';
import localFont from 'next/font/local';

export const dynamic = 'force-dynamic';

const outfit = localFont({
  src: '../public/fonts/Outfit-Variable.woff2',
  variable: '--font-outfit',
  weight: '100 900',
  display: 'swap',
});

export const metadata: Metadata = {
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <AmplitudeProvider>
        <html lang="en" className={outfit.variable} suppressHydrationWarning>
          <body className="font-outfit antialiased">
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              enableSystem
              disableTransitionOnChange
            >
              <TRPCProvider>{children}</TRPCProvider>
              <Toaster />
            </ThemeProvider>
          </body>
        </html>
      </AmplitudeProvider>
    </ClerkProvider>
  );
}
