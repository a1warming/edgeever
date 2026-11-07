import { AppError } from "./app-error";

// MCP-only projection. REST/Web and internal memo detail objects remain unchanged.
// Both content.text (compact JSON) and structuredContent stay below client 64 KiB budgets.
export const MCP_MEMO_JSON_BYTES = 48_000;
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const integer = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new AppError("invalid_argument", "Pagination values must be non-negative safe integers within the documented limits", 400);
  }
  return value;
};
const short = (value: unknown, maximum: number) => typeof value === "string" ? Array.from(value).slice(0, maximum).join("") : value;
const metadata = (memo: Record<string, unknown>) => ({
  id: short(memo.id, 160), notebookId: short(memo.notebookId, 160), title: short(memo.title, 160),
  revision: memo.revision, contentHash: short(memo.contentHash, 256),
  createdAt: memo.createdAt, updatedAt: memo.updatedAt,
  isPinned: memo.isPinned, isArchived: memo.isArchived, isDeleted: memo.isDeleted,
});

export async function memoPage(value: unknown, args: Record<string, unknown> = {}, maximum = 12_000) {
  const memo = record(value);
  const expected = args.expectedRevision === undefined ? undefined : integer(args.expectedRevision, 0);
  if (expected !== undefined && memo.revision !== expected) {
    throw new AppError("revision_conflict", "Memo changed during pagination; restart reading at offsetChars=0", 409);
  }
  const markdown = typeof memo.contentMarkdown === "string" ? memo.contentMarkdown : "";
  // Offsets count Unicode code points, never UTF-16 halves; use nextOffsetChars verbatim.
  const chars = Array.from(markdown);
  const offset = integer(args.offsetChars, 0);
  if (offset > chars.length) throw new AppError("invalid_argument", "offsetChars exceeds totalChars", 400);
  const maxChars = integer(args.maxChars, Math.min(8_000, maximum), maximum);
  if (maxChars < 1) throw new AppError("invalid_argument", "maxChars must be at least 1", 400);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(markdown))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const count = Math.min(maxChars, chars.length - offset);
  const make = (length: number) => ({
    ...metadata(memo), contentMarkdown: chars.slice(offset, offset + length).join(""),
    markdownSha256: hash, offsetChars: offset, totalChars: chars.length,
    nextOffsetChars: offset + length < chars.length ? offset + length : null,
    hasMore: offset + length < chars.length, offsetUnit: "unicode-code-points",
  });
  let low = 0, high = count;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes({ memo: make(middle) }) <= MCP_MEMO_JSON_BYTES) low = middle;
    else high = middle - 1;
  }
  if (low === 0 && count > 0) throw new AppError("result_too_large", "Memo metadata exceeds MCP output budget", 400);
  return make(low);
}

export const COMPACT_MEMO_TOOLS = new Set(["get_memo", "read_memo_page", "list_memos", "update_memo"]);
export async function projectMcpMemoOutput(name: string, value: unknown, args: Record<string, unknown>) {
  const result = record(value);
  if (name === "update_memo" && result.memo) {
    return { memo: { ...metadata(record(result.memo)), readTool: "get_memo" }, updated: true };
  }
  if ((name === "get_memo" || name === "read_memo_page") && result.memo) {
    // Preserve the existing visual read contract; specialized tools remain available.
    const extra = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "memo"));
    const page = { ...extra, memo: await memoPage(result.memo, args) };
    if (jsonBytes(page) > MCP_MEMO_JSON_BYTES) {
      return { memo: await memoPage(result.memo, args), visualReadRequired: true,
        readTools: ["get_diagram", "get_table_records", "get_poster"] };
    }
    return page;
  }
  if (name === "list_memos" && Array.isArray(result.memos)) {
    const includeContent = args.includeContent === true;
    const candidates = await Promise.all(result.memos.map(async value => includeContent
      ? await memoPage(value, { maxChars: 1_000 }, 1_000)
      : { ...metadata(record(value)), excerpt: short(record(value).excerpt, 300), poster: record(value).poster }));
    const memos: unknown[] = [];
    const offset = typeof result.offset === "number" ? result.offset : 0;
    const make = () => ({ ...result, memos, limit: memos.length, hasMore: result.hasMore === true || memos.length < candidates.length,
      nextOffset: result.hasMore === true || memos.length < candidates.length ? offset + memos.length : null,
      ...(includeContent ? { contentPolicy: "First 1000 Unicode code points per memo, byte-bounded. Continue each memo with read_memo_page using nextOffsetChars and expectedRevision." } : {}) });
    for (const memo of candidates) {
      memos.push(memo);
      if (jsonBytes(make()) > MCP_MEMO_JSON_BYTES) { memos.pop(); break; }
    }
    return make();
  }
  return value;
}
