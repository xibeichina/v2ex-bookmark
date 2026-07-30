# Icons

此扩展当前不在 `manifest.json` 中声明图标，因此可直接加载运行。

如需发布到 Chrome Web Store，可在此目录加入 `16.png`、`32.png`、`48.png` 和 `128.png`，再在 `manifest.json` 的根级添加：

```json
"icons": {
  "16": "icons/16.png",
  "32": "icons/32.png",
  "48": "icons/48.png",
  "128": "icons/128.png"
}
```
