import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@socialmonitor/shared", "@socialmonitor/pipeline", "@socialmonitor/db"],
  serverExternalPackages: ["telegram", "postgres", "google-play-scraper"],
  // Next 16 otherwise writes AGENTS.md/CLAUDE.md into apps/web on every dev run;
  // the repo's guidance lives in the root CLAUDE.md.
  agentRules: false,
};

export default nextConfig;
