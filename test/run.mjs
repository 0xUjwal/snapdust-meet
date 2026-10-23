import puppeteer from 'puppeteer-core';
const EXT='/home/sandbox/snapdust-ext/extension-test';
const SHOTS='/home/sandbox/snapdust-ext/shots';
const BASE='http://localhost:8787/harness.html';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const browser=await puppeteer.launch({
  executablePath:'/home/sandbox/browsers/chrome/linux-156.0.8078.47/chrome-linux64/chrome',
  headless:'new',
  args:['--no-sandbox','--disable-dev-shm-usage','--window-size=1280,900',
    `--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=/home/sandbox/snapdust-ext/test/cal.y4m']
  .concat(process.env.WEBGL_OFF==='1' ? ['--disable-webgl','--disable-webgl2'] : [])
});
const page=await browser.newPage();
await page.setViewport({width:1280,height:900});
page.on('console',m=>{const t=m.text();if(!t.includes('[harness]'))console.log('PAGE>',t.slice(0,300));});
page.on('pageerror',e=>console.log('PAGEERR>',String(e).slice(0,400)));

const which=process.argv[2]||'fx';

if(which==='fx'){
  await page.goto(BASE+'?mode=fx',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await sleep(2500);
  await page.screenshot({path:SHOTS+'/fx_normal.png'});
  await page.click('#snap');
  await sleep(800);
  await page.screenshot({path:SHOTS+'/fx_mid.png'});
  await sleep(1600);
  await page.screenshot({path:SHOTS+'/fx_gone.png'});
  await page.click('#snap');
  await sleep(700);
  await page.screenshot({path:SHOTS+'/fx_backmid.png'});
  await sleep(1600);
  await page.screenshot({path:SHOTS+'/fx_back.png'});
}else if(which==='real'){
  // Real-pipeline test with backdrop calibration. cal.y4m: 30s empty room,
  // then 20s of the portrait swaying. We calibrate during the intro, then
  // run the snap cycle once the person is in frame.
  const t0=Date.now();
  const at=async(s)=>{const dt=s*1000-(Date.now()-t0); if(dt>0) await sleep(dt);};
  await page.goto(BASE+'?mode=ml&debugmask='+((process.argv[3]==='debug')?'1':'0')+(process.env.FORCE_GPU==='1'?'&gpu=1':''),{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await at(2);
  // Snap before calibration must be refused.
  await page.click('#snap');
  await sleep(700);
  await page.screenshot({path:SHOTS+'/cal_gated.png'});
  // Start calibration (pill click does this while uncalibrated).
  await page.evaluate("window.postMessage({__snapdust:true,type:'snapdust-calibrate'},location.origin)");
  await page.waitForSelector('#snapdust-preview img',{timeout:30000}).catch(()=>console.log('PREVIEW TIMEOUT'));
  await sleep(400);
  await page.screenshot({path:SHOTS+'/cal_preview.png'});
  // Dismiss preview, wait for the person segment (video t=30s) and masks.
  await page.evaluate("const b=document.querySelector('#snapdust-preview button'); if(b) b.click();");
  await at(34);
  await page.screenshot({path:SHOTS+'/real_normal.png'});
  await page.click('#snap');
  await sleep(800);
  await page.screenshot({path:SHOTS+'/real_mid.png'});
  await sleep(1600);
  await page.screenshot({path:SHOTS+'/real_gone.png'});
  await page.click('#snap');
  await sleep(700);
  await page.screenshot({path:SHOTS+'/real_backmid.png'});
  await sleep(1600);
  await page.screenshot({path:SHOTS+'/real_back.png'});
}else if(which==='reload'){
  // Regression: page reload while the offscreen worker persists. Pre-fix,
  // the reloaded page's restarted clock broke every MediaPipe graph
  // (timestamp mismatch) and masks never returned. Post-fix they must resume.
  await page.goto(BASE+'?mode=ml',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await page.waitForFunction("window.__sdLog.some(l=>l.includes('mask coverage'))",{timeout:90000});
  console.log('phase1: masks flowing before reload');
  await sleep(3000);
  await page.reload({waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  const t1=Date.now();
  await page.waitForFunction("window.__sdLog.some(l=>l.includes('mask coverage'))",{timeout:90000});
  console.log('phase2: masks resumed '+((Date.now()-t1)/1000).toFixed(1)+'s after reload');
  await sleep(2000);
  await page.screenshot({path:SHOTS+'/reload_phase2.png'});
}else if(which==='double'){
  // Regression: a second getUserMedia call (Meet re-requesting the camera)
  // must also yield a live wrapped track.
  await page.goto(BASE+'?mode=ml&double=1',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await page.waitForFunction('window.__sdDouble===true',{timeout:30000});
  await sleep(3000);
  const st=await page.evaluate("document.getElementById('v2').srcObject.getVideoTracks()[0].readyState");
  console.log('second stream track state:', st);
  await page.screenshot({path:SHOTS+'/double.png'});
}else if(which==='killoff'){
  // Regression: the offscreen ML document is destroyed mid-session (SW kill,
  // crash). The camera must keep painting (raw passthrough) and ML must
  // recover by itself once failures trip the restart path.
  await page.goto(BASE+'?mode=ml',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await page.waitForFunction("window.__sdLog.some(l=>l.includes('mask coverage'))",{timeout:90000});
  const base=await page.evaluate("window.__sdLog.filter(l=>l.includes('mask coverage')).length");
  console.log('phase1: masks flowing (count '+base+')');
  const off=(await browser.targets()).find(t=>t.url().includes('offscreen.html'));
  if(!off){ console.log('FAIL: no offscreen target found'); process.exit(1); }
  const offSess=await off.createCDPSession();
  const tOld=(await offSess.send('Runtime.evaluate',{expression:'performance.timeOrigin',returnByValue:true})).result.value;
  const baseAtKill=await page.evaluate("window.__sdLog.filter(l=>l.includes('mask coverage')).length");
  const sw=(await browser.targets()).find(t=>t.url().includes('background.js'));
  if(!sw){ console.log('FAIL: no service worker target found'); process.exit(1); }
  const swSess=await sw.createCDPSession();
  await swSess.send('Runtime.evaluate',{expression:'chrome.offscreen.closeDocument()',awaitPromise:true});
  let destroyed=false;
  for(let i=0;i<24;i++){ await sleep(250); if(!(await browser.targets()).find(t=>t.url().includes('offscreen.html'))){destroyed=true;break;} }
  console.log('offscreen destroyed:', destroyed);
  if(!destroyed){ console.log('FAIL: offscreen still alive'); process.exit(1); }
  // camera must still be painting while ML is down
  await sleep(14000); // pass the 12s watchdog
  await page.screenshot({path:SHOTS+'/killoff_raw.png'});
  console.log('raw passthrough engaged during outage:', await page.evaluate("window.__sdLog.some(l=>l.includes('fx-state: raw'))"), '(false = recovery beat the 12s watchdog, also fine)');
  // recovery: fail streak -> ensureWorker -> SW recreates offscreen -> masks
  const t1=Date.now();
  await page.waitForFunction(`window.__sdLog.filter(l=>l.includes('mask coverage')).length>${baseAtKill}`,{timeout:120000});
  console.log('phase2: ML recovered, masks flowing again after '+((Date.now()-t1)/1000).toFixed(1)+'s');
  // prove the recovery came from a FRESH offscreen instance
  const off2=(await browser.targets()).find(t=>t.url().includes('offscreen.html'));
  const off2Sess=await off2.createCDPSession();
  const tNew=(await off2Sess.send('Runtime.evaluate',{expression:'performance.timeOrigin',returnByValue:true})).result.value;
  console.log('fresh offscreen instance:', tNew>tOld, '(old '+tOld+', new '+tNew+')');
  await page.screenshot({path:SHOTS+'/killoff_recovered.png'});
}else if(which==='rawmode'){
  // Deterministic raw-passthrough test: ML death signal mid-session must
  // keep the camera painting (mirrored video, no effects), and ml-alive
  // must restore effects.
  await page.goto(BASE+'?mode=ml',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await page.waitForFunction("window.__sdLog.some(l=>l.includes('mask coverage'))",{timeout:90000});
  const base2=await page.evaluate("window.__sdLog.filter(l=>l.includes('mask coverage')).length");
  await page.evaluate("window.postMessage({__snapdust:true,type:'ml-dead'},location.origin)");
  await sleep(2500);
  const rawOn=await page.evaluate("window.__sdLog.some(l=>l.includes('fx-state: raw'))");
  const trackLive=await page.evaluate("document.getElementById('v').srcObject.getVideoTracks()[0].readyState");
  await page.screenshot({path:SHOTS+'/rawmode_on.png'});
  console.log('raw engaged:', rawOn, '| camera track still live:', trackLive);
  await page.evaluate("window.postMessage({__snapdust:true,type:'ml-alive'},location.origin)");
  await sleep(2500);
  const backOn=await page.evaluate("window.__sdLog.filter(l=>l.includes('fx-state: ready')).length>=2");
  const masksResumed=await page.evaluate(`window.__sdLog.filter(l=>l.includes('mask coverage')).length>${base2}`);
  console.log('effects restored:', backOn, '| masks flowing:', masksResumed);
  await page.screenshot({path:SHOTS+'/rawmode_off.png'});
}else if(which==='ml'){
  await page.goto(BASE+'?mode=ml&debugmask='+((process.argv[3]==='debug')?'1':'0')+(process.env.FORCE_GPU==='1'?'&gpu=1':''),{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await sleep(20000); // let worker load models
  await page.screenshot({path:SHOTS+'/ml.png'});
}else if(which==='seg'){
  await page.goto(BASE+'?mode=seg',{waitUntil:'load'});
  await page.waitForFunction('window.__sdReady===true',{timeout:15000});
  await page.waitForFunction('window.__sdSegDone===true',{timeout:40000}).catch(()=>console.log('SEG TIMEOUT'));
  await sleep(500);
  await page.screenshot({path:SHOTS+'/seg.png'});
}
const log=await page.evaluate('window.__sdLog');
console.log('--- sdLog ---'); for(const l of log) console.log(l);
await browser.close();
