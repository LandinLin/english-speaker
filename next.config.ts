import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hostable Docker artifact: .next/standalone/server.js with no
  // node_modules install needed in the runtime image. Vercel ignores this.
  output: "standalone",
  // Native/network Node packages — keep them out of the bundler.
  // msedge-tts uses the `ws` WebSocket client + Node streams — keep external.
  serverExternalPackages: ["pg", "msedge-tts"],
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
