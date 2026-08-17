import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Academic Job Tracker",
  description: "A focused workspace for discovering, tracking, and applying to academic mathematics jobs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
