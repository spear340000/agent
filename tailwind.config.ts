import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        primary: '#F8FAFC',
        primaryAccent: '#0F172A',
        brand: '#F5B84B',
        background: {
          DEFAULT: '#0B1220',
          secondary: '#111C2E'
        },
        secondary: '#CBD5E1',
        border: 'rgba(var(--color-border-default))',
        accent: '#172338',
        muted: '#8FA1B8',
        destructive: '#F87171',
        positive: '#6EE7B7'
      },
      fontFamily: {
        geist: 'var(--font-geist-sans)',
        dmmono: 'var(--font-dm-mono)'
      },
      borderRadius: {
        xl: '10px'
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
