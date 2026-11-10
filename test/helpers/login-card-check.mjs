import fs from 'node:fs';
import path from 'node:path';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const WEB = path.resolve(process.argv[2] || path.join(ROOT, 'web'));
const shots = process.argv[3];
const account = process.argv[4] === 'account';
if (shots) fs.mkdirSync(shots, { recursive: true });
const rows = [];
const is = (n, w, g) => rows.push([n, JSON.stringify(w), JSON.stringify(g)].join('\x1f'));
const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
const pushText = Function(`return (${sw.match(/function pushText\(d\) \{[\s\S]*?\n\}/)[0]})`)();
is('mixed push still names the authorization server', true,
  pushText({ n: 2, kind: 'mixed', sessions: [{ project: 'acme-api', session: 'api-1', server: 'example' }] }).body.includes('example needs authorization'));
const srv = await serveDir(WEB);
let browser;
try {
  browser = await launch({ width: 390, height: 844, scale: 1, mobile: true });
  await browser.call('Network.enable'); await browser.call('Network.setBypassServiceWorker', { bypass: true });
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('gf.base','fixtures');
    const interval=window.setInterval.bind(window);
    window.setInterval=(fn,ms,...args)=>ms===5000?0:interval(fn,ms,...args);
    window.__loginCalls=[];
    let loginState=new URLSearchParams(location.search).get('login-state')||'pending';
    const real=window.fetch.bind(window);
    window.fetch=(url,opts)=>{
      if(String(url).includes('/fixtures/logins.json')) {
        const state=loginState;
        const connector=state==='claude.ai';
        const row={id:innerWidth+'-'+state,project:'acme-api@laptop',host:'laptop',server:connector?'claude_ai_Example':'example',
          provider:connector?'claude.ai':'auth.example.com',session:'api-1',expires:Date.now()+(state==='expired'?-1000:600000),
          status:state==='done'?'done':state==='expired'?'expired':'pending',kind:connector?'connector':'loopback',connector:'Example',
          first_site:state==='first-time-site',authorize:connector?'https://claude.ai/settings/connectors':'https://auth.example.com/oauth/authorize?state=placeholder'};
        if (${account}) Object.assign(row,{kind:'account',profile:'work',provider:'Claude account sign-in',server:'Claude account',
          status:state==='needs-login'?'needs-login':row.status,first_site:false,authorize:'https://claude.com/cai/oauth/authorize?state=placeholder'});
        return Promise.resolve(new Response(JSON.stringify({items:[row]}),{status:200}));
      }
      if(String(url).includes('/api/verb')) {
        const b=JSON.parse(opts.body); window.__loginCalls.push({tool:b.tool,project:b.args.project,session:b.args.session,assertion:!!opts.headers['X-Fleet-Assertion']});
        if(b.tool==='fleet_account_login_start') loginState='pending';
        return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({ok:true,text:'done · HTTP 200'}),{status:200})),200));
      }
      return real(url,opts);
    };` });
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
    await sleep(400); // let the app's resize repaint settle before placing the card
    for (const state of account ? ['pending', 'expired', 'done', 'needs-login'] : ['pending', 'first-time-site', 'expired', 'done', 'claude.ai']) {
      await browser.call('Page.navigate', { url: `${srv.base}/?login-state=${encodeURIComponent(state)}` });
      for (let i = 0; i < 80; i++) {
        const ready = await browser.evaluate(expected => {
          const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('continue without'));
          if (b) b.click();
          return document.querySelector('.login-card')?.dataset.login === expected;
        }, `${width}-${state}`);
        if (ready) break; await sleep(100);
      }
      const read = await browser.evaluate(() => {
        const card = document.querySelector('.login-card');
        return { title: card.querySelector('.c-name').textContent, text: card.textContent, input: !!card.querySelector('input'),
          first: card.textContent.includes('first time for this site'), link: card.querySelector('a')?.href,
          overflow: card.getBoundingClientRect().right > innerWidth + 1,
          countdown: !!card.querySelector('[data-login-expires]'), font: getComputedStyle(card.querySelector('.c-name')).fontSize };
      });
      is(`${width} ${state}: provider in title`, account ? 'Claude account sign-in' : state === 'claude.ai' ? 'claude.ai' : 'auth.example.com', read.title);
      is(`${width} ${state}: correct input`, !['expired', 'done', 'claude.ai', 'needs-login'].includes(state), read.input);
      is(`${width} ${state}: first site warning`, state === 'first-time-site', read.first);
      is(`${width} ${state}: stays inside viewport`, false, read.overflow);
      is(`${width} ${state}: host and session`, true, read.text.includes('laptop') && read.text.includes('api-1'));
      if (account) {
        is(`${width} ${state}: profile in large type`, true, await browser.evaluate(() => {
          const profile=[...document.querySelectorAll('.login-card .c-name')].find(n=>n.textContent==='work');
          return !!profile && parseFloat(getComputedStyle(profile).fontSize)>=20;
        }));
        if (state === 'needs-login') is(`${width}: Sign in addresses one session`, true, read.text.includes('Sign in'));
      }
      if (state === 'claude.ai') is(`${width} connector settings link`, 'https://claude.ai/settings/connectors', read.link);
      if (shots) { const { data } = await browser.call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${width}x${height}-${state}.png`), Buffer.from(data, 'base64')); }
      if (account && state === 'needs-login') {
        await browser.evaluate(() => document.querySelector('.login-card button').click());
        await sleep(500);
        is(`${width} Sign in sends one session to its own host`, { tool: 'fleet_account_login_start', project: 'acme-api@laptop', session: 'api-1', assertion: false },
          await browser.evaluate(() => window.__loginCalls.at(-1)));
        is(`${width} Sign in replaces the need with a paste card`, true, await browser.evaluate(() => !!document.querySelector('.login-card input')));
      }
      if (state === 'pending') {
        is(`${width} countdown present`, true, read.countdown);
        await browser.evaluate(isAccount => { const input = document.querySelector('.login-card input'); input.focus(); input.value = isAccount ? 'callback-secret-browser#placeholder' : 'http://localhost:12345/callback?code=callback-secret-browser&state=placeholder'; }, account);
        is(`${width} pasted field prevents destructive repaint`, true, await browser.evaluate(async () => (await import('./app.js')).typingNow()));
        await browser.evaluate(() => document.querySelector('.login-card button').click());
        is(`${width} callback cleared immediately`, true, await browser.evaluate(() => !document.querySelector('.login-card input')?.value));
        await sleep(100);
        is(`${width} callback absent from page and storage`, false, await browser.evaluate(() => document.body.textContent.includes('callback-secret-browser') || JSON.stringify(localStorage).includes('callback-secret-browser')));
        is(`${width} callback absent from client audit`, false, await browser.evaluate(async () => JSON.stringify((await import('./api.js')).auditLog()).includes('callback-secret-browser')));
        is(`${width} finish uses dedicated verb`, account ? 'fleet_account_login_finish' : 'fleet_login_finish', await browser.evaluate(() => window.__loginCalls.at(-1)?.tool));
      }
    }
  }
} catch (e) { console.error(e.stack); process.exitCode = 1; }
finally { if (browser) await browser.close(); await new Promise(r => (srv.close(), r())); console.log(rows.join('\n')); }
