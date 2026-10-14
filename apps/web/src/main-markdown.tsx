import React, { useState } from "react";
import { marked } from "marked";

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  href?: string;
  title?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean;
  task?: boolean;
  align?: ("left" | "center" | "right" | null)[];
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

function safeLink(href: string | undefined) {
  if (!href) return "";
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : "";
  } catch {
    return "";
  }
}

function InlineMarkdown({ tokens = [] }: { tokens?: MarkdownToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`;
        const children = token.tokens ?? [];
        switch (token.type) {
          case "strong":
            return (
              <strong key={key}>
                <InlineMarkdown tokens={children} />
              </strong>
            );
          case "em":
            return (
              <em key={key}>
                <InlineMarkdown tokens={children} />
              </em>
            );
          case "del":
            return (
              <del key={key}>
                <InlineMarkdown tokens={children} />
              </del>
            );
          case "codespan":
            return <code key={key}>{token.text}</code>;
          case "br":
            return <br key={key} />;
          case "link": {
            const href = safeLink(token.href);
            return href ? (
              <a
                key={key}
                href={href}
                title={token.title}
                target="_blank"
                rel="noreferrer noopener"
              >
                <InlineMarkdown tokens={children} />
              </a>
            ) : (
              <InlineMarkdown key={key} tokens={children} />
            );
          }
          case "image":
            return <span key={key}>{token.text ?? ""}</span>;
          case "html":
            return <span key={key}>{token.raw ?? token.text ?? ""}</span>;
          case "text":
            return children.length ? (
              <React.Fragment key={key}>
                <InlineMarkdown tokens={children} />
              </React.Fragment>
            ) : (
              <React.Fragment key={key}>{token.text ?? ""}</React.Fragment>
            );
          default:
            return (
              <React.Fragment key={key}>
                {token.text ?? token.raw ?? ""}
              </React.Fragment>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="markdown-code">
      <div className="markdown-code-bar">
        <span>{language || "代码"}</span>
        <button type="button" onClick={() => void copy()} aria-label="复制代码">
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function MarkdownBlocks({ tokens = [] }: { tokens?: MarkdownToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`;
        const inline = <InlineMarkdown tokens={token.tokens ?? []} />;
        switch (token.type) {
          case "heading": {
            const level = Math.min(6, Math.max(1, token.depth ?? 1));
            return React.createElement(`h${level}`, { key }, inline);
          }
          case "paragraph":
          case "text":
            return <p key={key}>{inline}</p>;
          case "list": {
            const items = (token.items ?? []).map((item, itemIndex) => (
              <li key={itemIndex}>
                {item.task && (
                  <input
                    type="checkbox"
                    checked={Boolean(item.checked)}
                    readOnly
                    aria-label="任务项"
                  />
                )}
                <MarkdownBlocks tokens={item.tokens ?? []} />
              </li>
            ));
            return token.ordered ? (
              <ol key={key} start={token.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case "blockquote":
            return (
              <blockquote key={key}>
                <MarkdownBlocks tokens={token.tokens} />
              </blockquote>
            );
          case "code":
            return (
              <CodeBlock
                key={key}
                code={token.text ?? ""}
                language={token.lang?.split(/\s+/, 1)[0]}
              />
            );
          case "table":
            return (
              <div className="markdown-table-wrap" key={key}>
                <table>
                  <thead>
                    <tr>
                      {(token.header ?? []).map((cell, cellIndex) => (
                        <th
                          key={cellIndex}
                          style={{ textAlign: token.align?.[cellIndex] ?? undefined }}
                        >
                          <InlineMarkdown tokens={cell.tokens} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(token.rows ?? []).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            style={{ textAlign: token.align?.[cellIndex] ?? undefined }}
                          >
                            <InlineMarkdown tokens={cell.tokens} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={key} />;
          case "space":
            return null;
          case "html":
            return <p key={key}>{token.raw ?? token.text ?? ""}</p>;
          default:
            return <p key={key}>{inline}</p>;
        }
      })}
    </>
  );
}

export function MarkdownMessage({ value }: { value: string }) {
  const tokens = marked.lexer(value) as MarkdownToken[];
  return <MarkdownBlocks tokens={tokens} />;
}
