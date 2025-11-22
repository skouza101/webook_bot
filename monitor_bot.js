const { Cluster } = require("puppeteer-cluster");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
require("dotenv").config();

puppeteer.use(StealthPlugin());

// --- CONFIGURATION FROM .ENV ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_URL = process.env.TARGET_URL;
const BUY_BUTTON_SELECTOR = process.env.BUY_BUTTON_SELECTOR || '[data-testid="book-button"]';

// اسم ملف المستخدمين الذي يحتوي على التوكنات
const USERS_FILE = "users.json"; 

// قائمة البروكسيات من ملف .env
const PROXIES = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(",") : [];

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ----------------------------------------------------
// 🎲 HELPER FUNCTIONS
// ----------------------------------------------------
const getRandomElements = (array, count) => {
  const shuffled = array.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
};

// دالة سحب الإيميل (احتياطية، لأننا نملك الإيميل من الملف أصلاً)
const getAccountEmail = async (page) => {
  const profileURL = "https://webook.com/ar/profile";
  const emailSelector = "p.text-body-M.font-label.text-text-tertiary"; 
  try {
    await page.goto(profileURL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(emailSelector, { timeout: 10000 });
    const emailElement = await page.$(emailSelector);
    return await page.evaluate((el) => el.textContent.trim(), emailElement);
  } catch (error) {
    return "Unknown";
  }
};

// ----------------------------------------------------
// 🎯 MAIN TASK (المنطق الرئيسي)
// ----------------------------------------------------
const monitorTask = async ({ page, data }) => {
  // البيانات القادمة من Cluster
  const { email, token, proxy } = data;
  console.log(`[TASK] Started for: ${email}`);

  // 1. تسريع الصفحة (منع الصور والخطوط)
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // 2. تسجيل الدخول عبر التوكن (Token Injection)
  // هذه هي الطريقة التي يستخدمها بوت العميل في Python
  if (token) {
      await page.setCookie({
          name: 'token', // اسم الكوكي كما في كود Python: cookie = driver.get_cookie("token")
          value: token,
          domain: '.webook.com', // النطاق مهم جداً لكي يعمل الكوكي
          path: '/',
          secure: true, // الموقع يستخدم HTTPS
          httpOnly: false
      });
      console.log(`[INFO] Token injected for ${email}`);
  } else {
      console.log(`[ERROR] No token found for ${email}, skipping...`);
      return;
  }
  
  // 3. الانتقال لصفحة الحدث
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  let isTicketFound = false;

  // --- MONITORING LOOP ---
  while (!isTicketFound) {
    try {
      const buyButton = await page.waitForSelector(BUY_BUTTON_SELECTOR, { timeout: 2000 });

      if (buyButton) {
        console.log(`[SUCCESS] ${email}: TICKET FOUND!`);

        // --- STEP 1: CLICK BOOK BUTTON ---
        await buyButton.click();
        console.log("[ACTION] Clicked Book. Waiting for Map...");

        // انتظار تحميل أي نوع من الخرائط
        try {
            await page.waitForFunction(() => 
                document.querySelector('svg') || document.querySelector('#canvas') || document.querySelector('[data-testid="zone"]'),
                { timeout: 20000 }
            );
        } catch(e) { console.log('[WARN] Map wait timeout, proceeding anyway...'); }

        // --- STEP 2: CHOOSE ZONE (If available) ---
        let selectedAreaName = "Direct/Unknown";
        try {
          const areaSelector = 'path[fill]:not([fill="none"]), g.available-zone, [data-testid="zone-available"]';
          const availableAreas = await page.$$(areaSelector);

          if (availableAreas.length > 0) {
            const randomArea = getRandomElements(availableAreas, 1)[0];
            
            // محاولة قراءة اسم المنطقة
            const areaNameSelector = 'div[style*="gap: 14px"] span[style*="font-weight: 700"] > span';
            
            await randomArea.click();
            await page.waitForTimeout(2000); // Wait for zoom

            try {
                await page.waitForSelector(areaNameSelector, { timeout: 3000 });
                selectedAreaName = await page.$eval(areaNameSelector, el => el.textContent.trim());
            } catch(e) { selectedAreaName = "Zone Selected (Name Hidden)"; }
          }
        } catch (areaError) {
          console.log(`[INFO] Area selection skipped.`);
        }

        // --- STEP 3: CANVAS CLICKING (Coordinate Strategy) ---
        let selectedSeatsList = [];
        try {
          const canvasSelector = "#canvas";
          const canvas = await page.waitForSelector(canvasSelector, { timeout: 5000 }).catch(() => null);

          if (canvas) {
             const box = await canvas.boundingBox();
             if (box) {
                // محاولة النقر 30 مرة عشوائية
                for (let i = 0; i < 30; i++) {
                    if (selectedSeatsList.length >= 5) break;
                    
                    const x = box.x + box.width * 0.1 + Math.random() * (box.width * 0.8);
                    const y = box.y + box.height * 0.1 + Math.random() * (box.height * 0.8);

                    await page.mouse.click(x, y);
                    await page.waitForTimeout(100); 

                    // التحقق من التول تيب (Tooltip)
                    try {
                        const seatInfo = await page.evaluate(() => {
                            const tip = document.querySelector("#sectionTooltip");
                            return (tip && tip.innerText.length > 0) ? tip.innerText.split("\n")[0] : null; 
                        });

                        if (seatInfo && !selectedSeatsList.includes(seatInfo)) {
                            selectedSeatsList.push(seatInfo);
                        }
                    } catch (e) {}
                }
             }
          }
        } catch (canvasError) {
          console.log(`[ERROR] Seat interaction failed: ${canvasError.message}`);
        }

        // --- STEP 4: CONFIRM ---
        try {
          console.log("[ACTION] Confirming selection...");
          const nextBtnSelector = "button.primary-action, [data-testid='add-to-cart'], button[class*='checkout']";
          const nextBtn = await page.$(nextBtnSelector);
          if (nextBtn) await nextBtn.click();
        } catch (e) {}

        // --- STEP 5: FINAL SCRAPING & TELEGRAM ---
        const proxy_info = data.proxy ? data.proxy.replace(/https?:\/\//, '').split('@').pop() : "Direct";
        
        let finalTicketDetails = "Scraping Failed";
        let confirmedTicketIDs = [];
        let firstTicketID = "N/A";

        try {
            console.log("[ACTION] Waiting for Order Summary...");
            await page.waitForFunction(
                () => document.body.innerText.includes('المجموع') || document.querySelector('#event-tickets'), 
                { timeout: 30000 }
            );

            // سحب الـ IDs
            confirmedTicketIDs = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('li [data-testid^="cart-ticket-line-"]'));
                return elements.map(el => el.getAttribute('data-testid'));
            });
            if (confirmedTicketIDs.length > 0) firstTicketID = confirmedTicketIDs[0];
            
            // سحب النص التفصيلي
            finalTicketDetails = await page.evaluate(() => {
                const listItems = Array.from(document.querySelectorAll('#event-tickets li'));
                if (listItems.length > 0) {
                    return listItems.map(item => {
                        const nameContainer = item.querySelector('div[data-testid^="cart-ticket-name-"] p'); 
                        const rawText = nameContainer ? nameContainer.innerText : item.innerText; 
                        return rawText.replace(/\s\s+/g, ' ').trim(); 
                    }).join('\n');
                }
                // Fallback
                const allText = document.body.innerText.split('\n');
                const seatLines = allText.filter(line => (line.includes('المقعد') || line.includes('Seat')) && line.length < 100);
                return seatLines.length > 0 ? seatLines.join('\n') : "Seats secured, check cart manually.";
            });

        } catch (scrapeError) {
            console.log(`[ERROR] Final Scraping Failed: ${scrapeError.message}`);
            finalTicketDetails = selectedSeatsList.join(", ") || "Check Cart - Manual Scan Needed";
        }

        console.log(`[INFO] All Confirmed IDs: ${confirmedTicketIDs.join(', ')}`); 
        
        const telegram_message = `
🚨 **SEATS SECURED!**
------------------------------
👤 **Account:** ${email}
📍 **Area:** ${selectedAreaName}
💺 **Confirmed Seats:**
${finalTicketDetails}
🔗 **Proxy:** ${proxy_info}
------------------------------
🔑 **First ID:** ${firstTicketID}
🔴 **PAYMENT REQUIRED NOW!**
        `;

        try {
          await bot.sendMessage(TELEGRAM_CHAT_ID, telegram_message);
        } catch (e) {}

        // --- STEP 6: EXIT ---
        console.log("[DONE] Task finished. Waiting for payment...");
        isTicketFound = true;
        await new Promise((resolve) => setTimeout(resolve, 900000)); // 15 Minutes hold
        return;
      }
    } catch (error) {
      console.log(`[INFO] Waiting for tickets...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

// ----------------------------------------------------
// 🌐 CLUSTER LAUNCHER
// ----------------------------------------------------
(async () => {
  // 1. قراءة ملف المستخدمين (users.json) وتجهيز الحسابات
  let accounts = [];
  try {
      // قراءة الملف كنص
      const rawData = fs.readFileSync(USERS_FILE, 'utf8');
      const jsonData = JSON.parse(rawData);
      
      // التنسيق المتوقع هو: {"data": [{"email1": "token1"}, {"email2": "token2"}]}
      if (jsonData.data && Array.isArray(jsonData.data)) {
          jsonData.data.forEach(obj => {
              // كل كائن يحتوي على مفتاح واحد (الإيميل) وقيمته (التوكن)
              const email = Object.keys(obj)[0];
              const token = obj[email];
              
              if (email && token) {
                  accounts.push({ email, token });
              }
          });
      }
      console.log(`✅ Loaded ${accounts.length} accounts from ${USERS_FILE}`);
  } catch (error) {
      console.error(`❌ Error reading ${USERS_FILE}:`, error.message);
      return;
  }

  // 2. إعداد Cluster
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_BROWSER, // متصفح منفصل لكل حساب (أفضل للعزل)
    maxConcurrency: PROXIES.length > 0 ? PROXIES.length : 2, // عدد المتصفحات المتزامنة
    timeout: 600000,
    puppeteerOptions: {
      headless: false,
      defaultViewport: null,
      args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
      ignoreHTTPSErrors: true,
    },
  });

  cluster.on("taskerror", (err, data) => {
    console.log(`[ERROR] ${data.email}: ${err.message}`);
  });

  // 3. إرسال المهام للـ Cluster
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    // توزيع البروكسيات بالدور على الحسابات
    const proxyUrl = PROXIES.length > 0 ? PROXIES[i % PROXIES.length] : null;

    await cluster.queue(
      {
        email: acc.email,
        token: acc.token,
        proxy: proxyUrl,
      },
      monitorTask
    );
  }

  await cluster.idle();
  await cluster.close();
})();