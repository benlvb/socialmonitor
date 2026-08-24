import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@socialmonitor/shared", "@socialmonitor/pipeline", "@socialmonitor/db"],
  serverExternalPackages: ["telegram", "postgres"],
};

export default nextConfig;
