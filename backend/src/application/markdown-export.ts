export type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; text: string }
  | { type: "code"; text: string }
  | { type: "rule" }
  | {
      type: "table";
      headers: string[];
      alignments: Array<"left" | "center" | "right">;
      rows: string[][];
    };

export function splitMarkdownTableRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let codeTicks = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "`") {
      let end = index + 1;
      while (value[end] === "`") end += 1;
      const count = end - index;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += value.slice(index, end);
      index = end - 1;
      continue;
    }
    if (character === "\\" && !escaped) {
      escaped = true;
      cell += character;
      continue;
    }
    if (character === "|" && !escaped && !codeTicks) {
      cells.push(cell.trim().replace(/\\\|/g, "|"));
      cell = "";
    } else cell += character;
    escaped = false;
  }
  cells.push(cell.trim().replace(/\\\|/g, "|"));
  return cells;
}

function tableDivider(line: string): string[] | null {
  const cells = splitMarkdownTableRow(line);
  return cells.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
    ? cells
    : null;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(
          lines[index]!,
        )
      )
        code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (lines[index + 1] && line.includes("|")) {
      const divider = tableDivider(lines[index + 1]!);
      if (divider) {
        const headers = splitMarkdownTableRow(line);
        const alignments = Array.from(
          { length: headers.length },
          (_, column) => {
            const cell = divider[column] ?? "---";
            return cell.startsWith(":") && cell.endsWith(":")
              ? "center"
              : cell.endsWith(":")
                ? "right"
                : "left";
          },
        );
        const rows: string[][] = [];
        index += 2;
        while (
          index < lines.length &&
          lines[index]!.trim() &&
          lines[index]!.includes("|")
        ) {
          rows.push(splitMarkdownTableRow(lines[index]!));
          index += 1;
        }
        blocks.push({ type: "table", headers, alignments, rows });
        continue;
      }
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1]! });
      index += 1;
      continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      blocks.push({ type: "list", ordered: Boolean(list[2]), text: list[3]! });
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^(?:#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*(`{3,}|~{3,})|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(
        lines[index]!,
      ) &&
      !(
        lines[index + 1] &&
        lines[index]!.includes("|") &&
        tableDivider(lines[index + 1]!)
      )
    )
      paragraph.push(lines[index++]!.trim());
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

export function stripMarkdownInline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, "$1 ($2)")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, "$1$2")
    .replace(/\*(.+?)\*|_(.+?)_/gu, "$1$2")
    .replace(/`([^`]+)`/gu, "$1");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
function inlineHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, "<strong>$1$2</strong>")
    .replace(/\*(.+?)\*|_(.+?)_/gu, "<em>$1$2</em>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function tableColumnWidths(block: Extract<MarkdownBlock, { type: "table" }>): number[] {
  const columnCount = block.headers.length;
  if (columnCount === 1) return [100];
  const widths = block.headers.map((header, column) =>
    Math.min(
      40,
      Math.max(
        5,
        Array.from([header, ...block.rows.map((row) => row[column] ?? "")]).reduce(
          (maximum, value) =>
            Math.max(
              maximum,
              Array.from(value).reduce(
                (width, character) => width + (character.codePointAt(0)! > 0xff ? 2 : 1),
                0,
              ),
            ),
          0,
        ),
      ),
    ),
  );
  const minimum = Math.min(columnCount <= 4 ? 8 : 5, 100 / columnCount);
  const distributable = 100 - minimum * columnCount;
  const totalWeight = widths.reduce((total, width) => total + width, 0);
  const percentages = widths.map((width) =>
    Number((minimum + (distributable * width) / totalWeight).toFixed(1)),
  );
  const lastColumn = percentages.length - 1;
  percentages[lastColumn] = Number(
    (
      percentages[lastColumn]! +
      100 -
      percentages.reduce((total, width) => total + width, 0)
    ).toFixed(1),
  );
  return percentages;
}

export function markdownDocumentHtml(markdown: string, title: string): string {
  const blocks = parseMarkdownBlocks(markdown);
  const output: string[] = [];
  if (!blocks.some((block) => block.type === "heading" && block.level === 1))
    output.push(`<h1>${inlineHtml(title)}</h1>`);
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index]!;
    if (block.type === "heading")
      output.push(
        `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`,
      );
    else if (block.type === "paragraph")
      output.push(`<p>${inlineHtml(block.text)}</p>`);
    else if (block.type === "quote")
      output.push(`<blockquote>${inlineHtml(block.text)}</blockquote>`);
    else if (block.type === "code")
      output.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
    else if (block.type === "rule") output.push("<hr>");
    else if (block.type === "list") {
      const tag = block.ordered ? "ol" : "ul";
      const items: string[] = [];
      while (
        index < blocks.length &&
        blocks[index]!.type === "list" &&
        (blocks[index] as Extract<MarkdownBlock, { type: "list" }>).ordered ===
          block.ordered
      ) {
        items.push(
          `<li>${inlineHtml((blocks[index] as Extract<MarkdownBlock, { type: "list" }>).text)}</li>`,
        );
        index += 1;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    } else {
      const columnWidths = tableColumnWidths(block);
      const columns = columnWidths
        .map((width) => `<col style="width:${width}%">`)
        .join("");
      const heading = block.headers
        .map(
          (cell, column) =>
            `<th style="text-align:${block.alignments[column] ?? "left"}">${inlineHtml(cell)}</th>`,
        )
        .join("");
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${block.headers.map((_, column) => `<td style="text-align:${block.alignments[column] ?? "left"}">${inlineHtml(row[column] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("");
      output.push(
        `<table><colgroup>${columns}</colgroup><thead><tr>${heading}</tr></thead><tbody>${rows}</tbody></table>`,
      );
    }
    index += 1;
  }
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src 'none';"><title>${escapeHtml(title)}</title><style>@page{size:A4 portrait}*{box-sizing:border-box}html{print-color-adjust:exact;-webkit-print-color-adjust:exact}body{margin:0;font-family:"Malgun Gothic","Noto Sans CJK KR",Arial,sans-serif;color:#202923;font-size:10.5pt;line-height:1.58;overflow-wrap:anywhere}h1{font-size:23pt;line-height:1.3;margin:0 0 22pt;padding:0 0 11pt;border-bottom:1.5pt solid #547565;break-after:avoid}h2{font-size:15pt;line-height:1.35;color:#244537;margin:22pt 0 8pt;padding-bottom:5pt;border-bottom:.6pt solid #e2e7e2;break-after:avoid}h3,h4,h5,h6{font-size:12pt;line-height:1.4;color:#365c4a;margin:16pt 0 6pt;break-after:avoid}p{margin:0 0 10pt;orphans:3;widows:3}ul,ol{margin:0 0 11pt;padding-left:23pt}li{margin:0 0 4pt;padding-left:2pt}blockquote{margin:12pt 0;padding:9pt 12pt;border-left:3pt solid #9fb8a8;background:#f3f6f2;color:#43564a;break-inside:avoid}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:10pt 0 14pt;font-size:9.2pt;break-inside:auto}thead{display:table-header-group}thead tr,tr{break-inside:avoid;break-after:auto}th,td{border:.6pt solid #d7ded8;padding:6pt 7pt;vertical-align:top;overflow-wrap:anywhere}th{background:#e9efea;font-weight:700;text-align:left}tbody tr:nth-child(even){background:#f8f7f2}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f2ee;padding:10pt;font-family:Consolas,monospace;font-size:9pt;break-inside:avoid}code{font-family:Consolas,monospace;background:#f1f2ee;padding:0 2pt}a{color:#27644f;text-decoration:underline;overflow-wrap:anywhere}hr{border:0;border-top:.6pt solid #d7ded8;margin:14pt 0}</style></head><body><main>${output.join("\n")}</main></body></html>`;
}
