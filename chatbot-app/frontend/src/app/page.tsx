import { redirect } from "next/navigation"

// The reconciliation platform's landing is the recon dashboard — not the generic chat agent.
export default function Home() {
  redirect("/recon/dashboard")
}
