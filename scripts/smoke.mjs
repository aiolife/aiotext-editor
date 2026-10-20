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

    // v0.9 菜单结构：「简繁」= 6 个转换方向直接点（不套二级菜单）+ 转换预览…；
    // 「排版」= 5 个排版类工具 + 6 个高频直点项，分「排版规范 / 常用」两组。
    // 这条断言盯的是结构不回退——谁再把方向塞回二级菜单、
    // 或把排版菜单拍平 / 塞回 18 个细项，这里立刻红。
    const menuProbe = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 80));
        const openMenu = async (label) => {
          const t = [...document.querySelectorAll('header .menubar-trigger')]
            .find((e) => e.textContent.trim() === label);
          if (!t) return null;
          t.click();
          await tick();
          const panel = t.parentElement?.querySelector('.menu-panel');
          return panel ? { t, panel } : null;
        };

        // ---- 简繁 ----
        const conv = await openMenu('简繁');
        if (!conv) return { ok: false, reason: '顶栏没有「简繁」入口' };
        // 第一条分隔线之前 = 直接可点的转换方向（恰好 6 个）。
        // 注意不能靠「含『简』且含『繁』」去筛标签：台湾那两项是
        // 「简体 → 台湾正体…」/「台湾正体 → 简体…」，标签里没有「繁」字，会被漏掉。
        const directions = [];
        for (const el of conv.panel.children) {
          if (el.classList.contains('menu-sep')) break;
          if (el.classList.contains('menu-item')) directions.push(el.textContent.trim());
        }
        const hasPreview = [...conv.panel.querySelectorAll('.menu-item')].some(
          (e) => e.textContent.trim() === '转换预览…',
        );
        const subs = conv.panel.querySelectorAll('.menu-sub').length;
        conv.t.click(); // 收起，别挡住后面的断言
        await tick();

        // ---- 排版 ----
        const layout = await openMenu('排版');
        if (!layout) return { ok: false, reason: '顶栏没有「排版」入口' };
        const groups = [...layout.panel.querySelectorAll('.menu-group-title')].map((e) =>
          e.textContent.trim(),
        );
        const items = [...layout.panel.querySelectorAll('.menu-item')].map((e) =>
          e.textContent.replace(/…$/, '').trim(),
        );
        layout.t.click();
        return { ok: true, directions, hasPreview, subs, groups, items };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (menuProbe.exceptionDetails) {
      throw new Error(`菜单求值异常：${menuProbe.exceptionDetails.text}`);
    }
    const menu = menuProbe.result.value;

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
      '简繁菜单：6 个转换方向直接可点',
      menu?.ok === true && menu.directions.length === 6,
      menu?.ok ? `${menu.directions.length} 个：${menu.directions.join(' / ')}` : menu?.reason,
    );
    check('简繁菜单：带「转换预览…」', menu?.hasPreview === true);
    check('简繁菜单：转换方向不再套二级菜单', menu?.subs === 0, `${menu?.subs} 个二级菜单`);
    check(
      '排版菜单：5 个排版类工具 + 6 个常用项',
      menu?.items?.length === 11,
      menu?.items?.join(' / ') ?? '',
    );
    check(
      '排版菜单：分「排版规范 / 常用」两组',
      menu?.groups?.join(' / ') === '排版规范 / 常用',
      menu?.groups?.join(' / ') ?? '',
    );

    // v0.9：五个排版类工具**端到端**跑一遍 —— 菜单 → 选项对话框 → 预览 → 应用。
    //
    // 上面那几条只能证明「入口在」，这里证明的是「规则真的按预期改写了正文」：
    // 判据是编辑器里最终落在文档上的文本，逐字比对。
    // `evaluate` 与 `window.__perf` 都定义在后面的性能段里，这里还轮不到它们出场，
    // 所以本段自带一套最小 helper。
    const runJs = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`排版端到端求值异常：${r.exceptionDetails.text}`);
      }
      return r.result?.value;
    };

    await runJs(`
      window.__layout = {
        frame: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120))),
        // CodeMirror 把不可见字符渲染成了符号，读回真实文本要还原；
        // 空节点里的零宽字符也得剔掉（JSON 打印看不出来，但会让逐字比对假失败）
        read: () => {
          const VIS = { '·': ' ', '→': '\\t', '¬': '', '¶': '' };
          return [...document.querySelectorAll('.cm-line')]
            .map((l) => [...l.textContent].map((c) => VIS[c] ?? c).join(''))
            .join('\\n')
            .replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '');
        },
        pick: async (menuLabel, itemText) => {
          const t = [...document.querySelectorAll('header .menubar-trigger')]
            .find((e) => e.textContent.trim() === menuLabel);
          if (!t) return false;
          t.click();
          await window.__layout.frame();
          const panel = document.querySelector('.menu-panel');
          const el = [...(panel?.querySelectorAll('.menu-item') ?? [])]
            .find((e) => e.textContent.includes(itemText));
          if (!el) return false;
          el.click();
          await window.__layout.frame();
          return true;
        },
        applyIfDialog: () => {
          const b = document.querySelector('.dialog-primary');
          if (b && !b.disabled) {
            b.click();
            return true;
          }
          return false;
        },
        note: () => document.querySelector('.tool-preview-stat')?.textContent?.trim() ?? null,
      };
      true;
    `);

    const LAYOUT_CASES = [
      {
        name: '规范标点（引号 / 省略号 / 破折号 / 竖排横转）',
        item: '规范标点',
        sample: '他说"你好",真的吗?\n等等...\n他--走了\n甲︐乙',
        expect: '他说“你好”，真的吗？\n等等……\n他——走了\n甲，乙',
      },
      {
        // 段首缩进默认是 0（网文稿件多半已带着缩进，补一遍就成双份）
        name: '网文排版（中英 / 中数补空格，URL 不动；段首缩进默认 0）',
        item: '网文排版',
        sample: '第1章 起点\n中文abc混合\n见 https://a.com/x?y=1 不动',
        expect: '第 1 章 起点\n中文 abc 混合\n见 https://a.com/x?y=1 不动',
      },
      {
        // 与网文排版相反：中文文案排的是要发布的稿子，默认空两格
        name: '中文文案（标点后去空格 / 重复标点合并 / 数字单位 / 段首缩进默认 2）',
        item: '中文文案',
        sample: '中文， abc！！重量100kg\n等等...',
        expect: '　　中文，abc！重量 100 kg\n　　等等……',
      },
      {
        name: '技术文档（标题空格 / 列表符号 / 围栏空行，围栏内不动）',
        item: '技术文档',
        sample: '#标题\n* 项目\n正文abc\n```\ncode中文\n```',
        expect: '# 标题\n- 项目\n正文 abc\n\n```\ncode中文\n\n```\n',
      },
      {
        name: '片段处理（清两端空格 + 删空行）',
        item: '片段处理',
        sample: '  b  \n  a  \n\nb',
        expect: 'b\na\nb',
      },
      {
        // 不带「…」的项不弹对话框，点一下就直接应用
        name: '常用项：删除行首行末空格',
        item: '删除行首行末空格',
        sample: '  甲  \n　乙\t',
        expect: '甲\n乙',
      },
    ];

    for (const c of LAYOUT_CASES) {
      await runJs(`window.__layout.pick('文件', '新建')`);
      await runJs(`document.querySelector('.cm-content')?.focus(); true`);
      await cdp.send('Input.insertText', { text: c.sample });
      await sleep(300);
      await runJs(`window.__layout.pick('排版', '${c.item}')`);
      await sleep(600); // 预览是防抖 250ms 之后才算
      const previewNote = await runJs(`window.__layout.note()`);
      await runJs(`window.__layout.applyIfDialog()`);
      await sleep(350);
      const got = await runJs(`window.__layout.read()`);
      check(`排版端到端：${c.name}`, got === c.expect, `${previewNote ?? ''} → ${JSON.stringify(got)}`);
    }
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
    // -----------------------------------------------------------------------
    // 性能预算：打字响应与大块插入（第十阶段之后补的性能守护）
    //
    // 测的是「输入 → 下一帧」的真实端到端时间（含 CodeMirror 更新、React 重渲染、
    // 状态栏计数、不可见字符 decoration 重建），不是某个函数的孤立耗时。
    // -----------------------------------------------------------------------
    /**
     * 一次性灌进文档的规模（行）。
     *
     * 走 `execCommand('insertText')` 而不是合成 `paste` 事件：后者在本项目的
     * WebView2 里会让页面直接崩掉（CM 读合成 `clipboardData` 那一步），
     * 而 execCommand 是 DOM 级的真插入，代价是它按 mutation 一次同步一次 —— 规模不能太大。
     */
    const PERF_BIG_LINES = 2000;
    /** 灌几轮：攒出一份「大文件」（2000 行 × 5 ≈ 160K 字符），再量打字延迟 */
    const PERF_BULK_ROUNDS = 5;
    /**
     * 真正的「输入」走 CDP 的 `Input.insertText`（相当于用户在键盘上敲出来的），
     * 页面里合成的 beforeinput / execCommand 要么是 CM 不认、要么 update 不进 store，
     * 那样测出来的只是 CodeMirror 内部的耗时，量不到 React 侧的统计与重渲染。
     */
    const evaluate = (expression) =>
      cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(
        (r) => r.result.value,
      );
    const big = '汉字软件测试，abc 123。\n'.repeat(PERF_BIG_LINES);
    await evaluate(`
      window.__perf = {
        frame: () => new Promise((r) => {
          const id = setTimeout(r, 200);
          requestAnimationFrame(() => { clearTimeout(id); r(true); });
        }),
        focus: () => { document.querySelector('.cm-content')?.focus(); return true; },
        han: () => Number(
          /汉字 (\\d+)/.exec(
            document.querySelector('.app-statusbar .statusbar-right')?.textContent ?? '',
          )?.[1] ?? -1,
        ),
        panelOf: async (label) => {
          const t = [...document.querySelectorAll('header .menubar-trigger')].find(
            (e) => e.textContent.trim() === label,
          );
          if (!t) return false;
          t.click();
          await window.__perf.frame();
          return true;
        },
        clickItem: async (text) => {
          const panel = document.querySelector('.menu-panel');
          const item = [...(panel?.querySelectorAll('.menu-item') ?? [])].find((e) =>
            e.textContent.includes(text),
          );
          if (item) item.click();
          await window.__perf.frame();
          return !!item;
        },
        /**
         * 埋一个「输入 → 状态栏 DOM 真的更新了」的计时器。
         * 用 MutationObserver 而不是 setTimeout 轮询：前者在 DOM 提交的那一刻就被叫醒，
         * 量出来的就是 React 渲染 + 全文统计的真实耗时。
         */
        arm: () =>
          new Promise((resolve) => {
            const content = document.querySelector('.cm-content');
            const bar = document.querySelector('.app-statusbar .statusbar-right');
            if (!content || !bar) {
              resolve({ latency: -1, why: !content ? '没有编辑器' : '没有状态栏计数' });
              return;
            }
            let inputAt = 0;
            // CodeMirror 自己接管 beforeinput 并 preventDefault，所以 **不会** 冒出 input 事件，
            // 锚点得挂在 beforeinput 上（这正是 CM 开始处理这次输入的那一刻）
            const onInput = () => {
              if (!inputAt) inputAt = performance.now();
            };
            content.addEventListener('beforeinput', onInput);
            content.addEventListener('input', onInput);
            const done = (latency) => {
              clearTimeout(timer);
              ob.disconnect();
              content.removeEventListener('input', onInput);
              content.removeEventListener('beforeinput', onInput);
              resolve({
                latency: Math.round(latency * 10) / 10,
                busyMs: Math.round((inputAt ? performance.now() - inputAt : 0) * 10) / 10,
                longTasks: Math.round(tasks),
                longestTask: Math.round(longest),
              });
            };
            // 顺便记一下这段时间里主线程有多少 >50ms 的长任务（判断时间花在 JS 还是在别处）
            let tasks = 0;
            let longest = 0;
            let po = null;
            try {
              po = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  tasks += e.duration;
                  longest = Math.max(longest, e.duration);
                }
              });
              po.observe({ entryTypes: ['longtask'] });
            } catch {
              po = null;
            }
            const ob = new MutationObserver(() =>
              done(inputAt ? performance.now() - inputAt : -2 /* 没等到输入事件 */),
            );
            ob.observe(bar, { subtree: true, characterData: true, childList: true });
            // 文档压根没变化时不该把测量挂死
            const timer = setTimeout(() => done(-1), 5000);
          }),
      };
      true;
    `);
    await evaluate('window.__perf.focus()');

    const newTab = async () => {
      await evaluate("window.__perf.panelOf('文件')");
      await evaluate("window.__perf.clickItem('新建')");
      await evaluate('window.__perf.focus()');
      await evaluate('window.__perf.frame()');
    };
    /**
     * 一次输入的端到端延迟：从 CodeMirror 的 `input` 事件起，
     * 到状态栏计数**真的重算并落到 DOM**为止（中间含 React 提交与全文统计）。
     *
     * 全程在页面里计时（`arm()` 先埋好 observer，再让 CDP 真的插入文本），
     * 所以不含 WebSocket 往返那种与被测对象无关的噪声。
     */
    const measure = async (text) => {
      const armed = cdp.send('Runtime.evaluate', {
        expression: 'window.__perf.arm()',
        returnByValue: true,
        awaitPromise: true,
      });
      await evaluate('window.__perf.focus()');
      await cdp.send('Input.insertText', { text });
      const r = (await armed).result?.value;
      if (r && r.latency < 0) console.log(`   ! 计时失败：${JSON.stringify(r)}`);
      if (process.env.PERF_AB === '1' && r) {
        console.log(`   ·   长任务 ${r.longTasks}ms（最长 ${r.longestTask}ms）· 主线程忙到 ${r.busyMs}ms`);
      }
      return r?.latency ?? -1;
    };

    await newTab();
    const samples = [];
    for (let i = 0; i < 5; i += 1) samples.push(await measure('字'));
    samples.sort((a, b) => a - b);
    const keySmall = Math.round(samples[Math.floor(samples.length / 2)] * 10) / 10;
    const grewSmall = await evaluate('window.__perf.han()');

    // 灌出一份大文件再打字：全文统计是 O(文档长度)，只有文档足够大才量得出差别。
    //
    // 注意：`bulk` 这一趟**不做断言**——它吃的是 CDP `Input.insertText` 的合成成本
    // （实测 36K 字符要 12s，但期间主线程记录到的长任务是 **0ms**，即 JS 几乎没干活），
    // 量出来的不是应用的编辑性能。真正有代表性的指标是下面的「大文档里单次输入」。
    let bulk = -1;
    for (let round = 0; round < PERF_BULK_ROUNDS; round += 1) bulk = await measure(big);
    const grewBig = await evaluate('window.__perf.han()');
    // 文档变大了之后，同样的单次输入要走一遍更长的全文扫描
    const keyOnBigDoc = await measure('字');

    check(
      '性能：空文档里单次输入到状态栏刷新 < 20ms',
      keySmall >= 0 && keySmall < 20,
      `${keySmall}ms（文档 ${grewSmall} 汉字）`,
    );
    check(
      `性能：大文档（≈${Math.round((big.length * PERF_BULK_ROUNDS) / 1000)}K 字符）里单次输入 < 15ms`,
      keyOnBigDoc >= 0 && keyOnBigDoc < 15 && grewBig > grewSmall,
      `${keyOnBigDoc}ms · 文档汉字 ${grewSmall} → ${grewBig}`,
    );
    console.log(
      `   · 性能实测：单次输入 ${keySmall}ms（空文档） / ${keyOnBigDoc}ms` +
        `（≈${Math.round((big.length * PERF_BULK_ROUNDS) / 1000)}K 字符文档） · ` +
        `一次性插入 ${PERF_BIG_LINES} 行 ${bulk}ms（含 CDP 合成成本，仅供参考）`,
    );

    check('无页面运行时错误', errors.length === 0, errors.length ? errors.map((e) => e.method).join(',') : 'none');

    // v0.9：关掉所有标签之后，编辑区必须是一片空白 —— 不塞欢迎语、不塞功能介绍。
    // 这条断言盯的是「空白页又被塞回东西」这类回退。
    const emptyState = await evaluate(`(async () => {
      const tick = () => new Promise((r) => setTimeout(r, 150));
      const trigger = (label) =>
        [...document.querySelectorAll('header .menubar-trigger')].find((e) => e.textContent.trim() === label);
      const clickItem = (text) => {
        const panel = document.querySelector('.menu-panel');
        const item = [...(panel?.querySelectorAll('.menu-item') ?? [])].find((e) =>
          e.textContent.includes(text),
        );
        if (item) item.click();
        return !!item;
      };
      const t = trigger('文件');
      if (!t) return { ok: false, reason: '顶栏没有「文件」' };
      t.click();
      await tick();
      const clicked = clickItem('全部关闭');
      await tick();
      // 有未保存内容时会弹确认对话框：选「（全部）不保存」
      const discard = document.querySelector('.dialog-danger');
      if (discard) {
        discard.click();
        await tick();
      }
      const ph = document.querySelector('.app-placeholder');
      return {
        ok: clicked,
        editorGone: !document.querySelector('.cm-content'),
        hasPlaceholder: !!ph,
        text: ph ? ph.textContent.trim() : '',
      };
    })()`);
    check(
      '关掉所有标签后编辑区留白（不显示任何文字）',
      emptyState?.hasPlaceholder === true && emptyState.text === '',
      emptyState?.hasPlaceholder
        ? `空白区文字 ${emptyState.text.length} 字 · 编辑器已卸载 ${emptyState.editorGone}`
        : JSON.stringify(emptyState),
    );

    // 冒烟在文档里灌了几十 K 字符、还留着未保存标签，跑完把会话抹掉，别污染用户的下次启动
    if (process.platform === 'win32' && process.env.APPDATA) {
      try {
        rmSync(path.join(process.env.APPDATA, 'AioTextEditor', 'session.json'), { force: true });
      } catch {
        // 清不掉就算了，不影响结论
      }
    }

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
