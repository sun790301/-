# AI Office 🏢

一間 3D 像素風的 AI 辦公室：你交代工作給「主管」，主管會依照員工的技能分派任務，員工在辦公桌前打字工作，完成後回報；沒事的時候，員工會跑去茶水間、沙發區互相聊天。

## 功能

- **3D 等角辦公室**：會議室、工作區、主管辦公室、茶水間、休息區，可拖曳旋轉/縮放，白天/夜晚切換（晚上自動顯示「加班中」）。
- **看得見的工作狀態**：每位角色頭上有狀態燈：🟢 閒置、🟠 工作中、🔵 思考中、🟣 聊天中，工作時電腦螢幕會亮起。
- **主管 → 員工的任務分派**：主管是一個使用 `assign_task` 工具的 Claude agent，可以同時把工作平行派給多位員工；每位員工是有自己職位、技能、個性的子 agent。
- **小組管理**：在「小組」分頁招募/編輯/解僱員工（最多 6 位），自訂技能與個性、衣服顏色。
- **茶水間閒聊**：員工閒下來會兩兩聊天，對話由 Claude 依照個性與最近發生的事產生（可在設定關閉）。
- **花費統計**：右上角顯示累計任務數與估算花費（US$）。
- **示範模式**：沒有 API Key 也能玩，會用預設的回覆模擬整個流程。

## 使用方式

1. 開啟 `ai-office/index.html`（透過 GitHub Pages，或在本機用任何靜態伺服器，例如 `python3 -m http.server`，然後打開 `http://localhost:8000/ai-office/`）。
   > 直接雙擊打開檔案（`file://`）時，瀏覽器會擋下 ES module，請用伺服器開啟。
2. 點右上角 ⚙️，貼上你的 Anthropic API Key（到 https://platform.claude.com 申請），選擇模型。
3. 在右側「主管」分頁輸入工作，例如：「幫我寫一份新產品上市的社群貼文，再整理一份 FAQ」。

## 安全提醒

API Key 只存在你這台瀏覽器的 `localStorage`，請求直接從瀏覽器送到 Anthropic API（使用 SDK 的 `dangerouslyAllowBrowser`）。這適合個人自己使用；**不要**把含有金鑰的頁面分享給別人，也不要在公用電腦上使用。若要給多人使用，請改成由後端伺服器代為呼叫 API。

## 技術

- 純前端、免建置：[three.js](https://threejs.org/)（3D 場景）＋ [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)（從 CDN 載入）。
- 預設模型 `claude-opus-5-5`，開啟 prompt caching 與伺服器端 refusal fallback；主管與員工使用串流（streaming）。
- 檔案：`office.js`（場景、家具、A* 尋路、角色動畫）、`ai.js`（主管/員工/閒聊的 Claude 呼叫與示範模式）、`main.js`（行為控制與介面）。
