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
    '--use-file-for-fake-video-capture=/home/sandbox/snapdust-ext/test/person.y4m']
});
const page=await browser.newPage();
await page.setViewport({width:1280,height:900});
page.on('console',m=>{const t=m.text();if(t.includes('SnapDust'))console.log('PAGE>',t.slice(0,200));});
page.on('pageerror',e=>console.log('PAGEERR>',String(e).slice(0,300)));

// 1. Landing page: does the extension inject on the real Meet origin?
await page.goto('https://meet.google.com/',{waitUntil:'networkidle2',timeout:45000});
await sleep(4000);
await page.screenshot({path:SHOTS+'/meet_landing.png'});
console.log('LANDING URL:', page.url());

// 2. A meeting code URL: how far can we get signed out? (no join click)
await page.goto('https://meet.google.com/abc-defg-hij',{waitUntil:'networkidle2',timeout:45000});
await sleep(5000);
await page.screenshot({path:SHOTS+'/meet_code.png'});
const txt=await page.evaluate(()=>document.body.innerText.slice(0,400));
console.log('CODE PAGE URL:', page.url());
console.log('CODE PAGE TEXT:', JSON.stringify(txt));
// Did anything request camera/mic?
const perms=await page.evaluate(async()=>{
  try{const v=await navigator.permissions.query({name:'camera'});const a=await navigator.permissions.query({name:'microphone'});return 'camera='+v.state+' mic='+a.state;}catch(e){return 'perm query failed: '+e;}
});
console.log('PERMISSIONS:', perms);
await browser.close();
