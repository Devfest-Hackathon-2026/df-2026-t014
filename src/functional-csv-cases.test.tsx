// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { RosterImportPanel } from './RosterImportPanel';
import { testDom } from './testDom';
import { baseState } from './domain/functional-fixtures';
import { NEW_STUDENT } from './domain/rosterCsv';
let dom:ReturnType<typeof testDom>;
afterEach(async()=>{await dom?.close()});
async function setup(empty=false){dom=testDom();const state=empty?baseState([]):baseState(),onChange=vi.fn();await dom.render(<RosterImportPanel state={state} sample={false} busy={false} actor="teacher-test" onChange={onChange}/>);return{state,onChange};}
async function csv(text:string){await act(async()=>{const el=dom.container.querySelector('input[type=file]')!;Object.defineProperty(el,'files',{configurable:true,value:[{name:'fixture.csv',size:new TextEncoder().encode(text).length,text:async()=>text}]});el.dispatchEvent(new dom.dom.window.Event('change',{bubbles:true}));});}
const mapping=(row=2)=>dom.container.querySelector(`[aria-label="${row}行目の対応先"]`) as HTMLSelectElement;
async function confirm(){await dom.click(dom.input('人数・氏名・番号・座席と'));await dom.click(dom.button('確認した名簿を反映'));}
describe('Excel functional CSV actual input and import UI',()=>{
 it('PF-F009 BOM and header aliases with LF/CRLF reach explicit import and correct zero-based seat',async()=>{for(const nl of ['\n','\r\n'])for(const header of ['出席番号,氏名,行,列','number,name,row,col']){const x=await setup(true);await csv('\uFEFF'+header+nl+'1,架空,1,1'+nl);expect(mapping().value).toBe('');await dom.value(mapping(),NEW_STUDENT);await confirm();expect(x.onChange).toHaveBeenCalledOnce();expect(x.onChange.mock.calls[0][0].students[0]).toMatchObject({name:'架空',number:1,seat:{row:0,col:0}});await dom.close();}});
 it('PF-F010 quoted comma escaped quote and newline stay visible as one person before explicit application',async()=>{const x=await setup(true),name='名,前"確認\n続き';await csv('番号,氏名\n1,"名,前""確認\n続き"');expect(dom.container.querySelectorAll('tbody tr')).toHaveLength(1);expect(dom.container.querySelector('tbody tr')?.textContent).toContain(name);await dom.value(mapping(),NEW_STUDENT);await confirm();expect(x.onChange.mock.calls[0][0].students).toHaveLength(1);expect(x.onChange.mock.calls[0][0].students[0].name).toBe(name);});
 for(const [id,values,error] of [
 ['PF-F011',['番号,氏名\n1,正常\n2,"未完'],'引用符'],
 ['PF-F012',['','\n\r\n  ','番号,氏名\n'],'1人以上'],
 ['PF-F013',['氏名,別列\n架空,1','番号,別列\n1,架空'],'見出し'],
 ['PF-F014',['0','-1','1.5','１'].map(n=>'番号,氏名\n'+n+',架空'),'氏名・出席番号'],
 ['PF-F016',['番号,氏名\n1,同名\n1,同名','番号,氏名\n1,同名\n1,別名'],'重複'],
 ['PF-F017',['1,',',1','0,1'].map(p=>'番号,氏名,行,列\n7,架空,'+p),'座席'],
 ] as const)it(id+' invalid CSV is shown as an error without partial apply or roster loss',async()=>{for(const value of values){const x=await setup(),before=structuredClone(x.state);await csv(value);expect(dom.container.querySelector('.notice.danger')?.textContent).toContain(error);expect(mapping()).toBeNull();expect(x.onChange).not.toHaveBeenCalled();expect(x.state).toEqual(before);await dom.close();}});
 it('PF-F017 blank CSV seat pair adds an unplaced person',async()=>{const x=await setup();await csv('番号,氏名,行,列\n7,新規,,');await dom.value(mapping(),NEW_STUDENT);await confirm();expect(x.onChange.mock.calls[0][0].students.find((s:{number:number})=>s.number===7).seat).toBeNull();});
 it('PF-F018 two same-name rows remain unmapped until both stable IDs and confirmation are selected',async()=>{const x=await setup();await csv('番号,氏名\n3,佐藤 蓮\n4,佐藤 蓮');expect(mapping(2).value).toBe('');expect(mapping(3).value).toBe('');await dom.value(mapping(2),'S03');await dom.click(dom.input('人数・氏名・番号・座席と'));expect(dom.button('確認した名簿を反映').disabled).toBe(true);await dom.value(mapping(3),'S04');expect(dom.button('確認した名簿を反映').disabled).toBe(true);await confirm();expect(x.onChange).toHaveBeenCalledOnce();expect(x.onChange.mock.calls[0][0].students.filter((s:{name:string})=>s.name==='佐藤 蓮')).toHaveLength(2);});
 it('PF-F019 two rows cannot map to the same stable ID and no other student is deleted',async()=>{const x=await setup(),before=structuredClone(x.state);await csv('番号,氏名\n3,佐藤 蓮\n4,佐藤 蓮');await dom.value(mapping(2),'S03');await dom.value(mapping(3),'S03');await confirm();expect(dom.container.querySelector('.notice.danger')?.textContent).toContain('複数行');expect(x.onChange).not.toHaveBeenCalled();expect(x.state).toEqual(before);});
 it('PF-F020 unmentioned existing attendance number and seat conflicts reject all imported rows',async()=>{for(const text of ['番号,氏名\n6,新規','番号,氏名,行,列\n7,新規,2,3']){const x=await setup();await csv(text);await dom.value(mapping(),NEW_STUDENT);await confirm();expect(dom.container.querySelector('.notice.danger')).not.toBeNull();expect(x.onChange).not.toHaveBeenCalled();expect(x.state.students).toHaveLength(6);await dom.close();}});
 it('PF-F021 external ID suggestion exposes differing name while name-only match stays unselected',async()=>{const x=await setup();await csv('番号,氏名,id\n3,改名された人,google-3\n4,佐藤 蓮,');expect(mapping(2).value).toBe('S03');expect(mapping(3).value).toBe('');expect(dom.container.querySelector('tbody tr')?.textContent).toContain('改名された人');await dom.value(mapping(3),'S04');await confirm();expect(x.onChange.mock.calls[0][0].students.find((s:{id:string})=>s.id==='S03').name).toBe('改名された人');});
});
