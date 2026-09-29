import type { Metadata } from 'next'
import { DM_Mono, Geist } from 'next/font/google'
import './globals.css'

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
  title: 'Workroom',
  description: '자료를 모으고 문서 초안을 준비하는 작업 공간'
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
