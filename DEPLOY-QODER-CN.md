# 部署到 Qoder CN

两份东西，各取所需：

- **第二章：部署命令** —— 能直接敲的 shell，给运维或自己在服务器上跑
- **第三章：提示词** —— 整段复制粘给 Qoder CN，让它自己干

> ⚠️ 最重要的两条（漏了必出问题，都在下面正文里重复强调过）：
> 1. `gateway.yaml` 和 `.env` **被 .gitignore 忽略**，从 GitHub clone 下来是没有的，必须单独上传
> 2. 走 Nginx 反代时，`server.auth.trustProxy` 必须改 `true`，且 **Nginx 必须传 X-Forwarded-For**

---

## 一、部署前，本地只做一件事：填密钥

网关**拒绝空密钥启动**，所以先在本地填好再传上去。

```bash
cd D:\服务器\repos\API-ALL

# 生成 3 个随机值
node -e "for(let i=0;i<3;i++)console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

填进 `.env`：

| 变量 | 填什么 | 必填 |
|---|---|---|
| `GATEWAY_ADMIN_PASSWORD` | 第 1 个 —— 状态页登录密码（用户名 `admin`） | ✅ |
| `GATEWAY_TOKEN_A` | 第 2 个 —— A 组调用令牌 | ✅ |
| `GATEWAY_TOKEN_B` / `_C` | 先留空（B/C 组暂无渠道，配置里是 `enabled: false`） | ❌ |
| `OPENCODE_GO_API_KEY` | **已填好，不要动** | — |

确认能通过校验：

```bash
node gateway.js --check
# 期望：配置校验通过 / 渠道 1 个（启用 1）/ 令牌 3 个 / 登录 已开启
```

---

## 二、部署命令（可直接执行）

### 2.1 把代码弄到服务器上

`.env` 和 `gateway.yaml` 不在版本库里，**必须单独传**。

```bash
# —— 本地执行 ——
# 方式 A：从 GitHub clone（注意：不含下面两个文件）
# git clone https://github.com/YuemingHub/Ming-Gateway.git

# 方式 B：整目录打包上传（含 .env 与 gateway.yaml）
tar czf api-gateway.tgz \
  --exclude=node_modules --exclude=data --exclude=.git \
  gateway.js lib web scripts test package.json README.md gateway.yaml .env

scp api-gateway.tgz root@39.107.228.76:/tmp/
```

```bash
# —— 服务器执行 ——
sudo mkdir -p /opt/api-gateway
sudo tar xzf /tmp/api-gateway.tgz -C /opt/api-gateway
cd /opt/api-gateway

# 如果走的是 clone 方式，把两个缺失文件单独 scp 上来：
# scp gateway.yaml .env root@39.107.228.76:/opt/api-gateway/

chmod 600 gateway.yaml .env     # 密钥文件必须 600
node -v                          # 必须 >= 18，不够先升级；不用 npm install
node gateway.js --check          # 上服务器后先自检一次
```

### 2.2 按生产环境改两处配置

```bash
cd /opt/api-gateway
cp gateway.yaml gateway.yaml.bak   # 改前先备份
```

编辑 `gateway.yaml`：

```yaml
server:
  auth:
    cookieSecure: false   →   true     # HTTPS 下不改会出现「登录成功又跳回登录页」
    trustProxy: false     →   true     # 走反代必须开，见下方说明
```

**为什么 `trustProxy` 必须开**：走反代后网关看到的 socket 地址永远是 `127.0.0.1`，
不开的话**所有外部来源都被算成同一个 IP**，一个人连续输错 8 次密码就会把所有人的登录锁住 10 分钟。
（管理面本身仍要求登录，所以这不是越权问题，是限速粒度问题。）
开了 `trustProxy` 之后，**Nginx 必须真的传 `X-Forwarded-For`**，否则等于没开。

### 2.3 systemd 托管

```bash
sudo tee /etc/systemd/system/api-gateway.service > /dev/null <<'EOF'
[Unit]
Description=Unified API Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/api-gateway
ExecStart=/usr/bin/node gateway.js
Restart=always
RestartSec=3
EnvironmentFile=/opt/api-gateway/.env
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now api-gateway
sudo systemctl status api-gateway      # 必须是 active (running)
```

`ExecStart` 里的 node 路径先确认：`which node`。不是 `/usr/bin/node` 就改成实际路径。

启动失败看日志：

```bash
journalctl -u api-gateway -n 50 --no-pager
```

### 2.4 Nginx 反向代理 + HTTPS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx    # Debian/Ubuntu
sudo certbot --nginx -d ymai.fun
```

站点配置（**重点看 `X-Forwarded-For` 与 `proxy_buffering off`**）：

```nginx
server {
    listen 443 ssl http2;
    server_name ymai.fun;

    ssl_certificate     /etc/letsencrypt/live/ymai.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ymai.fun/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;

        # 真实客户端 IP —— 网关开了 trustProxy 就靠这两个头认人
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Host              $host;

        # SSE 流式必须关缓冲，否则响应被攒着一次性吐出
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;

        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    client_max_body_size 16m;   # 与 gateway.yaml 的 server.maxBodyBytes 保持一致
}

server {
    listen 80;
    server_name ymai.fun;
    return 301 https://$host$request_uri;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

防火墙只开 80 / 443，**不要暴露 8787**。

### 2.5 验收（服务器上跑一遍）

```bash
DOMAIN=ymai.fun
TOKEN=<.env 里 GATEWAY_TOKEN_A 的值>

# 1) 探活
curl -s https://$DOMAIN/healthz                       # 期望 {"ok":true,...}

# 2) 无令牌必须 401
curl -s -o /dev/null -w "%{http_code}\n" https://$DOMAIN/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}]}'
# 期望 401

# 3) 真实调用，确认落在 opencode-go
curl -s -D- -o /dev/null https://$DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"只回复两个字：收到"}],"max_tokens":64}' \
  | grep -i 'x-gw-channel'
# 期望 X-GW-Channel: opencode-go

# 4) 流式必须是边收边出（时间戳应逐个跳，不是最后一起刷出）
curl -N -s https://$DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"数到五"}],"stream":true}' \
  | head -20

# 5) 超大请求体必须 413（不是 500，也不是挂住）
curl -s -o /dev/null -w "%{http_code}\n" https://$DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @<(node -e "process.stdout.write(JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'x'.repeat(20*1024*1024)}]}))")
# 期望 413
```

浏览器打开 `https://ymai.fun/__gw/` → 应出现**登录页**（不是直接进状态页）→
用 `admin` + `GATEWAY_ADMIN_PASSWORD` 登录 → 右上角显示 admin。

---

## 三、提示词（整段复制粘给 Qoder CN）

````
请帮我把一个「零依赖 Node.js 的 LLM API 网关」部署到服务器。严格按下面的要求做，不要自由发挥改代码。

【目标服务器】
- 地址：39.107.228.76
- 域名：ymai.fun
- 系统：Linux（如不是 Linux 先告诉我，不要擅自换方案）
- 规格：2 核 / 1.6G 内存（内存很紧张，不要装 Docker、数据库、Redis）

【项目是什么】
- Node.js 内置模块写的 HTTP 反向代理网关，把多个大模型厂商的 API 聚合成一个 OpenAI 兼容端点。
- 零 npm 依赖：不需要 npm install，直接 node gateway.js 就能跑。
- 内存约 40–60MB，常驻内存态（限流/冷却/缓存都在进程内，不需要外部存储）。
- 入口 gateway.js，代码在 lib/，状态页 web/dashboard.html。

【需要上传哪些文件】
整个项目目录。但特别注意：gateway.yaml 和 .env 被 .gitignore 忽略，
从 git clone 下来是没有的，必须单独上传（这两个文件我会在本地填好给你）。
建议部署到 /opt/api-gateway，并 chmod 600 gateway.yaml .env

【环境】
- Node.js >= 18（推荐 20/22），先 node -v 确认，不够就先升级。
- 不需要 npm install，不需要构建步骤。

【启动方式】
systemd 托管，/etc/systemd/system/api-gateway.service：

[Unit]
Description=Unified API Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/api-gateway
ExecStart=/usr/bin/node gateway.js
Restart=always
RestartSec=3
EnvironmentFile=/opt/api-gateway/.env
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target

ExecStart 的 node 路径先用 which node 确认，不是 /usr/bin/node 就改成实际路径。
然后 systemctl daemon-reload && systemctl enable --now api-gateway，
并确认 systemctl status api-gateway 是 active (running)。
启动失败请把 journalctl -u api-gateway -n 50 的原文给我，不要自己改代码"修"。

【HTTPS 之后必须改的两个配置】
编辑 /opt/api-gateway/gateway.yaml（改前先 cp gateway.yaml gateway.yaml.bak）：
  1. server.auth.cookieSecure: false → true
     不改会出现「密码输对了、提示登录成功、又跳回登录页」
  2. server.auth.trustProxy: false → true
     走反代后网关看到的地址永远是 127.0.0.1，不开的话所有外部来源会被算成同一个 IP，
     一个人输错 8 次密码会把所有人的登录锁住 10 分钟。
     开了之后 Nginx 必须真的传 X-Forwarded-For，否则等于没开。
改完 systemctl restart api-gateway。

【Nginx：必须走 HTTPS 反向代理】
网关默认只监听 127.0.0.1:8787，请用 Nginx + Let's Encrypt 做反向代理。
站点配置里必须包含这些（前两个是真实 IP，后一组是流式必需的）：

    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header Host              $host;

    proxy_buffering off;          # 否则 SSE 流式会被攒着一次性吐出
    proxy_cache off;
    proxy_read_timeout 300s;
    chunked_transfer_encoding on;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    client_max_body_size 16m;     # 与 gateway.yaml 的 server.maxBodyBytes 保持一致

防火墙只开 80/443，不要对外暴露 8787。
不要改 gateway.yaml 里的 server.host 为 0.0.0.0 —— 保持 127.0.0.1 + Nginx 更安全。

【验收标准（逐条验证并把结果贴给我）】
1. curl https://ymai.fun/healthz                    → 返回 JSON 且含 "ok":true
2. 浏览器打开 https://ymai.fun/__gw/                 → 出现登录页（不是直接进状态页）
3. 用 admin + .env 里的 GATEWAY_ADMIN_PASSWORD 登录 → 能进状态页，右上角显示 admin
4. 调一次真实接口（TOKEN 换成 .env 里 GATEWAY_TOKEN_A 的值）：
   curl https://ymai.fun/v1/chat/completions \
     -H "Authorization: Bearer <GATEWAY_TOKEN_A>" -H "Content-Type: application/json" \
     -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"只回复两个字：收到"}],"max_tokens":64}'
   → 200，且响应头含 X-GW-Channel: opencode-go
5. 不带令牌调同一个接口                            → 必须 401
6. 流式请求（加 "stream": true）                   → 边收边出，不是等几秒一次性吐完
7. 发一个 20MB 的超大请求体                        → 必须 413（不是 500，也不是挂住）

【不要做的事】
- 不要改 lib/ 或 gateway.js 里的任何代码（除非有明确启动报错，那也先告诉我）
- 不要把 .env、gateway.yaml 提交进任何 git 仓库，也不要打印到日志
- 不要安装 Docker / Redis / 数据库
- 不要顺手"优化"配置里的超时、重试、限流参数
  （requestTimeoutMs 是整体超时、maxBodyBytes 是请求体上限，都是有意设定的）
- 不要对外暴露 8787 端口

【已知的正常信息，不用当错误处理】
- 启动若打印「这些渠道的密钥引用了环境变量，但没读到值」→ .env 没传上去或 EnvironmentFile 路径不对
- /healthz 不需要登录，这是故意的（给探活用）

【如果卡住】
把报错原文（systemctl status / journalctl 最后 50 行）贴给我，我来判断，不要自行改代码绕过。
````

---

## 四、三个关键约定（别让 Qoder 改掉）

1. **按组隔离**：`fallback.crossGroup: false`。用哪个组的 key 就只用哪个组 ——
   B 组全挂了就报错，不会悄悄跑到 A 组。
2. **组内轮换**：`retryOnStatus` 含 `401/403/404`。某个渠道「没有这个模型 / Key 失效」时
   换下一个渠道，而不是把错误直接丢回客户端。
3. **超时与上限**：`requestTimeoutMs: 120000`（整体超时，不是空闲超时）、
   `connectTimeoutMs: 5000`、`maxBodyBytes: 16777216`（16MB，1.6G 内存的机器上别调高）。
