import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  experimental: { cpus: 1 }
}

export default nextConfig
