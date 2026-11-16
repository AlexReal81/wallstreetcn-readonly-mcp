import test from 'node:test';
import assert from 'node:assert/strict';
import { getCaixinWindowIndex } from '../src/caixin.js';

const date = (day,hr='12:00:00') => `${day} ${hr}`;
const item = (id,t) => ({link:`https://finance.caixin.com/2026-11-16/${id}.html`,desc:`Title ${id}`,summ:`Summary ${id}`,time:t});
const f = pages => async url => {const off=Number(new URL(url).searchParams.get('start'));return {ok:true,json:async()=>({count:25,datas:pages[off]??[],start:off})};};

test('one-page completed window and expected section',async()=>{
 const data=[item(123456,'2026-11-16 20:00:00'),item(123457,'2026-11-16 18:00:00'),item(123458,'2026-11-15 18:00:00')];
 const x=await getCaixinWindowIndex({section:'finance',start:date('2026-11-15','19:00:00'),end:date('2026-11-16','19:00:00')},f({0:data}));
 assert.equal(x.complete,true);assert.equal(x.pages_read,1);assert.equal(x.batch_count,1);assert.equal(x.items[0].id,'123457');
});

test('reject missing beginning and do not claim complete',async()=>{
 const data=[item(123456,'2026-11-16 18:00:00')];
 await assert.rejects(()=>getCaixinWindowIndex({section:'finance',start:date('2026-11-15','19:00:00'),end:date('2026-11-16','19:00:00')},f({0:data})),/exhausted/);
});

test('continue by offset over two pages',async()=>{
 const x=[];for(let i=0;i<25;i++)x.push(item(123456+i,`2026-11-16 ${String(18-Math.floor(i/2)).padStart(2,'0')}:00:00`));
 const y=[item(123500,'2026-11-15 18:00:00')];
 const common={section:'finance',start:date('2026-11-15','19:00:00'),end:date('2026-11-16','19:00:00'),pagesPerCall:1};
 const a=await getCaixinWindowIndex(common,f({0:x,25:y}));assert.equal(a.complete,false);assert.equal(a.next_offset,25);
 const b=await getCaixinWindowIndex({...common,nextOffset:a.next_offset},f({0:x,25:y}));assert.equal(b.complete,true);assert.equal(b.next_offset,null);
});
