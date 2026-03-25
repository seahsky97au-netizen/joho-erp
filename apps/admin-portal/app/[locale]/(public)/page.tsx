import { SignInButton, SignUpButton } from '@clerk/nextjs';
import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@joho-erp/ui';
import Image from 'next/image';

export const dynamic = 'force-dynamic';

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale });

  return (
    <main className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between p-6 border-b">
        <div className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt={t('common.brand')}
            width={40}
            height={40}
            className="rounded-lg"
          />
          <h1 className="text-2xl font-bold">Joho Foods ERP</h1>
        </div>
        <LanguageSwitcher />
      </header>

      {/* Hero Section */}
      <section className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="max-w-md w-full text-center space-y-8">
          {/* Logo/Brand */}
          <div className="space-y-4">
            <h2 className="text-4xl font-bold tracking-tight">
              {t('common.welcome')}
            </h2>
            <p className="text-xl text-muted-foreground">
              {t('landing.subtitle')}
            </p>
          </div>

          {/* Auth Buttons */}
          <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
            <SignInButton mode="modal">
              <button className="w-full sm:w-auto px-8 py-3 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                {t('common.signIn')}
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="w-full sm:w-auto px-8 py-3 bg-secondary text-secondary-foreground font-semibold rounded-lg hover:bg-secondary/80 transition-colors border">
                {t('common.signUp')}
              </button>
            </SignUpButton>
          </div>
        </div>
      </section>
    </main>
  );
}
