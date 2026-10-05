import XLSX from 'xlsx';
import { parseRose, parseSvincolati } from '../public/xlsx-parse.js';
const U='/root/.claude/uploads/6071e3f5-f3e6-5fcc-ae06-ae77ef8892e2/';
const rose=parseRose(XLSX,XLSX.readFile(U+'1ffa4ff9-rose-308228-1.xlsx'));
const L=parseSvincolati(XLSX,XLSX.readFile(U+'70e4445d-quotazioni-valore.xlsx'));
const n=s=>s.toLowerCase().trim();
const byNC=new Map(L.map(p=>[n(p.name)+'|'+n(p.club),p]));
const byNR=new Map(); for(const p of L){const k=n(p.name)+'|'+p.role; byNR.set(k,(byNR.get(k)||[]).concat(p));}
let exact=0, nameRole=0, ambig=0, none=[];
for(const t of rose) for(const p of t.players){
  if(byNC.has(n(p.name)+'|'+n(p.club))) {exact++; continue;}
  const c=byNR.get(n(p.name)+'|'+p.role)||[];
  if(c.length===1){nameRole++; console.log('club diverso:',p.name,p.club,'->',c[0].club);} else if(c.length>1){ambig++;console.log('ambiguo',p.name);} else none.push(p.name+' ('+p.club+','+p.role+')');
}
console.log({listone:L.length, rosePlayers:rose.reduce((a,t)=>a+t.players.length,0), exact, nameRole, ambig, none:none.length}); console.log('non nel listone:',none.join(', '));
// duplicates name+role in listone
const d=[...byNR].filter(([k,v])=>v.length>1).map(([k,v])=>k+':'+v.map(x=>x.club).join('/')); console.log('omonimi stesso ruolo nel listone:',d);
