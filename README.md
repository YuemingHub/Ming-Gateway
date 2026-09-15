# 统一 API 网关（Unified API Gateway）

> 仓库：[github.com/YuemingHub/Ming-Gateway](https://github.com/YuemingHub/Ming-Gateway)

把所有零散的大模型 API 收拢到一个入口，分三组管理，故障自动切换，成本看得见。

**零依赖 · 单进程 · 单文件配置**。只用 Node 内置模块（http / crypto / fs），不需要 `npm install`，不需要数据库，不需要 Redis。

---

## 一句话定位

| | |
|---|---|
| 它不是 | Kong / APISIX / Higress 那种重型网关，也不是需要 Postgres + Redis 的 LiteLLM |
| 它是 | 一个 ~2000 行的 Node 单进程反代，借鉴 one-api / Bifrost 的渠道池与分组治理思路，按个人自用场景裁剪 |
| 目标 | 统一入口、稳定、可观测、可限本；**网关引入后不改变原有 API 的速率与性能** |

---

## 快速开始

```bash
# 0. 获取代码（零依赖，不需要 npm install）
git clone https://github.com/YuemingHub/Ming-Gateway.git
cd Ming-Gateway

# 1. 生成配置（真实 Key 建议走环境变量）
cp gateway.example.yaml gateway.yaml
cp .env.example .env       # 然后填里面的密钥，见下方「登录与密钥」

# 2. 校验配置
node gateway.js --check

# 3. 启动
node gateway.js
# 状态页：http://127.0.0.1:8787/__gw/   ← 首次访问会要求登录，登录后即可在线增删改渠道

# 4. 接口冒烟测试（128 项断言，全绿）
node test/smoke.js
# 端口被占用时（比如 demo 在跑）可换端口段：
# SMOKE_MOCK_BASE=9801 SMOKE_GW_PORT=8188 node test/smoke.js

# 5a. 界面端到端测试（真实 Chrome 点击操作，59 项断言，需先跑 demo）
node scripts/demo.js
node test/ui-e2e.js        # 另开一个终端

# 5b. 只想看演示效果（mock 上游 + 自动造流量）
node scripts/demo.js

# 5c. 登录页端到端测试（22 项断言，自带 mock + 网关，无需先跑 demo）
node test/auth-ui.js

# 5d. 部署前体检：组隔离 / 组内轮换 / 延迟 / 稳定性（23 项断言）
node test/deploy-check.js

# 5e. 生产加固回归：并发槽守恒 / 请求体上限 / 畸形请求不打挂进程 / 超时与中断（47 项断言）
node test/prod-hardening.js

# 5f. 真实上游联调（需要 .env 里已填 OPENCODE_GO_API_KEY；没填会自动跳过）
node test/real-upstream.js
```

改一行代码即可接入 —— 把原来指向 `https://api.deepseek.com` 的 `base_url` 换成网关地址就行：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="任意或你配置的令牌")
```

---

## 登录与密钥

部署后不能让人随便用，所以有**两道独立的门**，缺哪道都不行：

| 门 | 挡住谁 | 怎么配 |
|---|---|---|
| **管理面登录** | 打开状态页、增删改渠道、看配置的人 | `server.auth` + `.env` 里的 `GATEWAY_ADMIN_PASSWORD` |
| **客户端令牌** | 调 `/v1/*` 花你额度的调用方 | `tokens[].key` + `.env` 里的 `GATEWAY_TOKEN_A/B/C`（请求头 `Authorization: Bearer <key>`） |

`.env` 放在 `gateway.yaml` 同目录（已被 `.gitignore` 忽略，不会进版本库），启动时自动加载，
**真实环境变量优先于 `.env`** —— 所以在 systemd / Docker 里用环境变量注入也没问题。

```bash
# 生成两个强随机值（直接粘进 .env 即可）
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

```ini
# .env
OPENCODE_GO_API_KEY=sk-...          # 订阅密钥
GATEWAY_ADMIN_PASSWORD=<上面生成的>   # 状态页登录密码（用户名默认 admin）
GATEWAY_TOKEN_A=<上面生成的>          # A 组调用令牌（必填）
GATEWAY_TOKEN_B=                    # B 组令牌：等 B 组真加了渠道再填并启用
GATEWAY_TOKEN_C=                    # C 组令牌：同上
```

**安全闸门（都是故意的，别当成 bug）：**

- 密码为空 → **拒绝启动**。没有密码的登录页等于没有登录页。
- 令牌为空 → **拒绝启动**。放行空令牌等于没鉴权。
- `host` 是对外地址、且令牌和登录都没有 → **拒绝启动**。这是防「部署上去裸奔被刷爆」的最后一道。
- 同一 IP 连续登录失败 8 次 / 10 分钟 → 暂时拒绝（防在线爆破）。
- 令牌只允许非空字符串：即使配置被写成对象之类脏数据，也不会静默生成一个 `[object Object]` 这种可猜令牌。

**HTTPS 部署时**记得把 `server.auth.cookieSecure` 改成 `true`；
否则浏览器不会通过 HTTPS 回传会话 Cookie，现象是「输对密码、提示登录成功、又跳回登录页」。

---

## 三组规则

| 组 | 定位 | 典型成员 | 关键策略 |
|---|---|---|---|
| **A 稳定开发组** | 日常主力，性价比优先 | DeepSeek / GLM / 通义 / 豆包 / Kimi / Coding Plan | 多渠道**顺序互备**（组内从上往下依次消耗）、连续失败自动冷却（60s→900s 指数退避）、默认不限流 |
| **B 免费消耗组** | 免费或极低成本，兜底 | 硅基流动免费模型 / Cloudflare Workers AI / 本地 Ollama | A 组全挂时自动降级、默认开启缓存 |
| **C 高配置组** | 昂贵模型，严格控本 | GPT-4o / o1 / Claude Opus·Sonnet | **永不被动进入**、`日/月预算熔断`、`RPM+TPM 双桶限流`、`强制缓存`、逐次计成本 |

**降级链：`A → B`，C 组不在链上。**

C 组必须显式指定，两种写法：

```bash
# 写法一：请求头
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "X-GW-Group: C" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# 写法二：模型前缀
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"c:gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

不指定时请求 `gpt-4o` 会返回 `503 no_available_channel` —— 这不是缺陷，是设计：**防止一次误调用烧掉预算**。

### 按组隔离：用哪个组的 key，就只用哪个组

默认规则是**严格隔离**（`fallback.crossGroup: false`）：

- 令牌的 `allowGroups` 只写一个组 → 该 key 的请求**只在这个组的渠道里轮换**；
  这个组全挂了就直接报 `503 no_available_channel`，**不会偷偷跑到别的组**。
- 想让某个 key 跨组降级，就把它的 `allowGroups` 写成多个组（如 `[A, B]`），
  这时按 `fallback.chain` 顺序尝试 —— 关掉 `crossGroup` 时只取链上第一个组。
- 也可以单次请求用 `X-GW-Group: B` 指定组（令牌必须被授权该组，否则 403）。

所以「选 B 免费组就只轮换免费组」是默认行为，不需要额外配置：
拿 `GATEWAY_TOKEN_B` 调用，就只会在 B 组渠道之间轮换。

> 组内轮换与跨组降级是两件事：**组内随便换渠道，跨组必须显式允许。**

---

## 性能

实测（本机 mock 上游，30 并发，内容各不相同以绕开缓存）：

```
直连上游      0.4 ms/请求
经网关        1.4 ms/请求
网关引入       ≈0.9 ms
```

对一次动辄几百毫秒到几十秒的 LLM 请求，0.9ms 完全可以忽略。做法是四条硬约束：

1. **流式零缓冲** —— 上游 chunk 到达即写回，不攒包，首字延迟不受影响
2. **请求体默认原样转发** —— 不需要改 model 时不做 parse/stringify
3. **连接复用** —— 全局 keepAlive Agent，每主机 64 连接
4. **不重新压缩** —— 请求上游时不声明 accept-encoding，明文传输省一次 gzip

另外，限流默认**全关**（`rpm/tpm/concurrency` 都是 0）。只有你显式配置了才生效 —— 网关不会偷偷给你的 API 降速。

---

## 配置要点

完整模板见 `gateway.example.yaml`，这里说几个容易踩的点：

### 服务器侧的两个安全/稳定性开关

| 配置项 | 默认 | 说明 |
|---|---|---|
| `server.maxBodyBytes` | `16777216`（16MB） | 单个请求体上限，超限返回 **413**。配置值会被钳制在 64KB ~ 256MB 之间。小内存机器（1C2G）别调太高：几个并发大请求就能把内存吃光。 |
| `server.auth.trustProxy` | `false` | 是否采信 `X-Forwarded-For` 判定客户端 IP。 |

`trustProxy` 这条要特别说一下。**默认必须是 false**：

- 直接暴露端口时若信 XFF，任何人都能用 `X-Forwarded-For: <随机IP>` 伪造来源，
  一是让「同一 IP 连续失败 N 次就拒绝」的防爆破彻底失效，二是能用海量假 IP 把失败记录表撑到内存耗尽；
- 反过来，**网关放在 nginx / CDN 后面时必须改成 true**（同时要求反代真的传 XFF）：
  那时 socket 地址永远是 `127.0.0.1`，不认 XFF 的话**所有外部来源都被算成同一个 IP**，
  一个人连续输错 8 次密码，会把所有人的登录一起锁住 10 分钟。

> 说明：这条影响的是**登录限速的粒度**，不是越权。
> `server.auth.enabled: true` 时管理面强制要求登录会话，本机判断不参与放行；
> 只有在你手动关掉登录（`enabled: false`）时，`isLocalRequest` 才会被用来放行，那时「被当成 127.0.0.1」才是真的放行。

判断标准就一条：**网关前面有没有反向代理**。有就 true，没有就 false。

### 渠道怎么管：页面 vs 文件

渠道有**两个来源**，优先级如下：

| 优先级 | 来源 | 什么时候用 |
|---|---|---|
| 高 | `data/channels.json` | 你在状态页点过「保存/启用/停用/删除」之后，渠道就以这个文件为准 |
| 低 | `gateway.yaml` 的 `channels` | 页面还没保存过时的基线；页面只要保存过一次，就被整体接管 |

**为什么分开存，而不是回写 YAML？**

- 项目只有 YAML 解析器没有序列化器，回写会重排注释和缩进，把你手写的配置搞乱；
- 渠道是高频改的数据，分组/预算/令牌/降级链是低频改的策略，混在一起容易误伤；
- 误操作之后，删掉 `data/channels.json` 就能一键回到 YAML 基线（页面也提供重置接口，会自动备份成 `channels.json.bak`）。

**密钥处理**：页面**永不下发明文 Key**，只回传 `sk-a****7890` 这样的掩码和「有没有配」的标记。

- 编辑时留空 = 保持原密钥不变（不是清空）；
- 用 `${ENV_VAR}` 形式填的 Key，落盘时保留 `${ENV_VAR}` 原样、运行时才展开 —— 页面每保存一次不会把环境变量里的密钥固化成明文。

改完**立即生效，不用重启**。

### 添加渠道：模型名不用背，点着挑

只填**上游地址**和 **API Key**，模型名一个字都不用记：

1. 点「🔍 **获取模型列表**」→ 问上游要一份模型清单；
2. 清单以按钮形式列出来，**点一下就加入、再点一下移出**；有多选「全选」和关键字筛选；
3. 点「保存」即可。

点「🔄 测试连通性」也会**顺带把模型清单列出来**，所以「先测通、再挑模型」一趟就能走完。

设计上的两个硬约束（都是踩过坑才加的）：

- **查模型不需要先填模型名**。早期版本把「至少填一个模型」当成硬校验，结果要查模型清单就必须先知道模型名 —— 死循环。现在只有**保存**时才要求模型非空（留空语义是「接受任意模型名」）。
- **绝不出现「一直转圈」**。所有按钮（测试 / 获取列表 / 保存）都在 `finally` 里恢复原状；后端的探测也设了硬超时（列模型 10s、对话探测 15s），上游挂起时到点就返回并如实报错，不会无限等待。

上游没提供 `/models` 时会明确告诉你状态码，并提示「手动填写模型名」这个可执行动作。

### 渠道

```yaml
- id: deepseek-main
  name: DeepSeek 主账号
  group: A
  provider: openai          # openai（含绝大多数国产兼容）/ anthropic / gemini
  plan: standard            # standard | coding | agent | free（仅用于分类统计）
  baseUrl: https://api.deepseek.com/v1
  apiKey: ${DEEPSEEK_API_KEY}      # 支持环境变量，别把 Key 写进文件
  models: [deepseek-chat, deepseek-reasoner]
  order: 0                  # 组内消耗顺序（0 起，数字小者先被使用）；不写则排在所属组末尾
  weight: 100               # 已不参与排序，仅作兼容保留
  priority: 10              # 已不参与排序，仅作兼容保留
  enabled: true
  cooldown:
    baseSec: 60             # 连续失败 3 次起冷却，按 2^n 退避
    maxSec: 900
    failThreshold: 3
  headers:                  # 可选：需要自定义请求头的上游（见下方 OpenCode Go）
    X-Some-Header: value
```

### OpenCode Go 订阅（有三个实测出来的坑）

```yaml
- id: opencode-go
  name: OpenCode Go 订阅
  group: A
  provider: openai
  plan: coding
  baseUrl: https://opencode.ai/zen/go/v1
  apiKey: ${OPENCODE_GO_API_KEY}
  headers:
    x-opencode-session: api-all-gateway   # ① 少了它，上游直接 400 MissingSessionID
  models:                                  # ③ 只放实测能跑的，别拿 /models 全选
    [deepseek-flash, deepseek-v4-flash, deepseek-v4.1-flash, deepseek-v4-pro,
     mimo-v2.5, mimo-v2.5-pro, glm-5.3-flash, glm-5.3, glm-5.2, glm-5.1,
     kimi-k3, kimi-k2.7-code, kimi-k2.6, longcat-2.0, hy4-preview, hy3,
     minimax-m3, qwen3.8-flash]
```

三个坑都是**真跑出来的**，不是文档抄的：

1. **必须带 `x-opencode-session` 请求头**，否则一律 `400 MissingSessionID`。
   实测：不带头 → 400；带上 → 200。用上面的 `headers` 配置即可。
2. **模型 ID 全小写**：写作 `mimo-v2.5`，写成 `MiMo-V2.5` 会被拒（`401 not supported`）。
3. **`/models` 会列 37 个，但只有 18 个真能跑** —— 其余要么返回 "Model is unavailable"，
   要么走的是别的协议（`/messages`、`/responses`）。所以**别在「获取模型列表」里全选**，
   选了也用不了。上面这份是逐个实测筛出来的。

> 顺带一提：这类带思考过程的模型（如 `mimo-v2.5`）如果 `max_tokens` 给得太小，
> 预算会全花在思考上，表现为 `content: null` + `finish_reason: "length"`。
> 这不是网关故障，把 `max_tokens` 放大到 64 以上就正常了。

### Coding / Agent 套餐的配额窗口

订阅制套餐常见「5 小时 N 次」的限制，用窗口精确建模，配额耗尽自动冷却到窗口结束：

```yaml
  limits:
    concurrency: 2
    windowSec: 18000        # 5 小时
    windowMaxRequests: 400
```

多个套餐可以并列配置，一个打满自动切下一个。

### 预算熔断（C 组）

```yaml
  budget:
    dailyUSD: 5
    monthlyUSD: 60
    warnRatio: 0.8
```

超出即返回 `429 budget_exceeded`，请求根本不会发到上游。

### 客户端令牌（可选）

`tokens` 留空 = 不鉴权（仅建议本机/内网）。配了就必须带 `Authorization: Bearer <key>`，可按组、按模型、按额度授权。

---

## 管理接口

| 接口 | 说明 |
|---|---|
| `GET /__gw/` | 状态页（单文件 HTML，无外部资源） |
| `GET /__gw/api/status` | 网关总状态：分组、渠道、健康度、用量、预算、缓存 |
| `GET /__gw/api/tokens` | 客户端令牌列表：分组、名称、启用状态、掩码值与**完整值**（供复制进调用方；页面默认打码，点「显示」展开，响应带 `no-store`） |
| `GET /__gw/api/channels` | 渠道列表（密钥以掩码形式返回）+ 当前来源（`store` / `yaml`） |
| `GET /__gw/api/meta` | 新增表单所需的选项：分组、厂商协议、套餐类型、9 个厂商预设 |
| `POST /__gw/api/channel/save` | 新增或更新渠道（`originalId` 不同即为改 id；`apiKey` 留空表示不改） |
| `POST /__gw/api/channel/delete` | 删除渠道 `{"id":"x"}` |
| `POST /__gw/api/channel/toggle` | 启用/停用渠道 `{"id":"x","enabled":false}`（会落盘） |
| `POST /__gw/api/channel/reorder` | 调整组内**消耗顺序** `{"group":"A","ids":["a1","a2","a3"]}` —— `ids` 必须是该组全部渠道的新顺序，落盘并热更新；状态页列表里的 ▲▼ 就是调它 |
| `POST /__gw/api/channel/test` | 连通性测试 `{"id":"x"}` 或 `{"channel":{...}}`，失败也返回 200，原因在 `message`；**顺带把上游模型清单一起带回**（`models` 字段） |
| `POST /__gw/api/models/fetch` | 一键获取模型列表 `{"id":"x"}` 或 `{"channel":{...}}`，返回 `{ok,models,count,via,status,latencyMs,message}` |
| `POST /__gw/api/channel/reset` | 丢弃 `data/channels.json`，回到 `gateway.yaml` 基线（自动备份为 `.bak`） |
| `GET /__gw/api/logs?limit=50` | 最近请求日志 |
| `POST /__gw/api/cache/purge` | 清空响应缓存 |
| `GET /healthz` | 存活探针 |

**安全**：配置 `server.adminToken` 后需带 `X-Admin-Token`；未配置时管理接口**只允许 127.0.0.1 访问**。

---

## 部署（给运维 / 部署 agent）

需求：Node >= 18，无需其他任何依赖。

```bash
# 目录结构
gateway.js
lib/
web/dashboard.html
gateway.yaml          # 生产配置，别提交到 git
data/                 # 用量日志 + 页面维护的渠道库（含密钥，需可写且别提交）
```

> `data/channels.json` 里可能有明文 Key，建议 `chmod 600`（网关写入时会自动设权限）。

**systemd 单元示例：**

```ini
[Unit]
Description=Unified API Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/api-gateway
ExecStart=/usr/bin/node gateway.js
Restart=always
RestartSec=3
Environment=DEEPSEEK_API_KEY=sk-xxx
Environment=OPENAI_API_KEY=sk-xxx
EnvironmentFile=/opt/api-gateway/.env   # 推荐把 Key 放这里

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now api-gateway
curl http://127.0.0.1:8787/healthz
```

**生产建议：**

- `server.host` 改 `0.0.0.0`，前面套 Nginx/Caddy 做 HTTPS 和访问控制
- **必须开启 `server.auth` 并设强密码**（状态页和管理接口的登录门），同时**必须配置 `tokens`**（调用 `/v1/*` 的客户端令牌）。
  两者都为空时网关**拒绝启动**——没有这道门，任何扫到端口的人都能白嫖你的额度、还能进状态页改渠道看密钥。
- 走 HTTPS 反代时把 `auth.cookieSecure` 改成 `true`，否则浏览器不会通过 HTTPS 回传会话 Cookie，会表现为「登录成功却又跳回登录页」
- `data/` 目录定期清理（每天一个 `usage-YYYY-MM-DD.jsonl`）
- 内存占用约 40–60MB，1.6G 的小机器完全够用

---

## 已验证的能力

**接口侧**：`node test/smoke.js` 共 128 项断言，全部通过：

| 项 | 覆盖内容 |
|---|---|
| T1 | 非流式请求 + 故障渠道自动切换 |
| T2 | 流式 SSE 零缓冲透传（首字节 < 1s） |
| T3 | 连续失败后渠道冷却摘除 |
| T4 | A 组全挂 → 自动降级 B 组 |
| T5 | C 组必须显式指定（防误烧钱） |
| T6 | C 组预算熔断返回 429 |
| T7 | 确定性请求缓存命中 |
| T8 | 管理接口 / 模型列表 / 日志 / 状态页 |
| T9 | 用量统计与分组健康度 |
| T10 | 性能：并发 30 请求，网关开销 ≈0.9ms |
| T11 | 渠道在线增删改：热更新、局部更新不丢字段、`${ENV_VAR}` 不被固化、非法配置被拦、重置回 YAML 基线 |
| T12 | 一键获取模型列表：未保存的渠道也能查、Gemini/Ollama 形状解析、上游无 `/models` 的提示、地址连不上快速失败、上游挂起时按超时返回不串第二次请求 |
| T13 | 管理面登录 + 客户端令牌：未登录跳登录页、管理接口 401、密码错误/正确、会话 Cookie 的 HttpOnly+SameSite、跳转不跑站外、退出即失效、令牌三态、连续失败触发 429 |
| T13b | 登录/配置层独立校验：正确密码通过、错密码/错用户名拒绝、对外监听且无鉴权时拒绝启动、开了登录却没密码时拒绝启动 |
| T14 | 渠道自定义请求头转发：复刻 OpenCode Go 的 `x-opencode-session`，头真的转发出去、清空后上游确实拒绝（反证）、连通性探测同样带自定义头、**界面保存时不会把请求头冲掉** |
| T14b | `.env` 加载：变量读入并展开、落盘保留 `${VAR}` 不固化明文、支持引号、真实环境变量优先 |
| T15 | YAML 空值解析 + 令牌不能凭空生成：`- key:` 后面有同级兄弟键时值为 `null`（曾被误解析成对象，导致空令牌检查漏检）、更深缩进仍按嵌套解析、未展开的令牌拒绝启动且报错点名是哪个变量、非字符串令牌一律拒绝 |

**部署前体检**：`node test/deploy-check.js` 共 23 项断言，专门回答部署前最该确认的四件事：

| 项 | 覆盖内容 |
|---|---|
| 组隔离 | 用哪个组的 key 就只落哪个组；B 组全挂时 B 组 key 直接报错而不串到 A；A 组 key 不能越权指定 C 组 |
| 组内轮换 | 首选渠道**超时** → 换；次选渠道**404 模型不通** → 换；主力停掉 → 退到备用；组内全挂 → 明确 `no_available_channel` 且不跨组 |
| 延迟 | 并发 40 的 p50/p95/p99、流式首字节 TTFB（不缓冲整段） |
| 稳定性 | 300 请求持续压力：全部成功、无未捕获异常、堆内存增长可控 |

**生产加固回归**：`node test/prod-hardening.js` 共 47 项断言，盯的是「上线才会要命」的那类缺陷：

| 组 | 覆盖内容 |
|---|---|
| H0 | 登录闸门：未登录 401、Cookie 的 HttpOnly / SameSite、带会话后可访问 |
| H1/H2 | 并发槽守恒：上游持续报错、以及切换渠道重试之后，借走的槽位必须归零，渠道不能被占死 |
| H2b | 响应写回之后的环节抛异常时，不能二次归还并发槽（否则别人的在飞槽位被还掉，并发上限失效） |
| H3 | 请求体超限返回 **413**（不是 500），超限后进程存活、正常请求不受影响 |
| H4 | 管理接口 / 登录接口收到超大或畸形请求体，必须有明确响应而**不能打挂进程**（早期版本 `readBody` 的 reject 没人接，一个请求就能让 Node 退出） |
| H5 | 非 JSON、JSON 数组等非法请求体返回 400 并说明原因 |
| H6/H7 | `X-Forwarded-For` 不能被伪造：不认 XFF 时按真实 IP 累计失败、失败记录表有 10000 条上限 |
| H8 | 用户名里的换行不能伪造出一行假日志 |
| H9 | 管理令牌校验：正确接受、错一个字符拒绝、Bearer 形式有效 |
| H10 | **整体超时**：上游每 100ms 滴一个字节时也必须被掐断（只靠空闲超时永远不会触发） |
| H11 | 客户端中途断开：网关不崩、不空转 |
| H12 | 全程没有未捕获异常 / 未处理拒绝 |

**真实上游联调**：`node test/real-upstream.js`（`.env` 里没填 `OPENCODE_GO_API_KEY` 时自动跳过），
用真实订阅端点验证非流式对话、流式 SSE 完整收尾（含 `[DONE]`）、首字节延迟，以及路由到上游但上游报错时快速返回。

**登录页**：`node test/auth-ui.js` 共 22 项断言（自带 mock + 网关，无需先跑 demo），
真实浏览器走一遍：未登录被拦 → 登录页渲染正常（CSS 生效、无外部资源）→ 密码错误有可见提示 →
正确密码进入状态页并显示用户名 → 退出后旧会话立即失效。

**界面侧**：`node test/ui-e2e.js` 驱动真实 Chrome，共 59 项断言，全部通过 ——
真正去点「添加渠道」、填表、保存、编辑、测试连通性、启停、删除，再回头查接口确认落库并立即生效；
顺带回归：导航栏吸顶与标题栏高度（防 `.bar` 类名冲突复现）、
「模型列表为空也能测连通性」、点选/全选/筛选模型并落库、按钮永不停留在加载态、
以及**下拉框不含 `value="undefined"` 废选项**（真实 meta 与兜底数据形状不一致，曾导致厂商/套餐选不上）。

脚本在断言失败时会打印**页面现场快照**（弹窗是否还开着、哪个字段报了错、按钮状态），
避免只看到一句「等待超时」而无从下手。

---

## 已知边界

- **单机内存态**：限流计数、冷却状态、缓存都在进程内存里，多实例部署不会同步。个人自用无影响，要横向扩展得引入 Redis。
- **协议覆盖**：主要面向 OpenAI 兼容接口（绝大多数国产厂商都兼容）；Anthropic / Gemini 做了鉴权头适配，但未做完整的协议转换。
- **价格表**：内置的是公开参考价，厂商随时调价，请在 `pricing` 段按实际账单价覆盖。
- **流式不支持中途重试**：一旦开始向客户端吐字节就无法换渠道（响应头已发出），这是 HTTP 的固有约束。
- **页面只管渠道**：分组策略、预算、降级链、客户端令牌仍在 `gateway.yaml` 里手改（这些是低频策略，不适合页面随手改）。改完需要重启。
- **`data/channels.json` 可能含明文 Key**：用 `${ENV_VAR}` 填写就不会落明文，建议优先这样填。
