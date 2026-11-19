# 秋天工坊 · 卡密版（Render 部署 · 数据永久保存版）

这个包 = 原来的网站 + 一道门禁 + 一个管理后台。

- 网站首页：要卡密才能进
- 管理后台：`你的网址/admin`，输入管理口令进去
- 管理后台能干：开/关公益模式、生成 6 种卡密、查卡密状态、停用/延期/删除、备份恢复数据
- 卡密存在云端（免费 Upstash Redis），**服务器睡觉、重启、重新部署都不会丢**

---

## 一、手机部署到 Render（大约 10 分钟，已部署过可跳过）

### 第 1 步：把文件传到 GitHub

1. 手机浏览器打开 `github.com`，注册/登录
2. 右上角 `+` → `New repository`
3. 名字随便写，比如 `qiutian-gate`，选 **Private（私有）**，点 `Create repository`
4. 进去后点 `uploading an existing file`
5. 把这些拖进去上传（手机上点「选择文件」逐个选）：
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `public/` 里面的三个文件：`index.html`、`admin.html`、`gate.html`
   （上传时注意 `public` 目录结构要保留：在 GitHub 上先建一个 `public` 文件夹再往里传）
6. 底部点 `Commit changes`

### 第 2 步：在 Render 建服务

1. 打开 `render.com`，用 GitHub 账号登录
2. 点 `New +` → `Web Service`
3. 选刚才那个仓库 → `Connect`
4. 确认这几项：
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. **Environment Variables** 加一条：
   - Key：`ADMIN_PASSWORD`
   - Value：你想用的管理口令（**至少 8 位**，别用生日、别发群里）
6. 点 `Create Web Service`，等 2–3 分钟

部署完会给你一个网址，形如 `https://xxxx.onrender.com`。
打开是门禁页，网址后面加 `/admin` 是管理后台。

---

## 二、让卡密永久保存（免费，5 分钟，必做）

Render 免费版的磁盘是临时的：**服务器一睡觉、一重启、一重新部署，磁盘就清空。**
卡密存本地 = 会没。解决办法：把卡密存到外面一个免费数据库里。

### 重要：按这个顺序做，别反过来

如果你线上已经生成、已经发出去了卡密，**先备份，再配置**：

1. 打开 `https://你的网址/admin` 登录
2. 拉到最下面「设置与备份」→ 点 **备份到本机**（会下载一个 json 文件，存好）
3. 再去下面第 1 步配数据库
4. 配置完服务重启后，回到后台 → **从备份恢复** → 选刚才那个 json，卡密全回来，并且从此存进云端

（如果还没发过卡，跳过备份，直接配就行。）

### 第 1 步：注册免费的 Upstash

1. 手机打开 `upstash.com` → 右上角 `Sign Up`（用 GitHub 或 Google 登录最省事）
2. 进去后点 `Create Database`
3. 名字随便写（比如 `qiutian`），类型选 **Regional**，区域选 **US East (Virginia)**（离 Render 近），免费额度够用
4. 点 `Create`

### 第 2 步：复制两个值

进这个数据库的详情页，往下找 **REST API** 那一块，有两个值：

- `UPSTASH_REDIS_REST_URL`（一个 https 地址）
- `UPSTASH_REDIS_REST_TOKEN`（一长串字符）

两个都复制下来。

### 第 3 步：填进 Render

1. Render → 你的服务 → 左边 `Environment`
2. 点 `Add Environment Variable`，加两条：
   - Key 填 `UPSTASH_REDIS_REST_URL`，Value 粘贴第一个
   - Key 填 `UPSTASH_REDIS_REST_TOKEN`，Value 粘贴第二个
3. 点 `Save Changes`，服务会自动重新部署（2 分钟左右）

### 第 4 步：确认成功

打开 `https://你的网址/admin` 登录，看页面顶部那行字：

- 显示 **「存储：云端（长期保存）」** → 成功 ✅
- 还是 **「本机文件（重启会重置）」** → 两个环境变量名字拼错了，或者服务还没重启完，回 Render 检查一下

**从此以后**：睡觉、重启、重新部署、改代码，卡密都还在。

> 免费额度说明：Upstash 免费版对一个小站完全够用（一天几千次验证都碰不到上限），只有访问量特别大才需要升级。

---

## 三、可选：让它不睡觉（打开不用等）

免费服务 15 分钟没人访问就会休眠，下次打开要等 30–60 秒。想免掉这个等待，可以挂个免费定时访问：

1. 手机打开 `cron-job.org`，注册个账号（免费）
2. `Create cronjob`
3. URL 填：`https://你的网址/healthz`
4. 执行频率选 **每 10 分钟**
5. 保存

这样它会定时叫醒服务，你打开就是秒开。
（Render 免费额度是每月 750 小时，一个服务全天在线大约 730 小时，刚好在额度内。）

不挂也没关系：卡密已经存云端了，睡觉不会丢数据，只是第一次打开慢一点。

---

## 四、管理后台怎么用

1. 打开 `https://你的网址/admin`，输入 `ADMIN_PASSWORD`
2. 顶部开关 = **公益模式**
   - 打开：所有人打开网站直接进，不用卡密
   - 关掉：恢复卡密验证（已发出去的卡照样有效）
3. 「生成卡密」：选类型 → 填数量 → 点生成
   - **小时卡 / 天卡 / 周卡 / 月卡**：从「第一次使用」那一刻开始计时
   - **永久卡**：不过期
   - **次数卡**：每验证进入一次扣 1 次，扣完失效
4. 生成完一键复制，直接发给买家
5. 「卡密管理」里能看到每张卡：未激活 / 生效中 / 已过期 / 已用完，还有到期时间和剩余次数，可停用、延期、删除

---

## 五、换口令 / 卡密前缀

- 换管理口令：改 Render 里的 `ADMIN_PASSWORD` 环境变量，保存后自动生效
- 卡密前缀：生成时填，比如填 `QT` → `QT-XXXX-XXXX-XXXX`
- 不填前缀就是纯字母数字

---

## 六、常见问题

**打开网站一直转圈？**
服务在冷启动，等 30 秒；配了第三节的定时访问就不会了。

**后台顶部显示「云端暂时连不上，正在自动重试」？**
云端那一刻网络抖了。这期间你生成/修改的东西会先存在本机，连上后自动合并回云端，两边都不会丢。等一两分钟刷新就恢复。

**卡密提示「不存在」？**
会自动转大写，别漏字符、别把 `0` 和 `O` 看错。

**想让所有人都能进？**
后台打开「公益模式」，立刻全场免卡密。

**想彻底不用 Render，换别的平台？**
这个包是标准 Node 服务（零依赖），Koyeb、Zeabur、Hugging Face Spaces、自己的服务器都能跑，
只要配上 `ADMIN_PASSWORD` + 那两个 Upstash 变量就行。

---

文件清单：

```
server.js          服务主程序
package.json       项目配置
render.yaml        一键部署配置（可选）
public/index.html  你的网站（原样，一个字节没改）
public/gate.html   门禁页（输卡密）
public/admin.html  管理后台
```
