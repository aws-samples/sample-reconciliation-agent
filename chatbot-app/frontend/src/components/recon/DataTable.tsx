"use client";

import {
  DataTable as SharedDataTable,
  type DataTableProps as SharedDataTableProps,
} from "@/components/app-ui/DataTable";

// The recon app's table is the shared one (`@/components/app-ui/DataTable`) with `appId` fixed, so
// stored column layouts stay under the `cols:recon:*` keys they have always used. Kept at this path so
// the recon pages' imports do not move; new code should import the shared table and name its app.

export type { DataTableColumn } from "@/components/app-ui/DataTable";

/** The shared table's props minus `appId`, which this wrapper supplies. */
export type DataTableProps<T> = Omit<SharedDataTableProps<T>, "appId">;

export function DataTable<T>(props: DataTableProps<T>) {
  return <SharedDataTable appId="recon" {...props} />;
}
