
const { chromium } = require('playwright');

async function main() {
    const browser = await chromium.launch({
        headless: true
    });

    const page = await browser.newPage();

    try {
        const url = process.env.SITE_URL;
        const selector = process.env.TARGET_SELECTOR;

        console.log('Opening website:', url);

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForSelector(selector, {
            timeout: 30000
        });

        await page.locator(selector).click();

        console.log('Click successful!');

    } catch (error) {
        console.error('Error:', error);
        process.exitCode = 1;

    } finally {
        await browser.close();
    }
}

main();
