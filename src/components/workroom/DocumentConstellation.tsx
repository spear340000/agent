// 시작 화면에 문서 형식별 아이콘과 가능한 작업을 마인드맵 형태로 표시한다.
import Image from 'next/image'

const documents = [
  {
    type: 'docx',
    side: 'left',
    actions: ['초안 작성', '내용 요약', '문장 다듬기', '목차 구성', 'DOCX 저장']
  },
  {
    type: 'xlsx',
    side: 'right',
    actions: [
      '데이터 분석',
      '표·차트',
      '수식 정리',
      '인사이트 요약',
      'XLSX 저장'
    ]
  },
  {
    type: 'pptx',
    side: 'left',
    actions: [
      '슬라이드 구성',
      '발표 자료',
      '핵심 시각화',
      '발표자 노트',
      'PPTX 저장'
    ]
  },
  {
    type: 'pdf',
    side: 'right',
    actions: ['내용 검토', '형식 변환', '페이지 요약', '정보 추출', 'PDF 저장']
  }
] as const

export default function DocumentConstellation() {
  return (
    <div className="empty-visual" aria-hidden="true">
      {documents.map((document, index) => (
        <span
          className={`document-cluster orbit-${index + 1} cluster-${document.side}`}
          key={document.type}
        >
          <span className="orbit">
            <Image
              src={`/icons/documents/${document.type}.svg`}
              alt=""
              width={60}
              height={60}
              unoptimized
            />
          </span>
          {document.actions.map((action, actionIndex) => (
            <span className={`mind-node node-${actionIndex + 1}`} key={action}>
              {action}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}
