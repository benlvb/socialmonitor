import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "socialmonitor",
  description: "Configurable multi-source social monitoring",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
