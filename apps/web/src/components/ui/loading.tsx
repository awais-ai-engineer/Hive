'use client';

import { LoadingState, Skeleton } from '@hive/ui';

/** Shared compatibility wrapper for route-level loading states. */
export function Loading({ label = 'Loading…', className = '' }: { label?: string; className?: string }) {
  return <LoadingState label={label} className={`min-h-[40vh] flex-1 ${className}`} />;
}

/** Shared message-shaped placeholder for loading message lists. */
export function MessageSkeleton({ rows = 6 }: { rows?: number }) {
  const widths = ['62%', '38%', '74%', '46%', '58%', '30%'];
  return <div role="status" aria-label="Loading messages" aria-busy="true" className="space-y-5 py-2">
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex items-start gap-3">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <span className="flex-1 space-y-2 pt-1"><Skeleton className="block h-3 w-28" /><Skeleton className="block h-3" style={{ width: widths[index % widths.length] }} /></span>
    </div>)}
  </div>;
}
