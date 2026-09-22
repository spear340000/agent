import Image from 'next/image'
import { FileText } from 'lucide-react'
import type { Task } from './types'

const icons = {
  docx: { name: 'Word 문서', src: '/icons/documents/docx.svg' },
  xlsx: { name: 'Excel 문서', src: '/icons/documents/xlsx.svg' },
  pptx: { name: 'PowerPoint 문서', src: '/icons/documents/pptx.svg' },
  pdf: { name: 'PDF 문서', src: '/icons/documents/pdf.svg' }
}

export default function DocumentIcon({
  type
}: {
  type?: Task['documentType']
}) {
  const icon =
    type && Object.prototype.hasOwnProperty.call(icons, type)
      ? icons[type as keyof typeof icons]
      : undefined
  return icon ? (
    <Image
      src={icon.src}
      alt={icon.name}
      width={20}
      height={20}
      className="shrink-0"
      unoptimized
    />
  ) : (
    <FileText size={16} aria-label={type === 'md' ? 'Markdown 문서' : '문서'} />
  )
}
