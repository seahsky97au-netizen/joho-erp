import { Skeleton, Card, CardContent, CardHeader } from "@joho-erp/ui";
import { getTranslations } from "next-intl/server";

export default async function OnboardingLoading() {
  const t = await getTranslations("common");
  return (
    <div className="min-h-screen bg-background" aria-busy="true" role="status" aria-label={t("aria.loadingOnboarding")}>
      {/* Header skeleton */}
      <div className="border-b bg-card">
        <div className="container py-4 flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      <div className="container py-8">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Title skeleton */}
          <div className="text-center space-y-2">
            <Skeleton className="h-8 w-64 mx-auto" />
            <Skeleton className="h-5 w-96 mx-auto" />
          </div>

          {/* Progress steps skeleton */}
          <div className="flex items-center justify-center gap-4 py-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-10 w-10 rounded-full" />
                {i < 4 && <Skeleton className="h-0.5 w-8" />}
              </div>
            ))}
          </div>

          {/* Form card skeleton */}
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-72" />
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Form fields */}
              <div className="grid gap-4 md:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="space-y-2"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ))}
              </div>

              {/* Full width field */}
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-24 w-full" />
              </div>

              {/* Navigation buttons */}
              <div className="flex justify-between pt-4">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-28" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
