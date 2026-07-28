"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BulkAccountAutomationModal } from "@/shared/components";

export default function LivsceneBulkPage() {
  const router = useRouter();

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/automation?provider=livscene"
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text-main hover:border-primary/40 hover:bg-primary/5"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Back
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            Livscene Bulk Google Auto Login
          </h1>
          <p className="text-xs text-text-muted">
            Bulk gmail:password automation via Livscene Google sign-up.
          </p>
        </div>
      </div>

      <BulkAccountAutomationModal
        asPage
        provider="livscene"
        title="Livscene Bulk Google Auto Login"
        serviceName="Livscene"
        showReferralInput
        onSuccess={() => router.refresh()}
      />
    </div>
  );
}
