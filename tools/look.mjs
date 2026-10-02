/**
 * Open the game in headless Chrome, optionally run some script in the page, and save a screenshot.
 * For checking by eye what a change looks like without a visible browser.
 *
 *   node tools/look.mjs out.jpg                              # the title screen
 *   node tools/look.mjs out.jpg "breach.view.yaw = 1" 3      # run a script, wait 3 s, then shoot
 *   node tools/look.mjs out.jpg "" 2 "#room=ABCD"            # with a URL suffix
 *
 * The script may return a promise. Console errors are printed.
 */
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./chrome.mjs";

const [file = "look.jpg", script = "", wait = "2", suffix = "", width = "1280", height = "720"] = process.argv.slice(2);
const port = 8300 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [fileURLToPath(new URL("./serve.mjs", import.meta.url)), String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await launch({ gpu: true });
try {
    const page = await browser.page(`http://localhost:${port}/${suffix}`, { width: +width, height: +height });
    await page.waitFor("!!window.breach", 15000);
    if (script) console.log("script:", JSON.stringify(await page.evaluate(script)));
    await new Promise((r) => setTimeout(r, +wait * 1000));
    await writeFile(file, await page.screenshot("jpeg", 85));
    console.log(file + (page.errors.length ? "\nconsole errors:\n" + page.errors.join("\n") : "  (no console errors)"));
} finally {
    await browser.close();
    server.kill();
}
setTimeout(() => process.exit(0), 300);
