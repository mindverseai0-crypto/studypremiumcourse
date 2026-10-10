import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import PWARegister from "@/components/pwa-register";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: {
    default: "STUDY PREMIUM COURSE",
    template: "%s | STUDY PREMIUM COURSE",
  },
  description:
    "STUDY PREMIUM COURSE — Your premium learning platform. Explore courses, batches, study materials, and more.",
  icons: {
    icon: [
      {
        url: "/logo-bison.png?v=3",
        type: "image/png",
      },
    ],
    apple: "/logo-bison.png?v=3",
  },
  manifest: "/manifest.webmanifest",
  applicationName: "STUDY PREMIUM COURSE",
  appleWebApp: {
    capable: true,
    title: "STUDY PREMIUM COURSE",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#111827",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Self-hosted Font Awesome — supports offline caching */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link
          href="/vendor/fontawesome/css/all.min.css"
          rel="stylesheet"
        />
      </head>
      <body className={`${inter.variable} antialiased`}>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
