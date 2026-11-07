import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { memoPage, projectMcpMemoOutput, jsonBytes, MCP_MEMO_JSON_BYTES } from "./mcp-memo-output.ts";
const detail = (contentMarkdown) => ({id:"memo_1",notebookId:"nb",title:"中文😀",revision:2,contentHash:"db-hash",contentMarkdown,contentJson:{huge:contentMarkdown.repeat(2)},contentText:contentMarkdown});

test("Unicode pages reconstruct exactly, omit redundant bodies, and preserve source", async()=>{
 const body = "中文😀\n\\\"\u0000".repeat(5000), source=detail(body);let offset=0,out="",pages=0;
 do { const {memo}=await projectMcpMemoOutput("get_memo",{memo:source},{offsetChars:offset,maxChars:12000,expectedRevision:2});
  expect(jsonBytes({memo})).toBeLessThanOrEqual(MCP_MEMO_JSON_BYTES);expect(memo.contentJson).toBeUndefined();expect(memo.contentText).toBeUndefined();
  expect(memo.contentMarkdown).not.toMatch(/[\uD800-\uDBFF]$/u);out+=memo.contentMarkdown;pages++;offset=memo.nextOffsetChars;
  expect(memo.markdownSha256).toBe(createHash("sha256").update(body).digest("hex"));
 } while(offset!==null);
 expect(out).toBe(body);expect(pages).toBeGreaterThan(2);expect(source.contentJson.huge).toBe(body.repeat(2));
});

test("default first page and empty/exact endpoint are explicit",async()=>{
 const memo=await memoPage(detail("😀".repeat(8001)));expect(Array.from(memo.contentMarkdown)).toHaveLength(8000);expect(memo.hasMore).toBe(true);expect(memo.nextOffsetChars).toBe(8000);expect(memo.totalChars).toBe(8001);
 const last=await memoPage(detail("😀"),{offsetChars:1});expect(last.hasMore).toBe(false);expect(last.nextOffsetChars).toBeNull();expect(last.contentMarkdown).toBe("");
 expect((await memoPage(detail(""))).totalChars).toBe(0);
});

test("invalid offsets, nonintegers and concurrent revision fail without partial text",async()=>{
 for(const args of [{offsetChars:-1},{offsetChars:0.5},{offsetChars:9},{maxChars:0},{maxChars:12001},{expectedRevision:1}]) await expect(memoPage(detail("abc"),args)).rejects.toThrow();
});

test("escape-heavy text and huge metadata respect final JSON byte ceiling",async()=>{
 const source={...detail("\u0000".repeat(12000)),title:"\u0000".repeat(100000)};
 const memo=await memoPage(source,{maxChars:12000});expect(memo.hasMore).toBe(true);expect(memo.nextOffsetChars).toBeGreaterThan(0);expect(jsonBytes({memo})).toBeLessThanOrEqual(48000);
});

test("content list has bounded previews and real continuation after byte cap",async()=>{
 const memos=Array.from({length:10},(_,i)=>({...detail("\u0000".repeat(9000)),id:"memo_"+i}));
 const result=await projectMcpMemoOutput("list_memos",{memos,limit:10,offset:30,hasMore:false,nextOffset:null},{includeContent:true});
 expect(jsonBytes(result)).toBeLessThanOrEqual(48000);expect(result.memos.length).toBeLessThan(10);expect(result.hasMore).toBe(true);expect(result.nextOffset).toBe(30+result.memos.length);
 expect(result.memos[0].nextOffsetChars).toBe(1000);expect(result.memos[0].hasMore).toBe(true);expect(result.contentPolicy).toContain("read_memo_page");
});

test("write receipts compact, alias equivalent, unrelated output unchanged",async()=>{
 const source=detail("big".repeat(100000));const r=await projectMcpMemoOutput("update_memo",{memo:source},{});expect(r.updated).toBe(true);expect(r.memo.revision).toBe(2);expect(r.memo.contentMarkdown).toBeUndefined();expect(jsonBytes(r)).toBeLessThan(1000);
 expect(await projectMcpMemoOutput("read_memo_page",{memo:source},{})).toEqual(await projectMcpMemoOutput("get_memo",{memo:source},{}));
 expect(await projectMcpMemoOutput("unrelated",source,{})).toBe(source);
});
