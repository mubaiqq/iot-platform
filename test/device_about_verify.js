const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
 const b=await chromium.launch({headless:true});
 for(const vp of [{n:'desktop',width:1280,height:800},{n:'mobile',width:390,height:844}]){
  const c=await b.newContext({viewport:{width:vp.width,height:vp.height}});await c.addCookies([{name:'session_token',value:fs.readFileSync('/tmp/iot-owner-token','utf8').trim(),url:'http://127.0.0.1:3000'}]);
  const p=await c.newPage();let errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.goto('http://127.0.0.1:3000/user/device/32',{waitUntil:'networkidle'});await p.waitForTimeout(600);
  const about=p.getByText('关于',{exact:true});console.log(vp.n,{about:await about.count(),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),errors:errs});
  await about.click(); await p.waitForTimeout(500);
  console.log(vp.n,'about clicked'); await c.close();
 }
 await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
