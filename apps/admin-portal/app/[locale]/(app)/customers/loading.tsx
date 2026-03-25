import { Skeleton, Card, CardContent } from "@joho-erp/ui";
import { getTranslations } from "next-intl/server";

export default async function CustomersLoading() {
  const t = await getTranslations("common");
  return (
    <div className="space-y-6" aria-busy="true" role="status" aria-label={t("aria.loadingCustomers")}>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-10 w-36" />
      </div>

      {/* Search and filter bar */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 flex-1 max-w-sm" />
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-28" />
      </div>

      {/* Table skeleton */}
      <Card>
        <CardContent className="p-0">
          {/* Table header */}
          <div className="border-b px-4 py-3 flex gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-24" />
            ))}
          </div>
          {/* Table rows */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="border-b px-4 py-3 flex items-center gap-4" style={{ animationDelay: `${i * 50}ms` }}>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
