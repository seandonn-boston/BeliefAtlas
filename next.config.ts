import type { NextConfig } from "next";

// Every page here depends on the session cookie and live vote data, so nothing is prerendered.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      // No page can be framed by another site, except the embed (/embed/:id), which sets its own
      // "frame-ancestors *" policy.
      {
        source: "/((?!embed/).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
