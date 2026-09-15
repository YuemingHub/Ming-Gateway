'use strict';

/**
 * 界面端到端测试（真实浏览器）
 * 运行：node test/ui-e2e.js        （需先启动 scripts/demo.js）
 *
 * 为什么要有这个：接口测试只能证明后端对，证明不了「页面点得动、存得下、看得见」。
 * 这里用 Chrome DevTools Protocol 驱动真实 Chrome：
 *   真正去点「添加渠道」按钮、真在输入框里填值、真点「保存」，
 *   最后直接查接口和界面确认结果落库并生效。
 *
 * 依赖：Chrome + Node 内置 WebSocket（Node 22+），零 npm 依赖。
 */

const fs = require('fs');
const path = require('path');

const { launch, shutdown, fetchJson, postJson, sleep, CHROME_CANDIDATES } = require('./cdp');

const GW = process.env.UI_GW || 'http://127.0.0.1:8787';
const PAGE = GW + '/__gw/';
const DEBUG_PORT = Number(process.env.UI_CDP_PORT || 9333);
const TEST_ID = 'ui-e2e-chan';
const TEST_MODEL = 'ui-e2e-model';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ------------------------------------------------------------------ 页面内工具

/** 注入到页面的辅助函数（浏览器端） */
const PAGE_HELPERS = `
window.__t = {
  $: function (id) { return document.getElementById(id); },
  set: function (id, v) {
    var el = document.getElementById(id);
    if (!el) throw new Error('找不到元素 #' + id);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  wait: function (fn, ms) {
    ms = ms || 6000;
    return new Promise(function (res, rej) {
      var t0 = Date.now();
      (function loop() {
        var ok = false;
        try { ok = fn(); } catch (e) { ok = false; }
        if (ok) return res(true);
        if (Date.now() - t0 > ms) return rej(new Error('等待超时'));
        setTimeout(loop, 80);
      })();
    });
  },
  rows: function () {
    var tb = document.getElementById('bodyChannels');
    return tb ? Array.prototype.map.call(tb.querySelectorAll('tr'), function (tr) {
      var edit = tr.querySelector('button[data-edit]');
      return edit ? edit.getAttribute('data-edit') : null;
    }).filter(Boolean) : [];
  },
  clickEdit: function (id) {
    var b = document.querySelector('#bodyChannels button[data-edit="' + id + '"]');
    if (!b) throw new Error('没有找到 ' + id + ' 的编辑按钮');
    b.click();
    return true;
  },
  clickToggle: function (id) {
    var b = document.querySelector('#bodyChannels button[data-toggle="' + id + '"]');
    if (!b) throw new Error('没有找到 ' + id + ' 的启停按钮');
    b.click();
    return true;
  },
  clickDelete: function (id) {
    var b = document.querySelector('#bodyChannels button[data-del="' + id + '"]');
    if (!b) throw new Error('没有找到 ' + id + ' 的删除按钮');
    b.click();
    return true;
  },
  /* 出错时的现场快照：不看这个就只能靠猜 */
  snap: function () {
    function txt(id) { var e = document.getElementById(id); return e ? e.textContent : null; }
    function vis(id) { var e = document.getElementById(id); return e ? !e.hidden : null; }
    var errs = {};
    ['id', 'name', 'group', 'provider', 'baseUrl', 'apiKey', 'models', 'weight', 'priority'].forEach(function (k) {
      var v = txt('e_' + k);
      if (v && v.trim()) errs[k] = v.trim();
    });
    var f = document.getElementById('f_models');
    return {
      modalOpen: vis('chModal'),
      modalErr: vis('mdlErr') ? txt('mdlErr') : null,
      fieldErrs: errs,
      testBar: vis('testBar') ? txt('testBar') : null,
      models: f ? f.value : null,
      pickerVisible: vis('mpick'),
      btnSaveDisabled: (document.getElementById('btnSave') || {}).disabled,
      btnTestDisabled: (document.getElementById('btnTest') || {}).disabled,
      btnFetchDisabled: (document.getElementById('btnFetchModels') || {}).disabled
    };
  }
};
true;
`;

// ------------------------------------------------------------------ 主流程

async function main() {
  console.log(`\n目标页面：${PAGE}`);

  // 0. 页面必须先活着
  let status;
  try {
    status = await fetchJson(GW + '/__gw/api/status');
  } catch (e) {
    console.error(`\n[前置失败] 网关没在 ${GW} 上跑。请先执行：node scripts/demo.js\n  ${e.message}\n`);
    process.exit(1);
  }
  console.log(`  网关在线：v${status.version}，渠道 ${status.channels.length} 个\n`);

  // 1. 找 Chrome
  if (!CHROME_CANDIDATES.some((p) => fs.existsSync(p))) {
    console.error('[前置失败] 没找到 Chrome / Edge，跳过界面测试。');
    process.exit(1);
  }

  let session = null;
  let cdp = null;
  try {
    session = await launch({ debugPort: DEBUG_PORT, windowSize: '1600,1200' });
    cdp = session.cdp;
    console.log(`  浏览器：${session.executable}`);

    // 打开状态页
    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(1500);

    // 等页面自身渲染完成（渠道表出现行）
    await cdp.eval(PAGE_HELPERS);
    await cdp.eval(`__t.wait(function(){ return __t.rows().length > 0; }, 10000)`);
    ok('状态页加载并渲染出渠道表', true);

    // 把 confirm 自动判定为「确定」，方便测删除
    await cdp.eval(`window.confirm = function () { return true; }; true;`);

    // ---------------------------------------------------------------- A. 布局回归
    console.log('\n[A] 布局回归（此前踩过的 .bar 类名冲突）');
    const layout = await cdp.eval(`(function () {
      var hd = document.querySelector('header.bar');
      var nav = document.querySelector('nav.nav');
      var meter = document.querySelector('.meter');
      var r = function (el) { return el ? el.getBoundingClientRect() : null; };
      var hb = r(hd), nb = r(nav), mb = r(meter);
      return {
        hasHeader: !!hd,
        headerH: hb ? Math.round(hb.height) : -1,
        hasNav: !!nav,
        navH: nb ? Math.round(nb.height) : -1,
        navPos: nav ? getComputedStyle(nav).position : '',
        hasMeter: !!meter,
        meterH: mb ? Math.round(mb.height) : -1,
        titleFont: hd ? getComputedStyle(hd.querySelector('h1') || hd).fontSize : ''
      };
    })()`);
    ok('顶部标题栏存在且高度正常（>60px）', layout.headerH > 60, `实际 ${layout.headerH}px`);
    ok('导航栏存在且高度正常（>28px）', layout.hasNav && layout.navH > 28, `实际 ${layout.navH}px`);
    ok('导航栏为吸顶定位', layout.navPos === 'sticky' || layout.navPos === 'fixed', layout.navPos);
    ok('进度条已改名 .meter（不再污染 header）', layout.hasMeter && layout.meterH <= 20, `meterH=${layout.meterH}`);

    // ---------------------------------------------------------------- B. 控件齐备
    console.log('\n[B] 渠道管理控件齐备');
    const controls = await cdp.eval(`(function () {
      var tb = document.getElementById('bodyChannels');
      return {
        add: !!document.getElementById('btnAddChannel'),
        reload: !!document.getElementById('btnReloadCh'),
        modal: !!document.getElementById('chModal'),
        form: ['f_id','f_name','f_group','f_provider','f_plan','f_baseUrl','f_apiKey','f_models','f_weight','f_priority'].map(function (k) { return !!document.getElementById(k); }).every(Boolean),
        editBtns: document.querySelectorAll('#bodyChannels button[data-edit]').length,
        toggleBtns: document.querySelectorAll('#bodyChannels button[data-toggle]').length,
        delBtns: document.querySelectorAll('#bodyChannels button[data-del]').length,
        rowCount: tb ? tb.querySelectorAll('tr').length : 0
      };
    })()`);
    ok('有「添加渠道」按钮', controls.add);
    ok('有「重新加载」按钮', controls.reload);
    ok('弹窗容器存在', controls.modal);
    ok('表单字段齐全', controls.form);
    ok('每行都有 编辑 / 启停 / 删除 三个按钮', controls.editBtns === controls.rowCount && controls.toggleBtns === controls.rowCount && controls.delBtns === controls.rowCount,
      `行 ${controls.rowCount} 编辑 ${controls.editBtns} 启停 ${controls.toggleBtns} 删除 ${controls.delBtns}`);

    // 先把可能残留的测试渠道删掉，保证可重复运行
    const existing = (await fetchJson(GW + '/__gw/api/channels')).channels.map((c) => c.id);
    if (existing.includes(TEST_ID)) {
      await cdp.eval(`fetch('/__gw/api/channel/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(TEST_ID)} }) }).then(function () { return true; })`);
      await cdp.eval(`__t.wait(function(){ return __t.rows().indexOf(${JSON.stringify(TEST_ID)}) < 0; }, 6000)`);
    }

    // ---------------------------------------------------------------- C. 新增
    console.log('\n[C] 通过界面新增渠道');
    const before = (await fetchJson(GW + '/__gw/api/channels')).channels.length;

    await cdp.eval(`document.getElementById('btnAddChannel').click(); true;`);
    const modalOpen = await cdp.eval(`__t.wait(function(){ return !document.getElementById('chModal').hidden; }, 4000).then(function(){ return true; })`);
    ok('点击「添加渠道」后弹窗打开', modalOpen === true);

    const title = await cdp.eval(`document.getElementById('mdlTitle').textContent`);
    ok('弹窗标题为「添加渠道」', /添加/.test(title), title);

    const presetCount = await cdp.eval(`document.querySelectorAll('#presetBox button').length`);
    ok('快速填充预设已渲染', presetCount > 0, `${presetCount} 个`);

    // 真实填表
    await cdp.eval(`(function () {
      __t.set('f_id', ${JSON.stringify(TEST_ID)});
      __t.set('f_name', '界面新增渠道');
      __t.set('f_group', 'B');
      __t.set('f_provider', 'openai');
      __t.set('f_plan', 'free');
      __t.set('f_baseUrl', 'http://127.0.0.1:9904/v1');
      __t.set('f_apiKey', 'sk-ui-e2e-abcdefghij');
      __t.set('f_models', ${JSON.stringify(TEST_MODEL)});
      __t.set('f_weight', '77');
      __t.set('f_priority', '9');
      return true;
    })()`);

    await cdp.eval(`document.getElementById('btnSave').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 8000)`);
    ok('点击「保存」后弹窗关闭（未报错）', true);

    const afterAdd = await fetchJson(GW + '/__gw/api/channels');
    const added = afterAdd.channels.find((c) => c.id === TEST_ID);
    ok('新渠道已写入后端', !!added, '接口里查不到');
    ok('渠道数量 +1', afterAdd.channels.length === before + 1, `${before} → ${afterAdd.channels.length}`);
    ok('填写的字段均正确落库', added && added.group === 'B' && added.weight === 77 && added.priority === 9 && added.models.includes(TEST_MODEL),
      added ? JSON.stringify({ g: added.group, w: added.weight, p: added.priority, m: added.models }) : '');
    ok('密钥已保存但只回传掩码', added && added.hasApiKey === true && !/sk-ui-e2e-abcdefghij/.test(JSON.stringify(added)), '密钥泄漏或未保存');

    const uiRows = await cdp.eval(`__t.wait(function(){ return __t.rows().indexOf(${JSON.stringify(TEST_ID)}) >= 0; }, 8000).then(function(){ return __t.rows(); })`);
    ok('新渠道出现在页面表格中', uiRows.includes(TEST_ID), uiRows.join(','));

    // 新增的渠道必须立刻能转发（热更新）
    const chatRes = await postJson(GW + '/v1/chat/completions', {
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'ui-e2e-' + Date.now() }],
    });
    ok('新增渠道立即参与转发（无需重启）', chatRes.status === 200 && chatRes.headers['x-gw-channel'] === TEST_ID,
      `status=${chatRes.status} channel=${chatRes.headers['x-gw-channel']}`);

    // ---------------------------------------------------------------- D. 编辑
    console.log('\n[D] 通过界面编辑渠道');
    await cdp.eval(`__t.clickEdit(${JSON.stringify(TEST_ID)}); true;`);
    await cdp.eval(`__t.wait(function(){ return !document.getElementById('chModal').hidden; }, 4000)`);
    const editTitle = await cdp.eval(`document.getElementById('mdlTitle').textContent`);
    ok('编辑弹窗标题为「编辑渠道」', /编辑/.test(editTitle), editTitle);

    // 等配置预填完成
    const prefilled = await cdp.eval(`__t.wait(function(){ return document.getElementById('f_baseUrl').value === 'http://127.0.0.1:9904/v1'; }, 6000).then(function(){ return true; })`);
    ok('编辑时自动预填已有配置', prefilled === true);
    const idLocked = await cdp.eval(`document.getElementById('f_id').disabled`);
    ok('编辑态下渠道 ID 锁定不可改', idLocked === true);
    const keyEmpty = await cdp.eval(`document.getElementById('f_apiKey').value`);
    ok('编辑态不回显明文密钥', keyEmpty === '', `实际「${keyEmpty}」`);

    await cdp.eval(`__t.set('f_name', '界面改名后的渠道'); __t.set('f_weight', '55'); true;`);
    await cdp.eval(`document.getElementById('btnSave').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 8000)`);

    const afterEdit = await fetchJson(GW + '/__gw/api/channels');
    const edited = afterEdit.channels.find((c) => c.id === TEST_ID);
    ok('改名已保存', edited && edited.name === '界面改名后的渠道', edited && edited.name);
    ok('改权重已保存', edited && edited.weight === 55, edited && String(edited.weight));
    ok('未改动的字段保持原值（models 未被清空）', edited && edited.models.includes(TEST_MODEL), JSON.stringify(edited && edited.models));
    ok('留空密钥不会清掉原密钥', edited && edited.hasApiKey === true, '密钥被清空');

    // ---------------------------------------------------------------- E. 测试连通性
    console.log('\n[E] 弹窗内「测试连通性」');
    await cdp.eval(`__t.clickEdit(${JSON.stringify(TEST_ID)}); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('f_baseUrl').value === 'http://127.0.0.1:9904/v1'; }, 6000)`);
    await cdp.eval(`document.getElementById('btnTest').click(); true;`);
    const testBar = await cdp.eval(`__t.wait(function(){
      var b = document.getElementById('testBar');
      return !b.hidden && /✓|✕/.test(b.textContent);
    }, 20000).then(function(){ var b = document.getElementById('testBar'); return b.textContent; })`);
    ok('连通性测试回显结果', /✓|✕/.test(testBar), String(testBar).slice(0, 120));
    ok('测试结果为通过', /✓/.test(testBar), String(testBar).slice(0, 120));

    await cdp.eval(`document.getElementById('btnCancel').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 4000)`);
    ok('点击「取消」可关闭弹窗', true);

    // ---------------------------------------------------------------- F. 启停
    console.log('\n[F] 通过界面启用 / 停用');
    await cdp.eval(`__t.clickToggle(${JSON.stringify(TEST_ID)}); true;`);
    await cdp.eval(`__t.wait(function(){
      var b = document.querySelector('#bodyChannels button[data-toggle="${TEST_ID}"]');
      return b && b.getAttribute('data-enabled') === '1';
    }, 8000)`);
    let tState = (await fetchJson(GW + '/__gw/api/channels')).channels.find((c) => c.id === TEST_ID);
    ok('停用后 enabled=false 且已落盘', tState && tState.enabled === false, tState && String(tState.enabled));

    await cdp.eval(`__t.clickToggle(${JSON.stringify(TEST_ID)}); true;`);
    await cdp.eval(`__t.wait(function(){
      var b = document.querySelector('#bodyChannels button[data-toggle="${TEST_ID}"]');
      return b && b.getAttribute('data-enabled') === '0';
    }, 8000)`);
    tState = (await fetchJson(GW + '/__gw/api/channels')).channels.find((c) => c.id === TEST_ID);
    ok('重新启用后 enabled=true', tState && tState.enabled === true, tState && String(tState.enabled));

    // ---------------------------------------------------------------- G. 删除
    console.log('\n[G] 通过界面删除渠道');
    await cdp.eval(`__t.clickDelete(${JSON.stringify(TEST_ID)}); true;`);
    const gone = await cdp.eval(`__t.wait(function(){ return __t.rows().indexOf(${JSON.stringify(TEST_ID)}) < 0; }, 8000).then(function(){ return true; })`);
    ok('删除后该行从表格消失', gone === true);
    const afterDel = await fetchJson(GW + '/__gw/api/channels');
    ok('删除已落盘', !afterDel.channels.some((c) => c.id === TEST_ID), '后端仍存在');
    ok('渠道数量还原', afterDel.channels.length === before, `${before} → ${afterDel.channels.length}`);

    // ---------------------------------------------------------------- I. 获取模型列表
    console.log('\n[I] 一键获取模型列表 / 不填模型也能测连通性');
    const PICK_ID = 'ui-e2e-pick';
    const NOW = (await fetchJson(GW + '/__gw/api/channels')).channels.map((c) => c.id);

    // 清掉可能残留的测试数据，保证可重复运行
    if (NOW.includes(PICK_ID)) {
      await cdp.eval(
        `fetch('/__gw/api/channel/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(PICK_ID)}})}).then(function(){return true;})`
      );
      await cdp.eval(`__t.wait(function(){ return __t.rows().indexOf(${JSON.stringify(PICK_ID)}) < 0; }, 6000)`);
    }

    await cdp.eval(`document.getElementById('btnAddChannel').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return !document.getElementById('chModal').hidden; }, 4000)`);

    // I.0 下拉框回归：真实 meta（{key,label} 结构）加载后，「厂商/套餐」必须仍有可用选项。
    // 这里曾出过一个只有真人才会踩到的坑 —— 后端用 key、前端只认 value，
    // 下拉框被填成一堆 value="undefined"，界面看着正常但选不上，保存时才报「请选择厂商」。
    const optInfo = await cdp.eval(`(function () {
      function opts(id) {
        var s = document.getElementById(id);
        return Array.prototype.map.call(s.options, function (o) { return o.value; });
      }
      return { provider: opts('f_provider'), plan: opts('f_plan'), group: opts('f_group') };
    })()`);
    ok(
      '「厂商」下拉没有 undefined / 空值废选项',
      !optInfo.provider.includes('undefined') && !optInfo.provider.includes(''),
      JSON.stringify(optInfo.provider)
    );
    ok('「厂商」下拉含 openai', optInfo.provider.includes('openai'), JSON.stringify(optInfo.provider.slice(0, 8)));
    ok('「套餐」下拉含 standard', optInfo.plan.includes('standard'), JSON.stringify(optInfo.plan.slice(0, 8)));
    ok('「分组」下拉含 A 和 B', optInfo.group.includes('A') && optInfo.group.includes('B'), JSON.stringify(optInfo.group));

    // 只填地址和 Key，**故意不填模型** —— 用户被卡住的正是这个场景
    await cdp.eval(`(function () {
      __t.set('f_id', ${JSON.stringify(PICK_ID)});
      __t.set('f_name', '模型挑选测试');
      __t.set('f_group', 'B');
      __t.set('f_provider', 'openai');
      __t.set('f_baseUrl', 'http://127.0.0.1:9904/v1');
      __t.set('f_apiKey', 'sk-ui-pick-123456');
      __t.set('f_models', '');
      return true;
    })()`);

    // 直接盯住症状本身：填了厂商，下拉框里就得真的是它，不能被静默清成空
    ok(
      '填写的「厂商」真的落进了下拉框',
      (await cdp.eval(`document.getElementById('f_provider').value`)) === 'openai',
      JSON.stringify(await cdp.eval(`document.getElementById('f_provider').value`))
    );

    // I.1 模型为空时点「测试连通性」不能再被前端拦下
    await cdp.eval(`document.getElementById('btnTest').click(); true;`);
    const testMsg = await cdp.eval(`__t.wait(function () {
      var b = document.getElementById('testBar');
      return !b.hidden && /✓|✕/.test(b.textContent);
    }, 20000).then(function () { return document.getElementById('testBar').textContent; })`);
    ok('模型列表为空时也能测连通性（不再被前端拦下）', /✓/.test(testMsg), String(testMsg).slice(0, 150));

    ok('测试成功后自动列出模型清单', (await cdp.eval(`!document.getElementById('mpick').hidden`)) === true);

    const chipCount = await cdp.eval(`document.querySelectorAll('#mpickBody button.mchip').length`);
    ok('模型清单渲染成可点击的按钮', chipCount > 0, `${chipCount} 个`);

    const btnRestored = await cdp.eval(
      `document.getElementById('btnTest').disabled === false && !/测试中/.test(document.getElementById('btnTest').innerHTML)`
    );
    ok('测试按钮已恢复，不会一直转圈', btnRestored === true);

    // I.2 点一下即加入 / 再点一下移出
    const firstModel = await cdp.eval(`document.querySelector('#mpickBody button.mchip').textContent.trim()`);
    await cdp.eval(`document.querySelector('#mpickBody button.mchip').click(); true;`);
    let textVal = await cdp.eval(`document.getElementById('f_models').value`);
    ok('点一下模型名即加入列表', textVal.includes(firstModel), `点了「${firstModel}」→ ${JSON.stringify(textVal)}`);
    ok(
      '选中的模型有高亮态',
      (await cdp.eval(`document.querySelector('#mpickBody button.mchip').classList.contains('on')`)) === true
    );

    await cdp.eval(`document.querySelector('#mpickBody button.mchip').click(); true;`);
    textVal = await cdp.eval(`document.getElementById('f_models').value`);
    ok('再点一下即移出列表', textVal.trim() === '', JSON.stringify(textVal));

    // I.3 全选
    await cdp.eval(`document.getElementById('mpickAll').click(); true;`);
    textVal = await cdp.eval(`document.getElementById('f_models').value`);
    const lineCount = textVal.split('\n').filter(Boolean).length;
    ok('「全选」把当前清单全部加入', lineCount === chipCount, `${lineCount} 行 / ${chipCount} 个`);

    // I.4 筛选
    await cdp.eval(`__t.set('mpickSearch', 'qwen'); true;`);
    const filtered = await cdp.eval(`document.querySelectorAll('#mpickBody button.mchip').length`);
    ok('筛选框能缩小清单范围', filtered > 0 && filtered < chipCount, `${filtered} / ${chipCount}`);
    ok(
      '筛选后计数同步更新',
      /共/.test(await cdp.eval(`document.getElementById('mpickCount').textContent`)),
      await cdp.eval(`document.getElementById('mpickCount').textContent`)
    );
    await cdp.eval(
      `var s=document.getElementById('mpickSearch'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); true;`
    );

    // I.5 挑选结果要能落库
    await cdp.eval(`__t.set('f_models', ${JSON.stringify(firstModel)}); true;`);
    await cdp.eval(`document.getElementById('btnSave').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 8000)`);
    const picked = (await fetchJson(GW + '/__gw/api/channels')).channels.find((c) => c.id === PICK_ID);
    ok('挑选出来的模型已保存到后端', !!picked && picked.models.includes(firstModel), picked ? JSON.stringify(picked.models) : '渠道不存在');

    // I.6 独立的「获取模型列表」按钮（编辑态，且表单里 Key 为空 → 后端借用已存密钥）
    await cdp.eval(`__t.clickEdit(${JSON.stringify(PICK_ID)}); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('f_baseUrl').value === 'http://127.0.0.1:9904/v1'; }, 6000)`);
    ok('编辑态打开时拾取器默认收起', (await cdp.eval(`document.getElementById('mpick').hidden`)) === true);

    await cdp.eval(`document.getElementById('btnFetchModels').click(); true;`);
    const fetchMsg = await cdp.eval(`__t.wait(function () {
      var b = document.getElementById('testBar');
      return !b.hidden && /✓|✕/.test(b.textContent);
    }, 20000).then(function () { return document.getElementById('testBar').textContent; })`);
    ok('编辑态「获取模型列表」可用（表单没填 Key 时自动借用已存密钥）', /✓/.test(fetchMsg), String(fetchMsg).slice(0, 150));
    ok(
      '获取完成后按钮恢复可用',
      (await cdp.eval(`document.getElementById('btnFetchModels').disabled === false`)) === true
    );
    await cdp.eval(`document.getElementById('btnCancel').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 4000)`);

    // I.7 失败路径：9906 这个上游不提供 /models
    await cdp.eval(`document.getElementById('btnAddChannel').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return !document.getElementById('chModal').hidden; }, 4000)`);
    await cdp.eval(`(function () {
      __t.set('f_id', 'ui-e2e-nomodels');
      __t.set('f_name', '无模型清单上游');
      __t.set('f_group', 'B');
      __t.set('f_baseUrl', 'http://127.0.0.1:9906/v1');
      __t.set('f_apiKey', 'sk-x');
      return true;
    })()`);
    await cdp.eval(`document.getElementById('btnFetchModels').click(); true;`);
    const failMsg = await cdp.eval(`__t.wait(function () {
      var b = document.getElementById('testBar');
      return !b.hidden && /✓|✕/.test(b.textContent);
    }, 20000).then(function () { return document.getElementById('testBar').textContent; })`);
    ok(
      '上游没有 /models 时给出明确、可执行的失败提示',
      /✕/.test(failMsg) && /404|手动填|不支持/.test(failMsg),
      String(failMsg).slice(0, 170)
    );
    ok(
      '失败后按钮同样恢复可用（不会卡在加载态）',
      (await cdp.eval(`document.getElementById('btnFetchModels').disabled === false`)) === true
    );
    await cdp.eval(`document.getElementById('btnCancel').click(); true;`);
    await cdp.eval(`__t.wait(function(){ return document.getElementById('chModal').hidden; }, 4000)`);

    // 收尾
    await cdp.eval(
      `fetch('/__gw/api/channel/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(PICK_ID)}})}).then(function(){return true;})`
    );

    // ---------------------------------------------------------------- H. 无 JS 报错
    console.log('\n[H] 页面运行健康度');
    // CDP 侧采集到的未捕获异常与 console.error
    const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const consoleErrs = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.consoleAPICalled' &&
        e.params &&
        e.params.type === 'error'
    );
    const detail = thrown
      .map((e) => {
        const d = e.params && e.params.exceptionDetails;
        return d ? (d.exception && d.exception.description) || d.text : 'unknown';
      })
      .concat(consoleErrs.map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' ')));
    ok('页面无未捕获 JS 异常', thrown.length === 0, detail.slice(0, 2).join(' | '));
    ok('控制台无 console.error', consoleErrs.length === 0, detail.slice(0, 2).join(' | '));

    // 收尾：清理测试残留
    const leftover = (await fetchJson(GW + '/__gw/api/channels')).channels.map((c) => c.id);
    if (leftover.includes(TEST_ID)) {
      await cdp.eval(`fetch('/__gw/api/channel/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(TEST_ID)} }) }).then(function(){return true;})`);
    }
  } catch (e) {
    fail++;
    failures.push('测试执行中断：' + e.message);
    console.log(`\n  ✗ 测试执行中断：${e.message}`);
    // 打印现场快照，避免"超时了但不知道为什么"的黑盒排查
    try {
      const snap = await cdp.eval('JSON.stringify(__t.snap())');
      console.log('  现场快照：' + snap);
    } catch (_) {
      console.log('  现场快照：取不到（页面可能已不可用）');
    }
  } finally {
    await shutdown(session);
  }

  console.log('\n' + '='.repeat(56));
  console.log(`  界面测试：通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('='.repeat(56) + '\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
