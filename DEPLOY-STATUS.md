# 部署状态

> 本文件记录**线上实际状态**，便于回看与回滚。不含任何密钥。
> 最后更新：2026-09-15

## 当前结论

网关已上线，七条验收全部通过，且**未影响同机上已有的其他站点**。

| 项 | 值 |
|---|---|
| 服务器 | `39.107.228.76`（阿里云 cn-beijing） |
| 对外入口 | `https://api.ymai.fun`（Nginx 反代，Let's Encrypt） |
| 落地路径 | `/opt/api-gateway` |
| 服务名 | `api-gateway.service`（systemd，enabled + active，以专用账号 `gwapp` 运行） |
| 上游监听 | `127.0.0.1:8787`（**只回环，不对公网暴露**） |
| 证书 | `/etc/letsencrypt/live/api.ymai.fun/`，仅此一域名，有效至 2026-12-14 |
| 常驻内存 | 约 12 MB |

## 上线时改过的两处配置

`/opt/api-gateway/gateway.yaml`（原始副本留在同目录 `gateway.yaml.bak`）：

- `server.auth.cookieSecure: false → true` —— 否则 HTTPS 下「密码对了、提示成功、又跳回登录页」
- `server.auth.trustProxy: false → true` —— 否则反代后所有外部来源被算成同一个 IP

两处都依赖 Nginx 真实传 `X-Forwarded-For`；已在 `api-gateway` 块的 `proxy_set_header` 中确认。

## 验收结果（2026-09-15，走公网实测）

1. `GET /healthz` → `{"ok":true,"version":"1.0.0"}`，HTTP 200
2. `GET /__gw/` → 302 跳登录页，页面内无任何状态数据
3. 用 `server.auth.username` + `.env` 的 `GATEWAY_ADMIN_PASSWORD` 登录 → 302 进状态页，右上角显示该用户名；会话 Cookie 带 `Secure`
4. 带 `GATEWAY_TOKEN_A` 调用 `/v1/chat/completions` → 200，响应头 `X-GW-Channel: opencode-go`
5. 不带令牌调用同一接口 → 401
6. `"stream": true` → 分块逐条到达（时间戳递增），非一次性吐出
7. 20 MB 请求体 → 413（Nginx 直接拒绝）

## 回滚

```bash
# 撤回对外入口（证书与 /opt/api-gateway 保留）
rm -f /etc/nginx/sites-enabled/api-gateway
nginx -t && systemctl reload nginx
systemctl disable --now api-gateway
```

## 分组与调用密钥

网关按 A / B / C 三组隔离：**每组一把 KEY，每把 KEY 只能调它自己那组的模型**，跨组调用返回 503。

| 组 | 渠道 | 可调模型（示例） |
|---|---|---|
| A 稳定开发 | OpenCode Go | `deepseek-flash`、`mimo-v2.5`、`glm-5.3-flash`、`qwen3.8-flash`、`minimax-m3` |
| B 免费消耗 | Step、Agnes | `step-router-v1`、`step-3.7-flash`…；`agnes-3.0-flash`、`agnes-image-2.5-flash`、`agnes-video-2.5`… |
| C 高配置 | （暂无渠道） | 暂无，调用返回 503 |

- 调用地址 `https://api.ymai.fun/v1`，认证 `Authorization: Bearer <该组 KEY>`
- 三把 KEY 存在服务器 `/opt/api-gateway/.env` 的 `GATEWAY_TOKEN_A/B/C`；**密钥值不入库、不写进本文件**
- 2026-09-15 起，状态页新增「我的令牌」面板（导航第 3 项）：登录后可直接查看/复制三把 KEY，默认打码、点「显示」展开。对应接口 `GET /__gw/api/tokens`，**需登录**，响应带 `no-store`
- 2026-09-15 实测隔离：A KEY 调 B 组模型 503、B KEY 调 A 组模型 503、无令牌 401

## 组内消耗顺序（2026-09-15 新增）

组内渠道**严格按顺序消耗**：状态页渠道列表里**从上往下就是使用顺序**——第一路健康就一直用它，只有它失败 / 冷却 / 限流时才依次落到下一路。（此前是同优先级内加权随机打散。）

- **怎么调**：渠道列表的「顺序」列有 `▲` `▼` 按钮，点一下移动一位，立即生效（落盘 + 热更新，无需重启）。
- 新加的渠道默认排在所属组**末尾**，不会插队抢流量；把渠道改到别的组，它也会排到新组末尾。
- 旧的 `weight` / `priority` 字段**已不参与排序**，仅作兼容保留（编辑框里已标注）。
- 接口：`POST /__gw/api/channel/reorder`，body `{"group":"A","ids":[...]}`，`ids` 必须是该组**全部**渠道的新顺序。
- 实测（2026-09-15）：A 组把 `tokenrhythm` 从第 3 位提到第 1 位，同一个 `glm-5.3-flash` 请求的 `X-GW-Channel` 随之为 `tokenrhythm`；还原后又回到 `opencode-go`。

## 自建分组（2026-09-28 已部署到生产）

状态页「渠道分组 → ＋ 新建分组」可以在 A/B/C 之外自己加分组，不用改 `gateway.yaml`、不用重启：

- 数据落在 `/opt/api-gateway/data/groups.json`（网关写入时自动 `chmod 600`），里面含**自建组专用 KEY 的明文**；
  内置 A/B/C 不在这个文件里，仍以 `gateway.yaml` 为真源。
- 新建的组默认**不进降级链**（链仍是 `A → B`），只能用它自己的 KEY 或 `X-GW-Group: 组名` 走到。
- 每个自建组默认自动生成一把**只授权该组**的调用 KEY，显示与复制都在「我的令牌」面板里（默认打码）。
- 删除闸门：内置组删不掉；组下还有渠道时删不掉。
- 上线没有改任何配置：`gateway.yaml` 与 `.env` 都没动；`gwapp` 对 `data/` 本来就有写权限。

部署与验收（2026-09-28，全程只写 `data/groups.json`；`data/channels.json` 校验和前后一致，她当天上午刚改过的 20 个渠道一个字节都没变）：

- 替换 5 个代码文件（`gateway.js`、`lib/config.js`、`lib/server.js`、`lib/store.js`、`web/dashboard.html`），
  上传后逐个 `md5` 与本地一致；`node --check` + `node gateway.js --check` 用**她真实的 gateway.yaml** 通过后才
  `systemctl restart`。服务仍以 `gwapp` 运行，`healthz=200`，渠道 20 个（启用 18）不变。
- 生产上的功能验收 22/23：建组 → 组同时出现在状态页卡片、添加渠道的分组下拉、令牌面板 →
  该组 KEY 鉴权通过但因组内无渠道报 `503 no_available_channel`（**正好证明它不借用 A/B/C 的渠道**）→
  A 组 KEY 越权指定该组 403 → 删组后它的 KEY 立刻 401、`groups.json` 无残留。
- 那 1 项不是缺陷：我拿 `deepseek-chat` 做对照，而她的 A 组渠道并没有列这个模型名（都是 `glm-5.3-flash`、
  `deepseek-v4.1-flash` 这类），按设计就是 503。换成 `glm-5.3-flash` 复测 → **HTTP 200，实际落到 `tokenrhythm`**，
  并自动跳过了返回 429 的第一路 `step-router-v1`（上游原话 `you have no left credit for step plan`
  —— Step 套餐额度用完，与网关无关，需要她去 Step 那边充值或先把该渠道停用）。
- 页面确实换成新版：经 nginx + HTTPS 带着会话取回 `/__gw/`，其 `md5` 与仓库里的 `web/dashboard.html` 完全相同，
  含 `＋ 新建分组` 与 `/api/group/save`。
- 其余站点未受影响：`ymai.love` / `ymai.me` / `mingos.cn` 200，`ymai.fun` 跳 `/login` 后 200；
  `api.ymai.fun` 证书到期时间仍是 `Dec 14 2026`（没有重新签发）。

回滚这一项（只回到部署前那 5 个文件，数据与配置都不动）：

```bash
ssh fs 'cd /root/gw-deploy-20260928 && cp gateway.js /opt/api-gateway/ \
  && cp config.js server.js store.js /opt/api-gateway/lib/ \
  && cp dashboard.html /opt/api-gateway/web/ \
  && chown root:gwapp /opt/api-gateway/gateway.js /opt/api-gateway/lib/config.js /opt/api-gateway/lib/server.js /opt/api-gateway/lib/store.js /opt/api-gateway/web/dashboard.html \
  && systemctl restart api-gateway'
```

已经建出来的组不受回滚影响（想连组一起清掉：`ssh fs 'rm /opt/api-gateway/data/groups.json'`，内置 A/B/C 与所有渠道都不受影响）。
部署前的代码备份在服务器 `/root/gw-deploy-20260928/`（`code-before-20260928.tgz`，权限 600，含那 5 个原始文件）。

## 变更记录

- 2026-09-28：**自建分组**已提交并部署到生产（api.ymai.fun）。新增 `POST /__gw/api/group/save`、`POST /__gw/api/group/delete`
  与 `data/groups.json`；状态页新增建组表单、动态分组筛选按钮、自建组删除入口，并去掉了页面前端与后端里
  「只有 A/B/C 三组」的硬编码（分组顺序、筛选按钮、预算块、`需显式指定` 列表）。启动顺序改为**先叠分组、再校验渠道**。
  新增 `test/group-crud.js`（54 项），smoke 128 / ui-e2e 59 / auth-ui 22 全部重跑通过。

- 2026-09-15：渠道**连通性测试 / 获取模型列表**在鉴权失败（401/403）时，会把**上游的原话**一并显示出来（此前一律翻译成「API Key 可能无效、过期或权限不足」，把上游信息吞掉了）。这样能一眼区分是密钥**类型/格式**不对还是过期失效——例如火山方舟分别会返回 `The API key format is incorrect` 与 `the API key or AK/SK in the request is missing or invalid`。
- 2026-09-15：管理面登录用户名由默认 `admin` 改为自定义值（见服务器 `gateway.yaml` 的 `server.auth.username`），密码仍由 `.env` 的 `GATEWAY_ADMIN_PASSWORD` 提供。改动前的 `gateway.yaml` 与 `.env` 已在服务器同目录留备份 `*.bak-20260915*`。密码值不入库、也不写进本文件。

## 尚未做的事

- 暂无。

## 运行身份与文件权限（2026-09-15 收紧）

服务已**不再以 `root` 运行**，改用专用系统账号 `gwapp`（无登录 shell、无密码）：

- `/opt/api-gateway` 目录 `750 root:gwapp`，代码文件 `640 root:gwapp`
- `data/` 为 `gwapp:gwapp` `750`（用量日志、渠道库需要写）
- `.env` 保持 `600 root:root`：**只有 systemd 能读**，服务进程自己都读不到
- unit 里已加 `User=gwapp` / `Group=gwapp`；原始（root 版）unit 备份为 `/etc/systemd/system/api-gateway.service.bak-20260915-root`

实测以 `gwapp` 身份无法读取 `/root/.ssh/authorized_keys`、`/etc/wireguard/server.key`，以及 family-os / world-space 的 `.env`——即网关万一被攻破，损失被限制在 `/opt/api-gateway` 内。

## TeamoRouter 本机中转（2026-09-29 上线）

背景：`https://api.teamorouter.com` 在页面里添加时报 `fetch failed`。实测结论**不是配置错也不是对方宕机**：

- 同一台服务器、同一 IP `43.128.25.159`：TLS 握手时**报出 teamorouter 域名 → 0.1 秒内被重置**；不报域名（只在普通请求头里带域名）→ 0.118 秒握手成功并正常应答。80 端口的 `Host` 头同样被重置 → 按**域名**拦，与 DNS 无关（改 `/etc/hosts` 无效）。
- 对照（同一台服务器同时测）：`api.deepseek.com` 401、`api.groq.com` 403 都正常 → 出口本身没坏；`api.openai.com` 则是超时（另一种拦法）。
- 这类拦截对境外站点普遍存在，因此没有把它做进网关产品代码，只在本机加了一层中转。

做法：`/etc/nginx/conf.d/teamo-relay.conf`（内容存仓 `deploy/teamo-relay.conf`，两边 md5 都是 `fa23a9a717ab227daade9d8827b14988`）。nginx 对上游**默认不发 SNI**，正好走通；**现有 ymai.fun / api.ymai.fun 等配置文件一个字未改**，只新增这一个文件。

验收（2026-09-29 00:36–00:42 实测）：

1. `curl http://127.0.0.1:8471/v1/models`（不带 key）→ **HTTP 401 + 上游原话**，证明中转打到真上游
2. 网关管理面「获取模型列表」填 `http://127.0.0.1:8471/v1`（不带 key）→ HTTP 200 / `status=401` / 上游原话，证明**网关 Node fetch 这条路也通**
3. 反向对照：同一段代码、只把地址换回 `https://api.teamorouter.com/v1` → `status=0 fetch failed`（这条判据能变红，不是空跑）
4. 带上真实 key → **共 45 个模型**，`deepseek-flash-free` / `deepseek-v4-flash-free` / `glm-5.3-flash-free` 三个都在
5. 真实对话 `glm-5.3-flash-free` → **HTTP 200**，返回内容正常，usage 记录 `282` tokens
6. 上游证书校验**是开着的**（`proxy_ssl_verify on` + `verify_depth 3`；默认 depth=1 会让 Let's Encrypt 的链报 `certificate chain too long` → 502，已修正）
7. 中转只绑回环：`ss -ltn` 里 `8471` 只有 `127.0.0.1`，`0.0.0.0:8471` 计数为 0；非 `/v1/` 路径一律 404
8. 现有站点全部照旧：`ymai.fun 302`、`mingos.cn 200`、`www.mingos.cn 301`、`ymai.love 200`、`api.ymai.fun 302`、`/healthz 200`；nginx master PID 仍是 9-16 那个（reload 未重启进程）
9. 网关数据未被写入：渠道数 20、`data/groups.json` 1 个自建组，均是她自己在页面上建的

在页面里怎么填（我没有替她保存渠道，建渠道需要她点头并指定归哪个组）：

- 上游地址：`http://127.0.0.1:8471/v1`（**不是** teamorouter 的域名）
- 格式：OpenAI 兼容；模型名从「一键获取」里点（45 个都能列出来）
- key：`sk-teamo-` 开头那一把（已实测有效；她桌面那个 txt 里是明文，建议之后挪走或换一把）

代价与注意：

- 网关 ↔ 中转这一跳是**明文 HTTP，但只在 127.0.0.1 上**，出不了机器；中转 ↔ 上游仍是加密且校验证书
- `proxy_pass` 里的主机名在 nginx 启动/reload 时解析一次。**对方换 IP 后需要 `systemctl reload nginx`** 才跟上（可先按报错 `502 connect() failed` 判断）
- JEV 在这条路上可达（`POST /v1/systemone` → 400 `model is required`，路由存在），但它是**判断接口、非 OpenAI 聊天格式**，我们的网关转不了，模型清单里那把 `typesafe-ai/jev` 不能当聊天模型用

回滚（一条命令，不影响任何站点）：

```bash
ssh fs 'rm -f /etc/nginx/conf.d/teamo-relay.conf && nginx -t && systemctl reload nginx'
```

### 2026-09-29 · 渠道 `teamo-free` 已加进 WORK 组（她批准的回 2）

- 经管理面同一套接口保存（等价于她点「保存」），只新增一条：`20 → 21`，**原有 20 条逐字段比对 0 改动**
- 内容：`id=teamo-free`，名称「TeamoRouter 免费档」，组 `WORK`，`baseUrl=http://127.0.0.1:8471/v1`，
  模型 3 个（`deepseek-flash-free` / `deepseek-v4-flash-free` / `glm-5.3-flash-free`），`order=1`（排在她的 `deep` 之后）
- key：用她本地文件里那把，未打印；落盘后核对**长度 57、sha256 前 10 位 `bafa8b7605`**，与传入的一致
- **端到端实测**：用 WORK 组自己的 KEY 打 `/v1/chat/completions`（`glm-5.3-flash-free`）→
  **HTTP 200，由渠道 `teamo-free` 服务，3392ms**，日志 `req_1mson5`；回答正常，usage 105 tokens
- WORK 组 KEY 与 A/B/C 相互隔离：只有 WORK 的 KEY 用得着这三个模型（A/B/C 的 KEY 打它会找不到渠道）
- 回滚（二选一）：页面上直接点该渠道「删除」；或恢复写入前的备份
  `cp /root/gw-deploy-20260929-channels.json.bak /opt/api-gateway/data/channels.json && chown gwapp:gwapp /opt/api-gateway/data/channels.json && systemctl restart api-gateway`
  （备份 md5 `4a261ad70c24917f084fcd0392774be5`，即写入前的原状）

### 2026-09-29 · 这三个模型同时开放给 A 组（她回 2）

- **一条渠道只能属于一个组**（`channel.group` 是单值），所以"也给 A 组用"的做法是**再建一条指向同一家的 A 组渠道**，
  WORK 那条保留不动：现在 `teamo-free@WORK` + `teamo-free-a@A`，同一地址同一 key 两份登记。
- 保存前先检查 id 未被占用才写入（已知缺陷：`handleChannelSave` 的 `originalId` 回退到 `id`，**撞 id 会静默变成更新**，
  所以这一步不能省）。结果：`21 → 22`，**原有 21 条逐字段比对 0 改动**。
- 实测（用 `.env` 里的 A 组 KEY，不打印明文，指纹 `48f459a9de`）：
  `GET /v1/models` → **A 组能看见 40 个模型，三个 `-free` 全在**；
  `POST /v1/chat/completions`（`glm-5.3-flash-free`）→ **HTTP 200，由 `teamo-free-a` 服务，3582ms**，日志 `req_1oy8m6`。
- 未触碰：`teamo-relay.conf` md5 仍是 `fa23a9a7…`、`groups.json` 时间戳仍是她 23:31 那次、nginx 现有站点配置未改。
- ⚠️ 给客户用要知道的两件事：
  1. `-free` 是**当日免费额度**，用满上游返回 **402 `free_request_quota_exhausted`**（会原样传给她的客户），次日 0 点刷新；
     想要稳定供给，应该改用不带 `-free` 的同名付费档（`glm-5.3-flash` 等，清单里都有）。
  2. 同一上游登记两条 = 状态页上会算成两个渠道的用量，这是有意的取舍（为了两个组都能用）。
- 回滚：页面上删除 `teamo-free-a`；或 `cp /root/gw-deploy-20260929b-channels.json.bak /opt/api-gateway/data/channels.json
  && chown gwapp:gwapp /opt/api-gateway/data/channels.json && systemctl restart api-gateway`（该备份 md5 `6b96919c…`）
