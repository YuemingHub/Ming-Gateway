# 生产上线前审查报告

- 项目：统一 API 网关（API-ALL）
- 审查范围：`gateway.js` + `lib/*`（13 个源文件）+ `gateway.yaml` / `.env` / 配置与测试
- 审查日期：2026-09-14
- 结论：**已达生产上线标准**（前提是完成文末「部署前必做的 3 件事」）

---

## 一、审查方法

1. **全量扫描**：24 个源文件扫 TODO / 占位 / 硬编码密钥 / 调试残留 —— 未发现硬编码密钥或未实现功能。
2. **逐模块通读**：`proxy.js`（转发）、`limiter.js`（限流）、`router.js`（路由与组隔离）、
   `server.js`（入口与重试）、`auth.js`（登录）、`config.js`（配置校验）。
3. **针对性回归**：为每一处修复补测试，并做**反向验证**（把修复临时回退，确认测试真的会红）。
4. **真实链路复核**：用真实订阅端点跑非流式 / 流式 SSE / 上游报错三类请求。

> ⚠️ 反向验证这一步非常关键：它直接拆穿了我自己的一次误诊（见第三节 P0-0）。

---

## 二、发现的问题与修复

### P0-0 我的「并发泄漏」诊断是误诊 —— 已推翻，未造成错误改动

- **我的初判**：`server.js` 上游错误分支不归还并发槽，渠道会被永久占死。
- **反向验证结果**：把修复回退后 47 项测试**一条没红**。
- **真相**：`limiter.release()` 在 `const ok = r.status >= 200 && r.status < 300;` **之前**执行，
  forward 正常返回的所有分支（含 4xx/5xx）本来就归还了并发。
- **真实存在的问题**：`release()` 之后的后续处理（`usage.record`、`cache.set`）若抛异常，
  `catch` 会**再归还一次**，把别人的在飞槽位也还掉 → 并发计数失真、上限失效。
- **最终改动**：`slotReleased` 幂等闸门（只防重复归还），并删掉 3 处已证实为死代码的调用。

> 这条单列出来是因为它比任何一个 bug 都重要：**修 bug 之前先证明它存在。**

---

### P0-1 一个畸形请求可以打挂整个进程（致命）

- **位置**：`/__gw/login`、`/channel/save`、`/channel/delete`、`/channel/toggle` 四个接口
- **问题**：`readBody(req, n).then(...)` **没有 `.catch()`**。请求体超限或客户端中断时
  Promise 被 reject 却无人接，Node 视为未捕获异常 → **进程直接退出**。
- **修复**：新增 `readJsonBody()`，统一负责读取、解析、类型校验（必须是 JSON 对象）与错误转换，
  四个接口全部改用它，任何异常都转成明确的 4xx/5xx 响应。

### P0-2 请求体上限形同虚设（高）

- **问题**：`MAX_BODY_BYTES` 硬编码 64MB；且超限后 `req.destroy()` 会把 socket 一起拆掉，
  413 根本发不出去（客户端只看到 ECONNRESET）；错误还被记成 500。
- **修复**：
  - 上限外置为 `server.maxBodyBytes`（默认 16MB），配置层钳制在 64KB ~ 256MB；
  - 超限改为 `req.resume()` 排空（不缓存），让 413 正常写完，响应带 `Connection: close`；
  - 增加 Content-Length 预检，声明超限直接拒绝，不再把大 body 读进内存；
  - 超限返回 **413** + `payload_too_large`，不再记成 500。

### P0-3 X-Forwarded-For 可被伪造（高）

- **问题**：`clientIp()` 无条件信任 XFF。攻击者带 `X-Forwarded-For: <随机IP>` 即可
  ① 让「同 IP 连续失败 N 次就拒绝」的防爆破完全失效；② 用海量假 IP 把失败记录表撑到内存耗尽。
- **修复**：新增 `server.auth.trustProxy`（默认 `false`），只有显式开启才采信 XFF；
  失败记录表加上限 10000 条，超出丢弃最旧的一半。

### P0-4 `requestTimeoutMs` 名不副实（高）

- **问题**：`req.setTimeout()` 是**空闲超时**。上游只要持续滴字节（哪怕拖一小时）就永不触发，
  配置的 120s 上限对慢速上游完全无效。
- **修复**：`proxy.js` 新增整体 deadline 定时器，超时掐断并带 `UPSTREAM_TIMEOUT` 错误码。

### P0-5 上游超时被误判成「客户端断开」，不发响应（高）

- **问题**：`clientAbort` 只看 `err.code === 'ECONNRESET'`。我们自己按超时掐断上游时
  socket 关闭同样带 ECONNRESET，于是被当成「客户端走了」直接 `return` ——
  **客户端永远等不到响应，只能挂到自己的超时**。
- **修复**：改为先看 `res.destroyed / res.writableEnded` 判断客户端是不是真走了。

### P1-6 非流式路径不响应客户端断开（中）

- **问题**：只有流式分支挂了 `res.on('close')`。客户端断开后，非流式请求仍会把上游响应读完，
  再往一个死连接上写；写入抛错会冒泡成未捕获异常。
- **修复**：`forward` 统一挂 `res.on('close')` 掐掉上游；`sendJson` 与新增的 `writeRaw`
  全包 try/catch，写不回去就静默收场。

### P1-7 管理令牌可被逐字节试探（中）

- **问题**：`adminTokenOk` 用 `===` 比较，响应时间会泄露匹配前缀长度。
- **修复**：改用 `safeEqual()`（sha256 摘要 + `crypto.timingSafeEqual`），耗时与内容无关。

### P2-8 日志可被注入伪造（低）

- **问题**：登录失败日志直接拼接用户输入的 username，含换行即可伪造出一行假日志。
- **修复**：新增 `oneLine()` 把不可信输入压成单行并截断后再落日志。

---

## 三、我自己引入又自己拆掉的坑（记录以防复发）

给 `proxy.js` 加 deadline 时，我在回调里先 `settled = true` 再 `req.destroy()`。
destroy 触发的 `error` 事件随即被 `done()` 判为「重复结算」丢弃 → **Promise 永远不落地**。
现象很有迷惑性：上游确实超时了、`[drip] client req closed` 也打了，但客户端一直挂到自己的超时，
网关日志什么都不打。**修法：deadline 里不要置 settled，让 destroy 的 error 正常走 rejectDone。**

---

## 四、验证结论

| 测试套件 | 项数 | 结果 | 覆盖 |
|---|---|---|---|
| `test/smoke.js` | 128 | 全绿 | 功能主流程、路由、冷却、降级、缓存、用量、渠道增删改、登录、YAML 空值 |
| `test/deploy-check.js` | 23 | 全绿 | 组隔离、组内轮换、延迟（并发 40 的 p50/p95/p99）、持续压力稳定性 |
| `test/prod-hardening.js`（新增） | 47 | 全绿 | 并发槽守恒、请求体上限、畸形请求不打挂进程、XFF 不可伪造、日志注入、整体超时、客户端断开、全程无未捕获异常 |
| `test/auth-ui.js` | 22 | 全绿 | 真实浏览器登录流程、Cookie 属性、会话失效 |
| `test/ui-e2e.js` | 59 | 全绿 | 真实 Chrome 点按钮走完渠道增删改全流程 |
| `test/real-upstream.js`（新增） | 11 | 全绿 | 真实订阅端点：非流式 200、SSE 含 `[DONE]`、首字节 < 25s、上游报错快速返回 |

**合计 279 项断言 + 11 项真实链路，全部通过。**

关键路径的验证方式（任何人接手都能复现）：

```bash
node test/smoke.js                 # 功能回归
node test/prod-hardening.js        # 生产加固回归（本轮新增）
node test/deploy-check.js          # 部署前体检
node test/real-upstream.js         # 真实上游联调（没 key 自动跳过）
node test/auth-ui.js               # 登录页浏览器级
node scripts/demo.js               # 另开终端
node test/ui-e2e.js                # 界面级（需 demo 在 8787）
```

---

## 五、是否已达生产上线标准

**是** —— 但有一个前置条件：`.env` 里两个密钥还没填，`node gateway.js --check` 目前是**拒绝启动**的
（这是刻意设计的闸门，不是缺陷）。

已满足的生产标准：

- 无残缺功能、无 mock 数据（mock 只存在于 `test/`，不进产品代码）
- 所有主流程与异常路径均有明确响应，不存在「挂住不返回」
- 依赖为零 npm 包（纯 Node 内置模块），配置说明完整（README + `gateway.example.yaml`）
- 三条拒绝启动的闸门：无密码 / 无令牌 / 对外监听且两者皆无
- 关键路径全部有自动化验证，且经过反向验证确认测试有效

---

## 六、剩余风险与后续建议

### 必须做（否则部署即故障）

1. **填 `.env`**：`GATEWAY_ADMIN_PASSWORD` 与 `GATEWAY_TOKEN_A` 目前为空。
   生成命令：`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
2. **反代后必须开 `server.auth.trustProxy: true`，并让 Nginx 传 `X-Forwarded-For`**：
   不改的话 socket 地址永远是 `127.0.0.1`，所有外部来源会被算成同一个 IP ——
   一个人连续输错 8 次密码就把所有人的登录锁住 10 分钟（限速粒度问题）。
   注：`auth.enabled: true` 时管理面强制要求登录，本机判断不参与放行，因此**不存在越权**。
3. **`server.host` 改 `0.0.0.0`**，走 HTTPS 时 `auth.cookieSecure` 改 `true`
   （否则会「登录成功又跳回登录页」）。

### 已知边界（不是缺陷，是设计取舍）

- **单进程内存态**：限流计数、冷却状态、缓存都在进程内存里，多实例部署不会同步。
  个人自用无影响；要横向扩展得引入 Redis。
- **SSRF 面**：`/__gw/api/channel/test` 与 `/models/fetch` 会用你填的 baseUrl 发请求，
  理论上可探测内网。已鉴权后才可用，且这是渠道配置的固有需求 —— 不要把它暴露给不信任的人。
- **价格表**是公开参考价，厂商会调价，按实际账单价在 `pricing` 段覆盖。

### 建议（不紧急）

- 给 `/__gw/api/logs` 与用量落盘加上限与轮转，长期运行下 `data/` 会缓慢增长。
- 上游健康检查目前是被动的（失败才冷却），可考虑加一个低频主动探活。
- 多实例场景把限流与冷却外置到 Redis 之前，不要上多副本。
