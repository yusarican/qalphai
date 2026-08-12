import path from "node:path"
import type { NextConfig } from "next"

/*
 * The console lives inside the engine's repository, so there are two lockfiles above
 * it. Pinning the root stops Next from inferring the engine's directory and tracing
 * the whole backend as part of this build.
 */
const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
}

export default nextConfig
