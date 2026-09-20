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
  title: "Study Bison 🦬",
  description:
    "Study Bison — India's most affordable learning app. Explore batches for JEE, NEET, Boards, Commerce & more.",
  icons: {
    icon: [
      // versioned to defeat stale browser favicon caches
      { url: "/logo-bison.png?v=2", type: "image/png" },
    ],
    apple: "/logo-bison.png?v=2",
  },
  manifest: "/manifest.webmanifest",
  applicationName: "Study Bison",
  appleWebApp: {
    capable: true,
    title: "Study Bison",
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
        <link
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
          rel="stylesheet"
        />
      </head>
      <body className={`${inter.variable} sb-app antialiased`}>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
