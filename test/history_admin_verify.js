const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
 const token=fs.readFileSync('/tmp/iot-owner-token','utf8').trim();
 const browser=await chromium.launch({headless:true}); const report=[];
 for(const vp of [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}]){
  const ctx=await browser.newContext({viewport:{width:vp.width,height:vp.height}}); await ctx.addCookies([{name:'session_token',value:token,url:'http://127.0.0.1:3000'}]);
  await ctx.addInitScript(()=>{localStorage.setItem('iot_history_filters_v2',JSON.stringify({deviceId:'28',hours:'720',metric:'soil_moisture'}));localStorage.setItem('iot_admin_history_filters_v1',JSON.stringify({deviceId:'28',hours:'720',metric:'soil_moisture'}))});
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto('http://127.0.0.1:3000/user/pages/data_history.html',{waitUntil:'networkidle'}); await page.waitForTimeout(800);
  const nativeSelects=await page.locator('select').count(); const cards=page.locator('.metric-card'); const cardCount=await cards.count();
  if(cardCount>1) await cards.nth(1).click();
  const userState=await page.evaluate(()=>({saved:JSON.parse(localStorage.getItem('iot_history_filters_v2')||'{}'),y:chart.getOption().yAxis?.[0],series:chart.getOption().series?.length,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}));
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(500); const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('iot_history_filters_v2')||'{}'));
  report.push({vp:vp.name,page:'user-history',nativeSelects,cardCount,userState,restored,errors:[...errors]});
  errors.length=0; await page.goto('http://127.0.0.1:3000/admin/pages/realtime.html',{waitUntil:'networkidle'}); await page.waitForTimeout(500);
  report.push({vp:vp.name,page:'admin-realtime',devices:await page.locator('.device').count(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),errors:[...errors]});
  errors.length=0; await page.goto('http://127.0.0.1:3000/admin/pages/history.html',{waitUntil:'networkidle'}); await page.waitForTimeout(700);
  report.push({vp:vp.name,page:'admin-history',nativeSelects:await page.locator('select').count(),cards:await page.locator('.metric').count(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),errors:[...errors]});
  await ctx.close();
 }
 const ctx=await browser.newContext({viewport:{width:1280,height:800}});await ctx.addCookies([{name:'session_token',value:token,url:'http://127.0.0.1:3000'}]);const p=await ctx.newPage();let errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:3000/admin/',{waitUntil:'networkidle'});await p.locator('[data-page="realtime"]').click();await p.waitForTimeout(400);await p.locator('[data-page="history"]').click();await p.waitForTimeout(400);report.push({page:'admin-shell',realtimeFrames:await p.locator('.content-frame[data-id="realtime"]').count(),historyFrames:await p.locator('.content-frame[data-id="history"]').count(),errors});await ctx.close();
 console.log(JSON.stringify(report,null,2));
 const bad=report.filter(x=>x.errors?.length||x.overflow||x.nativeSelects>0||(x.page==='admin-shell'&&(!x.realtimeFrames||!x.historyFrames))||(x.page==='admin-realtime'&&!x.devices));
 await browser.close(); if(bad.length){console.error('FAIL',JSON.stringify(bad));process.exit(1)}
})().catch(e=>{console.error(e);process.exit(1)});