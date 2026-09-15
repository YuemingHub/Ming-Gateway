'use strict';

/**
 * 登录页 / 管理面闸门的浏览器端到端测试
 * 运行：node test/auth-ui.js      （自带 mock 上游与网关实例，不需要先跑 demo）
 *
 * 为什么单独做这一层：接口测试只能证明「HTTP 语义对」，
 * 证明不了「登录框看得见、点得动、CSS 没崩」。这里用真实 Chrome 走一遍。
 * 顺带把登录页截图存到 test/.dbg/ 便于肉眼复查。
 */

const path = require('path');
const fs = require('fs');

const { startMock } = require('./mock-upstream');
const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');
const { launch, shutdown, sleep } = require('./cdp');

if (!fs.existsSync(path.join(__dirname, '.data-authui'))) fs.mkdirSync(path.join(__dirname, '.data-authui'), { recursive: true });

const GW_PORT = Number(process.env.AUTHUI_GW_PORT || 8288);
const MOCK_PORT = Number(process.env.AUTHUI_MOCK_PORT || 9288);
const DEBUG_PORT = Number(process.env.AUTHUI_CDP_PORT || 9355);

const USER = 'admin';
const PW = 'auth-ui-test-password';
const BASE = `http://127.0.0.1:${GW_PORT}`;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 轮询页面里的表达式直到为真（页面导航期间求值会抛错，直接当作「未就绪」） */
async function waitFor(cdp, expr, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch (_) { /* 导航中，忽略 */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(150);
  }
}

async function main() {
  console.log(`\n目标：${BASE}/__gw/   登录用户：${USER}`);

  const mock = await startMock(MOCK_PORT, { channelId: 'authui', mode: 'ok' });
  const cfg = normalize(
    {
      server: {
        host: '127.0.0.1',
        port: GW_PORT,
        dataDir: './test/.data-authui',
        logLevel: 'error',
        adminToken: '',
        auth: { enabled: true, username: USER, password: PW, sessionTtlSec: 3600, maxFailures: 5, failureWindowSec: 120 },
      },
      groups: { A: { name: '稳定开发组', fallbackTo: [] }, B: { name: '免费消耗组', fallbackTo: [] }, C: { name: '高配置组', requireExplicit: true } },
      channels: [
        { id: 'ui-mock', name: 'UI 测试渠道', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'k', models: ['deepseek-chat'] },
      ],
      tokens: [{ key: 'sk-authui', name: 'authui' }],
      routes: {},
      cache: { enabled: false },
      fallback: { enabled: true, chain: ['A'] },
    },
    path.join(__dirname, '..')
  );
  const gw = new GatewayServer(cfg);
  await gw.start();

  let session = null;
  const cdpRef = { cdp: null };
  try {
    session = await launch({ debugPort: DEBUG_PORT, windowSize: '1280,900' });
    cdpRef.cdp = session.cdp;
    const cdp = session.cdp;

    // ---------------------------------------------------------------- A. 闸门
    console.log('\n[A] 未登录被挡在门外');
    await cdp.send('Page.navigate', { url: BASE + '/__gw/' });
    const redirected = await waitFor(cdp, `location.pathname === '/__gw/login'`, 10000);
    ok('访问状态页被重定向到登录页', redirected, await cdp.eval('location.pathname').catch(() => '?'));
    ok('浏览器地址栏确实是登录页', (await cdp.eval('location.href')).includes('/__gw/login'));

    // ---------------------------------------------------------------- B. 登录页外观
    console.log('\n[B] 登录页确实渲染出来了（不是白屏 / CSS 崩掉）');
    const look = await cdp.eval(`(function () {
      var f = document.querySelector('form');
      var u = document.getElementById('u');
      var p = document.getElementById('p');
      var btn = document.querySelector('form button[type=submit]');
      var cs = f ? getComputedStyle(f) : null;
      var r = f ? f.getBoundingClientRect() : null;
      var br = btn ? btn.getBoundingClientRect() : null;
      return {
        hasForm: !!f, hasUser: !!u, hasPass: !!p, hasBtn: !!btn,
        btnText: btn ? btn.textContent.trim() : '',
        title: document.title,
        formW: r ? Math.round(r.width) : 0,
        formH: r ? Math.round(r.height) : 0,
        bg: cs ? cs.backgroundColor : '',
        border: cs ? cs.borderTopWidth : '',
        btnW: br ? Math.round(br.width) : 0,
        passType: p ? p.type : '',
        userVisible: !!(u && u.offsetParent !== null),
        bodyText: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60)
      };
    })()`);
    ok('表单存在', look.hasForm);
    ok('有用户名输入框且可见', look.hasUser && look.userVisible);
    ok('密码框是 password 类型（不明文显示）', look.passType === 'password', look.passType);
    ok('有提交按钮', look.hasBtn && look.btnW > 100, `宽 ${look.btnW}px`);
    ok('页面标题正确', /登录/.test(look.title), look.title);
    ok('卡片有实际尺寸（CSS 生效）', look.formW > 250 && look.formH > 200, `${look.formW}x${look.formH}`);
    ok('卡片有背景色与边框（不是透明裸奔）', look.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(look.border) > 0, look.bg + ' / ' + look.border);
    ok('页面文案含网关名称', /统一 API 网关/.test(look.bodyText), look.bodyText);
    ok('登录页没有外部资源引用（断网也能用）',
       (await cdp.eval(`Array.prototype.every.call(document.querySelectorAll('script[src],link[href]'), function(e){ return /^\\/(?!\\/)/.test(e.getAttribute('src')||e.getAttribute('href')); })`)) === true);

    // 截图留档，方便肉眼复查
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const dbgDir = path.join(__dirname, '.dbg');
      fs.mkdirSync(dbgDir, { recursive: true });
      fs.writeFileSync(path.join(dbgDir, 'login-page.png'), Buffer.from(shot.data, 'base64'));
      console.log('  · 登录页截图：test/.dbg/login-page.png');
    } catch (e) {
      console.log('  · 截图失败（不影响测试）：' + e.message);
    }

    // ---------------------------------------------------------------- C. 密码错误
    console.log('\n[C] 密码错误要被拒绝并且看得见');
    await cdp.eval(`(function(){ document.getElementById('u').value=${JSON.stringify(USER)}; document.getElementById('p').value='wrong-password'; document.querySelector('form button[type=submit]').click(); return true; })()`);
    const shownErr = await waitFor(cdp, `!!document.querySelector('.err') && document.querySelector('.err').offsetHeight > 0`, 10000);
    ok('错误提示真的显示在页面上', shownErr);
    const errText = await cdp.eval(`(document.querySelector('.err')||{}).textContent || ''`);
    ok('提示文案是「用户名或密码不正确」', /不正确/.test(errText), String(errText).slice(0, 60));
    ok('密码错误后仍停留在登录页', (await cdp.eval('location.pathname')) === '/__gw/login');

    // ---------------------------------------------------------------- D. 登录成功
    console.log('\n[D] 正确密码 → 进入状态页');
    await cdp.eval(`(function(){ document.getElementById('u').value=${JSON.stringify(USER)}; document.getElementById('p').value=${JSON.stringify(PW)}; document.querySelector('form button[type=submit]').click(); return true; })()`);
    // 登录会 302 到 /__gw/，状态页再去拉接口渲染表格
    const landed = await waitFor(cdp, `location.pathname === '/__gw/' && !!document.querySelector('header.bar')`, 15000);
    ok('登录后跳转到状态页', landed, await cdp.eval('location.pathname').catch(() => '?'));
    const rows = await waitFor(cdp, `document.querySelectorAll('#bodyChannels tr').length > 0`, 15000);
    ok('状态页把渠道表渲染出来了（数据接口没被闸门挡住）', rows);

    const who = await cdp.eval(`(function () {
      var w = document.getElementById('whoBox');
      return { exists: !!w, hidden: w ? w.hidden : null, text: w ? w.innerText.replace(/\\s+/g,' ').trim() : '', href: (document.getElementById('btnLogout')||{}).getAttribute ? document.getElementById('btnLogout').getAttribute('href') : '' };
    })()`);
    ok('页头出现登录用户标识', who.exists && who.hidden === false, JSON.stringify(who));
    ok('标识里显示用户名', who.text.includes(USER), who.text);
    ok('有退出入口且指向 /__gw/logout', who.href === '/__gw/logout', who.href);

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, '.dbg', 'dashboard-logged-in.png'), Buffer.from(shot.data, 'base64'));
      console.log('  · 状态页截图：test/.dbg/dashboard-logged-in.png（右上角应有登录标识）');
    } catch (_) {}

    // ---------------------------------------------------------------- E. 退出
    console.log('\n[E] 退出登录');
    await cdp.eval(`document.getElementById('btnLogout').click(); true;`);
    const backToLogin = await waitFor(cdp, `location.pathname === '/__gw/login' && !!document.querySelector('form')`, 10000);
    ok('点退出后回到登录页', backToLogin, await cdp.eval('location.pathname').catch(() => '?'));
    const blockedAgain = await waitFor(cdp, `location.pathname === '/__gw/login'`, 3000);
    await cdp.send('Page.navigate', { url: BASE + '/__gw/' });
    const kicked = await waitFor(cdp, `location.pathname === '/__gw/login'`, 10000);
    ok('退出后再次访问状态页仍被拦下', kicked && blockedAgain);

    // ---------------------------------------------------------------- F. 页面干净度
    console.log('\n[F] 页面运行健康度');
    const errs = cdp.pageErrors();
    ok('登录页与状态页均无未捕获 JS 异常', errs.length === 0,
       errs.slice(0, 2).map((e) => (e.params.exceptionDetails && e.params.exceptionDetails.text) || 'err').join(' | '));
  } catch (e) {
    fail++;
    failures.push('测试执行中断：' + e.message);
    console.log(`\n  ✗ 测试执行中断：${e.message}`);
    try {
      if (cdpRef.cdp) console.log('  当前地址：' + (await cdpRef.cdp.eval('location.href')));
    } catch (_) {}
  } finally {
    await shutdown(session);
  }

  console.log('\n' + '='.repeat(56));
  console.log(`  登录界面测试：通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('='.repeat(56) + '\n');

  gw.stop();
  try { mock.close(); } catch (_) {}
  fs.rmSync(path.join(__dirname, '.data-authui'), { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
