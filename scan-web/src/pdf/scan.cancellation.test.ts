import {beforeEach,describe,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({destroy:vi.fn(async()=>{}),canvases:[] as {width:number;height:number}[]}));
vi.mock('./renderer',()=>({
 loadPdf:async()=>({document:{numPages:2},destroy:fake.destroy}),
 renderPageCanvas:async()=>{const canvas={width:10,height:10,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray(400).fill(255)})})};fake.canvases.push(canvas);return canvas;},
 thumbnailOf:()=> 'data:image/jpeg;base64,synthetic',
 throwIfAborted:(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('cancelled','AbortError');},
}));
vi.mock('./decode',()=>({findQrValues:()=>[],isOpaqueToken:()=>false,isBlankCandidate:()=>true}));
import{scanPdf}from'./scan';
beforeEach(()=>{fake.destroy.mockClear();fake.canvases.length=0;});
describe('PF-F167 PF-M047 scan cancellation boundaries',()=>{
 for(const at of [0,1,2])it(`rejects cancellation at progress ${at}, including final page, and releases document`,async()=>{
  const controller=new AbortController();if(at===0)controller.abort();
  await expect(scanPdf({bytes:new Uint8Array([1]),signal:controller.signal,onProgress:p=>{if(p.current===at)controller.abort();}})).rejects.toMatchObject({name:'AbortError'});
  expect(fake.destroy).toHaveBeenCalledOnce();expect(fake.canvases.every(c=>c.width===1&&c.height===1)).toBe(true);
 });
 it('rejects cancellation arriving during the final event loop yield',async()=>{
  const controller=new AbortController();await expect(scanPdf({bytes:new Uint8Array([1]),signal:controller.signal,onProgress:p=>{if(p.current===2)setTimeout(()=>controller.abort(),0);}})).rejects.toMatchObject({name:'AbortError'});expect(fake.destroy).toHaveBeenCalledOnce();
 });
 it('retries successfully with a new signal after cancellation',async()=>{
  const cancelled=new AbortController();cancelled.abort();await expect(scanPdf({bytes:new Uint8Array([1]),signal:cancelled.signal})).rejects.toMatchObject({name:'AbortError'});
  const pages=await scanPdf({bytes:new Uint8Array([1]),signal:new AbortController().signal});expect(pages).toHaveLength(2);expect(pages.every(p=>p.token===undefined&&p.reason)).toBe(true);expect(fake.destroy).toHaveBeenCalledTimes(2);
 });
});
