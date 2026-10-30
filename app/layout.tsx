import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LoanSaarthi - Bank Statement Analysis",
  description: "Internal underwriting and bank statement forensics for LoanSaarthi DSA.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
