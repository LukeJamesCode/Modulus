# modulus-browser

Lets agents drive a real headless browser (navigate, read, click, type, screenshot).

**Tier:** Intended for Standard or Heavy hardware tiers. **NOT a Raspberry Pi.** Requires Playwright + Chromium.

## Installation

Heavy deps install themselves when you enable the module — core never carries
them. On enable (via the panel or `modulus mod install modulus-browser`) the
module's `setup` entrypoint installs the `playwright` npm package into the
module's own folder and downloads a Chromium binary. No manual step is needed;
watch the enable output for progress.

If the automatic install is interrupted, finish it by hand from the module
folder (`~/.modulus/modules/modulus-browser/`):
```bash
npm install --prefix ~/.modulus/modules/modulus-browser playwright
node ~/.modulus/modules/modulus-browser/node_modules/playwright/cli.js install chromium
```

## Tools

* **browser_navigate:** Navigates to a URL. (auto)
* **browser_read:** Reads the text on the current page. (auto)
* **browser_click:** Clicks an element. (confirm)
* **browser_type:** Types into an element. (confirm)
* **browser_screenshot:** Saves a screenshot to the data directory. (auto)

## Agent

Ships a `browser-operator` specialist scoped to these tools — delegate web tasks to it from the fleet.

## Safety

All URLs are checked against a strict SSRF guard. It prevents navigation to localhost, local network IP ranges, and cloud metadata APIs. It also requires HTTP/HTTPS protocols (no `file://`).
For mutating actions (click, type), the agent will ask for human confirmation (confirm tier).
