import type { NextConfig } from "next";

const apiProxy = process.env.API_PROXY_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@vela/ui", "@vela/api-client", "@vela/shared", "@vela/validation"],
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiProxy}/api/v1/:path*` }];
  },
};

export default nextConfig;
