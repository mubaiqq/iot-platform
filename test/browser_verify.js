const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
  const token=fs.readFileSync('/tmp/iot-owner-token','utf8').trim();
  const browser=await chromium.launch({headless:true});
  const results=[];
  for(const viewport of [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}]){
    const ctx=await browser.newContext({viewport:{width:viewport.width,height:viewport.height}});
    await ctx.addCookies([{name:'session_token',value:token,url:'http://127.0.0.1:3000'}]);
    const page=await ctx.newPage(); const errors=[];
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text())}); page.on('pageerror',e=>errors.push(e.message));
    for(const route of ['/user/pages/data_realtime.html','/user/pages/data_history.html']){
      await page.goto('http://127.0.0.1:3000'+route,{waitUntil:'networkidle'});
      await page.waitForTimeout(500);
      results.push({viewport:viewport.name,route,title:await page.title(),errors:[...errors],overflow:await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),body:(await page.locator('body').innerText()).slice(0,300)});
      errors.length=0;
    }
    await ctx.close();
  }
  console.log(JSON.stringify(results,null,2)); await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
