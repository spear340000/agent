import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
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
