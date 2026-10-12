import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  // Keep `next build` from replacing the filesystem artifacts used by a live
  // `next dev` process (both normally share `.next`).
  distDir:
    process.env.NODE_ENV === 'production'
      ? '.next-production'
      : '.next-development',
  devIndicators: false,
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  experimental: { cpus: 1 },
  async rewrites() {
    if (
      process.env.NODE_ENV !== 'development' ||
      process.env.WORKFOLIO_LOCAL_BACKEND_PROXY !== 'true'
    ) {
      return []
    }

    return [
      {
        source: '/__workfolio_backend/:path*',
        destination: 'http://127.0.0.1:8787/:path*'
      }
    ]
  }
}

export default nextConfig
