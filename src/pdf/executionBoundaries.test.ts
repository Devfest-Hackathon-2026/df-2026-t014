import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCollection, recordBatch } from "../domain/logic";
import { createRevision } from "../domain/workflows";
import { prepareAdditionalIssue, completeAdditionalIssue } from "../domain/additionalIssue";
import type { AppState, ScanPage } from "../domain/types";
import { A4, mm, printLayoutMetrics, printManifest, qrBox, reservedArea, sourceTransform } from "./geometry";
import { assertPdfInput, extractStudentPdf, inspectSourcePdf, setStablePdfDates } from "./documents";
import { generatePrintPdf } from "./generate";
import { isBlankCandidate, isOpaqueToken } from "./decode";

const people = [
  {id:"A",name:"青木葵",number:1,seat:{row:0,col:0}},
  {id:"B",name:"佐藤蓮",number:2,seat:{row:0,col:1}},
];
function issuance(pages=3,duplex=false) {
  const c=createCollection({title:"試験専用同意書",className:"架空2年",pageCount:pages,requiredPages:[pages],qrCorner:"top-right",duplex,order:"number",reverse:false,versionLabel:"第2版",layoutMode:"reserved-corner"},people);
  c.createdAt="2026-11-10T00:00:00.000Z";return c;
}
async function source(count=3) {
  const doc=await PDFDocument.create();setStablePdfDates(doc,"2026-11-10T00:00:00.000Z");
  const font=await doc.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=count;n++)doc.addPage([A4.width,A4.height]).drawText(`ORIGINAL-${n}`,{x:130,y:500,font});
  return doc;
}
function padded(bytes:Uint8Array,length:number) {
  const result=new Uint8Array(length);result.fill(32);result.set(bytes);return result;
}
async function textOf(bytes:Uint8Array) {
  const task=getDocument({data:bytes.slice(),useSystemFonts:false});
  try {const doc=await task.promise, text:string[]=[];for(let n=1;n<=doc.numPages;n++){const p=await doc.getPage(n);text.push((await p.getTextContent()).items.map(x=>"str" in x?x.str:"").join(""));}return text;}finally{await task.destroy();}
}
beforeAll(async()=>{const font=await readFile(new URL("./assets/BIZUDGothic-Regular.ttf",import.meta.url));vi.stubGlobal("fetch",vi.fn(async()=>new Response(font)));});
afterAll(()=>vi.unstubAllGlobals());

describe("Excel PF-F PDF execution boundaries",()=>{
  it("PF-F035 PF-F123 one person all four orders and one/two/three recipients produce exactly the actual page count",async()=>{
    const roster=[...people,{id:"C",name:"架空三人目",number:3,seat:{row:0,col:2}}],src=await(await source(1)).save();
    for(const count of [1,2,3])for(const order of count===1?['number','row','column','snake']as const:['number']as const){const c=createCollection({...issuance(1),order},roster.slice(0,count));const pdf=await generatePrintPdf({collection:c,students:roster.slice(0,count),sourcePdf:src});const texts=await textOf(pdf.bytes);expect(texts).toHaveLength(count);texts.forEach((t,i)=>expect(t).toContain(roster[i].name));expect(texts.join('')).not.toContain('undefined');}
  });
  it("PF-F068 interrupted issuance retries the identical persisted snapshot without replacing tokens IDs or order",async()=>{
    const c=issuance(2);c.status='generating';const snapshot=structuredClone(c),src=await(await source(2)).save(),controller=new AbortController();
    await expect(generatePrintPdf({collection:c,students:people,sourcePdf:src,signal:controller.signal,onProgress:p=>{if(p.current===2)controller.abort();}})).rejects.toMatchObject({name:'AbortError'});expect(c).toEqual(snapshot);
    const retry=await generatePrintPdf({collection:c,students:people,sourcePdf:src}),reference=await generatePrintPdf({collection:c,students:people,sourcePdf:src});expect(retry.collection).toBe(c);expect(retry.bytes).toEqual(reference.bytes);expect(c).toEqual(snapshot);expect((await textOf(retry.bytes)).map(t=>t.includes('青木葵')?'A':'B')).toEqual(['A','A','B','B']);
  });
  it("PF-F071 revised second-page source snapshot renders separately while old source tokens and receipt remain intact",async()=>{
    const c=issuance(2),oldSource=await(await source(2)).save(),oldHash=createHash('sha256').update(oldSource).digest('hex');c.sourceHash=oldHash;c.sourceDriveFileId='old-source-id';
    const s:AppState={schemaVersion:1,className:c.className,students:people,collections:[c],receipts:[],batches:[],events:[]},token=c.tokens.find(t=>t.studentId==='A'&&t.pageNumber===2)!;
    const p:ScanPage={id:'old-receipt-page',sourcePage:1,status:'matched',resolution:'accepted',token:token.token,studentId:token.studentId,pageNumber:2,collectionId:c.id,versionId:c.versionId};
    const recorded=recordBatch(s,{id:'old-batch',collectionId:c.id,hash:oldHash,fileName:'old-scan.pdf',pageCount:1,createdAt:c.createdAt,pages:[p]},[p]);const previous=structuredClone(recorded);
    const revision=createRevision(recorded,c.id,{sourceName:'revised-source.pdf',versionLabel:'第3版'},{actor:'synthetic-teacher',reason:'2頁の本文を改訂'});const edited=await PDFDocument.load(oldSource,{updateMetadata:false});edited.getPage(1).drawText('REVISION-2',{x:130,y:440,size:16});const newSource=await edited.save();revision.collection.sourceHash=createHash('sha256').update(newSource).digest('hex');revision.collection.sourceDriveFileId='new-source-id';
    const oldPrint=await generatePrintPdf({collection:c,students:people,sourcePdf:oldSource}),newPrint=await generatePrintPdf({collection:revision.collection,students:people,sourcePdf:newSource});expect((await textOf(oldPrint.bytes)).every(t=>!t.includes('REVISION-2'))).toBe(true);const nextText=await textOf(newPrint.bytes);expect(nextText[1]).toContain('REVISION-2');expect(nextText[3]).toContain('REVISION-2');expect(nextText[0]).not.toContain('REVISION-2');expect(revision.collection.logicalCollectionId).toBe(c.id);expect(revision.collection.id).not.toBe(c.id);expect(revision.collection.versionId).not.toBe(c.versionId);expect(revision.collection.tokens.every(t=>!c.tokens.some(o=>o.token===t.token))).toBe(true);expect(recorded).toEqual(previous);expect(revision.state.receipts).toEqual(recorded.receipts);expect(createHash('sha256').update(oldSource).digest('hex')).toBe(oldHash);expect(revision.state.collections.find(x=>x.id===c.id)?.sourceDriveFileId).toBe('old-source-id');
    await mkdir("artifacts/test-execution/pdf", { recursive: true });
    await writeFile('artifacts/test-execution/pdf/F071-old-source.pdf',oldSource);await writeFile('artifacts/test-execution/pdf/F071-new-source.pdf',newSource);await writeFile('artifacts/test-execution/pdf/F071-old-print.pdf',oldPrint.bytes);await writeFile('artifacts/test-execution/pdf/F071-new-print.pdf',newPrint.bytes);
  });
  it("PF-F089 PF-F090 PF-F091 rejects empty/non-PDF and checks 1024-byte header boundary",()=>{
    expect(()=>assertPdfInput(new Uint8Array())).toThrow();
    expect(()=>assertPdfInput(new TextEncoder().encode("PNG pretending to be .pdf"))).toThrow("PDF形式");
    for(const offset of [0,1019,1020]){const b=new Uint8Array(1100);b.fill(32);b.set(new TextEncoder().encode("%PDF-1.7"),offset);if(offset===1020)expect(()=>assertPdfInput(b)).toThrow();else expect(()=>assertPdfInput(b)).not.toThrow();}
  });
  it("PF-F093 corrupt document is rejected without a partial source",async()=>{
    await expect(inspectSourcePdf(new TextEncoder().encode("%PDF-1.7\n broken xref"))).rejects.toThrow("原稿PDFを開けません");
  });
  it("PF-F092 real password-encrypted source is rejected",async()=>{
    const encrypted=await readFile(new URL("../../tests/fixtures/encrypted-test.pdf",import.meta.url));
    await expect(inspectSourcePdf(new Uint8Array(encrypted))).rejects.toThrow("パスワード");
  });
  it("PF-F094 valid original at 20MiB-1 / 20MiB passes; +1 rejects",async()=>{
    const bytes=await (await source(1)).save();
    for(const size of [20971519,20971520])expect((await inspectSourcePdf(padded(bytes,size))).byteLength).toBe(size);
    await expect(inspectSourcePdf(padded(bytes,20971521))).rejects.toThrow("20MiB");
  });
  it("PF-F095 original count 0/1/9/10/11 retains all or rejects",async()=>{
    for(const count of [0,1,9,10,11]){const bytes=await (await source(count)).save({addDefaultPage:false});if(count===0||count===11)await expect(inspectSourcePdf(bytes)).rejects.toThrow("1〜10");else expect((await inspectSourcePdf(bytes)).pageCount).toBe(count);}
  });
  it("PF-F096 A4 absolute dimensional tolerance 1.99/2.00/2.01 pt",async()=>{
    for(const axis of ["width","height"] as const)for(const delta of [1.99,2,2.01]){const d=await source(1);d.getPage(0).setSize(A4.width+(axis==="width"?delta:0),A4.height+(axis==="height"?delta:0));const result=inspectSourcePdf(await d.save());if(delta>2)await expect(result).rejects.toThrow("A4縦");else expect((await result).pageCount).toBe(1);}
  });
  it("PF-F097 PF-F102 rejects landscape/Letter/A3 and last-page mixed size",async()=>{
    for(const size of [[841.89,595.28],[612,792],[841.89,1190.55]]){const d=await source(1);d.getPage(0).setSize(...size as [number,number]);await expect(inspectSourcePdf(await d.save())).rejects.toThrow("A4縦");}
    const d=await source(10);d.getPage(9).setSize(612,792);await expect(inspectSourcePdf(await d.save())).rejects.toThrow("10ページ目");
  });
  it("PF-F098 rotated A4 sources retain every page and normalize dimensions",async()=>{
    for(const angle of [0,90,180,270]){const d=await source(3);for(const p of d.getPages()){if(angle%180)p.setSize(A4.height,A4.width);p.setRotation(degrees(angle));}
      const bytes=await d.save();expect((await inspectSourcePdf(bytes)).pages.every(p=>p.width===A4.width&&p.height===A4.height)).toBe(true);
      const c=issuance();const out=await generatePrintPdf({collection:c,students:people,sourcePdf:bytes});const pdf=await PDFDocument.load(out.bytes);expect(pdf.getPages().every(p=>Math.abs(p.getWidth()-A4.width)<.01&&Math.abs(p.getHeight()-A4.height)<.01)).toBe(true);
      expect((await textOf(out.bytes)).filter(t=>t.includes("ORIGINAL-3"))).toHaveLength(2);
    }
  });
  it("PF-F099 rejects invalid Rotate without rounding",async()=>{for(const angle of [45,-45]){const d=await source(1);d.getPage(0).node.set(PDFName.of("Rotate"),PDFNumber.of(angle));await expect(inspectSourcePdf(await d.save())).rejects.toThrow("回転角度");}});
  it("PF-F100 PF-F101 checks crop and MediaBox origins at .009/.010/.011 pt",async()=>{
    for(const kind of ["crop","media"] as const)for(const delta of [.009,.01,.011]){const d=await source(1),p=d.getPage(0);if(kind==="crop")p.setCropBox(delta,0,A4.width,A4.height);else {p.setMediaBox(delta,0,A4.width,A4.height);p.setCropBox(delta,0,A4.width,A4.height);}const result=inspectSourcePdf(await d.save());if(delta>.01)await expect(result).rejects.toThrow("切り抜き");else expect((await result).pageCount).toBe(1);}
  });
  it("PF-F103 page count mismatch cannot silently discard a source page",async()=>{const c=issuance(2);await expect(generatePrintPdf({collection:c,students:people,sourcePdf:await(await source(3)).save()})).rejects.toThrow("原稿は3ページ");});
  it("PF-F104 PF-F105 PF-F116 multi-page contents remain searchable original Forms with version text",async()=>{
    const c=issuance(),result=await generatePrintPdf({collection:c,students:people,sourcePdf:await(await source()).save()});const texts=await textOf(result.bytes);expect(texts).toHaveLength(6);
    texts.forEach((t,i)=>{expect(t).toContain(`ORIGINAL-${i%3+1}`);expect(t).toContain(people[Math.floor(i/3)].name);expect(t).toContain("第2版");});
    const out=await PDFDocument.load(result.bytes);expect(out.getPage(0).node.Resources()?.has(PDFName.of("XObject"))).toBe(true);
  });
  it("PF-F107 missing font glyph fails instead of blank success",async()=>{const c=issuance(1);c.title="同意書😀";await expect(generatePrintPdf({collection:c,students:people,sourcePdf:await(await source(1)).save()})).rejects.toThrow("同梱フォントにない文字");});
  it("PF-F109 PF-F111 PF-F112 PF-F113 four corners and explicit/legacy scaling preserve layout contract",()=>{
    for(const corner of ["top-left","top-right","bottom-left","bottom-right"] as const){const box=qrBox(A4.width,A4.height,corner),area=reservedArea(A4.width,A4.height,corner);expect(box.width).toBe(mm(25));expect(box.height).toBe(mm(25));expect(area.width).toBe(mm(90));expect(sourceTransform(A4.width,A4.height,corner,"reserved-corner").scale).toBe(1);expect(sourceTransform(A4.width,A4.height,corner)).toEqual(sourceTransform(A4.width,A4.height,corner,"management-band"));const edgeX=corner.endsWith("right")?A4.width-box.x-box.width:box.x;expect(edgeX).toBeCloseTo(mm(10),8);}
    expect(sourceTransform(A4.width,A4.height,"top-right","management-band").scale).toBeCloseTo((A4.height-mm(48))/A4.height,10);
  });
  it("PF-F114 omitting names retains class/number/version and tokens",async()=>{const c=issuance(1);c.showNames=false;const before=JSON.stringify(c.tokens),pdf=await generatePrintPdf({collection:c,students:people,sourcePdf:await(await source(1)).save()});const text=(await textOf(pdf.bytes)).join("");expect(text).not.toContain("青木葵");expect(text).not.toContain("佐藤蓮");expect(text).toContain("1番");expect(text).toContain("架空2年");expect(text).toContain("第2版");expect(JSON.stringify(c.tokens)).toBe(before);});
  it("PF-F124 PF-F125 PF-F126 PF-F127 single/duplex and spacer packet counts",()=>{
    expect(printLayoutMetrics(3,2,false)).toMatchObject({sheetsPerStudent:3,totalPages:6,totalSheets:6});
    expect(printLayoutMetrics(2,2,true)).toMatchObject({sheetsPerStudent:1,totalPages:4,totalSheets:2});
    expect(printLayoutMetrics(3,2,true)).toMatchObject({sheetsPerStudent:2,totalPages:8,totalSheets:4});
    const c=issuance(3,true),m=printManifest(c);expect(m.map(x=>`${x.student.id}:${x.token.pageNumber}`)).toEqual(["A:1","A:2","A:3","A:4","B:1","B:2","B:3","B:4"]);expect(m.filter(x=>x.token.kind==="spacer").every(x=>!x.token.required)).toBe(true);
  });
  it("PF-F128 actual 399/400 page output succeeds and 401 is refused",async()=>{
    const input={title:"上限試験",className:"架空",pageCount:1,requiredPages:[1],qrCorner:"top-right" as const,duplex:false,order:"number" as const,reverse:false,layoutMode:"reserved-corner" as const};
    const src=await(await source(1)).save();for(const n of [399,400,401]){const students=Array.from({length:n},(_,i)=>({id:String(i),name:`架空${i}`,number:i+1,seat:null})),c=createCollection(input,students);const result=generatePrintPdf({collection:c,students,sourcePdf:src});if(n>400)await expect(result).rejects.toThrow("400ページ");else expect((await PDFDocument.load((await result).bytes)).getPageCount()).toBe(n);}
  },30000);
  it("PF-F129 PF-F130 PF-F131 subset validation preserves issued order",async()=>{
    const c=issuance(3,true),src=await(await source()).save();for(const ids of [[],["Z"],["A","Z"]])await expect(generatePrintPdf({collection:c,students:people,sourcePdf:src,studentIds:ids})).rejects.toThrow("再印刷");
    const pdf=await generatePrintPdf({collection:c,students:people,sourcePdf:src,studentIds:["B","A"],pageNumbers:[3,1]});const text=await textOf(pdf.bytes);expect(text).toHaveLength(4);expect(text[0]).toContain("青木葵");expect(text[0]).toContain("ORIGINAL-1");expect(text[1]).toContain("ORIGINAL-3");
    for(const pages of [[],[0],[4],[1.5]])await expect(generatePrintPdf({collection:c,students:people,sourcePdf:src,pageNumbers:pages})).rejects.toThrow("範囲外");
  });
  it("PF-F132 byte identical output for stable timestamp, source and tokens",async()=>{const c=issuance(),options={collection:c,students:people,sourcePdf:await(await source()).save()};const first=(await generatePrintPdf(options)).bytes;const second=(await generatePrintPdf(options)).bytes;expect(second).toEqual(first);});
  it("PF-F049 PF-F055 reverse actual duplex PDF keeps each three-page packet and spacer together",async()=>{
    const c=issuance(3,true);c.reverse=true;const pdf=await generatePrintPdf({collection:c,students:people,sourcePdf:await(await source()).save()});const text=await textOf(pdf.bytes);expect(text).toHaveLength(8);
    for(let i=0;i<8;i++){expect(text[i]).toContain(i<4?"佐藤蓮":"青木葵");if(i%4<3)expect(text[i]).toContain(`ORIGINAL-${i%4+1}`);else {expect(text[i]).toContain("調整");expect(text[i]).not.toContain("ORIGINAL-");}}
  });
  it("PF-F081 PF-F085 PF-F087 same-version additional issue full PDF and subset preserve immutable links and order",async()=>{
    const c=issuance(2);c.reverse=true;c.sourceDriveFileId="original-source-id";c.printDriveFileId="original-print-id";
    const added=Array.from({length:4},(_,i)=>({id:`S0${i+3}`,name:`追加生徒${i+3}`,number:i+3,seat:null}));
    const state:AppState={schemaVersion:1,className:c.className,students:[...people,...added],collections:[c],receipts:[],batches:[],events:[]};const context={actor:"synthetic-teacher",reason:"試験用の同版追加"};
    const prepared=prepareAdditionalIssue(state,c.id,added.map(s=>s.id),context);const tokenSnapshot=JSON.stringify(prepared.collection.tokens.map(t=>t.token));const sourcePdf=await(await source(2)).save();
    const subset=await generatePrintPdf({collection:prepared.collection,students:state.students,sourcePdf,studentIds:["S03"]});const subsetText=await textOf(subset.bytes);expect(subsetText).toHaveLength(2);expect(subsetText.every(t=>t.includes("追加生徒3"))).toBe(true);expect(subsetText[0]).toContain("ORIGINAL-1");expect(subsetText[1]).toContain("ORIGINAL-2");
    const complete=completeAdditionalIssue(prepared.state,c.id,added.map(s=>s.id),context);const full=await generatePrintPdf({collection:complete.collections[0],students:state.students,sourcePdf});const texts=await textOf(full.bytes);const names=["佐藤蓮","青木葵",...added.slice().reverse().map(s=>s.name)];expect(texts).toHaveLength(12);texts.forEach((text,i)=>{expect(text).toContain(names[Math.floor(i/2)]);expect(text).toContain(`ORIGINAL-${i%2+1}`);});
    const after=complete.collections[0];expect(after.versionId).toBe(c.versionId);expect(after.tokens.slice(0,c.tokens.length)).toEqual(c.tokens);expect(JSON.stringify(after.tokens.map(t=>t.token))).toBe(tokenSnapshot);expect(after.sourceDriveFileId).toBe("original-source-id");expect(after.printDriveFileId).toBe("original-print-id");expect(state.collections[0]).toBe(c);expect(c.recipients).toHaveLength(2);
  });
  it("PF-F134 PF-F135 extracted order and rotation remain original; invalid indices fail",async()=>{const d=await source();d.getPage(2).setRotation(degrees(180));const bytes=await d.save(),out=await extractStudentPdf(bytes,[3,1]);const pdf=await PDFDocument.load(out);expect(pdf.getPageCount()).toBe(2);expect(pdf.getPage(0).getRotation().angle).toBe(180);expect((await textOf(out))[0]).toContain("ORIGINAL-3");for(const pages of [[],[0],[4],[1.5]])await expect(extractStudentPdf(bytes,pages)).rejects.toThrow();});
  it("PF-F136 cancellation before, during and on final progress never returns partial PDF",async()=>{const c=issuance(),src=await(await source()).save();for(const at of [0,2,6]){const controller=new AbortController();if(!at)controller.abort();await expect(generatePrintPdf({collection:c,students:people,sourcePdf:src,signal:controller.signal,onProgress:p=>{if(p.current===at)controller.abort();}})).rejects.toMatchObject({name:"AbortError"});}});
  it("PF-F137 malformed fixed date is rejected; valid date is retained",async()=>{const c=issuance(1),src=await(await source(1)).save();c.createdAt="not-a-date";await expect(generatePrintPdf({collection:c,students:people,sourcePdf:src})).rejects.toThrow("保存日時");c.createdAt="2026-11-10T00:00:00.000Z";const out=await PDFDocument.load((await generatePrintPdf({collection:c,students:people,sourcePdf:src})).bytes,{updateMetadata:false});expect(out.getCreationDate()?.toISOString()).toBe(c.createdAt);expect(out.getModificationDate()?.toISOString()).toBe(c.createdAt);});
  it("PF-F143 PF-F144 recognizes both opaque encodings but never a URL",()=>{expect(isOpaqueToken("f".repeat(32))).toBe(true);expect(isOpaqueToken("AbCdEfGhIjKlMnOpQrSt_1")).toBe(true);expect(isOpaqueToken("https://example.test")).toBe(false);});
  it("PF-F161 pixel threshold 9/10/11 and alpha/luminance boundaries",()=>{for(const count of [9,10,11]){const pixels=new Uint8ClampedArray(1000*1000*4);pixels.fill(255);for(let i=0;i<count;i++)pixels.set([247,247,247,255],i*4);expect(isBlankCandidate(pixels)).toBe(count<=10);}for(const pixel of [[248,248,248,255],[247,247,247,16]]){const data=new Uint8ClampedArray(1000*1000*4);data.fill(255);for(let i=0;i<100;i++)data.set(pixel,i*4);expect(isBlankCandidate(data)).toBe(true);}});
  it("PF-F163 exact 100MiB input boundary is independent of original 20MiB limit",()=>{for(const size of [104857599,104857600,104857601]){const b=new Uint8Array(size);b.set(new TextEncoder().encode("%PDF-1.7"));if(size>104857600)expect(()=>assertPdfInput(b)).toThrow("100MiB");else expect(()=>assertPdfInput(b)).not.toThrow();}});
});
