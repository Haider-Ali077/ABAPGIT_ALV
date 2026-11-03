import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "SuperNova POC", description: "Requirement → FSD → ABAP (abapGit)" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
