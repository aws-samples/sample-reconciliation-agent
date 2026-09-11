"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { SettingsSkeleton } from "@/components/console/AdminDataFallback";
import { SettingsScreen } from "@/components/console/SettingsScreen";

// `useSearchParams` makes a page client-rendered up to the nearest Suspense boundary, and Next
// refuses to prerender one without a boundary; hence the split. The screen itself is in
// `components/console` so it can be rendered in tests with a plain `tabParam`.
function SettingsWithTab() {
  const params = useSearchParams();
  return <SettingsScreen tabParam={params?.get("tab") ?? null} />;
}

export default function ConsoleSettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton rows={4} />}>
      <SettingsWithTab />
    </Suspense>
  );
}
