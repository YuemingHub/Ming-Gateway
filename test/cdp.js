'use strict';

/**
 * 真实浏览器的自动化驱动（Chrome DevTools Protocol）
 *
 * 为什么不用 puppeteer / playwright：本项目坚持零依赖。
 * Node 22+ 自带全局 WebSocket，配合 CDP 的 HTTP 接口就够用了。
 *
 * 被 test/ui-e2e.js（状态页交互）与 test/auth-ui.js（登录页）共用。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(t));
          } catch (e) {
            reject(new Error('非 JSON 响应：' + t.slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * POST JSON，并把状态码 / 响应头 / 原始文本一并带回来。
 * 测试需要断言响应头（例如 x-gw-channel）时用这个，fetchJson 只适合读 JSON 体。
 */
function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign(
          { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          headers || {}
        ),
      },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(t);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, text: t, json });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败：' + (e.message || 'unknown'))));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      });
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  /** 在页面里执行表达式；awaitPromise 支持 async 函数 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面 JS 抛错：' +
          (r.exceptionDetails.exception && r.exceptionDetails.exception.description
            ? r.exceptionDetails.exception.description
            : r.exceptionDetails.text)
      );
    }
    return r.result ? r.result.value : undefined;
  }

  /** 页面里未捕获的异常与 console.error，用于「页面必须干净」这类断言 */
  pageErrors() {
    return this.events.filter(
      (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    );
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

/**
 * 起一个 headless 浏览器并连上空白页
 * @returns {{chrome, cdp, userDataDir, profile}}
 */
async function launch(opts) {
  const o = opts || {};
  const chromePath = o.executable || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('没找到 Chrome / Edge');

  const debugPort = Number(o.debugPort || 9333);
  const userDataDir = o.userDataDir || path.join(os.tmpdir(), 'gw-cdp-' + Date.now() + '-' + Math.floor(Math.random() * 1e4));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    `--window-size=${o.windowSize || '1600,1200'}`,
    'about:blank',
  ];
  const chrome = spawn(chromePath, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    } catch (_) {
      await sleep(250);
    }
  }
  if (!version) {
    try { chrome.kill(); } catch (_) {}
    throw new Error('Chrome 调试端口未就绪');
  }

  const list = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const target = list.find((t) => t.type === 'page');
  if (!target) {
    try { chrome.kill(); } catch (_) {}
    throw new Error('没有可用的 page target');
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  return { chrome, cdp, userDataDir, executable: chromePath, debugPort };
}

/** 干净收尾：关连接、杀浏览器、删临时 profile */
async function shutdown(session) {
  if (!session) return;
  try { if (session.cdp) session.cdp.close(); } catch (_) {}
  try { if (session.chrome) session.chrome.kill(); } catch (_) {}
  await sleep(300);
  try {
    if (session.userDataDir) fs.rmSync(session.userDataDir, { recursive: true, force: true });
  } catch (_) {}
}

module.exports = { CDP, launch, shutdown, fetchJson, postJson, sleep, CHROME_CANDIDATES };
