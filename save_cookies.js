const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// Get filename from command line arguments (e.g., user1_cookies.json)
const COOKIES_FILE = process.argv[2]; 

if (!COOKIES_FILE) {
    console.log('ERROR: Please specify the output filename.');
    console.log('Usage: node save_cookies.js user1_cookies.json');
    return;
}

(async () => {
    const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
    const page = await browser.newPage();

    console.log(`--- STARTING SESSION FOR: ${COOKIES_FILE} ---`);
    console.log('Go to the browser and log in with the correct account now...');
    await page.goto('https://webook.com/ar/login', { waitUntil: 'networkidle2' });

    // Wait for the user to login (60 seconds)
    await new Promise(r => setTimeout(r, 120000));

    // Save cookies to the specified file
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    
    console.log(`[SUCCESS] Cookies saved to ${COOKIES_FILE}!`);
    await browser.close();
})();