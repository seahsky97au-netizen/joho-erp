import { SignInButton, SignUpButton } from '@clerk/nextjs';
import { currentUser } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import Image from 'next/image';
import { Star, Truck, DollarSign, HeadphonesIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button, LanguageSwitcher } from '@joho-erp/ui';
import { CategoryGrid } from '@/components/category-grid';

export const dynamic = 'force-dynamic';

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  let user, t;
  try {
    user = await currentUser();
    t = await getTranslations({ locale });
  } catch (error) {
    console.error('[Home Page] ERROR:', error);
    throw error;
  }

  const features = [
    {
      title: t('home.features.quality.title'),
      description: t('home.features.quality.description'),
      icon: Star,
    },
    {
      title: t('home.features.delivery.title'),
      description: t('home.features.delivery.description'),
      icon: Truck,
    },
    {
      title: t('home.features.pricing.title'),
      description: t('home.features.pricing.description'),
      icon: DollarSign,
    },
    {
      title: t('home.features.service.title'),
      description: t('home.features.service.description'),
      icon: HeadphonesIcon,
    },
  ];

  return (
    <main className="flex min-h-screen flex-col">
      {/* Header - only show for unauthenticated users (signed-in users see CustomerDesktopNav) */}
      {!user && (
        <header className="border-b">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <Image
                src="/logo.png"
                alt={t('common.brand')}
                width={40}
                height={40}
                className="rounded-lg"
              />
              <h1 className="text-2xl font-bold">Joho Foods</h1>
            </div>
            <div className="flex gap-4 items-center">
              <LanguageSwitcher />
              <SignInButton mode="modal">
                <Button variant="outline">
                  {t('common.signIn')}
                </Button>
              </SignInButton>
              <SignUpButton mode="modal">
                <Button>
                  {t('common.signUp', { default: 'Sign Up' })}
                </Button>
              </SignUpButton>
            </div>
          </div>
        </header>
      )}

      {/* Hero Section */}
      <section className="bg-gradient-to-b from-primary/10 to-white dark:from-gray-900 dark:to-gray-800 py-12 md:py-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-3xl md:text-5xl font-bold mb-4 md:mb-6">
            {t('home.heroTitle')}
          </h1>
          <p className="text-base md:text-xl text-muted-foreground mb-6 md:mb-8 max-w-2xl mx-auto">
            {t('home.heroDescription')}
          </p>
          <div className="flex gap-4 justify-center">
            {user ? (
              <Link href="/products">
                <Button size="lg" className="w-full sm:w-auto">
                  {t('products.title')}
                </Button>
              </Link>
            ) : (
              <SignUpButton mode="modal">
                <Button size="lg" className="w-full sm:w-auto">
                  {t('home.getStarted')}
                </Button>
              </SignUpButton>
            )}
          </div>
        </div>
      </section>

      {/* Category Grid - Only show for authenticated users */}
      {user && <CategoryGrid locale={locale} />}

      {/* Features Section */}
      <section className="py-12 md:py-20">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-8 md:mb-12">
            {t('home.features.title')}
          </h2>
          <div className="grid gap-4 md:gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <Card key={index}>
                  <CardHeader>
                    <Icon className="h-10 w-10 md:h-12 md:w-12 text-primary mb-3 md:mb-4" />
                    <CardTitle className="text-lg md:text-xl">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CardDescription className="text-sm md:text-base">
                      {feature.description}
                    </CardDescription>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-primary text-primary-foreground py-12 md:py-20">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4">
            {t('home.getStartedSection.title')}
          </h2>
          <p className="text-base md:text-xl mb-6 md:mb-8 max-w-2xl mx-auto opacity-90">
            {t('home.getStartedSection.description')}
          </p>
          {!user && (
            <SignUpButton mode="modal">
              <Button size="lg" variant="secondary" className="w-full sm:w-auto">
                {t('home.getStarted')}
              </Button>
            </SignUpButton>
          )}
        </div>
      </section>
    </main>
  );
}
