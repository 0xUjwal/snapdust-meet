import puppeteer from 'puppeteer-core';
const EXT='/home/sandbox/snapdust-ext/extension';
const SHOTS='/home/sandbox/snapdust-ext/shots';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const browser=await puppeteer.launch({
  executablePath:'/home/sandbox/browsers/chrome/linux-156.0.8078.47/chrome-linux64/chrome',
  headless:'new',
  args:['--no-sandbox','--disable-dev-shm-usage','--window-size=1280,900',
    `--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=/home/sandbox/snapdust-ext/test/cal.y4m']
});
const page=await browser.newPage();
await page.setViewport({width:1280,height:900});
page.on('console',m=>{const t=m.text();if(t.includes('SnapDust')||t.includes('Content Security')||t.includes('Refused'))console.log('PAGE>',t.slice(0,250));});
page.on('pageerror',e=>console.log('PAGEERR>',String(e).slice(0,300)));

await page.goto('https://meet.google.com/abc-defg-hij',{waitUntil:'networkidle2',timeout:45000});
await sleep(6000);
// wait for the pill (content script) and camera wrap
await page.waitForSelector('#snapdust-pill',{timeout:30000}).catch(()=>console.log('NO PILL'));
console.log('pill text:', await page.evaluate("document.querySelector('#snapdust-pill')?.textContent"));
// wait for ML masks (empty room, cov~0) then click the pill to calibrate
await sleep(12000); // model load
console.log('pill text before click:', await page.evaluate("document.querySelector('#snapdust-pill')?.textContent"));
await page.click('#snapdust-pill').catch(e=>console.log('click fail',String(e)));
// countdown 4s + capture; preview should appear shortly after
let found=false;
for(let i=0;i<30;i++){
  await sleep(1000);
  const st=await page.evaluate(`({
    pill: document.querySelector('#snapdust-pill')?.textContent || null,
    preview: !!document.querySelector('#snapdust-preview'),
    img: !!document.querySelector('#snapdust-preview img'),
    calstate: (window.__sdCalLog||[]).slice(-3)
  })`);
  if(i<8||st.preview||i%5===0) console.log('t+'+(i+1)+'s', JSON.stringify(st));
  if(st.preview){found=true;break;}
}
await page.screenshot({path:SHOTS+'/meet3_cal.png'});
console.log('PREVIEW SHOWN:', found);
await browser.close();
