import type { Metadata } from 'next'
import { DM_Mono, Geist } from 'next/font/google'
import './globals.css'
import './tools.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  weight: '400',
  subsets: ['latin']
})
const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-dm-mono',
  weight: '400'
})

export const metadata: Metadata = {
  title: 'Workfolio',
  description: '요청과 자료를 바탕으로 문서를 만들고 관리하는 작업 공간'
}

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className={`${geistSans.variable} ${dmMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  )
}
