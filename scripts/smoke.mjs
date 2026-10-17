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
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
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

    // v0.5：文件 / 编辑 新增的二级菜单（编码转换 / 重新载入 / 自定义替换）
    // + 保存回归（截图里的 `unknown variant 'utf-8'` 曾让保存必失败）
    const tmpSave = path.join(os.tmpdir(), 'aiotext-smoke-save.txt').split(path.sep).join('/');
    const extra = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 80));
        const trigger = (label) =>
          [...document.querySelectorAll('header .menubar-trigger')].find((e) => e.textContent.trim() === label);
        const openSub = async (menuLabel, subLabel) => {
          const t = trigger(menuLabel);
          if (!t) return { ok: false, reason: '顶栏没有「' + menuLabel + '」' };
          t.click();
          await tick();
          const panel = t.parentElement.querySelector('.menu-panel');
          if (!panel) return { ok: false, reason: menuLabel + ' 没展开' };
          const sub = [...panel.querySelectorAll('.menu-sub')].find((s) => s.textContent.includes(subLabel));
          if (!sub) return { ok: false, reason: '没有「' + subLabel + '」' };
          sub.querySelector('button').click();
          await tick();
          const items = [...sub.querySelectorAll('.menu-sub-panel .menu-item')].map((e) => e.textContent.trim());
          t.click();
          await tick();
          return { ok: true, items };
        };
        const convert = await openSub('文件', '编码转换');
        const reload = await openSub('文件', '重新载入');
        const custom = await openSub('编辑', '自定义替换');
        const saved = await window.__TAURI_INTERNALS__.invoke('fs_write', {
          path: '${tmpSave}',
          text: '汉字保存冒烟',
          opts: { encoding: 'utf-8', addBom: false, lineEnding: 'lf', unmappable: 'ask' },
        });
        return { convert, reload, custom, saved };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (extra.exceptionDetails) throw new Error(`二级菜单 / 保存求值异常：${extra.exceptionDetails.text}`);
    const extras = extra.result.value;

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
    check(
      '文件 → 编码转换 ▸ 有 4 个目标编码',
      extras?.convert?.ok === true && extras.convert.items.length === 4,
      extras?.convert?.ok ? extras.convert.items.join(' / ') : extras?.convert?.reason,
    );
    check(
      '文件 → 重新载入 ▸ 8 项（含 NFO 437）',
      extras?.reload?.ok === true &&
        extras.reload.items.length === 8 &&
        extras.reload.items.some((t) => t.includes('437')),
      extras?.reload?.ok ? extras.reload.items.join(' / ') : extras?.reload?.reason,
    );
    check(
      '编辑 → 自定义替换 ▸ 列出替换表',
      extras?.custom?.ok === true && extras.custom.items.length > 0,
      extras?.custom?.ok ? extras.custom.items.join(' / ') : extras?.custom?.reason,
    );
    check(
      '保存（fs_write · encoding=utf-8）成功',
      typeof extras?.saved?.bytesWritten === 'number' && extras.saved.bytesWritten > 0,
      extras?.saved ? `${extras.saved.bytesWritten} 字节 · ${extras.saved.actualEncoding}` : '无返回',
    );
    try {
      rmSync(tmpSave, { force: true });
    } catch {
      // 清理失败不影响结论
    }

    // 批处理对话框（TextPro 布局）真的能渲染：直接点菜单打开看一眼结构
    const batch = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
        const trigger = [...document.querySelectorAll('header .menubar-trigger')].find((e) => e.textContent.trim() === '编辑');
        if (!trigger) return { ok: false, reason: '顶栏没有「编辑」' };
        trigger.click();
        await tick();
        const panel = trigger.parentElement.querySelector('.menu-panel');
        const entry = panel && [...panel.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('批处理'));
        if (!entry) return { ok: false, reason: '编辑菜单里没有「批处理…」' };
        entry.click();
        await tick(400);
        const dlg = document.querySelector('.batch-dialog-textpro');
        if (!dlg) return { ok: false, reason: '批处理对话框没打开' };
        const titles = [...dlg.querySelectorAll('.batch-col-title')].map((e) => e.textContent.trim());
        const buttons = [...dlg.querySelectorAll('button')].map((e) => e.textContent.trim());
        const selects = dlg.querySelectorAll('.batch-io select').length;
        const exit = [...dlg.querySelectorAll('button')].find((e) => e.textContent.trim() === '退出');
        if (exit) exit.click();
        await tick(200);
        return {
          ok: true,
          titles,
          fileBtn: buttons.some((t) => t.includes('文件(F)')),
          hasProcess: buttons.includes('处理'),
          selects,
          closed: !document.querySelector('.batch-dialog-textpro'),
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (batch.exceptionDetails) throw new Error(`批处理求值异常：${batch.exceptionDetails.text}`);
    const batchUi = batch.result.value;
    // v0.6：视图菜单的统计项、编辑菜单头部（撤销 / 重做 / 跳转）、
    // 批处理面板白底黑字 + 四周 18px 留白
    const v06 = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
        const openPanel = async (label) => {
          const t = [...document.querySelectorAll('header .menubar-trigger')].find(
            (e) => e.textContent.trim() === label,
          );
          if (!t) return null;
          t.click();
          await tick();
          return { t, panel: t.parentElement.querySelector('.menu-panel') };
        };
        const close = async (p) => {
          if (p) p.t.click();
          await tick();
        };

        const view = await openPanel('视图');
        const items = (p) => (p ? [...p.panel.querySelectorAll('.menu-item')].map((e) => e.textContent.trim()) : []);
        const viewItems = items(view);
        const viewChecks = view ? view.panel.querySelectorAll('[role="menuitemcheckbox"]').length : 0;
        await close(view);

        const editPane = await openPanel('编辑');
        const editHead = items(editPane).slice(0, 3);
        await close(editPane);

        // 批处理：需求要白底黑字（原来跟着系统画布色发灰）
        let batchStyle = { ok: false };
        const pane = await openPanel('编辑');
        if (pane) {
          const entry = [...pane.panel.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('批处理'));
          if (entry) {
            entry.click();
            await tick(400);
            const dlg = document.querySelector('.batch-dialog-textpro');
            if (dlg) {
              const cs = getComputedStyle(dlg);
              batchStyle = {
                ok: true,
                bg: cs.backgroundColor,
                color: cs.color,
                border: cs.borderTopWidth,
                pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
              };
              const exit = [...dlg.querySelectorAll('button')].find((e) => e.textContent.trim() === '退出');
              if (exit) exit.click();
              await tick(200);
            }
          }
        }
        return { viewItems, viewChecks, editHead, batchStyle };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (v06.exceptionDetails) throw new Error(`v0.6 求值异常：${v06.exceptionDetails.text}`);
    const novitates = v06.result.value;
    const viewWanted = ['字数统计', '统计选定文字出现的次数', '显示段落数'];
    // 三个不可见字符开关已按要求搬去「选项 → 编辑器」，视图菜单里不该再有
    const movedAway = ['显示空格字符', '显示行尾字符', '显示换段符'];
    check(
      '视图菜单：3 个统计项在位，不可见字符开关已移走',
      viewWanted.every((label) => novitates?.viewItems?.includes(label)) &&
        movedAway.every((label) => !novitates?.viewItems?.includes(label)) &&
        novitates?.viewChecks === 4,
      `${novitates?.viewChecks} 个勾选项 · 缺失：${viewWanted.filter((l) => !novitates?.viewItems?.includes(l)).join('/') || '无'} · 残留开关：${movedAway.filter((l) => novitates?.viewItems?.includes(l)).join('/') || '无'}`,
    );
    // 不可见字符开关默认勾选（已搬进「选项 → 编辑器」），插文本后应立刻画出符号
    await cdp.send('Input.insertText', { text: 'a b\nc' });
    const inv = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
        const openPanel = async (label) => {
          const t = [...document.querySelectorAll('header .menubar-trigger')].find(
            (e) => e.textContent.trim() === label,
          );
          if (!t) return null;
          t.click();
          await tick();
          return { t, panel: t.parentElement.querySelector('.menu-panel') };
        };
        const clickItem = (panelRef, text) => {
          const item = [...panelRef.panel.querySelectorAll('.menu-item')].find((e) =>
            e.textContent.includes(text),
          );
          if (item) item.click();
          return !!item;
        };
        const closeBtn = async (scope, text) => {
          const btn = [...document.querySelectorAll(scope)].find((e) => e.textContent.trim() === text);
          if (btn) btn.click();
          await tick(250);
        };

        const content = document.querySelector('.cm-content');
        if (!content) return { ok: false, reason: '没有编辑器' };
        content.focus();
        await tick(300);
        const count = (sel) => document.querySelectorAll(sel).length;
        const invisible = {
          space: count('.cm-invisible-space'),
          lineEnd: count('.cm-invisible-line-end'),
          paragraph: count('.cm-invisible-paragraph'),
        };

        // 选项 → 编辑器：三个开关在不在、是不是默认勾上
        let toggles = { ok: false };
        const v1 = await openPanel('视图');
        if (v1 && clickItem(v1, '选项')) {
          await tick(400);
          const tabBtn = [...document.querySelectorAll('button')].find(
            (e) => e.textContent.trim() === '编辑器',
          );
          if (tabBtn) {
            tabBtn.click();
            await tick(300);
            const rows = [...document.querySelectorAll('.settings-row')];
            const pick = (label) => {
              const row = rows.find(
                (r) => r.querySelector('.settings-row-label span')?.textContent.trim() === label,
              );
              const box = row?.querySelector('input[type=checkbox]');
              return box ? box.checked : null;
            };
            toggles = {
              ok: true,
              spaces: pick('显示空格字符'),
              lineEnds: pick('显示行尾字符'),
              paragraphs: pick('显示换段符'),
            };
          }
          await closeBtn('button', '关闭');
        }

        // 视图 → 字数统计：多维度行数与关键维度标签
        let stats = { ok: false };
        const v2 = await openPanel('视图');
        if (v2 && clickItem(v2, '字数统计')) {
          await tick(400);
          const rows = [...document.querySelectorAll('.doc-stats-row')];
          stats = {
            ok: true,
            count: rows.length,
            labels: rows.map((r) => r.querySelector('dt')?.textContent.trim() ?? ''),
          };
          await closeBtn('.dialog button', '关闭');
        }
        return { ok: true, invisible, toggles, stats };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (inv.exceptionDetails) throw new Error(`不可见字符求值异常：${inv.exceptionDetails.text}`);
    const invis = inv.result.value;
    check(
      '不可见字符默认勾选：空格 / 行尾 / 换段符都画出来',
      invis?.ok === true &&
        invis.invisible.space > 0 &&
        invis.invisible.lineEnd + invis.invisible.paragraph > 0,
      invis?.ok
        ? `空格 ${invis.invisible.space} 个 · 行尾 ${invis.invisible.lineEnd} 个 · 换段 ${invis.invisible.paragraph} 个`
        : invis?.reason,
    );
    check(
      '选项 → 编辑器：三个不可见字符开关在位且默认勾选',
      invis?.toggles?.ok === true &&
        invis.toggles.spaces === true &&
        invis.toggles.lineEnds === true &&
        invis.toggles.paragraphs === true,
      invis?.toggles?.ok
        ? `空格=${invis.toggles.spaces} 行尾=${invis.toggles.lineEnds} 换段=${invis.toggles.paragraphs}`
        : '没打开设置对话框',
    );
    const statsWanted = [
      '中文字数（汉字）',
      '中文标点',
      '字母个数',
      '单词个数',
      '英文标点',
      '数字个数',
      '数字组',
      '字符数（不计空格与控制符）',
      '字符数（含空格）',
      '字符数（含空格与控制符）',
      '段落数',
      '非空行数',
      '字节数（UTF-8）',
    ];
    check(
      '字数统计：多维度（13 项起，含汉字 / 标点 / 单词 / 数字组 / 段落 / 字节）',
      invis?.stats?.ok === true &&
        invis.stats.count >= 13 &&
        statsWanted.every((label) => invis.stats.labels.some((l) => l.startsWith(label))),
      invis?.stats?.ok
        ? `${invis.stats.count} 行 · 缺失：${statsWanted.filter((label) => !invis.stats.labels.some((l) => l.startsWith(label))).join('/') || '无'}`
        : '没打开字数统计',
    );

    // v0.7：状态栏右侧的计数从「N 字符（M 码元）」改成 汉字 / 单词数 / 字节数
    const bar = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('.app-statusbar .statusbar-right');
        return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
      })()`,
      returnByValue: true,
    });
    const barText = bar.result.value ?? '';
    check(
      '状态栏：计数改为 汉字 / 单词 / 字节',
      /汉字 \d+ · 单词 \d+ · \d+ 字节/.test(barText),
      barText || '没找到状态栏计数',
    );

    check(
      '编辑菜单头部：撤销 / 重做 / 跳转',
      novitates?.editHead?.[0] === '撤销' &&
        novitates?.editHead?.[1] === '重做' &&
        // 「跳转…」带 Ctrl+G 提示，两个 span 在一个 textContent 里
        (novitates?.editHead?.[2] ?? '').startsWith('跳转'),
      (novitates?.editHead ?? []).join(' / '),
    );
    check(
      '批处理面板：白底黑字 + 外包框 + 四边 18px 留白',
      novitates?.batchStyle?.ok === true &&
        novitates.batchStyle.bg.replace(/\s/g, '') === 'rgb(255,255,255)' &&
        novitates.batchStyle.color.replace(/\s/g, '') === 'rgb(0,0,0)' &&
        novitates.batchStyle.pad.replace(/px/g, '').trim() === '18 18 18 18',
      novitates?.batchStyle?.ok
        ? `${novitates.batchStyle.bg} / ${novitates.batchStyle.color} / border=${novitates.batchStyle.border} / padding=${novitates.batchStyle.pad}`
        : '没取到样式',
    );

    check(
      '批处理对话框：TextPro 布局渲染',
      batchUi?.ok === true &&
        batchUi.titles.includes('可选择的处理') &&
        batchUi.titles.includes('需进行的处理') &&
        batchUi.fileBtn &&
        batchUi.hasProcess &&
        batchUi.selects === 2 &&
        batchUi.closed,
      batchUi?.ok
        ? `${batchUi.titles.join(' / ')} · 文件键=${batchUi.fileBtn} · 处理键=${batchUi.hasProcess} · 编码下拉=${batchUi.selects} · 退出后关闭=${batchUi.closed}`
        : batchUi?.reason,
    );
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
