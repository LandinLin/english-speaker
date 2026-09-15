import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon — keep it out of the bundler.
  // msedge-tts uses the `ws` WebSocket client + Node streams — keep external.
  serverExternalPackages: ["better-sqlite3", "msedge-tts"],
  async headers() {
    return [
      {
        // Service worker must always be revalidated so updates activate fast.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
