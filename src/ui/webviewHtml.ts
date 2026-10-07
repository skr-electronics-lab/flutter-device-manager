/**
 * Renders the webview shell document. The bundled main.js and main.css are
 * inlined so the panel never needs remote or extra resources.
 */
export function renderHtml(nonce: string, script: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https: vscode-resource:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flutter Device Manager</title>
<style>
${css || ""}
  #app { height: 100vh; }
</style>
</head>
<body>
<div id="app">
  <div class="boot">Loading device manager\u2026</div>
</div>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
}