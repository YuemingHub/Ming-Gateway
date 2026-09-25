# Ming-Gateway 外部替代实验报告（Bifrost Replacement Pilot）

- 日期：2026-09-25 / 26（Asia/Shanghai）
- 执行者：Window 2 / Lane B Primary Executor
- 任务真源：YuemingHub/Ming-Gateway Issue #1 · YuemingHub/agent-workspace Issue #10 Lane B
- 分支：`agent/external-gateway-replacement-pilot-20260925`（基线 `origin/main` @ `3f6eae3`）
- 候选：**Bifrost v2.2.3**（`npx -y @maximhq/bifrost`，Go 单二进制；本实验直接调用其缓存二进制）
- 北极星：不证明自研网关多好，而是证明世界已有能力能不能让我们把它删掉。

---

## 0. 结论

**建议：REPLACE（分阶段迁移），前置 4 项配置动作；不存在需要保留自研网关的证明性缺口。**

- 必需的 14 项证明全部满足：**31 PASS / 0 FAIL / 2 PARTIAL**（PARTIAL 均为"配置语义需要说明"，不是缺失能力）。
- A/B/C 隔离、组内顺序消费、A→B 降级、C 永不隐式降级、streaming、provider/key 失败、多 key 轮换、模型发现、operator 管理、密钥掩码、路由回读、备份/恢复、资源、调用方兼容，逐项有可复现证据。
- 关键发现：**用裸模型名（Ming-Gateway 现有调用形式）时，Bifrost 原生提供"确定首选 + 按序降级"链，调用方零改动**；不需要写代码，全部通过配置表达。
- 唯一需要付出的是：内存占用约 3.6–4.8×（≈240–300MB vs 62–66MB）、若干部署加固动作（见 §6）、以及把 `X-GW-Group`/`c:` 这类 Ming-Gateway 专有调用约定迁移掉（见 §5i）。
- **thin adapter 不是必需的**：只有"必须保留 `X-GW-Group` 头或 `c:` 模型前缀，或必须逐字保留旧错误码"时才需要写适配层。

---

## 1. 实验台（完全隔离，零真实密钥）

| 组件 | 位置 | 隔离方式 |
|---|---|---|
| mock 上游（OpenAI 兼容：`/v1/models`、`/v1/chat/completions` 非流式 + SSE） | `mock-upstream.js`，端口 **18080**（127.0.0.1） | 本地进程；可按 key 注入 401/429/500/timeout，可记录每次上游请求 |
| Bifrost v2.2.3 | `bifrost-app/`（独立 app-dir：config.json + config.db + logs.db），端口 **17878** | 本地进程；`-host localhost` 默认只监听回环 |
| 本地 Ming-Gateway 对照实例 | `gateway-local/gateway.pilot.yaml`，端口 **18787** | 本地进程；4 个 mock 渠道、4 个 dummy 令牌 |
| sanitized fixture | `fixtures/bifrost-config.json`（说明见 `fixtures/README.md`） | 全部 dummy key（`sk-mock-*` / `sk-bf-*`）、上游全部指向 127.0.0.1 |

红线遵守情况：**未对 api.ymai.fun 发出任何请求；未改 nginx / DNS / systemd；未搬迁或复制任何真实密钥；未给 Ming-Gateway 增加任何功能；未 merge main**（GitHub 上的改动只有本分支新增文件）。

Bifrost 用到的公开配置面（全部来自官方文档/schema，未修改候选代码）：`providers`（自定义 OpenAI 兼容 provider）、`governance.virtual_keys`（provider_configs / allowed_models / key_ids / rate_limit_id）、`governance.rate_limits`、`governance.budgets`、`governance.routing_rules`、`config_store` / `logs_store`（sqlite）、`source_of_truth`、`client.disable_content_logging`、`network_config.max_retries`。

---

## 2. 必需证明矩阵（Issue #1 §Required proof）

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | OpenAI 兼容调用只需改 base URL / key / model 映射 | **PASS** | T01/T02/T03/T122：`/v1/chat/completions` 非流式 200；**裸模型名直接可用**；Bearer VK 可用 |
| 2 | A/B/C 访问隔离（A 不能调 B/C，B 不能调 A/C） | **PASS** | T10–T14：越权请求一律 403 `provider_blocked`（与 Ming-Gateway 的 403 语义一致） |
| 3 | C 绝不被隐式 fallback | **PASS** | T20：C 上游 500 时调用方收到失败，mock 日志显示 A/B 上游零命中 |
| 4 | 顺序 fallback 可表达且可观察 | **PASS** | T30（a1 挂→a2）、T31（a1+a2 挂→b1）、T33（超时→a2）、T51（401→a2）；响应里带 `is_fallback` + `primary_provider` |
| 5 | streaming 分块正确 | **PASS** | T40：多个 `data:` 分块 + `[DONE]`，首字节早于整段完成，拼接内容完整 |
| 6 | provider/key 失败行为可预期 | **PASS** | T50（B 组 401 直接失败，无 fallback）、T51（401 标记 key 死亡并降级）、P5（全挂时按链逐一尝试后返回错误） |
| 7 | 多 key 行为 | **PASS** | T60：6 轮采样，run0 出现 `sk-mock-429:429 → sk-mock-mk1:ok`（失败 key 轮换到健康 key 后成功） |
| 8 | 模型列表发现与连通性 | **PASS** | T70（`/v1/models` 带 VK 可用）、T71（`/api/models` 网关侧目录）、operator 探针（新增 provider → 加 key → 通过它调用成功） |
| 9 | operator 管理体验 | **PASS** | T80（UI HTML）、T81–T83（providers / virtual keys / logs API）；`raw/operator-workflow.json`：模型发现 → 建 provider → 加 key → 建调用 key → 调用 200 → 删除清理，全流程走通 |
| 10 | admin/config API 不泄露 provider 密钥 | **PASS** | T90：10 个端点扫描，provider key **只以掩码出现**（`sk-m****k-a1`）；VK 明文值是设计如此（等同 Ming-Gateway 的 tokens API，供复制给调用方） |
| 11 | route/provider readback | **PASS** | T95/T96：每个响应带 `extra_fields.routing_info{provider,model,key}`；operator 日志含 provider/key/routing_rule |
| 12 | backup/restore 至少和今天一样简单 | **PASS（附条件）** | `raw/backup-restore.txt`：去掉 config.db → marker 消失；恢复目录副本 → marker 回来。**条件**：备份必须包含 sqlite（config.json 不够），且需先停机（WAL） |
| 13 | idle 与测试负载资源可接受 | **PASS（附数字）** | `raw/resource-footprint.txt`：Bifrost idle 296.5MB / 负载后 238.9MB；同机 Ming-Gateway 61.6 / 66.1MB；200×10 负载 p50 9ms / p95 135ms（对照 10/31ms），两者 0 错误 |
| 14 | 现有调用方是否依赖外部产品无法表达的 YueMing-specific 行为 | **无阻断项** | 见 §5i：裸模型名 ✓、`/v1` 路径 ✓、Bearer ✓；`X-GW-Group` 头与 `c:` 前缀不被识别（属专有约定，需迁移，不需要 adapter 也能做） |

附加项：T34（显式 `provider/model` 形式需请求级 `fallbacks`）、T120–T122（调用方兼容探针）、T130（限流 3/window → 第 4 次 429 `request_limited`）、T131（预算对象与用量暴露）。完整机器可读结果：`raw/matrix-results.json`；人类可读日志：`raw/matrix-log.txt`。

---

## 3. 核心语义对照（Ming-Gateway vs Bifrost）

| 语义 | Ming-Gateway | Bifrost v2.2.3（本 fixture） | 等价度 |
|---|---|---|---|
| 组隔离 | 令牌 `allowGroups` + 默认 `crossGroup:false` | virtual key `provider_configs`（deny-by-default） | ★★★ 等价，且 403 拒绝语义一致 |
| 组内顺序消费 | `order` 字段严格顺序 | 裸模型名 → 模型目录按 `provider_configs` 顺序选**确定首选**（6/6 命中 a1） | ★★★ 行为一致 |
| A→B 降级 | `fallback.chain: [A,B]`，服务端策略 | allowed provider 集合按序隐式降级（a1→a2→b1），无需调用方改动、无需 routing rule | ★★★ 等价 |
| C 永不隐式进入 | `requireExplicit` + 不在 chain 上 | C 的 VK 只允许 c1；无降级目标 | ★★★ 等价 |
| 显式进入 C | `X-GW-Group: C` 或 `c:` 前缀 | 用 C 的 VK（`sk-bf-c`） | ★★ 机制不同：从"请求头/前缀"变为"专用 key"（现有调用方多数已按令牌区分，改动小） |
| 冷却/退避 | 失败 3 次起 60s→900s 指数冷却 | `max_retries` + 401/402/403 永久标记 key 死亡 + 500/超时退避；**没有**等价的"渠道冷却计时器"文档字段 | ★★ 行为可用，机制不同（见 §5a/§6） |
| 限流 | RPM/TPM/并发（进程内存态） | VK 级 request/token 窗口；**窗口用量跨重启持久**（本次实测） | ★★★ 等价或更强 |
| 预算熔断 | 内置价格表 + daily/monthly USD | `governance.budgets`（max_limit/reset_duration）；**自定义/自建模型的美元核算需要价格配置**（已知模型有内置目录价） | ★★ 可表达；mock 场景下计价为 0（PARTIAL） |
| 响应缓存 | 非流式 + temperature=0 的确定性缓存，B/C 组默认开 | 语义缓存（需另行配置 `vector_store`），本次未启用（不在必需矩阵内） | ★ UNKNOWN——迁移前需单独评估 |
| 管理面 | 中文单文件状态页 + 登录门（空密码拒启） | 内置 Web UI + REST API；**无 admin 账号时回环 API 直通**；`0.0.0.0` 绑定也不拒绝启动（见 §5f） | ★★ 功能更强、加固默认值更弱 |
| 密钥处理 | 页面永不下发明文 Key；令牌 API 返回完整值（no-store） | provider key 只回掩码；VK 值可读（同设计） | ★★★ 等价 |
| 日志 | 仅元数据（无内容、无密钥） | **默认记录请求/响应内容**（可关闭，见 §5c） | ★★ 隐私默认更弱，可配置关闭 |

---

## 4. 资源占用（同机、同 mock、同负载）

| | Ming-Gateway (node) | Bifrost v2.2.3 (Go) |
|---|---|---|
| idle RSS | 61.6 MB | 296.5 MB |
| 200×10 后 RSS | 66.1 MB | 238.9 MB |
| 负载期 CPU 增量 | +0.22s | +0.34s |
| p50 / p95 | 10 ms / 31 ms | 9 ms / 135 ms |
| 错误 | 0 | 0 |
| 启动到可用 | < 2 s | ≈7–12 s |

Ming-Gateway README 自述约 40–60MB（1C2G 小机够用）。Bifrost 在 1.6GB 小机上约占 15–19% 内存——可用，但它是该机器上最大的单进程之一；这是本次唯一需要 Commander 权衡取舍的数字。

---

## 5. 发现与坑（全部可复现）

### 5a. 隐式 fallback 链只在"裸模型名"路径生效
- 裸模型名（Ming-Gateway 调用形式）：a1 挂 → a2 → b1，按 `provider_configs` 顺序，**确定首选**（`raw/failover-semantics.json`）。
- 显式 `provider/model`：钉死该 provider，除非请求体带 `fallbacks: ["provider/model", ...]`（T34）。
- 影响：现有调用方用裸模型名 → 零改动；若将来有调用方写死 provider 前缀，需要补 `fallbacks`。

### 5b. 启用的 routing rule 会**抑制**隐式 fallback（务必注意）
`scripts/rule-and-content-logging-test.sh` 两轮重启复现：规则 `enabled: true` 时 a1 故障 → 调用方收到 500，不降级；`enabled: false` 时恢复降级到 a2。本 fixture 因此**默认禁用 4 条 routing_rules**。结论：不要为了"显式声明降级链"而加 catch-all 规则，否则等于关掉降级。

### 5c. 内容日志默认开启；且 `config.json` 的开关需要 `source_of_truth` 配合
- 默认 `disable_content_logging=false` → 会话内容（请求/响应文本）写入日志库，可从 `/api/logs` 读回（T91 PARTIAL）。
- 只在 config.json 里改 `true` **不生效**（`config_store` 已存在时 DB 优先）——实测如此。
- 生效方式（已验证）：`"source_of_truth": "config.json"` + `"client": {"disable_content_logging": true}` → `/api/config` 回读为 true，新日志行 `content_summary` 为 `null`，marker 不再出现在日志里。
- 对照：Ming-Gateway 日志只有元数据。迁移后建议默认关闭内容日志（个人网关上更符合"最小保存"）。

### 5d. 备份/恢复：文件位置与 WAL
- `config_store.config.path` 的**相对路径按进程工作目录解析**，不是 `-app-dir`（本次实测：`./config.db` 落在启动时的 cwd）。`scripts/start-bifrost.sh` 已固定 `cd $APPDIR` 规避。
- 备份必须包含 `config.db`（+ `-wal`/`-shm`）：仅备份 `config.json` 会丢掉所有页面/API 产生的配置（实测：删 DB → marker 消失，恢复 → 回来）。
- 备份前先停机（SQLite WAL），恢复 = 整目录拷回。Ming-Gateway 是"拷两个文件、可随时拷"，Bifrost 是"拷整个 app 目录、需停机"——**略重，但仍是文件级操作**。

### 5e. 一次自我更正：日志里的 `sk-mock-*` 不是凭据泄漏
首轮扫描在 `/api/logs` 里发现 `sk-mock-a1/b1/c1`，一度判为泄漏；查证后确认是**本次 mock 把收到的 key 回显进答案文本**、而 Bifrost 默认记录内容造成的**误报**。provider 凭据在所有被测 API 中只以掩码出现（T90 PASS）。该误报已修正，扫描逻辑（T90）与内容日志问题（T91）已拆分。

### 5f. 公开绑定时不拒绝启动（安全默认值弱于 Ming-Gateway）
实测 `-host 0.0.0.0` + 无 admin 账号：Bifrost 只打印警告（"No admin account is configured…"）然后正常服务（17879 端口 health 200）。Ming-Gateway 在这种情况下**拒绝启动**。迁移到生产（nginx 后、回环绑定）时必须：设置 `setup_token` 建 admin、打开 `auth_config` 与推理鉴权（`enforce_auth_on_inference`）、保持回环绑定。

### 5g. operator API 的两个实际坑
- `POST /api/providers` 会**忽略内联 `keys`**；key 必须走 `POST /api/providers/{name}/keys`（已跑通完整流程并留证）。
- `POST /api/governance/virtual-keys` 不指定 `value` 时会自动生成 `sk-bf-<uuid>`；返回值需从列表/详情读回（体验上：比 Ming-Gateway"自己生成令牌再粘进 .env"更省事）。

### 5h. 限流窗口跨重启持久
C 组 3/窗口的用量在重启后仍是 3/3（存放在配置库）。Ming-Gateway 的计数是进程内存态（其 README 自述为已知边界）。这是**升级**而非缺口。

### 5i. 调用方兼容性清单
| 现有形式 | Bifrost | 处置 |
|---|---|---|
| `base_url: http://…/v1` + `Authorization: Bearer <token>` | 同形状可用（T122） | 无 |
| 裸模型名（如 `deepseek-chat`） | 可用（按 VK 允许集合解析） | 无 |
| `X-GW-Group: C` 请求头 | 被忽略（T120：不加权限、不报错） | 迁移到"按组的 VK" |
| `c:gpt-4o` 模型前缀 | 报 `model_blocked`（T121） | 同上 |
| 组令牌（`GATEWAY_TOKEN_A/B/C`） | 换成对应组的 VK 值 | 配置替换（值格式 `sk-bf-*`） |
| 上游 baseUrl 写 `/v1` 一级 | Bifrost 的 `base_url` 写根（自己补 `/v1/chat/completions`） | 迁移时逐条改配置 |

---

## 6. 缺失能力清单

**没有发现会让"保留自研网关"成立的缺失能力。** 以下 4 项是迁移前必须完成的动作（都是配置/流程，不是代码）：

1. **加固**：建 admin 账号 + 打开认证 + 保持回环绑定（§5f）。
2. **隐私默认**：`source_of_truth: "config.json"` + 关闭内容日志；或保留内容日志并接受其与 Ming-Gateway 的差异（§5c）。
3. **调用方迁移**：把 `X-GW-Group` / `c:` 的使用改为按组 VK；替换令牌值（§5i）。
4. **备份流程**：改为"停机 + 整目录备份"，并写进 runbook（§5d）。

已知的非等价项（不影响替换成立）：渠道冷却计时器没有 1:1 字段（用 `max_retries` + 永久死亡标记 + 上游 429/5xx 自行退避）；确定性响应缓存需改用语义缓存并另行评估；美元预算对自定义模型需要补价格。

---

## 7. thin adapter 是否足够

**不需要 adapter 即可替换**——被测的 14 项证明全部由 Bifrost 原生配置表达完成，调用方在"裸模型名 + Bearer 令牌"的用法下零代码改动。

只有在下列**额外**要求被提出时才需要 thin adapter，且届时它是"锦上添花"而非"能不能替换"的问题：

- 必须继续接受 `X-GW-Group: C` 头或 `c:` 模型前缀（老调用方不愿改）；
- 必须逐字保持旧错误码/错误文案（如 `no_available_channel`）；
- 必须保留 Ming-Gateway 的确定性缓存语义（temperature=0 命中）。

---

## 8. 最终建议

> **REPLACE** — 分阶段迁移，先影子验证再切流。

理由：
1. 14 项必需证明全部满足，且关键语义（组隔离、顺序消费、A→B 降级、C 不隐式降级）与现有行为**逐条对照等价**，证据可复现；
2. 迁移成本集中在配置与流程（§6），没有需要写代码才能补齐的能力；
3. 收益：减少约 2000 行自研代码 + 测试面维护、获得成熟的多 provider/治理/可观测能力；
4. 代价：内存 3.6–4.8×（小机上仍可承受）、部署加固默认值更弱（需一次配置）、内容日志默认更宽（需一次配置）。

建议的迁移路径（不在本任务授权内，仅建议）：先在隔离端口用真实 provider 跑影子流量（复用本 fixture 结构 + 真实 key 走环境变量）→ 对比错误率/延迟/成本读数 → 保留 Ming-Gateway systemd 单元与原配置作为回滚目标 → 切换 nginx upstream → 稳定观察后再退役。

---

## 9. UNKNOWN / 未测项

| 项 | 说明 |
|---|---|
| 真实 provider 行为 | 全部实验使用本地 mock；真实上游（限流、长思考、流式 usage、Anthropic/Gemini 适配路径）未测 |
| 语义缓存 | 未启用、未评估（需要 `vector_store` 配置） |
| UI 点击级验收 | 通过 REST API（UI 的后端）验证 operator 流程；未做浏览器点击级 E2E |
| 美元预算对真实模型的核算 | 未测（mock 模型无价格）；Bifrost 对已知模型有内置价格目录 |
| 现有调用方实际用法 | 未审计调用方代码，无法确认是否有人使用 `X-GW-Group` / `c:` 前缀（§5i 已列为迁移检查项） |
| 长时间稳定性 | 仅做了 200×10 的短时负载与一次 30s 超时场景；未做多日运行观察 |
| Bifrost 渠道冷却计时器 | 未找到与 Ming-Gateway `cooldown.baseSec/maxSec/failThreshold` 一一对应的文档字段（行为可用，机制不同） |

---

## 10. 复现方式

```bash
cd pilot/2026-09-25-bifrost-replacement

# 1) 起 mock 上游（:18080）
node mock-upstream.js &

# 2) 起 Bifrost（:17878，自动使用 fixtures/bifrost-config.json）
bash scripts/start-bifrost.sh &

# 3) 跑完整矩阵（写 raw/matrix-results.json + raw/matrix-log.txt）
node scripts/run-matrix.mjs

# 4) 单项复现
node scripts/probe-failover-semantics.mjs        # 裸模型名/显式 provider 的降级语义
node scripts/probe-operator-workflow.mjs         # operator 全流程（增删改查 + 调用）
bash scripts/backup-restore-test.sh              # 备份/恢复（含"删 DB 丢配置"证明）
bash scripts/rule-and-content-logging-test.sh    # 规则抑制 fallback + 内容日志开关（各一次重启）
node scripts/loadgen.mjs --n 200 --c 10 --vk sk-bf-a-strict   # 负载
powershell -NoProfile -File scripts/measure-gateway.ps1 -Label idle  # Ming-Gateway 资源（需先起 gateway-local）

# 5) Ming-Gateway 同机对照（:18787）
cd gateway-local && node ../../../gateway.js --config ./gateway.pilot.yaml
```

证据文件：`raw/matrix-results.json`、`raw/matrix-log.txt`、`raw/failover-semantics.json`、`raw/operator-workflow.json`、`raw/multikey-rotation.json`、`raw/backup-restore.txt`、`raw/rule-and-content-logging.txt`、`raw/resource-footprint.txt`。

测试结束后实验台会全部停止；本分支只新增文件，未修改 Ming-Gateway 任何现有代码（`gateway.js` / `lib/` / `web/` 零改动）。
