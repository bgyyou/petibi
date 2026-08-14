# -*- coding: utf-8 -*-
"""
take_result_screenshot.py — T3 工单：单独截一张结果页（百分比条重点展示）。

因为 setup 流程是 React reducer 内部 state，从外部推进到 result 步骤比较重；
直接做法：构造一个 result-screenshot.html，复用 setup 的样式 + 静态渲染
"四维百分比条"（E 51% / I 49% 等边界值 + 45-55% 弱倾向提示），让 owner 目检。

脚本：
  - 写 docs/tech/screenshots/t3/result-screenshot.html（含 4 条百分比条 demo）
  - 用 playwright 截图 docs/tech/screenshots/t3/07-result-bars.png

用法：
  python scripts/take_result_screenshot.py
"""

from __future__ import annotations

import http.server
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SHOTS_DIR = REPO_ROOT / "docs" / "tech" / "screenshots" / "t3"
TEMP_HTML = SHOTS_DIR / "_result-demo.html"

HTTP_PORT = 8766


def make_html() -> None:
    """构造一个 result demo HTML：标题 + 4 条百分比条（边界值 + 弱倾向提示）。
    CSS 内联（避免 file:// 跨文件加载被浏览器阻止）。"""
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    # 读 css 内容（构造时先把 css 写出来再内联）
    _write_css()
    css_text = (SHOTS_DIR / "result-demo.css").read_text(encoding="utf-8")
    html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Petibi 结果页百分比条（T3 demo）</title>
  <style>
__CSS__
  </style>
</head>
<body>
  <div class="setup-shell" style="--family-color: #785D87; --family-color-bg: #f1ebf6;">
    <header class="setup-header">
      <h1 class="setup-title">你的人格是…</h1>
      <p class="setup-subtitle">它就是你专属的桌宠形象</p>
    </header>
    <div class="setup-body">
      <div class="result-shell">
        <!-- 人格卡片（占位）-->
        <div class="result-card">
          <div class="result-portrait" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;font-family:var(--font-pixel-en),var(--font-body);font-size:40px;color:var(--ink);">INTJ</div>
          <div class="result-type">INTJ</div>
          <div class="result-subtype">坚定型</div>
          <div class="result-animal">猫头鹰 · 独立、长远规划的建筑师</div>
        </div>
        <!-- 百分比条（核心 T3 改造）-->
        <div class="result-bars" aria-label="四维百分比">
          <div class="result-bar">
            <div class="result-bar-name">能量来源</div>
            <div class="result-bar-row">
              <span class="result-bar-pole is-first">E</span>
              <div class="result-bar-track" role="progressbar" aria-valuenow="51" aria-valuemin="0" aria-valuemax="100">
                <div class="result-bar-fill" style="width:51%"></div>
              </div>
              <span class="result-bar-pole is-second">I</span>
            </div>
            <div class="result-bar-pct"><span>E 51%</span><span>I 49%</span></div>
            <div class="result-bar-hint">这个维度你的倾向较弱，结果可能随状态波动</div>
          </div>
          <div class="result-bar">
            <div class="result-bar-name">信息接收</div>
            <div class="result-bar-row">
              <span class="result-bar-pole is-first">S</span>
              <div class="result-bar-track">
                <div class="result-bar-fill" style="width:32%"></div>
              </div>
              <span class="result-bar-pole is-second">N</span>
            </div>
            <div class="result-bar-pct"><span>S 32%</span><span>N 68%</span></div>
          </div>
          <div class="result-bar">
            <div class="result-bar-name">决策方式</div>
            <div class="result-bar-row">
              <span class="result-bar-pole is-first">T</span>
              <div class="result-bar-track">
                <div class="result-bar-fill" style="width:75%"></div>
              </div>
              <span class="result-bar-pole is-second">F</span>
            </div>
            <div class="result-bar-pct"><span>T 75%</span><span>F 25%</span></div>
          </div>
          <div class="result-bar">
            <div class="result-bar-name">生活态度</div>
            <div class="result-bar-row">
              <span class="result-bar-pole is-first">J</span>
              <div class="result-bar-track">
                <div class="result-bar-fill" style="width:50%"></div>
              </div>
              <span class="result-bar-pole is-second">P</span>
            </div>
            <div class="result-bar-pct"><span>J 50%</span><span>P 50%</span></div>
            <div class="result-bar-hint">这个维度你的倾向较弱，结果可能随状态波动</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>"""
    html = html.replace("PORT_PLACEHOLDER", str(HTTP_PORT))
    html = html.replace("__CSS__", css_text)
    TEMP_HTML.write_text(html, encoding="utf-8")


def _write_css() -> None:
    """把 css 写到 shots/result-demo.css（也用作独立访问入口）。
    字体 url 走 8765 端口（take_t3_screenshots.py 的 http server），CSS url 走 8766。"""
    css = r"""
@font-face {
  font-family: 'PetibiPixel';
  font-style: normal;
  font-weight: 400;
  src: url('http://127.0.0.1:8765/fonts/fusion-pixel-12px-proportional-latin.woff2') format('woff2'),
       url('http://127.0.0.1:8765/fonts/fusion-pixel-12px-proportional-latin.otf') format('opentype');
  unicode-range: U+0020-007F, U+00A0-00FF;
}
@font-face {
  font-family: 'PetibiPixel';
  font-style: normal;
  font-weight: 400;
  src: url('http://127.0.0.1:8765/fonts/fusion-pixel-12px-proportional-zh_hans.woff2') format('woff2'),
       url('http://127.0.0.1:8765/fonts/fusion-pixel-12px-proportional-zh_hans.otf') format('opentype');
  unicode-range: U+3000-303F, U+4E00-9FFF, U+FF00-FFEF;
}
:root {
  --font-pixel-en: 'PetibiPixel', 'Courier New', monospace;
  --font-pixel-cn: 'PetibiPixel', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --ink: #2B2320; --cream: #FEF9EF; --paper: #FFFFFF; --mute: #8B8680;
  --family-color: #785D87; --family-color-bg: #f1ebf6;
  --border-px: 3px;
  --shadow-rest: 4px 4px 0 #2B2320;
  --fs-h1: 24px; --fs-h2: 18px; --fs-body: 14px; --fs-small: 12px; --fs-pixel-xl: 40px;
}
html, body {
  margin: 0; padding: 0; background: #FEF9EF; color: #2B2320;
  font-family: var(--font-body); font-size: 14px;
}
.setup-shell {
  display: flex; flex-direction: column; padding: 24px 36px; box-sizing: border-box;
}
.setup-header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
.setup-title {
  margin: 0; font-family: var(--font-pixel-en), var(--font-pixel-cn), var(--font-body);
  font-size: 24px; font-weight: 400; letter-spacing: 0.5px;
  image-rendering: pixelated;
}
.setup-subtitle { margin: 0; font-size: 12px; color: #8B8680; }
.setup-body { flex: 1; display: flex; flex-direction: column; }
.result-shell { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 8px 0; }
.result-card {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 28px 36px 22px; background: #FFFFFF; border: 3px solid #2B2320;
  min-width: 340px; box-shadow: 4px 4px 0 #2B2320;
}
.result-portrait {
  width: 128px; height: 128px; image-rendering: pixelated;
  border: 3px solid #2B2320; background: #f1ebf6;
}
.result-type {
  font-family: var(--font-pixel-en), var(--font-pixel-cn), var(--font-body);
  font-size: 40px; font-weight: 400; letter-spacing: 4px; line-height: 1;
  image-rendering: pixelated;
}
.result-subtype {
  font-size: 12px; padding: 4px 14px; border: 3px solid #2B2320;
  background: #785D87; color: #fff; letter-spacing: 1px;
  box-shadow: 2px 2px 0 #2B2320;
}
.result-animal { font-size: 14px; color: #8B8680; font-weight: 500; }
.result-bars {
  width: 100%; max-width: 460px; display: flex; flex-direction: column; gap: 10px;
  padding: 16px; background: #FFFFFF; border: 3px solid #2B2320;
  box-shadow: 4px 4px 0 #2B2320;
}
.result-bar { display: flex; flex-direction: column; gap: 2px; }
.result-bar-name { font-size: 11px; color: #8B8680; font-weight: 500; letter-spacing: 0.5px; }
.result-bar-row { display: grid; grid-template-columns: 28px 1fr 28px; align-items: center; gap: 8px; }
.result-bar-pole { font-family: var(--font-pixel-en); font-size: 16px; text-align: center; letter-spacing: 1px; }
.result-bar-pole.is-first { color: #785D87; }
.result-bar-pole.is-second { color: #8B8680; }
.result-bar-track {
  position: relative; height: 12px; background: #FEF9EF;
  border: 3px solid #2B2320; overflow: hidden;
}
.result-bar-fill {
  height: 100%; background: #785D87;
  background-image: linear-gradient(to right, #785D87 0, #785D87 4px, rgba(255,255,255,0.25) 4px, rgba(255,255,255,0.25) 8px);
  background-size: 8px 100%; background-repeat: repeat-x;
}
.result-bar-pct {
  font-family: var(--font-pixel-en); font-size: 11px; color: #8B8680;
  display: flex; justify-content: space-between; letter-spacing: 0.5px;
}
.result-bar-hint {
  margin-top: 4px; padding: 6px 10px; font-size: 11px; color: #8a6a1e;
  background: #fbf2dc; border: 1px dashed #8a6a1e;
}
"""
    css = css.replace("PORT_PLACEHOLDER", str(HTTP_PORT))
    (SHOTS_DIR / "result-demo.css").write_text(css, encoding="utf-8")


def serve():
    """起一个简单的 http server 在 SHOTS_DIR 上 serve 文件。"""
    handler = http.server.SimpleHTTPRequestHandler
    httpd = socketserver.TCPServer(("127.0.0.1", HTTP_PORT), handler)
    httpd.serve_forever()


def main() -> int:
    """构造 demo HTML + 起 server + playwright 截图。"""
    make_html()
    # 切换 cwd 到 shots 目录服务；要求 fonts 路径写死通过另一端口取
    # 上面 CSS 已经把 fonts URL 写成另一端口（8765 = take_t3_screenshots 那个 server）
    # 这里我们直接 serve SHOTS_DIR + 依赖 take_t3_screenshots 用的 server 已起了 fonts
    t = threading.Thread(target=serve, daemon=True)
    t.start()
    # 等等 server 起来 + 字体 server 也确认在跑
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", HTTP_PORT), timeout=1):
                break
        except OSError:
            time.sleep(0.3)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 820, "height": 700})
        page = ctx.new_page()
        # 直接 file:// 加载本地的 demo html，不依赖 http server 的根目录 cwd
        url = f"file:///{TEMP_HTML.as_posix()}"
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.evaluate("document.fonts && document.fonts.ready")
        page.wait_for_timeout(1000)
        out = SHOTS_DIR / "07-result-bars.png"
        page.screenshot(path=str(out), full_page=True)
        print(f"[result-shot] 保存：{out.relative_to(REPO_ROOT)}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())