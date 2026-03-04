import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { AmplitudeProvider } from '@joho-erp/shared/providers';
import { TRPCProvider } from './trpc-provider';
import { Toaster } from '@joho-erp/ui';
import type { Metadata } from 'next';
import localFont from 'next/font/local';

const outfit = localFont({
  src: '../public/fonts/Outfit-Variable.woff2',
  variable: '--font-outfit',
  weight: '100 900',
  display: 'swap',
});

export const dynamic = 'force-dynamic';

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
        <html lang="en" className={outfit.variable}>
          <body className="font-outfit antialiased">
            <TRPCProvider>{children}</TRPCProvider>
            <Toaster />
          </body>
        </html>
      </AmplitudeProvider>
    </ClerkProvider>
  );
}
