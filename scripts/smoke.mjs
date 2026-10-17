#!/usr/bin/env node
/**
 * 冒烟测试（第十阶段）：把**打包产物**真的跑起来看一眼。
 *
 * ## 为什么需要它
 *
 * `packaging.test.ts` 检查的是配置文件与产物元数据，它再严格也证明不了「双击装完之后能用」。
 * 这个脚本补上最后一环：启动真实二进制 → 连上 WebView2 的调试端口 → 断言界面真的渲染出来了、
 * 没有运行时错误、启动耗时在预算内。它同时是第九阶段「启动 < 1.5s」那条线的**发布构建**判定处
 * （`debugBuild === false` 时才按 1500ms 卡——dev 构建未优化，见 StartupMetrics 注释）。
 *
 * ## 零依赖的 CDP 客户端
 *
 * 只用到 Node 内置能力：`fetch` 取 `/json/list`、全局 `WebSocket`（Node ≥ 22.4 默认可用）发 CDP 命令。
 * 不引入 playwright —— CI 上少一个下载浏览器的步骤，本地也少一份依赖。
 *
 * ## 平台差异（诚实说明）
 *
 * - **Windows**：走 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 打开远端调试端口，做完整的界面断言。
 * - **macOS / Linux**：WebView 不是 WebView2，没有同款 CDP 开关，这里退化为**存活冒烟**——
 *   启动后确认进程活着、没有立刻退出。界面断言留给各平台的 E2E。
 *
 * 用法：
 *   node scripts/smoke.mjs [--exe <路径>] [--timeout <毫秒>] [--keep]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { exe: null, timeout: 60_000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--exe') out.exe = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 各平台默认的产物路径（`npm run tauri:build` 的输出位置） */
function defaultExe() {
  if (process.platform === 'win32') return path.join(ROOT, 'target', 'release', 'aiotext-editor.exe');
  if (process.platform === 'darwin') {
    return path.join(
      ROOT,
      'target',
      'release',
      'bundle',
      'macos',
      'AioTextEditor.app',
      'Contents',
      'MacOS',
      'AioTextEditor',
    );
  }
  return path.join(ROOT, 'target', 'release', 'aiotext-editor');
}

const exe = path.resolve(args.exe ?? defaultExe());

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let seq = 0;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
        return;
      }
      if (msg.method) events.push(msg);
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    ws.addEventListener('open', () => {
      const send = (method, params = {}) =>
        new Promise((ok, fail) => {
          const id = ++seq;
          pending.set(id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({ ws, send, events });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等界面真正挂载。
 *
 * 踩过的坑：CDP 一连上就探测 DOM，会拿到「标题已对、但 React 还没挂载」的中间态
 * （`.cm-content` 不存在、标签栏 0 个、启动指标为 null）——那不是应用坏了，是探针去得太早。
 * 所以先轮询 `.cm-content`，再开始断言。
 */
async function waitForUi(cdp, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `!!document.querySelector('.cm-content')`,
      returnByValue: true,
    });
    if (probe.result?.value === true) return true;
    await sleep(250);
  }
  return false;
}

async function waitForPage(port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 端口还没起来，继续等
    }
    await sleep(500);
  }
  throw new Error(`等待调试端口 ${port} 超时（${timeout}ms）`);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  [${detail}]` : ''}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (!existsSync(exe)) {
  console.error(`✗ 找不到产物：${exe}\n  先跑 npm run tauri:build`);
  process.exit(1);
}
console.log(`冒烟目标：${exe}\n`);

const port = 9333;
const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  stdio: 'ignore',
  detached: false,
  env: {
    ...process.env,
    ...(process.platform === 'win32'
      ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
      : {}),
  },
});

let exitCode = 0;
let exitedEarly = null;
child.on('exit', (code, signal) => {
  exitedEarly = signal ?? code;
});

try {
  if (process.platform !== 'win32') {
    // 存活冒烟：等一会儿，确认没立刻退出
    await sleep(6000);
    check('进程启动后仍然存活', exitedEarly === null, exitedEarly === null ? 'ok' : `已退出：${exitedEarly}`);
  } else {
    const page = await waitForPage(port, args.timeout);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    check('界面在 15s 内挂载', await waitForUi(cdp, 15_000));

    // 界面就绪（编辑器挂载）
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const q = (s) => document.querySelector(s);
        return {
          title: document.title,
          editor: !!q('.cm-content'),
          tabs: document.querySelectorAll('.tabbar-item').length,
          // PRD v0.5 §3.5：顶栏只有一条菜单栏（.menubar-trigger），旧的按钮式 .menu-trigger 已不存在
          helpButton: [...document.querySelectorAll('header .menubar-trigger, header .menu-trigger')].some((e) => e.textContent.includes('帮助')),
          startup: window.__aioStartupMetrics ?? null,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (probe.exceptionDetails) throw new Error(`页面求值异常：${probe.exceptionDetails.text}`);
    const info = probe.result.value;

    // 真跑一次简繁转换：这是唯一能证明「OpenCC 词典在静态 CRT 下加载正常」的办法。
    // （既存笔记里有「旧版 msvcp140.dll 会让词典加载访问违例」，我们已经不链接它了，
    //  这条断言就是盯着那个坑不复发。）
    const conv = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const call = (text, direction) =>
          window.__TAURI_INTERNALS__.invoke('convert_opencc', { req: { text, direction } });
        const s2t = await call('汉字软件测试', 's2t');
        const t2s = await call('漢字軟體測試', 't2s');
        return { s2t: s2t.text, s2tChanged: s2t.changedCount, t2s: t2s.text };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (conv.exceptionDetails) throw new Error(`转换求值异常：${conv.exceptionDetails.text}`);
    const converted = conv.result.value;

    // PRD v0.5 §3.5：「功能」菜单 = 常用 6 个转换方向**直接点**（不套二级菜单）
    // + 18 个整理工具按后端目录分 4 组。这条断言盯的是结构不回退——
    // 谁再把方向塞回二级菜单、或把工具分组拍平，这里立刻红。
    const func = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 80));
        const trigger = [...document.querySelectorAll('header .menubar-trigger')]
          .find((e) => e.textContent.trim() === '功能');
        if (!trigger) return { ok: false, reason: '顶栏没有「功能」入口' };
        trigger.click();
        await tick();
        const panel = trigger.parentElement.querySelector('.menu-panel');
        if (!panel) return { ok: false, reason: '「功能」菜单没展开' };
        // 第一条分隔线之前 = 直接可点的转换方向（PRD v0.5 §3.5：恰好 6 个）
        // 注意不能靠「含『简』且含『繁』」去筛标签：台湾那两项是
        // 「简体 → 台湾正体…」/「台湾正体 → 简体…」，标签里没有「繁」字，会被漏掉。
        const directions = [];
        for (const el of panel.children) {
          if (el.classList.contains('menu-sep')) break;
          if (el.classList.contains('menu-item')) directions.push(el.textContent.trim());
        }
        const groups = [...panel.querySelectorAll('.menu-group-title')]
          .map((e) => e.textContent.trim())
          .filter((g) => g !== '其他转换');
        const subs = panel.querySelectorAll('.menu-sub').length;
        trigger.click(); // 收起，别挡住后面的断言
        return { ok: true, directions, groups, subs };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (func.exceptionDetails) throw new Error(`菜单求值异常：${func.exceptionDetails.text}`);
    const funcMenu = func.result.value;

    const errors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'),
    );

    check('窗口标题正确', info.title === 'AioTextEditor', info.title);
    check('编辑器已挂载', info.editor === true);
    check('标签栏已渲染', info.tabs >= 1, `${info.tabs} 个标签`);
    check('顶栏「帮助」入口在位', info.helpButton === true);
    check('启动指标可读', !!info.startup, JSON.stringify(info.startup));
    if (info.startup && info.startup.debugBuild === false) {
      check(
        '发布构建启动 < 1500ms（第九阶段验收线）',
        info.startup.setupMs < 1500,
        `${info.startup.setupMs} ms`,
      );
    } else if (info.startup) {
      console.log(`· 启动 ${info.startup.setupMs} ms（dev 构建，不卡 1500ms 线）`);
    }
    check(
      'OpenCC 简→繁可用（词典加载正常）',
      typeof converted?.s2t === 'string' && converted.s2t.includes('漢') && converted.s2tChanged > 0,
      `${converted?.s2t}（${converted?.s2tChanged} 字变更）`,
    );
    // 只断言「漢/汉」这种无歧义的字符级映射：軟件 还是 軟體 取决于方向配置，
    // 拿它当期望值会把「配置差异」误报成「词典坏了」。
    check('OpenCC 繁→简可用', typeof converted?.t2s === 'string' && converted.t2s.includes('汉'), converted?.t2s);
    check(
      '功能菜单：常用 6 个转换方向直接可点',
      funcMenu?.ok === true && funcMenu.directions.length === 6,
      funcMenu?.ok ? `${funcMenu.directions.length} 个：${funcMenu.directions.join(' / ')}` : funcMenu?.reason,
    );
    check(
      '功能菜单：整理工具分 4 组',
      funcMenu?.groups?.length === 4,
      funcMenu?.groups?.join(' / ') ?? '',
    );
    check('功能菜单：转换方向不再套二级菜单', funcMenu?.subs === 0, `${funcMenu?.subs} 个二级菜单`);
    check('无页面运行时错误', errors.length === 0, errors.length ? errors.map((e) => e.method).join(',') : 'none');

    cdp.ws.close();
    if (results.some((r) => !r.ok)) exitCode = 1;
  }
} catch (err) {
  console.error(`\n✗ 冒烟失败：${err.message}`);
  exitCode = 1;
} finally {
  if (!args.keep) {
    try {
      child.kill();
    } catch {
      // 已经退出了
    }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== 冒烟结果：${passed} 通过 / ${results.length - passed} 失败 =====`);
process.exit(exitCode);
